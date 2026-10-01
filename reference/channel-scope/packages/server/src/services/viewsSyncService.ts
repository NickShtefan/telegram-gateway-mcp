import { Api } from 'telegram';
import Post from '../db/models/Post.js';
import Channel from '../db/models/Channel.js';
import { clientManager } from './clientManager.js';

const TIER_HOT_HOURS = 24;
const TIER_WARM_DAYS = 7;
const TIER_COOL_DAYS = 30;
const TIER_COLD_DAYS = 90;

const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 2000;

export interface SyncStatus {
  syncRunCount: number;
  lastSyncDate: Date | null;
  tierCounts: {
    hot: number;
    warm: number;
    cool: number;
    cold: number;
  };
}

export class ViewsSyncService {
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private shouldSyncTier(tier: 'hot' | 'warm' | 'cool' | 'cold', syncRunCount: number): boolean {
    switch (tier) {
      case 'hot':
      case 'warm':
        return true; // every run
      case 'cool':
        return syncRunCount % 3 === 0;
      case 'cold':
        return syncRunCount % 10 === 0;
    }
  }

  private getDateCutoffs(now: Date) {
    const msPerHour = 3600 * 1000;
    const msPerDay = 24 * msPerHour;
    return {
      hotStart: new Date(now.getTime() - TIER_HOT_HOURS * msPerHour),
      warmStart: new Date(now.getTime() - TIER_WARM_DAYS * msPerDay),
      coolStart: new Date(now.getTime() - TIER_COOL_DAYS * msPerDay),
      coldStart: new Date(now.getTime() - TIER_COLD_DAYS * msPerDay),
    };
  }

  async syncChannel(channelId: string, clientId: string): Promise<void> {
    const channel = await Channel.findOne({ channelId });
    if (!channel) throw new Error(`Channel not found: ${channelId}`);
    if (!channel.settings.viewsSync.enabled) return;

    const newSyncRunCount = (channel.settings.viewsSync.syncRunCount || 0) + 1;
    const now = new Date();
    const { hotStart, warmStart, coolStart, coldStart } = this.getDateCutoffs(now);

    // Update syncRunCount immediately
    await Channel.findByIdAndUpdate(channel._id, {
      'settings.viewsSync.syncRunCount': newSyncRunCount,
      'stats.lastViewsSyncDate': now,
    });

    const client = await clientManager.getClient(clientId);

    // Collect post IDs per tier
    const postIdSets: number[][] = [];

    // Hot + Warm: every run
    const hotWarmPosts = await Post.find({
      channelId,
      date: { $gte: warmStart },
    }).select('telegramId').sort({ date: -1 }).limit(500).lean();
    if (hotWarmPosts.length > 0) {
      postIdSets.push(hotWarmPosts.map(p => p.telegramId));
    }

    // Cool: every 3rd run
    if (this.shouldSyncTier('cool', newSyncRunCount)) {
      const coolPosts = await Post.find({
        channelId,
        date: { $gte: coolStart, $lt: warmStart },
      }).select('telegramId').sort({ date: -1 }).limit(50).lean();
      if (coolPosts.length > 0) {
        postIdSets.push(coolPosts.map(p => p.telegramId));
      }
    }

    // Cold: every 10th run
    if (this.shouldSyncTier('cold', newSyncRunCount)) {
      const coldPosts = await Post.find({
        channelId,
        date: { $gte: coldStart, $lt: coolStart },
      }).select('telegramId').sort({ date: -1 }).limit(20).lean();
      if (coldPosts.length > 0) {
        postIdSets.push(coldPosts.map(p => p.telegramId));
      }
    }

    // Flatten and deduplicate
    const allIds = [...new Set(postIdSets.flat())];
    if (allIds.length === 0) return;

    // Process in batches
    for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
      const batch = allIds.slice(i, i + BATCH_SIZE);
      try {
        const result = await client.invoke(
          new Api.messages.GetMessages({
            id: batch.map(id => new Api.InputMessageID({ id })),
          })
        ) as { messages?: Array<{ id: number; views?: number }> };

        const messages = result.messages || [];
        await Promise.all(
          messages.map(async (msg) => {
            if (msg && typeof msg.id === 'number' && typeof msg.views === 'number') {
              await Post.updateOne(
                { telegramId: msg.id, channelId },
                { 'stats.views': msg.views }
              );
            }
          })
        );
      } catch (err) {
        console.error(`[ViewsSync] Error fetching batch for ${channelId}:`, err);
      }

      if (i + BATCH_SIZE < allIds.length) {
        await this.sleep(BATCH_DELAY_MS);
      }
    }
  }

  async getSyncStatus(channelId: string): Promise<SyncStatus> {
    const channel = await Channel.findOne({ channelId });
    if (!channel) throw new Error(`Channel not found: ${channelId}`);

    const now = new Date();
    const { hotStart, warmStart, coolStart, coldStart } = this.getDateCutoffs(now);

    const [hotCount, warmCount, coolCount, coldCount] = await Promise.all([
      Post.countDocuments({ channelId, date: { $gte: hotStart } }),
      Post.countDocuments({ channelId, date: { $gte: warmStart, $lt: hotStart } }),
      Post.countDocuments({ channelId, date: { $gte: coolStart, $lt: warmStart } }),
      Post.countDocuments({ channelId, date: { $gte: coldStart, $lt: coolStart } }),
    ]);

    return {
      syncRunCount: channel.settings.viewsSync.syncRunCount || 0,
      lastSyncDate: channel.stats.lastViewsSyncDate || null,
      tierCounts: {
        hot: hotCount,
        warm: warmCount,
        cool: coolCount,
        cold: coldCount,
      },
    };
  }
}

export const viewsSyncService = new ViewsSyncService();
