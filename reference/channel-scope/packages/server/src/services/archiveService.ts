import { EventEmitter } from 'events';
import { TelegramClient } from 'telegram';
import Post, { type IPost } from '../db/models/Post.js';
import processMedia, { extractMediaMetadata, downloadPostMedia } from '../telegram/processors/processMediaClient.js';
import type { MediaItem, Reaction } from 'channel-scope-shared';
import type { GramJSReactions, GramJSClient } from '../types/index.js';

export interface LastPost {
  id: number;
  text: string;
  date: string;
  mediaCount: number;
}

export interface ArchiveProgress {
  status: 'idle' | 'downloading' | 'paused' | 'completed' | 'error';
  channel: string;
  totalProcessed: number;
  totalSaved: number;
  mediaDownloaded: number;
  errors: number;
  message: string;
  lastPost?: LastPost;
}

export interface ChannelStats {
  channelId: string;
  postCount: number;
  mediaCount: number;
  firstPost: Date | null;
  lastPost: Date | null;
  totalViews: number;
}

class ArchiveService extends EventEmitter {
  private client: TelegramClient | null = null;
  private progress: ArchiveProgress = {
    status: 'idle',
    channel: '',
    totalProcessed: 0,
    totalSaved: 0,
    mediaDownloaded: 0,
    errors: 0,
    message: '',
  };
  private _pauseRequested = false;
  private pauseResumeMinId = 0;
  private lastLimit: number | undefined = undefined;
  private lastSince: Date | undefined = undefined;
  private lastSkipMedia = false;

  getProgress(): ArchiveProgress {
    return { ...this.progress };
  }

  pause(): void {
    if (this.progress.status === 'downloading') {
      this._pauseRequested = true;
      this.updateProgress({ status: 'paused', message: 'Download paused' });
    }
  }

  resume(): void {
    if (this.progress.status === 'paused' && this.client) {
      this._pauseRequested = false;
      this.updateProgress({ status: 'downloading', message: 'Resuming download...' });

      // Only resume from where we left off (Phase 1 with minId, then Phase 2)
      // Do NOT restart Phase 1 from scratch — that causes infinite loops
      // when media download errors trigger pause/resume cycles
      const resumePromise = this.pauseResumeMinId > 0
        ? this.fetchHistoricalData(this.progress.channel, this.lastLimit, this.lastSince)
            .then(() => this.lastSkipMedia ? Promise.resolve() : this.downloadPendingMedia(this.progress.channel))
        : this.lastSkipMedia ? Promise.resolve() : this.downloadPendingMedia(this.progress.channel);

      resumePromise.then(() => {
        this.updateProgress({
          status: 'completed',
          message: `Archive complete: ${this.progress.totalSaved} posts saved, ${this.progress.mediaDownloaded} media files`,
        });
      }).catch(err => {
        this.updateProgress({
          status: 'error',
          message: `Archive failed: ${(err as Error).message}`,
        });
      });
    }
  }

  private updateProgress(update: Partial<ArchiveProgress>): void {
    Object.assign(this.progress, update);
    if (update.message) {
      console.log(`[Archive] ${update.message}`);
    }
    this.emit('progress', this.getProgress());
  }

  private processReactions(messageReactions: GramJSReactions | undefined | null): Reaction[] {
    if (!messageReactions || !Array.isArray(messageReactions.results) || messageReactions.results.length === 0) {
      return [];
    }
    const reactionsArray: Reaction[] = [];
    for (const result of messageReactions.results) {
      if (result && result.reaction && typeof result.count === 'number') {
        const reactionKey = result.reaction.emoticon
          ? result.reaction.emoticon.toString()
          : result.reaction.className === 'ReactionPaid'
            ? '⭐'
            : JSON.stringify(result.reaction);
        reactionsArray.push({ reaction: reactionKey, count: result.count });
      }
    }
    return reactionsArray;
  }

  async startArchive(
    channel: string,
    limit: number | undefined = undefined,
    telegramClient?: TelegramClient,
    since?: Date,
    skipMedia = false,
  ): Promise<void> {
    if (this.progress.status === 'downloading' || this.progress.status === 'paused') {
      throw new Error('Archive already in progress');
    }

    if (telegramClient) {
      this.client = telegramClient;
    }

    if (!this.client) {
      throw new Error('No connected Telegram account. Add an account in Settings → Accounts first.');
    }

    this._pauseRequested = false;
    this.lastLimit = limit;
    this.lastSince = since;
    this.lastSkipMedia = skipMedia;
    this.pauseResumeMinId = 0;

    this.updateProgress({
      status: 'downloading',
      channel,
      totalProcessed: 0,
      totalSaved: 0,
      mediaDownloaded: 0,
      errors: 0,
      message: `Starting archive of ${channel}...`,
      lastPost: undefined,
    });

    try {
      // Phase 1: Metadata pass (fast — no downloads)
      await this.fetchHistoricalData(channel, limit, since);
      if (!skipMedia) {
        // Phase 2: Download media for posts saved in Phase 1
        await this.downloadPendingMedia(channel);
        // After both passes, retry any remaining failed media
        await this.retryFailedMedia(channel);
      }
      this.updateProgress({
        status: 'completed',
        message: skipMedia
          ? `Archive complete (metadata only): ${this.progress.totalSaved} posts saved`
          : `Archive complete: ${this.progress.totalSaved} posts saved, ${this.progress.mediaDownloaded} media files`,
      });
    } catch (err) {
      this.updateProgress({
        status: 'error',
        message: `Archive failed: ${(err as Error).message}`,
      });
      throw err;
    }
  }

  /**
   * Phase 1: Iterate all messages and extract metadata WITHOUT downloading media.
   * This is fast — pure API + DB operations only.
   */
  private async fetchHistoricalData(channel: string, limit: number | undefined, since?: Date): Promise<void> {
    const BATCH_SIZE = 50;

    this.updateProgress({ message: 'Phase 1: Fetching metadata...' });

    // Pre-load existing telegramIds to avoid N+1 queries
    const existingPosts = await Post.find({ channelId: channel })
      .select('telegramId')
      .lean();
    const existingIds = new Set(existingPosts.map(p => p.telegramId));
    console.log(`[Archive] Pre-loaded ${existingIds.size} existing post IDs for ${channel}`);

    const iterOpts: { limit?: number; chunkSize: number; minId?: number } = {
      chunkSize: 100,
    };

    if (limit && limit > 0) {
      iterOpts.limit = limit;
    }

    // Only use minId when resuming from a pause (not for "smart resume")
    // Gap filling and time filters rely on iterating all messages + existingIds Set
    if (this.pauseResumeMinId > 0) {
      iterOpts.minId = this.pauseResumeMinId;
    }

    const client = this.client as unknown as GramJSClient;
    console.log(`[Archive] Phase 1: Starting metadata fetch for ${channel}, limit=${limit ?? 'all'}, minId=${iterOpts.minId ?? 0}, since=${since?.toISOString() ?? 'none'}`);

    // Batch buffer for bulk inserts
    let batch: {
      doc: Omit<IPost, 'createdAt' | 'updatedAt'>;
      mediaCount: number;
      messageId: number;
      text: string;
      dateStr: string;
    }[] = [];

    const flushBatch = async () => {
      if (batch.length === 0) return;

      const currentBatch = batch;
      batch = [];

      try {
        await Post.insertMany(
          currentBatch.map(item => item.doc),
          { ordered: false },
        );
      } catch (err: unknown) {
        // With ordered: false, insertMany continues past duplicate key errors.
        // Only count truly unexpected failures (not duplicate key code 11000).
        if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000) {
          // BulkWriteError with only duplicate key errors — all non-dupes were inserted
        } else if (err && typeof err === 'object' && 'writeErrors' in err) {
          const writeErrors = (err as { writeErrors: { code: number }[] }).writeErrors || [];
          const realErrors = writeErrors.filter(e => e.code !== 11000);
          if (realErrors.length > 0) {
            this.updateProgress({
              errors: this.progress.errors + realErrors.length,
              message: `${realErrors.length} insert errors in batch`,
            });
          }
        } else {
          // Unexpected error — count entire batch as errors
          this.updateProgress({
            errors: this.progress.errors + currentBatch.length,
            message: `Batch insert failed: ${(err as Error).message}`,
          });
          return;
        }
      }

      // Update existingIds and emit progress for each saved post
      let batchMediaCount = 0;
      let lastItem: typeof currentBatch[0] | undefined;
      for (const item of currentBatch) {
        existingIds.add(item.doc.telegramId);
        batchMediaCount += item.mediaCount;
        lastItem = item;
      }

      this.updateProgress({
        totalSaved: this.progress.totalSaved + currentBatch.length,
        mediaDownloaded: this.progress.mediaDownloaded + batchMediaCount,
        message: `Phase 1: Saved batch of ${currentBatch.length} posts`,
        ...(lastItem ? {
          lastPost: {
            id: lastItem.messageId,
            text: lastItem.text,
            date: lastItem.dateStr,
            mediaCount: lastItem.mediaCount,
          },
        } : {}),
      });
    };

    try {
      for await (const message of client.iterMessages(channel, iterOpts)) {
        if (this._pauseRequested) {
          this.pauseResumeMinId = message.id;
          await flushBatch();
          break;
        }

        // Stop if message is older than the `since` threshold
        if (since && message.date * 1000 < since.getTime()) {
          console.log(`[Archive] Reached time limit (${since.toISOString()}), stopping.`);
          await flushBatch();
          break;
        }

        // Use pre-loaded Set instead of N+1 findOne queries
        if (!existingIds.has(message.id)) {
          try {
            // Phase 1: Extract metadata only — no downloads
            const media = extractMediaMetadata(message, channel);
            // Count items that were already on disk (downloaded: true)
            const mediaCount = media.filter(m => m.downloaded).length;
            const hasUndownloadedMedia = media.some(m => !m.downloaded);

            batch.push({
              doc: {
                telegramId: message.id,
                channelId: channel,
                text: message.message || '',
                entities: message.entities || [],
                media,
                stats: {
                  views: message.views || 0,
                  reactions: this.processReactions(message.reactions),
                },
                date: new Date(message.date * 1000),
                mediaDownloadFailed: hasUndownloadedMedia,
              },
              mediaCount,
              messageId: message.id,
              text: message.message || '',
              dateStr: new Date(message.date * 1000).toISOString(),
            });

            if (batch.length >= BATCH_SIZE) {
              await flushBatch();
            }
          } catch (err) {
            this.updateProgress({
              errors: this.progress.errors + 1,
              message: `Error on post #${message.id}: ${(err as Error).message}`,
            });
          }
        }

        this.updateProgress({
          totalProcessed: this.progress.totalProcessed + 1,
        });
      }
    } finally {
      await flushBatch();
    }
  }

  /**
   * Phase 2: Download media files for posts that have undownloaded media.
   * Uses a concurrency semaphore (3 parallel downloads).
   */
  private async downloadPendingMedia(channel: string): Promise<void> {
    const allPendingPosts = await Post.find({
      channelId: channel,
      mediaDownloadFailed: true,
      'media.downloaded': false,
    });

    // Skip posts where all undownloaded items already have a permanent error
    const pendingPosts = allPendingPosts.filter(post => {
      const undownloaded = (post.media as MediaItem[]).filter(m => !m.downloaded);
      return undownloaded.some(m => !m.error);
    });

    if (pendingPosts.length === 0) {
      const skipped = allPendingPosts.length;
      console.log(`[Archive] Phase 2: No pending media to download${skipped > 0 ? ` (${skipped} posts skipped with permanent errors)` : ''}`);
      return;
    }

    this.updateProgress({
      message: `Phase 2: Downloading media... (${pendingPosts.length} posts with media${allPendingPosts.length > pendingPosts.length ? `, ${allPendingPosts.length - pendingPosts.length} skipped` : ''})`,
    });
    console.log(`[Archive] Phase 2: Downloading media for ${pendingPosts.length} posts`);

    const client = this.client as unknown as GramJSClient;
    const CONCURRENCY = 3;
    let downloadedTotal = 0;
    let processedCount = 0;

    const queue = [...pendingPosts];

    const processOne = async (): Promise<void> => {
      while (queue.length > 0) {
        if (this._pauseRequested) break;

        const post = queue.shift()!;
        try {
          const { media, newDownloads } = await downloadPostMedia(
            { telegramId: post.telegramId, channelId: post.channelId, media: post.media as MediaItem[] },
            client,
            channel,
          );

          const hasFailedMedia = media.some(m => !m.downloaded);
          post.media = media as typeof post.media;
          post.mediaDownloadFailed = hasFailedMedia;
          await post.save();

          downloadedTotal += newDownloads;
          processedCount++;

          if (newDownloads > 0) {
            this.updateProgress({
              mediaDownloaded: this.progress.mediaDownloaded + newDownloads,
              message: `Phase 2: Downloading media... (${processedCount}/${pendingPosts.length} posts)`,
            });
          }
        } catch (err) {
          console.error(`[Archive] Phase 2 error on post #${post.telegramId}:`, (err as Error).message);
          this.updateProgress({
            errors: this.progress.errors + 1,
          });
        }
      }
    };

    // Launch CONCURRENCY workers
    const workers: Promise<void>[] = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      workers.push(processOne());
    }
    await Promise.all(workers);

    console.log(`[Archive] Phase 2 complete: ${downloadedTotal} media files downloaded`);
    this.updateProgress({
      message: `Phase 2 complete: ${downloadedTotal} media files downloaded`,
    });
  }

  /**
   * Retry media downloads for posts where media previously failed.
   * Fetches messages in batches of up to 100 IDs per API call.
   */
  private async retryFailedMedia(channel: string): Promise<void> {
    const failedPosts = await Post.find({ channelId: channel, mediaDownloadFailed: true });
    if (failedPosts.length === 0) return;

    // Filter out posts where ALL undownloaded items already have a permanent error
    // (e.g. DC redirect). No point retrying those.
    const retryablePosts = failedPosts.filter(post => {
      const undownloaded = (post.media as MediaItem[]).filter(m => !m.downloaded);
      return undownloaded.some(m => !m.error);
    });

    if (retryablePosts.length === 0) {
      console.log(`[Archive] All ${failedPosts.length} failed posts have permanent errors, skipping retry`);
      return;
    }

    console.log(`[Archive] Retrying media for ${retryablePosts.length} posts (${failedPosts.length - retryablePosts.length} skipped with permanent errors)`);
    this.updateProgress({ message: `Retrying media for ${retryablePosts.length} posts...` });

    const client = this.client as unknown as GramJSClient;
    const BATCH_SIZE = 100;

    // Build a map of telegramId -> post document for quick lookup
    const postMap = new Map(retryablePosts.map(p => [p.telegramId, p]));

    // Batch fetch message IDs in groups of BATCH_SIZE
    const allIds = retryablePosts.map(p => p.telegramId);

    for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
      if (this._pauseRequested) break;

      const batchIds = allIds.slice(i, i + BATCH_SIZE);

      try {
        const messages = await client.getMessages(channel, { ids: batchIds });

        for (const foundMessage of messages) {
          if (!foundMessage) continue;
          if (this._pauseRequested) break;

          const post = postMap.get(foundMessage.id);
          if (!post) continue;

          try {
            const media = await processMedia(foundMessage, client, channel);
            const mediaCount = media.filter(m => m.downloaded).length;
            const hasFailedMedia = media.some(m => !m.downloaded);

            post.media = media as typeof post.media;
            post.mediaDownloadFailed = hasFailedMedia;
            await post.save();

            if (!hasFailedMedia) {
              this.updateProgress({
                mediaDownloaded: this.progress.mediaDownloaded + mediaCount,
                message: `Retried media for post #${post.telegramId}`,
              });
            }
          } catch (err) {
            console.error(`[Archive] Media retry failed for post #${post.telegramId}:`, (err as Error).message);
          }
        }
      } catch (err) {
        console.error(`[Archive] Batch message fetch failed for IDs ${batchIds[0]}-${batchIds[batchIds.length - 1]}:`, (err as Error).message);
      }
    }
  }

  async getHistory(): Promise<ChannelStats[]> {
    const channels = await Post.aggregate([
      {
        $group: {
          _id: '$channelId',
          postCount: { $sum: 1 },
          mediaCount: { $sum: { $size: '$media' } },
          firstPost: { $min: '$date' },
          lastPost: { $max: '$date' },
          totalViews: { $sum: '$stats.views' },
        },
      },
      { $sort: { lastPost: -1 } },
    ]);

    return channels.map((c: Record<string, unknown>) => ({
      channelId: c._id as string,
      postCount: c.postCount as number,
      mediaCount: c.mediaCount as number,
      firstPost: c.firstPost as Date | null,
      lastPost: c.lastPost as Date | null,
      totalViews: c.totalViews as number,
    }));
  }

  async getPosts(channel: string, page: number = 1, limit: number = 20) {
    const skip = (page - 1) * limit;
    const [posts, total] = await Promise.all([
      Post.find({ channelId: channel })
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Post.countDocuments({ channelId: channel }),
    ]);
    return { posts, total, page, pages: Math.ceil(total / limit) };
  }
}

export const archiveService = new ArchiveService();
