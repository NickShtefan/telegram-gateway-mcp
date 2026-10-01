import { Api } from 'telegram';
import bigInt from 'big-integer';
import Post from '../../db/models/Post.js';
import Comment from '../../db/models/Comment.js';
import config from '../../config/telegram.js';
import { getGramClient, resolvePeer } from '../client/gramClient.js';
import { resolveDiscussionPeer } from '../discussion.js';
import { toBotApiChatId, toMtprotoChannelId } from '../utils/chatId.js';
import { getNextCommentsRefreshAt } from './commentsAgeTiers.js';
import {
  envNumber,
  sleep,
  StageTimeoutError,
  runStage,
  getFloodWaitSeconds,
  isChannelInvalid,
  isChannelPrivate,
  isMsgIdInvalid,
  processGramCommentReactions,
} from './refreshShared.js';
import type { MediaItem, ICommentAuthor, GramJSReactions } from '../../types/index.js';

const DEFAULT_TICK_MS = 5 * 60 * 1000;
const DEFAULT_STAGGER_MS = 150 * 1000; // полтика StatsRefresher — тикеры интерливятся
const DEFAULT_POSTS_PER_TICK = 5;
const DEFAULT_THREAD_FETCH_LIMIT = 500;
const DEFAULT_PAGE_GAP_MS = 1000;
const DEFAULT_GRAM_TIMEOUT_MS = 30 * 1000;
const DEFAULT_FLOOD_WAIT_MAX_S = 5 * 60;
const DEFAULT_STUCK_TICKS_WARN = 3;
const DEFAULT_RESOLVE_MAX_ATTEMPTS = 3;
const PAGE_SIZE = 100; // MTProto GetReplies limit

const TAG = '[CommentsRefresher]';

let tickTimer: NodeJS.Timeout | null = null;
let staggerTimer: NodeJS.Timeout | null = null;
let tickInFlight = false;
let tickStartedAt: number | null = null;
let skippedTicksInARow = 0;

// ─── типы ───────────────────────────────────────────────────────────────────

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

interface GramPeerLike {
  className?: string;
  userId?: unknown;
  channelId?: unknown;
  chatId?: unknown;
}

interface GramCommentLike {
  className: string;
  id: number;
  date: number;
  message?: string;
  entities?: unknown[];
  media?: { className?: string; document?: { mimeType?: string; id?: unknown }; photo?: { id?: unknown } } | null;
  reactions?: GramJSReactions;
  editDate?: number;
  fromId?: GramPeerLike | null;
  peerId?: GramPeerLike;
  replyTo?: { replyToMsgId?: number; replyToTopId?: number };
  fwdFrom?: { savedFromMsgId?: number };
  groupedId?: unknown;
}

interface GramUserLike {
  id?: unknown;
  firstName?: string;
  lastName?: string;
  username?: string;
  bot?: boolean;
}

interface GramChatLike {
  id?: unknown;
  title?: string;
  username?: string;
}

interface PageResult {
  count?: number;
  messages?: unknown[];
  users?: GramUserLike[];
  chats?: GramChatLike[];
}

interface RefreshOutcome {
  status: 'ok' | 'skipped' | 'parked' | 'flood_abort';
  upserted: number;
  tombstoned: number;
}

// ─── авторы ─────────────────────────────────────────────────────────────────

export function authorFromPeer(
  fromId: GramPeerLike | null | undefined,
  usersById: Map<string, GramUserLike>,
  chatsById: Map<string, GramChatLike>,
  groupMtprotoId: number
): ICommentAuthor {
  if (fromId && fromId.className === 'PeerUser' && fromId.userId !== undefined) {
    const user = usersById.get(String(fromId.userId));
    return {
      id: Number(fromId.userId),
      type: 'user',
      username: user?.username ?? null,
      firstName: user?.firstName ?? null,
      lastName: user?.lastName ?? null,
      title: null,
      isBot: user?.bot ?? false,
    };
  }
  if (fromId && fromId.className === 'PeerChannel' && fromId.channelId !== undefined) {
    const chan = chatsById.get(String(fromId.channelId));
    const isGroupItself = Number(fromId.channelId) === groupMtprotoId;
    return {
      id: toBotApiChatId(Number(fromId.channelId)),
      type: isGroupItself ? 'group_anonymous' : 'channel',
      username: chan?.username ?? null,
      firstName: null,
      lastName: null,
      title: chan?.title ?? null,
      isBot: false,
    };
  }
  // fromId отсутствует: анонимный автор — считаем группой
  const group = chatsById.get(String(groupMtprotoId));
  return {
    id: null,
    type: 'group_anonymous',
    username: null,
    firstName: null,
    lastName: null,
    title: group?.title ?? null,
    isBot: false,
  };
}

// ─── медиа (только метаданные — воркер файлов не качает) ────────────────────

export function extractMediaMeta(msg: GramCommentLike): MediaItem[] {
  const media = msg.media;
  if (!media || !media.className) return [];
  if (media.className === 'MessageMediaPhoto') {
    return [{
      fileId: media.photo?.id !== undefined ? String(media.photo.id) : '',
      fileType: 'photo',
      caption: msg.message || '',
      filename: `${msg.id}_gram.jpg`,
      media_group_id: msg.groupedId !== undefined && msg.groupedId !== null ? String(msg.groupedId) : null,
      downloaded: false,
    }];
  }
  if (media.className === 'MessageMediaDocument') {
    const mime = media.document?.mimeType || '';
    const fileType: MediaItem['fileType'] =
      mime.startsWith('video') ? 'video'
        : mime === 'image/gif' ? 'animation'
          : mime.startsWith('audio') ? 'audio'
            : 'document';
    return [{
      fileId: media.document?.id !== undefined ? String(media.document.id) : '',
      fileType,
      caption: msg.message || '',
      filename: `${msg.id}_gram`,
      media_group_id: msg.groupedId !== undefined && msg.groupedId !== null ? String(msg.groupedId) : null,
      mime_type: mime || undefined,
      downloaded: false,
    }];
  }
  return [];
}

// ─── tombstone-фильтр (экспортирован для тестов) ────────────────────────────

/**
 * Комментарий tombstone'ится только если окно, в котором он живёт, было
 * ПОЛНОСТЬЮ наблюдено этим проходом:
 * - $lte maxFetched всегда: пришедшее mid-pass (id выше окна) не судим;
 * - $gte minFetched при частичном проходе: ниже окна не заглядывали;
 * - пустой fetch при count>0 — аномалия, сверку пропускаем (null);
 * - тред реально пуст (count==0, страницы исчерпаны) — tombstone только
 *   комментариев старше начала обхода (вставленное realtime mid-walk живёт).
 */
export function buildTombstoneFilter(args: {
  discussionChatId: number;
  threadRootId: number;
  fetchedIds: number[];
  pagesExhausted: boolean;
  knownCount: number | null;
  walkStartedAt: Date;
}): Record<string, unknown> | null {
  const { discussionChatId, threadRootId, fetchedIds, pagesExhausted, knownCount, walkStartedAt } = args;

  if (fetchedIds.length === 0) {
    if (pagesExhausted && knownCount === 0) {
      return { discussionChatId, threadRootId, deletedAt: null, date: { $lt: walkStartedAt } };
    }
    return null; // аномалия либо неполный обход — не судим
  }

  const idCond: Record<string, unknown> = {
    $nin: fetchedIds,
    $lte: Math.max(...fetchedIds),
  };
  if (!pagesExhausted) {
    idCond.$gte = Math.min(...fetchedIds);
  }
  return { discussionChatId, threadRootId, deletedAt: null, messageId: idCond };
}

// ─── FLOOD_WAIT-обёртка ─────────────────────────────────────────────────────

type InvokeOutcome =
  | { outcome: 'ok'; res: unknown }
  | { outcome: 'failed' }
  | { outcome: 'flood_abort' };

/**
 * Один MTProto-этап с FLOOD_WAIT-политикой воркера: в пределах капа — sleep и
 * один retry; выше капа — abort всего тика (флуд глобален для сессии,
 * продолжать другими постами бессмысленно — жёстче, чем skip-batch у статов).
 * Прочие ошибки (MSG_ID_INVALID и т.п.) пробрасываются вызывающему.
 */
async function invokeStage(stage: string, label: string, op: () => Promise<unknown>): Promise<InvokeOutcome> {
  const gramTimeoutMs = envNumber('COMMENTS_REFRESH_GRAM_TIMEOUT_MS', DEFAULT_GRAM_TIMEOUT_MS);
  try {
    return { outcome: 'ok', res: await runStage(TAG, stage, label, gramTimeoutMs, op) };
  } catch (err) {
    if (err instanceof StageTimeoutError) {
      return { outcome: 'failed' };
    }
    const wait = getFloodWaitSeconds(err);
    if (wait !== null) {
      const maxWait = envNumber('COMMENTS_REFRESH_FLOOD_WAIT_MAX_S', DEFAULT_FLOOD_WAIT_MAX_S);
      if (wait > maxWait) {
        console.warn(`${TAG} FLOOD_WAIT ${wait}s exceeds cap ${maxWait}s on ${label}, aborting tick`);
        return { outcome: 'flood_abort' };
      }
      console.warn(`${TAG} FLOOD_WAIT ${wait}s on ${label}, retrying once`);
      await sleep(wait * 1000);
      try {
        return {
          outcome: 'ok',
          res: await runStage(TAG, `${stage} retry after FLOOD_WAIT`, label, gramTimeoutMs, op),
        };
      } catch (retryErr) {
        if (retryErr instanceof StageTimeoutError) return { outcome: 'failed' };
        if (isMsgIdInvalid(retryErr) || isChannelInvalid(retryErr)) throw retryErr;
        console.warn(`${TAG} retry after FLOOD_WAIT failed for ${label}:`, (retryErr as Error).message);
        return { outcome: 'failed' };
      }
    }
    throw err;
  }
}

// ─── один пост: резолв корня + обход треда ──────────────────────────────────

/**
 * Перенос обхода на следующий слот при НЕтерминальном исходе. Для поста, ещё
 * не прошедшего первичный бэкфилл (lastCommentsRefreshedAt=null), лесенка
 * возвращает null, если пост старше cutoff — но парковать его нельзя: очередь
 * требует nextCommentsRefreshAt != null, и транзиентный сбой (таймаут, abort
 * тика по FLOOD_WAIT) молча выкинул бы пост из бэкфилла навсегда. Такие посты
 * ретраятся через тик-интервал; парковать их может только успешный обход.
 */
async function advanceSchedule(post: PostLite, now: Date, newestCommentDate: Date | null): Promise<void> {
  let next = getNextCommentsRefreshAt(post.date, newestCommentDate, now);
  if (next === null && post.discussion.lastCommentsRefreshedAt == null) {
    next = new Date(now.getTime() + envNumber('COMMENTS_REFRESH_TICK_MS', DEFAULT_TICK_MS));
  }
  try {
    await Post.updateOne(
      { telegramId: post.telegramId, channelId: post.channelId },
      { $set: { 'discussion.nextCommentsRefreshAt': next } }
    );
  } catch (err) {
    console.warn(`${TAG} failed to advance schedule for ${post.channelId}#${post.telegramId}:`, (err as Error).message);
  }
}

async function parkPost(post: PostLite, state: string, reason: string): Promise<void> {
  console.warn(`${TAG} ${reason} for ${post.channelId}#${post.telegramId}, parking (state=${state})`);
  await Post.updateOne(
    { telegramId: post.telegramId, channelId: post.channelId },
    { $set: { 'discussion.state': state, 'discussion.nextCommentsRefreshAt': null } }
  );
}

/**
 * A. Резолв корня треда (state='pending'): GetDiscussionMessage.
 * Realtime обычно успевает раньше через is_automatic_forward — сюда попадают
 * исторические посты и пропуски.
 */
async function resolveRoot(post: PostLite, now: Date): Promise<'resolved' | 'skipped' | 'parked' | 'flood_abort'> {
  const label = `${post.channelId}#${post.telegramId}`;
  const client = getGramClient();

  let channelPeer: Api.TypeInputPeer;
  try {
    const r = await invokeStage('resolvePeer', label, () => resolvePeer(post.channelId));
    if (r.outcome === 'flood_abort') return 'flood_abort';
    if (r.outcome !== 'ok') {
      await advanceSchedule(post, now, null); // иначе пост залипает в голове очереди
      return 'skipped';
    }
    channelPeer = r.res as Api.TypeInputPeer;
  } catch (err) {
    console.warn(`${TAG} resolvePeer failed for ${label}:`, (err as Error).message);
    await advanceSchedule(post, now, null);
    return 'skipped';
  }

  let res: unknown;
  try {
    const r = await invokeStage('GetDiscussionMessage', label, () =>
      client.invoke(new Api.messages.GetDiscussionMessage({ peer: channelPeer, msgId: post.telegramId }))
    );
    if (r.outcome !== 'ok') {
      if (r.outcome === 'flood_abort') return 'flood_abort';
      await advanceSchedule(post, now, null);
      return 'skipped';
    }
    res = r.res;
  } catch (err) {
    if (isMsgIdInvalid(err)) {
      // Комментарии выключены либо пост старше привязки группы — терминально.
      await parkPost(post, 'none', 'comments unavailable (MSG_ID_INVALID)');
      return 'parked';
    }
    if (isChannelPrivate(err)) {
      // Исправимо владельцем — не паркуем, ретраим по расписанию.
      console.error(
        `${TAG} CHANNEL_PRIVATE for ${label}: юзербот (STRING_SESSION) не участник приватной группы обсуждений — добавьте аккаунт в группу`
      );
      await advanceSchedule(post, now, null);
      return 'skipped';
    }
    if (isChannelInvalid(err)) {
      await parkPost(post, 'none', `invalid channel (${(err as Error).message})`);
      return 'parked';
    }
    console.warn(`${TAG} GetDiscussionMessage failed for ${label}:`, (err as Error).message);
    await advanceSchedule(post, now, null);
    return 'skipped';
  }

  const messages = ((res as PageResult | null)?.messages ?? []) as GramCommentLike[];
  const root = messages.find(
    m => m && m.className === 'Message' && m.fwdFrom?.savedFromMsgId === post.telegramId
  );
  if (!root || !root.peerId || root.peerId.channelId === undefined) {
    const attempts = (post.discussion.resolveAttempts ?? 0) + 1;
    const maxAttempts = envNumber('COMMENTS_RESOLVE_MAX_ATTEMPTS', DEFAULT_RESOLVE_MAX_ATTEMPTS);
    if (attempts >= maxAttempts) {
      await parkPost(post, 'none', `discussion root not found after ${attempts} attempts`);
      return 'parked';
    }
    await Post.updateOne(
      { telegramId: post.telegramId, channelId: post.channelId },
      { $set: { 'discussion.resolveAttempts': attempts } }
    );
    await advanceSchedule(post, now, null);
    return 'skipped';
  }

  const chatIdBotApi = toBotApiChatId(Number(root.peerId.channelId));
  await Post.updateOne(
    { telegramId: post.telegramId, channelId: post.channelId },
    {
      $set: {
        'discussion.chatId': chatIdBotApi,
        'discussion.rootMessageId': root.id,
        'discussion.state': 'linked',
        'discussion.resolveAttempts': 0,
      },
    }
  );
  console.info(`${TAG} resolved root for ${label}: group ${chatIdBotApi} root ${root.id}`);

  // локально продолжаем в этом же тике
  post.discussion.chatId = chatIdBotApi;
  post.discussion.rootMessageId = root.id;
  post.discussion.state = 'linked';
  return 'resolved';
}

/** B–E. Обход треда: страницы GetReplies -> upsert -> tombstone -> расписание. */
async function refreshPostComments(post: PostLite, now: Date): Promise<RefreshOutcome> {
  const label = `${post.channelId}#${post.telegramId}`;

  if (post.discussion.state === 'pending' || post.discussion.rootMessageId === null) {
    const resolved = await resolveRoot(post, now);
    if (resolved !== 'resolved') {
      return { status: resolved === 'flood_abort' ? 'flood_abort' : resolved === 'parked' ? 'parked' : 'skipped', upserted: 0, tombstoned: 0 };
    }
  }

  const rootMessageId = post.discussion.rootMessageId as number;
  const discussionChatId = post.discussion.chatId as number;
  const client = getGramClient();

  // InputPeer группы: кэшируется в discussion.ts; сам вызов — под гейтом и дедлайном.
  const peerResult = await invokeStage('resolveDiscussionPeer', label, () => resolveDiscussionPeer(post.channelId));
  if (peerResult.outcome !== 'ok') {
    if (peerResult.outcome === 'flood_abort') return { status: 'flood_abort', upserted: 0, tombstoned: 0 };
    await advanceSchedule(post, now, null);
    return { status: 'skipped', upserted: 0, tombstoned: 0 };
  }
  const dPeer = peerResult.res as Api.TypeInputPeer | null;
  if (!dPeer) {
    await advanceSchedule(post, now, null);
    return { status: 'skipped', upserted: 0, tombstoned: 0 };
  }

  const pageGapMs = envNumber('COMMENTS_REFRESH_PAGE_GAP_MS', DEFAULT_PAGE_GAP_MS);
  const fetchLimit = envNumber('COMMENTS_REFRESH_THREAD_FETCH_LIMIT', DEFAULT_THREAD_FETCH_LIMIT);
  const walkStartedAt = now;

  const fetched: GramCommentLike[] = [];
  const usersById = new Map<string, GramUserLike>();
  const chatsById = new Map<string, GramChatLike>();
  let offsetId = 0;
  let pagesExhausted = false;
  let knownCount: number | null = null;
  let pages = 0;

  for (;;) {
    let page: PageResult;
    try {
      const r = await invokeStage(`GetReplies page ${pages + 1}`, label, () =>
        client.invoke(new Api.messages.GetReplies({
          peer: dPeer,
          msgId: rootMessageId,
          offsetId,
          offsetDate: 0,
          addOffset: 0,
          limit: PAGE_SIZE,
          maxId: 0,
          minId: 0,
          hash: bigInt.zero,
        }))
      );
      if (r.outcome === 'flood_abort') return { status: 'flood_abort', upserted: 0, tombstoned: 0 };
      if (r.outcome === 'failed') break; // partial: pagesExhausted остаётся false
      page = r.res as PageResult;
    } catch (err) {
      if (isMsgIdInvalid(err)) {
        // Корень удалён — Telegram сносит тред целиком.
        const gone = await Comment.updateMany(
          { discussionChatId, threadRootId: rootMessageId, deletedAt: null },
          { $set: { deletedAt: now } }
        );
        const goneCount = (gone as { modifiedCount?: number })?.modifiedCount ?? 0;
        console.warn(`${TAG} root gone for ${label}, tombstoned ${goneCount} comments, parking`);
        await Post.updateOne(
          { telegramId: post.telegramId, channelId: post.channelId },
          { $set: { 'discussion.state': 'gone', 'discussion.nextCommentsRefreshAt': null } }
        );
        return { status: 'parked', upserted: 0, tombstoned: goneCount };
      }
      if (isChannelPrivate(err)) {
        console.error(
          `${TAG} CHANNEL_PRIVATE for ${label}: юзербот (STRING_SESSION) не участник приватной группы обсуждений — добавьте аккаунт в группу`
        );
        break;
      }
      if (isChannelInvalid(err)) {
        await parkPost(post, 'none', `discussion group unavailable (${(err as Error).message})`);
        return { status: 'parked', upserted: 0, tombstoned: 0 };
      }
      console.warn(`${TAG} GetReplies failed for ${label}:`, (err as Error).message);
      break;
    }

    pages++;
    knownCount = knownCount ?? (typeof page.count === 'number' ? page.count : null);
    for (const u of page.users ?? []) {
      if (u?.id !== undefined) usersById.set(String(u.id), u);
    }
    for (const c of page.chats ?? []) {
      if (c?.id !== undefined) chatsById.set(String(c.id), c);
    }

    const raw = (page.messages ?? []) as GramCommentLike[];
    const usable = raw.filter(m => m && m.className === 'Message' && m.id !== rootMessageId);
    fetched.push(...usable);

    // Терминация — по СЫРОЙ длине страницы: страница из одних сервисных
    // сообщений не должна досрочно завершать обход.
    if (raw.length === 0 || raw.length < PAGE_SIZE) {
      pagesExhausted = true;
      break;
    }
    if (fetched.length >= fetchLimit) {
      break; // partial by design
    }
    offsetId = Math.min(...raw.map(m => m.id));
    await sleep(pageGapMs); // вне гейта
  }

  // Ни одной страницы не получили (таймаут/сбой первой же) — это НЕ успешный
  // обход: не финализируем (иначе провал записался бы как commentsCount=0 и
  // пост ушёл бы из бэкфилл-ветки), просто переносим на следующий слот.
  if (pages === 0) {
    await advanceSchedule(post, now, null);
    return { status: 'skipped', upserted: 0, tombstoned: 0 };
  }

  // C. Upsert. Монотонный гард по editedAt: не откатываем более свежую
  // realtime-правку снапшотом, снятым до неё. media.filePath — чтобы не
  // затирать скачанные realtime-файлы GramJS-метаданными.
  const stored = (await Comment.find(
    { discussionChatId, threadRootId: rootMessageId },
    { messageId: 1, editedAt: 1, 'media.filePath': 1 }
  ).lean()) as unknown as Array<{ messageId: number; editedAt: Date | null; media?: Array<{ filePath?: string }> }>;
  const storedById = new Map(stored.map(s => [s.messageId, s]));

  const mtprotoGroupId = toMtprotoChannelId(discussionChatId);

  let upserted = 0;
  const ops: Array<Record<string, unknown>> = [];
  for (const msg of fetched) {
    const parentRaw = msg.replyTo?.replyToMsgId;
    const parentCommentId = typeof parentRaw === 'number' && parentRaw !== rootMessageId ? parentRaw : null;
    const author = authorFromPeer(msg.fromId, usersById, chatsById, mtprotoGroupId);
    const fetchedEditedAt = typeof msg.editDate === 'number' ? new Date(msg.editDate * 1000) : null;
    const storedDoc = storedById.get(msg.id);
    const skipContent = Boolean(
      storedDoc?.editedAt &&
      (!fetchedEditedAt || fetchedEditedAt.getTime() < new Date(storedDoc.editedAt).getTime())
    );
    // Скачанные realtime-файлы (filePath) не затираем GramJS-метаданными.
    const hasDownloadedMedia = Boolean(storedDoc?.media?.some(m => m?.filePath));

    const set: Record<string, unknown> = {
      parentCommentId,
      reactions: processGramCommentReactions(msg.reactions),
      deletedAt: null,
      lastSyncedAt: now,
      updatedAt: now,
      'author.type': author.type,
      'author.isBot': author.isBot,
    };
    // min-populated ответы не должны затирать более богатого автора из realtime
    if (author.id !== null) set['author.id'] = author.id;
    if (author.username !== null) set['author.username'] = author.username;
    if (author.firstName !== null) set['author.firstName'] = author.firstName;
    if (author.lastName !== null) set['author.lastName'] = author.lastName;
    if (author.title !== null) set['author.title'] = author.title;
    if (!skipContent) {
      set.text = msg.message || '';
      set.entities = msg.entities || [];
      set.editedAt = fetchedEditedAt;
      const mediaMeta = extractMediaMeta(msg);
      if (mediaMeta.length > 0 && !hasDownloadedMedia) set.media = mediaMeta;
    }

    ops.push({
      updateOne: {
        filter: { discussionChatId, messageId: msg.id },
        update: {
          $set: set,
          // Линковка — first-writer-wins: у постов-альбомов несколько
          // автофорвардов могут претендовать на один тред, перезапись
          // postTelegramId туда-обратно недопустима.
          $setOnInsert: {
            date: new Date(msg.date * 1000),
            channelId: post.channelId,
            postTelegramId: post.telegramId,
            threadRootId: rootMessageId,
          },
        },
        upsert: true,
      },
    });
  }

  if (ops.length > 0) {
    try {
      const bulkRes = await Comment.bulkWrite(ops as never[], { ordered: false });
      upserted = ops.length;
      void bulkRes;
    } catch (err) {
      // E11000 при гонке с realtime-писателем: повторяем один раз — вторая
      // попытка становится обычным update.
      if ((err as { code?: number }).code === 11000 || String((err as Error).message).includes('E11000')) {
        try {
          await Comment.bulkWrite(ops as never[], { ordered: false });
          upserted = ops.length;
        } catch (retryErr) {
          console.warn(`${TAG} bulkWrite retry failed for ${label}:`, (retryErr as Error).message);
        }
      } else {
        console.warn(`${TAG} bulkWrite failed for ${label}:`, (err as Error).message);
      }
    }

    // Линковка через $setOnInsert не чинит сирот от realtime — досвязываем их
    // отдельным проходом (тред ↔ пост в рамках обхода 1:1).
    try {
      await Comment.updateMany(
        { discussionChatId, threadRootId: rootMessageId, postTelegramId: null },
        { $set: { postTelegramId: post.telegramId, channelId: post.channelId } }
      );
    } catch (err) {
      console.warn(`${TAG} orphan adoption failed for ${label}:`, (err as Error).message);
    }
  }

  // D. Tombstone-сверка с гардами окна.
  let tombstoned = 0;
  const filter = buildTombstoneFilter({
    discussionChatId,
    threadRootId: rootMessageId,
    fetchedIds: fetched.map(m => m.id),
    pagesExhausted,
    knownCount,
    walkStartedAt,
  });
  if (filter === null) {
    if ((knownCount ?? 0) > 0) {
      console.warn(`${TAG} skipping tombstone pass for ${label}: empty fetch but count=${knownCount}`);
    }
  } else {
    try {
      const res = await Comment.updateMany(filter, { $set: { deletedAt: now } });
      tombstoned = (res as { modifiedCount?: number })?.modifiedCount ?? 0;
    } catch (err) {
      console.warn(`${TAG} tombstone pass failed for ${label}:`, (err as Error).message);
    }
  }

  // E. Расписание по эффективному возрасту + счётчик.
  const newestCommentDate = fetched.length > 0
    ? new Date(Math.max(...fetched.map(m => m.date)) * 1000)
    : null;
  try {
    await Post.updateOne(
      { telegramId: post.telegramId, channelId: post.channelId },
      {
        $set: {
          'discussion.commentsCount': knownCount ?? fetched.length,
          'discussion.lastCommentsRefreshedAt': now,
          'discussion.nextCommentsRefreshAt': getNextCommentsRefreshAt(post.date, newestCommentDate, now),
        },
      }
    );
  } catch (err) {
    console.warn(`${TAG} failed to finalize ${label}:`, (err as Error).message);
  }

  console.info(
    `${TAG} post ${label}: ${upserted} upserted, ${tombstoned} tombstoned, count=${knownCount ?? fetched.length} (pages=${pages}, partial=${pagesExhausted ? 'no' : 'yes'})`
  );
  return { status: 'ok', upserted, tombstoned };
}

// ─── tick ───────────────────────────────────────────────────────────────────

async function runTick(): Promise<void> {
  if (tickInFlight) {
    skippedTicksInARow++;
    const tickAgeSec = tickStartedAt === null ? 0 : Math.round((Date.now() - tickStartedAt) / 1000);
    const message = `${TAG} tick skipped: previous tick still running (${skippedTicksInARow} in a row, tick age ${tickAgeSec}s)`;
    const warnAfter = envNumber('COMMENTS_REFRESH_STUCK_TICKS_WARN', DEFAULT_STUCK_TICKS_WARN);
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

  const startedAt = Date.now();
  try {
    const postsPerTick = envNumber('COMMENTS_REFRESH_POSTS_PER_TICK', DEFAULT_POSTS_PER_TICK);
    const cutoffDays = envNumber('COMMENTS_REFRESH_CUTOFF_DAYS', 30);
    const pageGapMs = envNumber('COMMENTS_REFRESH_PAGE_GAP_MS', DEFAULT_PAGE_GAP_MS);
    const now = new Date();
    const cutoff = new Date(now.getTime() - cutoffDays * 24 * 60 * 60 * 1000);

    // Backfill-aware query — зеркало statsRefresher: пост в очереди, пока не
    // прошёл первичный обход, даже если старше cutoff.
    const due = (await Post.find({
      'discussion.nextCommentsRefreshAt': { $ne: null, $lte: now },
      'discussion.state': { $in: ['pending', 'linked'] },
      $or: [
        { date: { $gte: cutoff } },
        { 'discussion.lastCommentsRefreshedAt': null },
      ],
    })
      .sort({ 'discussion.nextCommentsRefreshAt': 1 })
      .limit(postsPerTick)
      .lean()) as unknown as PostLite[];

    const pending = due.filter(p => p.discussion?.state === 'pending').length;
    console.info(`${TAG} tick: ${due.length} due posts (${pending} pending, ${due.length - pending} linked)`);
    if (due.length === 0) return;

    let totalUpserted = 0;
    let totalTombstoned = 0;
    let skipped = 0;
    let aborted = false;

    for (const post of due) {
      if (!post.discussion) {
        skipped++;
        continue;
      }
      try {
        const result = await refreshPostComments(post, now);
        totalUpserted += result.upserted;
        totalTombstoned += result.tombstoned;
        if (result.status === 'skipped' || result.status === 'parked') skipped++;
        if (result.status === 'flood_abort') {
          aborted = true;
          const remaining = due.slice(due.indexOf(post));
          for (const rest of remaining) {
            await advanceSchedule(rest, now, null);
          }
          console.warn(`${TAG} tick aborted by FLOOD_WAIT, ${remaining.length} posts deferred`);
          break;
        }
      } catch (err) {
        skipped++;
        console.warn(`${TAG} post ${post.channelId}#${post.telegramId} failed:`, (err as Error).message);
        await advanceSchedule(post, now, null);
      }
      await sleep(pageGapMs); // пауза и между постами
    }

    console.info(
      `${TAG} tick done: posts=${due.length} upserted=${totalUpserted} tombstoned=${totalTombstoned} skipped=${skipped}${aborted ? ' (aborted)' : ''} in ${Date.now() - startedAt}ms`
    );
  } catch (err) {
    console.warn(`${TAG} tick failed:`, (err as Error).message);
  } finally {
    tickInFlight = false;
    tickStartedAt = null;
  }
}

/**
 * Единая миграция фичи комментариев: досоздаёт discussion-суб-документ у
 * исторических постов и ставит их в очередь бэкфилла (state='pending',
 * nextCommentsRefreshAt=now — иначе очередь пуста и бэкфилл не стартует).
 * Гейтится флагом COMMENTS_ENABLED на уровне start — выключенная фича не
 * мутирует базу.
 */
async function runInitMigration(): Promise<void> {
  try {
    const res = await Post.updateMany(
      { 'discussion.state': { $exists: false } },
      {
        $set: {
          discussion: {
            chatId: null,
            rootMessageId: null,
            state: 'pending',
            commentsCount: 0,
            resolveAttempts: 0,
            lastCommentsRefreshedAt: null,
            nextCommentsRefreshAt: new Date(),
          },
        },
      }
    );
    const modified = (res as { modifiedCount?: number })?.modifiedCount ?? 0;
    if (modified > 0) {
      console.info(`${TAG} init migration: set discussion on ${modified} posts`);
    }
  } catch (err) {
    console.warn(`${TAG} init migration failed:`, (err as Error).message);
  }
}

export async function startCommentsRefresher(): Promise<void> {
  if (tickTimer || staggerTimer) {
    console.warn(`${TAG} already started`);
    return;
  }
  if (!config.comments.enabled) {
    console.info(`${TAG} disabled (COMMENTS_ENABLED=false), worker idle`);
    return;
  }
  const tickMs = envNumber('COMMENTS_REFRESH_TICK_MS', DEFAULT_TICK_MS);
  const staggerMs = envNumber('COMMENTS_REFRESH_STAGGER_MS', DEFAULT_STAGGER_MS);
  await runInitMigration();
  console.info(`${TAG} starting with tickMs=${tickMs} stagger=${staggerMs}`);
  staggerTimer = setTimeout(() => {
    staggerTimer = null;
    tickTimer = setInterval(() => {
      void runTick();
    }, tickMs);
    void runTick();
  }, staggerMs);
}

export function stopCommentsRefresher(): void {
  if (staggerTimer) {
    clearTimeout(staggerTimer);
    staggerTimer = null;
  }
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  tickInFlight = false;
  tickStartedAt = null;
  skippedTicksInARow = 0;
}

// Экспорт для тестов и backfill-скрипта.
export const __testables = {
  runTick,
  refreshPostComments,
  resolveRoot,
  runInitMigration,
};
export { refreshPostComments };
