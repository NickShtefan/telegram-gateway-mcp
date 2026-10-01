import { Api } from 'telegram';
import Post from '../db/models/Post.js';
import ResearchChannel from '../db/models/ResearchChannel.js';
import { clientManager } from './clientManager.js';
import { processReactionsFromGramJS } from '../telegram/processors/processReactions.js';
import type { GramJSReactionResult } from '../types/index.js';

const BATCH_SIZE = 100;
const BATCH_DELAY_MS = 2000;
const MAX_REFRESH_LIMIT = 500;

/** In-memory lock per channelId to prevent concurrent operations. */
const channelLocks = new Map<string, boolean>();

/**
 * Refresh views and reactions for the most recent posts in a channel.
 * Appends current views to viewsHistory before updating.
 */
export async function refreshViewsAndReactions(
  channelId: string,
  limit: number = 100,
): Promise<{ updated: number }> {
  // Cap the limit
  const effectiveLimit = Math.min(limit, MAX_REFRESH_LIMIT);

  // Acquire channel lock
  if (channelLocks.get(channelId)) {
    throw Object.assign(new Error('Refresh already in progress for this channel'), { statusCode: 409 });
  }
  channelLocks.set(channelId, true);

  try {
    const telegramClient = await clientManager.getFirstActiveClient();
    if (!telegramClient) {
      throw Object.assign(new Error('No connected Telegram accounts'), { statusCode: 400 });
    }

    // Use lookupIds for DB queries (search by both channelId and username)
    const researchChannel = await ResearchChannel.findOne({
      $or: [{ channelId }, { username: channelId }],
    });
    const lookupIds = [channelId];
    if (researchChannel) {
      if (researchChannel.username && !lookupIds.includes(researchChannel.username)) {
        lookupIds.push(researchChannel.username);
      }
      if (researchChannel.channelId && !lookupIds.includes(researchChannel.channelId)) {
        lookupIds.push(researchChannel.channelId);
      }
    }

    // Get the last N posts from DB
    const posts = await Post.find({ channelId: { $in: lookupIds } })
      .sort({ telegramId: -1 })
      .limit(effectiveLimit)
      .select('telegramId stats.views')
      .lean();

    if (posts.length === 0) {
      return { updated: 0 };
    }

    // O(1) lookup map instead of .find()
    const postsMap = new Map(posts.map(p => [p.telegramId, p]));
    const telegramIds = posts.map(p => p.telegramId);
    let updated = 0;
    const now = new Date();

    const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

    // Resolve the channel entity for Api.channels.GetMessages
    const channelEntity = await telegramClient.getInputEntity(channelId);

    // Process in batches of BATCH_SIZE (GramJS getMessages supports up to 100 per call)
    for (let i = 0; i < telegramIds.length; i += BATCH_SIZE) {
      const batch = telegramIds.slice(i, i + BATCH_SIZE);

      try {
        const result = await telegramClient.invoke(
          new Api.channels.GetMessages({
            channel: channelEntity,
            id: batch.map(id => new Api.InputMessageID({ id })),
          })
        ) as { messages?: Array<{ id: number; views?: number; reactions?: { results?: GramJSReactionResult[] } }> };

        const messages = result.messages || [];

        for (const msg of messages) {
          if (!msg || typeof msg.id !== 'number') continue;

          const currentPost = postsMap.get(msg.id);
          const currentViews = currentPost?.stats?.views ?? 0;
          const newViews = typeof msg.views === 'number' ? msg.views : currentViews;
          const newReactions = processReactionsFromGramJS(msg.reactions);

          const updateOp: Record<string, unknown> = {
            'stats.views': newViews,
            'stats.reactions': newReactions,
          };

          // Always record a history entry when refreshing; cap viewsHistory at 90 entries
          const dbResult = await Post.updateOne(
            { telegramId: msg.id, channelId: { $in: lookupIds } },
            {
              $set: updateOp,
              $push: {
                'stats.viewsHistory': {
                  $each: [{ date: now, views: newViews }],
                  $slice: -90,
                },
              },
            },
          );
          if (dbResult.modifiedCount > 0) updated++;
        }
      } catch (err) {
        console.error(`[RefreshService] Error fetching batch for ${channelId}:`, err);
      }

      if (i + BATCH_SIZE < telegramIds.length) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    console.log(`[RefreshService] Refreshed ${updated} posts for ${channelId}`);
    return { updated };
  } finally {
    channelLocks.delete(channelId);
  }
}

/** Expose the lock map so researchService can share it. */
export { channelLocks };
