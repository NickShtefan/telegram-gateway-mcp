import fs from 'fs';
import path from 'path';
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import { archiveService } from './archiveService.js';
import { clientManager } from './clientManager.js';
import { analyzeChannel } from './analyzeChannel.js';
import { channelLocks } from './refreshService.js';
import { getChannelUsername, getChannelFullInfo } from './telegramUtils.js';
import { ROOT_DIR } from '../config/paths.js';
import { presetToDate, DEPTH_PRESETS } from 'channel-scope-shared';
import type { DepthPreset } from 'channel-scope-shared';
import ResearchChannel from '../db/models/ResearchChannel.js';
import Post from '../db/models/Post.js';
import processMedia from '../telegram/processors/processMediaClient.js';
import { processReactionsFromGramJS } from '../telegram/processors/processReactions.js';
import type { GramJSClient } from '../types/index.js';

/**
 * Fetch channel description and avatar from Telegram, update the ResearchChannel record.
 * Runs once during the download flow (Phase 0) so the UI shows real metadata immediately.
 */
async function enrichResearchChannel(
  researchChannelId: string,
  archiveTarget: string,
  telegramClient: TelegramClient,
): Promise<void> {
  try {
    const entity = await telegramClient.getEntity(archiveTarget);
    if (!(entity instanceof Api.Channel)) return;

    const { description, linkedGroup, subscriberCount } = await getChannelFullInfo(entity, null, telegramClient);

    const update: Record<string, unknown> = {};
    if (description) update.description = description;
    if (linkedGroup) update.linkedGroup = linkedGroup;
    if (subscriberCount > 0) update.subscriberCount = subscriberCount;

    // Download avatar
    try {
      if (entity.photo && entity.photo.className === 'ChatPhoto') {
        const username = getChannelUsername(entity);
        const avatarId = username || entity.id.toString();
        const avatarDir = path.join(ROOT_DIR, 'data', 'avatars');
        if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir, { recursive: true });
        const avatarPath = path.join(avatarDir, `${avatarId}.jpg`);
        if (fs.existsSync(avatarPath)) {
          update.hasAvatar = true;
        } else {
          const buffer = await telegramClient.downloadProfilePhoto(entity);
          if (buffer && Buffer.byteLength(buffer) > 0) {
            await fs.promises.writeFile(avatarPath, buffer);
            update.hasAvatar = true;
          }
        }
      }
    } catch (err) {
      console.warn('[Research] Avatar download failed:', (err as Error).message);
    }

    if (Object.keys(update).length > 0) {
      await ResearchChannel.findByIdAndUpdate(researchChannelId, update);
      console.log(`[Research] Enriched ${archiveTarget}: ${Object.keys(update).join(', ')}`);
    }
  } catch (err) {
    console.warn('[Research] Enrichment failed (non-fatal):', (err as Error).message);
  }
}

// --- Auto-queue state ---
let autoQueueActive = false;
let autoQueuePreset: DepthPreset = '3m';
let autoQueueSkipMedia = true;

/** Stop the auto-queue after the current download finishes. */
export function stopAutoQueue(): void {
  autoQueueActive = false;
  console.log('[Research] Auto-queue stopped');
}

/** Check if auto-queue is currently active. */
export function isAutoQueueActive(): boolean {
  return autoQueueActive;
}

/**
 * Start downloading all `discovered` research channels sequentially.
 * Triggers the first one; auto-continue in startResearchDownload handles the rest.
 */
export async function startDownloadAll(preset: DepthPreset = '3m', skipMedia = true): Promise<{ ok: true; message: string }> {
  const next = await ResearchChannel.findOne({ status: 'discovered' }).sort({ createdAt: 1 });
  if (!next) {
    return { ok: true, message: 'No discovered channels to download' };
  }

  autoQueueActive = true;
  autoQueuePreset = preset;
  autoQueueSkipMedia = skipMedia;
  const result = await startResearchDownload(next._id.toString(), preset, skipMedia);
  return { ok: true, message: `Auto-queue started. ${result.message}` };
}

/**
 * Called after a research download completes successfully.
 * If auto-queue is active, picks the next discovered channel and starts it.
 */
async function continueAutoQueue(): Promise<void> {
  if (!autoQueueActive) return;

  const next = await ResearchChannel.findOne({ status: 'discovered' }).sort({ createdAt: 1 });
  if (!next) {
    autoQueueActive = false;
    console.log('[Research] Auto-queue complete — no more discovered channels');
    return;
  }

  console.log(`[Research] Auto-queue: starting next channel ${next.channelId}`);
  try {
    await startResearchDownload(next._id.toString(), autoQueuePreset, autoQueueSkipMedia);
  } catch (err) {
    console.error('[Research] Auto-queue: failed to start next channel:', (err as Error).message);
    autoQueueActive = false;
  }
}

export async function startResearchDownload(
  researchChannelId: string,
  preset: DepthPreset = '3m',
  skipMedia = true,
): Promise<{ ok: true; message: string }> {
  const channel = await ResearchChannel.findById(researchChannelId);
  if (!channel) {
    throw Object.assign(new Error('Research channel not found'), { statusCode: 404 });
  }

  const progress = archiveService.getProgress();
  if (['downloading', 'paused'].includes(progress.status)) {
    throw Object.assign(new Error('Archive already in progress'), { statusCode: 409 });
  }

  const telegramClient = await clientManager.getFirstActiveClient();
  if (!telegramClient) {
    throw Object.assign(new Error('No connected Telegram accounts. Add an account in Accounts page first.'), { statusCode: 400 });
  }

  // Convert preset to since date (undefined for 'all')
  const since = presetToDate(preset);

  await ResearchChannel.findByIdAndUpdate(researchChannelId, { status: 'downloading' });

  // Resolve entity: prefer username, for numeric IDs search by title to cache entity
  let archiveTarget = channel.username || channel.channelId;
  if (!channel.username && /^\d+$/.test(channel.channelId)) {
    try {
      const searchResult = await telegramClient.invoke(new Api.contacts.Search({
        q: channel.title, limit: 10,
      }));
      const found = searchResult.chats.find(
        (c: { id?: { toString: () => string } }) => c.id?.toString() === channel.channelId,
      );
      if (found && 'username' in found && (found as Api.Channel).username) {
        archiveTarget = (found as Api.Channel).username!;
        await ResearchChannel.findByIdAndUpdate(researchChannelId, { username: archiveTarget });
      }
    } catch (searchErr) {
      console.warn(`[Research] Could not resolve channel by search:`, (searchErr as Error).message);
    }
  }

  // Phase 0: Enrich channel metadata (description + avatar) before downloading posts
  await enrichResearchChannel(researchChannelId, archiveTarget, telegramClient);

  // Time-based download: no downloadLimit, only since date
  archiveService.startArchive(archiveTarget, undefined, telegramClient, since, skipMedia).then(async () => {
    // Check if archive was paused rather than completed — don't finalize
    const finalProgress = archiveService.getProgress();
    if (finalProgress.status === 'paused') {
      console.log(`[Research] Archive paused for ${channel.channelId}, skipping finalization`);
      await ResearchChannel.findByIdAndUpdate(researchChannelId, { status: 'downloading' });
      return;
    }

    const history = await archiveService.getHistory();
    const stats = history.find(h => h.channelId === archiveTarget);
    if (stats) {
      await ResearchChannel.findByIdAndUpdate(researchChannelId, {
        status: 'downloaded',
        postsCount: stats.postCount,
        avgViews: stats.postCount > 0 ? Math.round(stats.totalViews / stats.postCount) : 0,
      });
    } else {
      await ResearchChannel.findByIdAndUpdate(researchChannelId, { status: 'downloaded' });
    }
    try {
      const analytics = await analyzeChannel(researchChannelId);
      console.log(`[Research] Auto-analyzed ${channel.channelId}`);

      // Save analysis depth and push to history
      const score = analytics?.score?.total ?? 0;
      await ResearchChannel.findByIdAndUpdate(researchChannelId, {
        analysisDepth: preset,
        $push: {
          analysisHistory: {
            depth: preset,
            analyzedAt: new Date(),
            score,
          },
        },
      });
    } catch (analyzeErr) {
      console.error(`[Research] Auto-analyze failed for ${channel.channelId}:`, analyzeErr);
    }
    // Auto-queue: trigger next discovered channel if queue is active
    await continueAutoQueue();
  }).catch(async (err) => {
    console.error('Research download failed:', err);
    await ResearchChannel.findByIdAndUpdate(researchChannelId, { status: 'discovered' });
  });

  return { ok: true, message: `Download started for ${channel.channelId} (depth: ${preset})` };
}

/**
 * Incremental update: fetch only new posts (with telegramId > highest existing)
 * for a research channel that has already been downloaded.
 */
export async function updateChannel(
  researchChannelId: string,
): Promise<{ ok: true; newPosts: number }> {
  const channel = await ResearchChannel.findById(researchChannelId);
  if (!channel) {
    throw Object.assign(new Error('Research channel not found'), { statusCode: 404 });
  }

  const archiveTarget = channel.username || channel.channelId;

  // Acquire channel lock
  if (channelLocks.get(archiveTarget)) {
    throw Object.assign(new Error('Update already in progress for this channel'), { statusCode: 409 });
  }
  channelLocks.set(archiveTarget, true);

  try {
    const progress = archiveService.getProgress();
    if (['downloading', 'paused'].includes(progress.status)) {
      throw Object.assign(new Error('Archive already in progress'), { statusCode: 409 });
    }

    const telegramClient = await clientManager.getFirstActiveClient();
    if (!telegramClient) {
      throw Object.assign(new Error('No connected Telegram accounts'), { statusCode: 400 });
    }

    // Find the highest telegramId already in DB for this channel
    const lookupIds = [channel.channelId];
    if (channel.username) lookupIds.push(channel.username);

    const latestPost = await Post.findOne({ channelId: { $in: lookupIds } })
      .sort({ telegramId: -1 })
      .select('telegramId')
      .lean();

    const minId = latestPost ? latestPost.telegramId : 0;
    console.log(`[Research] Incremental update for ${archiveTarget}, minId=${minId}`);

    const client = telegramClient as unknown as GramJSClient;

    let newPosts = 0;
    let batch: InstanceType<typeof Post>[] = [];
    const BATCH_SIZE = 20;

    for await (const message of client.iterMessages(archiveTarget, { chunkSize: 20, minId })) {
      // Skip if already exists (minId is exclusive in GramJS but be safe)
      if (message.id <= minId) continue;

      const media = await processMedia(message, client, archiveTarget);
      const hasFailedMedia = media.some(m => !m.downloaded);

      batch.push(new Post({
        telegramId: message.id,
        channelId: archiveTarget,
        text: message.message || '',
        entities: message.entities || [],
        media,
        stats: {
          views: message.views || 0,
          reactions: processReactionsFromGramJS(message.reactions),
          viewsHistory: [],
        },
        date: new Date(message.date * 1000),
        mediaDownloadFailed: hasFailedMedia,
      }));

      if (batch.length >= BATCH_SIZE) {
        try {
          const result = await Post.insertMany(batch, { ordered: false });
          newPosts += result.length;
        } catch (err) {
          // insertMany with ordered:false throws but still inserts non-duplicates
          if ((err as { code?: number }).code === 11000) {
            newPosts += (err as { insertedDocs?: unknown[] }).insertedDocs?.length ?? 0;
          } else {
            console.error(`[Research] Error saving batch:`, (err as Error).message);
          }
        }
        batch = [];
      }
    }

    // Flush remaining batch
    if (batch.length > 0) {
      try {
        const result = await Post.insertMany(batch, { ordered: false });
        newPosts += result.length;
      } catch (err) {
        if ((err as { code?: number }).code === 11000) {
          newPosts += (err as { insertedDocs?: unknown[] }).insertedDocs?.length ?? 0;
        } else {
          console.error(`[Research] Error saving final batch:`, (err as Error).message);
        }
      }
    }

    // Update ResearchChannel stats
    const highestPost = await Post.findOne({ channelId: { $in: lookupIds } })
      .sort({ telegramId: -1 })
      .select('telegramId')
      .lean();

    const totalPosts = await Post.countDocuments({ channelId: { $in: lookupIds } });
    const viewsAgg = await Post.aggregate([
      { $match: { channelId: { $in: lookupIds } } },
      { $group: { _id: null, totalViews: { $sum: '$stats.views' } } },
    ]);
    const totalViews = viewsAgg.length > 0 ? (viewsAgg[0].totalViews as number) : 0;

    await ResearchChannel.findByIdAndUpdate(researchChannelId, {
      lastUpdatedAt: new Date(),
      lastSyncPostId: highestPost?.telegramId ?? null,
      postsCount: totalPosts,
      avgViews: totalPosts > 0 ? Math.round(totalViews / totalPosts) : 0,
    });

    // Re-analyze after incremental update
    try {
      await analyzeChannel(researchChannelId);
      console.log(`[Research] Re-analyzed ${channel.channelId} after incremental update`);
    } catch (analyzeErr) {
      console.error(`[Research] Re-analyze failed for ${channel.channelId}:`, analyzeErr);
    }

    console.log(`[Research] Incremental update complete: ${newPosts} new posts for ${archiveTarget}`);
    return { ok: true, newPosts };
  } finally {
    channelLocks.delete(archiveTarget);
  }
}
