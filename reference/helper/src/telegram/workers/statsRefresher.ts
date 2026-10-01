import { Api } from 'telegram';
import Post from '../../db/models/Post.js';
import { getGramClient, resolvePeer } from '../client/gramClient.js';
import { getNextRefreshAt } from './ageTiers.js';
import config from '../../config/telegram.js';
import {
  envNumber,
  sleep,
  StageTimeoutError,
  runStage,
  getFloodWaitSeconds,
  isChannelInvalid,
  processGramReactions,
} from './refreshShared.js';
import type { GramJSReactions } from '../../types/index.js';

const DEFAULT_TICK_MS = 5 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 100; // MTProto GetMessages limit
const DEFAULT_CUTOFF_DAYS = 30;
const DEFAULT_GRAM_TIMEOUT_MS = 30 * 1000;
const DEFAULT_FLOOD_WAIT_MAX_S = 5 * 60;
const DEFAULT_STUCK_TICKS_WARN = 3;

const TAG = '[StatsRefresher]';

let tickTimer: NodeJS.Timeout | null = null;
let tickInFlight = false;
let tickStartedAt: number | null = null;
let skippedTicksInARow = 0;

// Общие хелперы (envNumber, withTimeout, FLOOD_WAIT-парсинг, нормализация
// реакций) вынесены в refreshShared.ts — их использует и CommentsRefresher.
const processReactions = processGramReactions;

interface PostLite {
  telegramId: number;
  channelId: string;
  date: Date;
  discussion?: {
    commentsCount?: number;
    lastCommentsRefreshedAt?: Date | null;
  };
}

interface GramMessageLike {
  className: string;
  id: number;
  date: number;
  views?: number;
  reactions?: GramJSReactions;
  replies?: { replies?: number; comments?: boolean };
}

// ─── core ───────────────────────────────────────────────────────────────────

/**
 * Один запрос GetMessages для канала + апдейт всех постов батча.
 * Возвращает счётчики для суммарного логирования.
 */
async function refreshChannelBatch(
  channelId: string,
  posts: PostLite[]
): Promise<{ viewsUpdated: number; reactionsUpdated: number; skipped: number }> {
  const client = getGramClient();
  const gramTimeoutMs = envNumber('STATS_REFRESH_GRAM_TIMEOUT_MS', DEFAULT_GRAM_TIMEOUT_MS);
  const label = `channel ${channelId} (${posts.length} posts)`;

  let peer: Api.TypeInputPeer;
  try {
    peer = await runStage(TAG, 'resolvePeer', label, gramTimeoutMs, () =>
      resolvePeer(channelId)
    );
  } catch (err) {
    if (err instanceof StageTimeoutError) {
      return { viewsUpdated: 0, reactionsUpdated: 0, skipped: posts.length };
    }
    throw err;
  }

  const ids = posts.map(p => new Api.InputMessageID({ id: p.telegramId }));

  const doCall = (stage: string): Promise<unknown> =>
    runStage(TAG, stage, label, gramTimeoutMs, () =>
      client.invoke(new Api.channels.GetMessages({ channel: peer, id: ids }))
    );

  let res: unknown;
  try {
    res = await doCall('GetMessages');
  } catch (err) {
    if (err instanceof StageTimeoutError) {
      return { viewsUpdated: 0, reactionsUpdated: 0, skipped: posts.length };
    }
    const wait = getFloodWaitSeconds(err);
    if (wait !== null) {
      const maxWait = envNumber('STATS_REFRESH_FLOOD_WAIT_MAX_S', DEFAULT_FLOOD_WAIT_MAX_S);
      if (wait > maxWait) {
        console.warn(
          `[StatsRefresher] FLOOD_WAIT ${wait}s exceeds cap ${maxWait}s on channel ${channelId}, skipping batch (${posts.length} posts)`
        );
        return { viewsUpdated: 0, reactionsUpdated: 0, skipped: posts.length };
      }
      console.warn(`[StatsRefresher] FLOOD_WAIT ${wait}s on channel ${channelId}, retrying once`);
      await sleep(wait * 1000);
      try {
        res = await doCall('GetMessages retry after FLOOD_WAIT');
      } catch (retryErr) {
        console.warn(
          `[StatsRefresher] retry after FLOOD_WAIT failed for ${channelId}:`,
          (retryErr as Error).message
        );
        return { viewsUpdated: 0, reactionsUpdated: 0, skipped: posts.length };
      }
    } else if (isChannelInvalid(err)) {
      console.warn(
        `[StatsRefresher] invalid channel ${channelId} (${(err as Error).message}), stopping refresh for ${posts.length} posts`
      );
      await Post.updateMany(
        { channelId, telegramId: { $in: posts.map(p => p.telegramId) } },
        { $set: { nextRefreshAt: null } }
      );
      return { viewsUpdated: 0, reactionsUpdated: 0, skipped: posts.length };
    } else {
      console.warn(
        `[StatsRefresher] GetMessages failed for ${channelId}:`,
        (err as Error).message
      );
      return { viewsUpdated: 0, reactionsUpdated: 0, skipped: posts.length };
    }
  }

  const messages = (res as { messages?: unknown[] } | null)?.messages ?? [];
  const postByTgId = new Map<number, PostLite>();
  for (const p of posts) postByTgId.set(p.telegramId, p);

  let viewsUpdated = 0;
  let reactionsUpdated = 0;
  let skipped = 0;
  const seen = new Set<number>();
  const now = new Date();

  for (const raw of messages) {
    const msg = raw as GramMessageLike;
    if (!msg || msg.className !== 'Message') {
      skipped++;
      continue;
    }
    const stored = postByTgId.get(msg.id);
    if (!stored) {
      skipped++;
      continue;
    }
    seen.add(msg.id);

    const views = typeof msg.views === 'number' ? msg.views : 0;
    const reactions = processReactions(msg.reactions);
    const postDate =
      stored.date instanceof Date
        ? stored.date
        : typeof msg.date === 'number'
          ? new Date(msg.date * 1000)
          : new Date();
    const nextRefreshAt = getNextRefreshAt(postDate, now);

    const updateSet: Record<string, unknown> = {
      'stats.views': views,
      'stats.reactions': reactions,
      'stats.lastRefreshedAt': now,
      nextRefreshAt,
    };

    // Связка с комментариями: message.replies.replies приходит в этом же
    // ответе бесплатно. Если счётчик разошёлся с кэшем — подтянуть сверку
    // треда воркером комментариев. Только для постов, уже прошедших первичный
    // бэкфилл (иначе очередь и так их держит).
    const repliesCount = msg.replies?.replies;
    if (
      config.comments.enabled &&
      typeof repliesCount === 'number' &&
      stored.discussion?.lastCommentsRefreshedAt != null &&
      repliesCount !== (stored.discussion.commentsCount ?? 0)
    ) {
      updateSet['discussion.nextCommentsRefreshAt'] = now;
    }

    try {
      await Post.updateOne(
        { telegramId: msg.id, channelId },
        { $set: updateSet }
      );
      if (views > 0) viewsUpdated++;
      if (reactions.length > 0) reactionsUpdated++;
    } catch (err) {
      console.warn(
        `[StatsRefresher] updateOne failed for ${channelId}#${msg.id}:`,
        (err as Error).message
      );
      skipped++;
    }
  }

  // Сообщения, которых Telegram не вернул (удалены на стороне канала и т.п.) —
  // просто переносим nextRefreshAt на следующий слот, чтобы не зациклиться.
  for (const p of posts) {
    if (seen.has(p.telegramId)) continue;
    skipped++;
    const nextRefreshAt = getNextRefreshAt(p.date, now);
    try {
      await Post.updateOne(
        { telegramId: p.telegramId, channelId },
        { $set: { nextRefreshAt } }
      );
    } catch (err) {
      console.warn(
        `[StatsRefresher] failed to advance nextRefreshAt for ${channelId}#${p.telegramId}:`,
        (err as Error).message
      );
    }
  }

  return { viewsUpdated, reactionsUpdated, skipped };
}

async function runTick(): Promise<void> {
  if (tickInFlight) {
    skippedTicksInARow++;
    const tickAgeSec =
      tickStartedAt === null ? 0 : Math.round((Date.now() - tickStartedAt) / 1000);
    const message = `[StatsRefresher] tick skipped: previous tick still running (${skippedTicksInARow} in a row, tick age ${tickAgeSec}s)`;
    const warnAfter = envNumber('STATS_REFRESH_STUCK_TICKS_WARN', DEFAULT_STUCK_TICKS_WARN);
    if (skippedTicksInARow >= warnAfter) {
      console.error(`${message} — worker looks stuck, check GramJS/network connectivity`);
    } else {
      console.info(message);
    }
    return;
  }
  tickInFlight = true;
  tickStartedAt = Date.now();
  skippedTicksInARow = 0;

  try {
    const batchSize = envNumber('STATS_REFRESH_BATCH_SIZE', DEFAULT_BATCH_SIZE);
    const cutoffDays = envNumber('STATS_REFRESH_CUTOFF_DAYS', DEFAULT_CUTOFF_DAYS);
    const now = new Date();
    const cutoff = new Date(now.getTime() - cutoffDays * 24 * 60 * 60 * 1000);

    // Backfill-aware query: pick up any post still due for refresh, including
    // old ones that have never been refreshed (initial deploy on a long-running
    // archive). After the first refresh, `stats.lastRefreshedAt` is set; if the
    // post is also past the 30-day cutoff it stops matching either branch of
    // the $or and the age-tier logic sets nextRefreshAt=null, parking it.
    const candidates = (await Post.find({
      nextRefreshAt: { $ne: null, $lte: now },
      $or: [
        { date: { $gte: cutoff } },
        { 'stats.lastRefreshedAt': { $exists: false } },
      ],
    })
      .limit(batchSize)
      .lean()) as unknown as PostLite[];

    const byChannel = new Map<string, PostLite[]>();
    for (const p of candidates) {
      if (!p.channelId) continue;
      const arr = byChannel.get(p.channelId);
      if (arr) arr.push(p);
      else byChannel.set(p.channelId, [p]);
    }

    console.info(
      `[StatsRefresher] tick: ${candidates.length} candidates across ${byChannel.size} channels`
    );
    if (candidates.length === 0) return;

    let totalViews = 0;
    let totalReactions = 0;
    let totalSkipped = 0;

    for (const [channelId, posts] of byChannel) {
      try {
        const { viewsUpdated, reactionsUpdated, skipped } = await refreshChannelBatch(
          channelId,
          posts
        );
        totalViews += viewsUpdated;
        totalReactions += reactionsUpdated;
        totalSkipped += skipped;
      } catch (err) {
        console.warn(
          `[StatsRefresher] channel ${channelId} failed:`,
          (err as Error).message
        );
        totalSkipped += posts.length;
      }
    }

    console.info(
      `[StatsRefresher] updated ${totalViews} views, ${totalReactions} reactions, skipped ${totalSkipped}`
    );
  } catch (err) {
    console.warn('[StatsRefresher] tick failed:', (err as Error).message);
  } finally {
    tickInFlight = false;
    tickStartedAt = null;
  }
}

/**
 * Бэкфилл nextRefreshAt для постов, сохранённых ДО этого воркера.
 * Запускается один раз при старте. Выставляет now(), чтобы попали в ближайший tick.
 */
async function runInitMigration(): Promise<void> {
  try {
    const res = await Post.updateMany(
      { nextRefreshAt: { $exists: false } },
      { $set: { nextRefreshAt: new Date() } }
    );
    const modified = (res as { modifiedCount?: number })?.modifiedCount ?? 0;
    if (modified > 0) {
      console.info(`[StatsRefresher] init migration: set nextRefreshAt on ${modified} posts`);
    }
  } catch (err) {
    console.warn(
      '[StatsRefresher] init migration failed:',
      (err as Error).message
    );
  }
}

export async function startStatsRefresher(): Promise<void> {
  if (tickTimer) {
    console.warn('[StatsRefresher] already started');
    return;
  }
  const tickMs = envNumber('STATS_REFRESH_TICK_MS', DEFAULT_TICK_MS);
  await runInitMigration();
  console.info(`[StatsRefresher] starting with tickMs=${tickMs}`);
  tickTimer = setInterval(() => {
    void runTick();
  }, tickMs);
  // Первый tick — сразу, не ждать первого интервала.
  void runTick();
}

export function stopStatsRefresher(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  tickInFlight = false;
  tickStartedAt = null;
  skippedTicksInARow = 0;
}

// Экспорт для тестов: позволяет выполнить один tick вручную.
export const __testables = {
  runTick,
  refreshChannelBatch,
  processReactions,
};
