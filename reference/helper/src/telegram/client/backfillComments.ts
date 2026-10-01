import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { Api } from 'telegram';
import Post from '../../db/models/Post.js';
import config from '../../config/telegram.js';
import { initGramClient, getGramClient, resolvePeer } from './gramClient.js';
import { refreshPostComments } from '../workers/commentsRefresher.js';
import { envNumber, sleep, withTimeout, getFloodWaitSeconds } from '../workers/refreshShared.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * УСКОРИТЕЛЬ бэкфилла комментариев. В норме НЕ НУЖЕН: init-миграция +
 * обычные тики CommentsRefresher дренируют историю сами (~60 постов/час)
 * с нулевым риском для сессии.
 *
 * Этот скрипт — ВТОРОЙ процесс на том же STRING_SESSION. Запуск при живом
 * helper-bot ведёт к AUTH_KEY_DUPLICATED: Telegram инвалидирует ОБЕ сессии,
 * восстановление — интерактивный релогин. Запускать ТОЛЬКО так:
 *
 *   docker compose stop helper && \
 *   docker compose run --rm helper node dist/telegram/client/backfillComments.js && \
 *   docker compose up -d helper
 *
 * Пока сервис остановлен, НЕ пишутся и посты канала (polling выключен) —
 * держите остановку сильно короче 24 часов.
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ./media смонтирован и в контейнер, и на хост — lock виден с обеих сторон.
const LOCK_FILE = path.resolve('media', '.backfill.lock');
const BATCH_SIZE = 100; // MTProto GetMessages limit

interface PostLite {
  telegramId: number;
  channelId: string;
  date: Date;
  discussion: {
    chatId: number | null;
    rootMessageId: number | null;
    state: string;
    commentsCount: number;
    resolveAttempts: number;
    lastCommentsRefreshedAt: Date | null;
  };
}

function parseArgs(): { channel: string; limit: number; force: boolean } {
  const args = process.argv.slice(2);
  let channel = config.telegram.channelName;
  let limit = 0; // 0 = unlimited
  let force = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--channel' && args[i + 1]) {
      channel = args[i + 1];
      i++;
    } else if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--force') {
      force = true;
    }
  }
  return { channel, limit, force };
}

function acquireLock(): void {
  if (fs.existsSync(LOCK_FILE)) {
    console.error(
      `[CommentsBackfill] найден lock-файл ${LOCK_FILE} — другой запуск не завершился?\n` +
      'Если вы уверены, что скрипт не работает, удалите файл и повторите.'
    );
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  fs.writeFileSync(LOCK_FILE, `pid=${process.pid} started=${new Date().toISOString()}\n`);
}

function releaseLock(): void {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    // уже удалён — не страшно
  }
}

interface RepliesInfo {
  replies: number;
}

/**
 * Пре-скан: один channels.GetMessages на 100 постов вместо
 * GetDiscussionMessage+GetReplies на каждый — на порядок меньше вызовов.
 */
async function prescanRepliesCounts(
  channel: string,
  posts: PostLite[]
): Promise<Map<number, RepliesInfo>> {
  const client = getGramClient();
  const peer = await resolvePeer(channel);
  const result = new Map<number, RepliesInfo>();

  const gramTimeoutMs = envNumber('COMMENTS_REFRESH_GRAM_TIMEOUT_MS', 30_000);
  for (let i = 0; i < posts.length; i += BATCH_SIZE) {
    const batch = posts.slice(i, i + BATCH_SIZE);
    const ids = batch.map(p => new Api.InputMessageID({ id: p.telegramId }));
    const doCall = (): Promise<unknown> => withTimeout(
      client.invoke(new Api.channels.GetMessages({ channel: peer, id: ids })),
      gramTimeoutMs,
      'GetMessages prescan'
    );

    let raw: unknown;
    try {
      raw = await doCall();
    } catch (err) {
      const wait = getFloodWaitSeconds(err);
      if (wait !== null && wait <= 3600) {
        console.warn(`[CommentsBackfill] FLOOD_WAIT ${wait}s на пре-скане, ждём`);
        await sleep(wait * 1000);
        raw = await doCall();
      } else {
        throw err;
      }
    }
    const res = raw as { messages?: Array<{ className?: string; id?: number; replies?: { replies?: number; comments?: boolean } }> };

    for (const msg of res.messages ?? []) {
      if (!msg || msg.className !== 'Message' || typeof msg.id !== 'number') continue;
      const replies = msg.replies;
      result.set(msg.id, { replies: replies?.comments ? (replies.replies ?? 0) : 0 });
    }
    await sleep(1000);
  }
  return result;
}

async function run(): Promise<void> {
  const { channel, limit, force } = parseArgs();

  console.warn(
    '\n⚠️  [CommentsBackfill] Скрипт делит STRING_SESSION с helper-bot.\n' +
    '⚠️  Убедитесь, что сервис ОСТАНОВЛЕН (docker compose stop helper),\n' +
    '⚠️  иначе Telegram инвалидирует обе сессии (AUTH_KEY_DUPLICATED).\n' +
    '⚠️  10 секунд на Ctrl+C...\n'
  );
  await sleep(10_000);

  acquireLock();
  const startedAt = Date.now();
  const maxRuntimeMs = envNumber('COMMENTS_BACKFILL_MAX_RUNTIME_MIN', 120) * 60 * 1000;
  const postGapMs = envNumber('COMMENTS_BACKFILL_POST_GAP_MS', 1500);

  try {
    await mongoose.connect(process.env.MONGO_URI!);
    console.log('[CommentsBackfill] MongoDB подключена');
    await initGramClient();

    // Резюмируемость: посты с lastCommentsRefreshedAt уже пройдены (кроме --force).
    const query: Record<string, unknown> = {
      channelId: channel,
      'discussion.state': { $in: ['pending', 'linked'] },
    };
    if (!force) query['discussion.lastCommentsRefreshedAt'] = null;

    let posts = (await Post.find(query)
      .sort({ telegramId: 1 })
      .lean()) as unknown as PostLite[];
    if (limit > 0) posts = posts.slice(0, limit);

    console.log(`[CommentsBackfill] к обработке: ${posts.length} постов канала ${channel}`);
    if (posts.length === 0) return;

    const counts = await prescanRepliesCounts(channel, posts);
    const now = new Date();
    const withComments: PostLite[] = [];
    let noComments = 0;

    for (const post of posts) {
      const info = counts.get(post.telegramId);
      if (!info || info.replies === 0) {
        // Комментариев нет (или пост не вернулся) — фиксируем проход, но НЕ
        // паркуем терминально: поздние комментарии заметит связка replies.replies.
        noComments++;
        await Post.updateOne(
          { telegramId: post.telegramId, channelId: channel },
          {
            $set: {
              'discussion.commentsCount': 0,
              'discussion.lastCommentsRefreshedAt': now,
              'discussion.nextCommentsRefreshAt': null,
            },
          }
        );
        continue;
      }
      withComments.push(post);
    }
    console.log(
      `[CommentsBackfill] pre-scan: ${posts.length} постов, ${withComments.length} с комментариями, ` +
      `${noComments} без (${Math.ceil(posts.length / BATCH_SIZE)} GetMessages-вызовов)`
    );

    let processed = 0;
    let totalUpserted = 0;
    for (const post of withComments) {
      if (Date.now() - startedAt > maxRuntimeMs) {
        console.warn(
          `[CommentsBackfill] wall-clock кап ${Math.round(maxRuntimeMs / 60000)} мин исчерпан, выходим. ` +
          'Скрипт резюмируемый — просто запустите ещё раз.'
        );
        break;
      }
      const result = await refreshPostComments(post, new Date());
      totalUpserted += result.upserted;
      processed++;
      if (result.status === 'flood_abort') {
        console.warn('[CommentsBackfill] FLOOD_WAIT выше капа — останавливаемся, запустите позже');
        break;
      }
      if (processed % 20 === 0) {
        console.log(`[CommentsBackfill] progress: ${processed}/${withComments.length} постов, ${totalUpserted} комментариев`);
      }
      await sleep(postGapMs);
    }

    console.log(`[CommentsBackfill] готово: ${processed} постов, ${totalUpserted} комментариев сохранено`);
  } finally {
    releaseLock();
  }
  process.exit(0);
}

// Ctrl+C / docker stop не должны оставлять lock-файл
process.on('SIGINT', () => {
  releaseLock();
  process.exit(130);
});
process.on('SIGTERM', () => {
  releaseLock();
  process.exit(143);
});

run().catch(err => {
  console.error('[CommentsBackfill] fatal:', err);
  releaseLock();
  process.exit(1);
});
