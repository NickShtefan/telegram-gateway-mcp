import type TelegramBot from 'node-telegram-bot-api';
import type { Message } from 'node-telegram-bot-api';
import Post from '../../db/models/Post.js';
import Comment from '../../db/models/Comment.js';
import config from '../../config/telegram.js';
import { processCommentMedia } from './processMediaBot.js';
import type { ICommentAuthor, MessageExtraFields } from '../../types/index.js';

type CommentMessage = Message & MessageExtraFields;

interface RootLink {
  postTelegramId: number;
  channelId: string;
  rootMessageId: number;
  discussionChatId: number;
}

// ─── буфер «свежих корней» ──────────────────────────────────────────────────
// Гонка: комментарий может прийти раньше, чем linkRootToPost допишет маппинг в
// Post (или пока processPost ещё качает медиа поста). Автофорвард-корень
// запоминается здесь СРАЗУ, до записи в базу, и комментарии окна гонки
// резолвятся из буфера. Ограничен по размеру и TTL: протухшее доберёт воркер.
const RECENT_ROOTS_MAX = 200;
const RECENT_ROOTS_TTL_MS = 10 * 60 * 1000;

const recentRoots = new Map<number, { postTelegramId: number; channelId: string; addedAt: number }>();

function rememberRoot(rootMessageId: number, postTelegramId: number, channelId: string): void {
  const now = Date.now();
  for (const [key, value] of recentRoots) {
    if (now - value.addedAt > RECENT_ROOTS_TTL_MS) recentRoots.delete(key);
  }
  while (recentRoots.size >= RECENT_ROOTS_MAX) {
    const oldest = recentRoots.keys().next().value;
    if (oldest === undefined) break;
    recentRoots.delete(oldest);
  }
  recentRoots.set(rootMessageId, { postTelegramId, channelId, addedAt: now });
}

function recallRoot(rootMessageId: number): { postTelegramId: number; channelId: string } | null {
  const entry = recentRoots.get(rootMessageId);
  if (!entry) return null;
  if (Date.now() - entry.addedAt > RECENT_ROOTS_TTL_MS) {
    recentRoots.delete(rootMessageId);
    return null;
  }
  return { postTelegramId: entry.postTelegramId, channelId: entry.channelId };
}

// ─── корень-автофорвард ─────────────────────────────────────────────────────

const LINK_RETRY_DELAYS_MS = [2_000, 10_000, 30_000];

/**
 * Автофорвард поста канала в группу: сохраняем маппинг «корень треда -> пост».
 * Стаб-посты не создаём — владелец создания Post это processPost/история.
 */
export async function processDiscussionRoot(msg: Message): Promise<void> {
  const m = msg as CommentMessage;
  const origin = m.forward_origin;
  if (!origin || origin.type !== 'channel' || !origin.chat?.username || typeof origin.message_id !== 'number') {
    console.warn('[Comments] автофорвард без forward_origin channel — пропускаем:', m.message_id);
    return;
  }
  const link: RootLink = {
    postTelegramId: origin.message_id,
    channelId: origin.chat.username,
    rootMessageId: m.message_id,
    discussionChatId: m.chat.id,
  };
  rememberRoot(link.rootMessageId, link.postTelegramId, link.channelId);
  await linkRootToPost(link, 0);
}

export async function linkRootToPost(link: RootLink, attempt: number): Promise<void> {
  const res = await Post.updateOne(
    { telegramId: link.postTelegramId, channelId: link.channelId },
    {
      $set: {
        'discussion.chatId': link.discussionChatId,
        'discussion.rootMessageId': link.rootMessageId,
        'discussion.state': 'linked',
        'discussion.resolveAttempts': 0,
        // Гонка: воркер мог успеть запарковать пост (MSG_ID_INVALID до
        // материализации автофорварда) — возвращаем тред в расписание, иначе
        // он навсегда невидим для сверки (очередь требует != null).
        'discussion.nextCommentsRefreshAt': new Date(),
      },
    }
  );

  if ((res as { matchedCount?: number }).matchedCount === 0) {
    // Гонка: processPost ещё качает медиа и пост не сохранён.
    if (attempt < LINK_RETRY_DELAYS_MS.length) {
      setTimeout(() => {
        void linkRootToPost(link, attempt + 1).catch(err => {
          console.error('[Comments] retry linkRootToPost не удался:', (err as Error).message);
        });
      }, LINK_RETRY_DELAYS_MS[attempt]);
    } else {
      console.warn(
        `[Comments] пост ${link.channelId}#${link.postTelegramId} для автофорварда так и не найден ` +
        '(бот был офлайн при публикации?), оставляем воркеру'
      );
    }
    return;
  }

  console.info(
    `[Comments] корень треда ${link.rootMessageId} привязан к посту ${link.channelId}#${link.postTelegramId}`
  );

  // Подцепляем сирот, успевших прийти до маппинга.
  const adopted = await Comment.updateMany(
    { discussionChatId: link.discussionChatId, threadRootId: link.rootMessageId, postTelegramId: null },
    { $set: { postTelegramId: link.postTelegramId, channelId: link.channelId } }
  );
  const modified = (adopted as { modifiedCount?: number })?.modifiedCount ?? 0;
  if (modified > 0) {
    console.info(`[Comments] привязано ${modified} комментариев-сирот к посту ${link.postTelegramId}`);
  }
}

// ─── комментарии ────────────────────────────────────────────────────────────

/**
 * Позитивный контент-чек: отсекает сервисные сообщения (джойны, пины и т.п.).
 * Экзотика (dice, invoice, venue) сознательно не сохраняется — воркер увидит.
 */
function hasCommentContent(msg: Message): boolean {
  return Boolean(
    msg.text || msg.caption || msg.photo || msg.video || msg.animation ||
    msg.document || msg.audio || msg.voice || msg.video_note || msg.sticker || msg.poll
  );
}

function extractAuthor(m: CommentMessage): ICommentAuthor {
  if (m.sender_chat) {
    // Анонимный админ пишет от имени самой группы; иначе — от имени канала.
    const type = m.sender_chat.id === m.chat.id ? 'group_anonymous' : 'channel';
    return {
      id: m.sender_chat.id,
      type,
      username: m.sender_chat.username ?? null,
      firstName: null,
      lastName: null,
      title: m.sender_chat.title ?? null,
      isBot: false,
    };
  }
  return {
    id: m.from?.id ?? null,
    type: 'user',
    username: m.from?.username ?? null,
    firstName: m.from?.first_name ?? null,
    lastName: m.from?.last_name ?? null,
    title: null,
    isBot: m.from?.is_bot ?? false,
  };
}

interface ThreadLink {
  postTelegramId: number | null;
  channelId: string | null;
}

/**
 * Позитивная проверка принадлежности к треду комментариев. Наивное «есть
 * message_thread_id — значит комментарий» тащит в базу обычные реплай-цепочки
 * участников группы (у них тоже есть thread id) — вечные сироты.
 */
async function resolveThread(m: CommentMessage, threadRootId: number): Promise<ThreadLink | null> {
  // 1) reply_to_message — сам корень-автофорвард: мгновенный self-resolve.
  const root = m.reply_to_message as CommentMessage | undefined;
  if (
    root &&
    root.message_id === threadRootId &&
    root.is_automatic_forward &&
    root.forward_origin?.type === 'channel' &&
    typeof root.forward_origin.message_id === 'number'
  ) {
    const channelId = root.forward_origin.chat?.username ?? null;
    if (channelId) rememberRoot(threadRootId, root.forward_origin.message_id, channelId);
    return { postTelegramId: root.forward_origin.message_id, channelId };
  }

  // 2) Корень уже известен в базе.
  const post = await Post.findOne({
    'discussion.chatId': m.chat.id,
    'discussion.rootMessageId': threadRootId,
  }).select('telegramId channelId discussion.state').lean();
  if (post) {
    // Тред снесён вместе с корнем: реплей апдейтов (окно ~24ч) не должен
    // воскрешать tombstone'ы — переобхода 'gone'-треда больше не будет.
    if ((post as { discussion?: { state?: string } }).discussion?.state === 'gone') {
      return null;
    }
    return { postTelegramId: post.telegramId, channelId: post.channelId };
  }

  // 3) Корень видели только что (окно гонки с linkRootToPost).
  const buffered = recallRoot(threadRootId);
  if (buffered) {
    return { postTelegramId: buffered.postTelegramId, channelId: buffered.channelId };
  }

  return null;
}

/** Upsert с одним ретраем на E11000 — гонка двух писателей на общем unique-ключе. */
async function upsertComment(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<void> {
  try {
    await Comment.updateOne(filter, update, { upsert: true });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      await Comment.updateOne(filter, update, { upsert: true });
    } else {
      throw err;
    }
  }
}

export default async function processComment(msg: Message, bot: TelegramBot, isEdit: boolean): Promise<void> {
  const m = msg as CommentMessage;
  const threadRootId = m.message_thread_id;
  if (!threadRootId) return;          // болтовня вне тредов
  if (!hasCommentContent(m)) return;  // сервисные сообщения

  const link = await resolveThread(m, threadRootId);
  if (!link) {
    // Реплай-цепочка вне тредов комментариев либо корень неизвестен — дроп,
    // пропущенное доберёт CommentsRefresher при обходе треда.
    console.log(`[Comments] сообщение ${m.chat.id}#${m.message_id} вне известных тредов, пропускаем`);
    return;
  }

  const media = await processCommentMedia(m, bot, {
    channelName: link.channelId ?? config.telegram.channelName,
    threadRootId,
    download: config.comments.downloadMedia && !isEdit,
  });

  const author = extractAuthor(m);
  const replyTo = m.reply_to_message;
  const parentCommentId = replyTo && replyTo.message_id !== threadRootId ? replyTo.message_id : null;

  await upsertComment(
    { discussionChatId: m.chat.id, messageId: m.message_id },
    {
      $set: {
        threadRootId,
        parentCommentId,
        text: m.text || m.caption || '',
        entities: m.entities || m.caption_entities || [],
        author,
        ...(link.postTelegramId !== null ? { postTelegramId: link.postTelegramId } : {}),
        ...(link.channelId !== null ? { channelId: link.channelId } : {}),
        // при edit медиа не трогаем вовсе: перезапись метаданными с
        // download:false стёрла бы filePath уже скачанных файлов
        ...(!isEdit ? { media } : {}),
        ...(isEdit && m.edit_date ? { editedAt: new Date(m.edit_date * 1000) } : {}),
        // видим сообщение живьём — значит оно живо (снимает ложный tombstone)
        deletedAt: null,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        date: new Date(m.date * 1000),
        reactions: [],
        lastSyncedAt: null,
      },
    }
  );

  console.log(
    `[Comments] ${isEdit ? 'обновлён' : 'сохранён'} комментарий ${m.chat.id}#${m.message_id}` +
    ` -> пост ${link.postTelegramId ?? '???'}`
  );
}

/** Сброс in-memory состояния — для юнит-тестов. */
export function __resetCommentStateForTests(): void {
  recentRoots.clear();
}
