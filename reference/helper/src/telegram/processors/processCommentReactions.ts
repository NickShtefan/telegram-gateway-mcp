import Comment from '../../db/models/Comment.js';
import Post from '../../db/models/Post.js';
import CommentReactionActor from '../../db/models/CommentReactionActor.js';
import { reactionKey } from './reactionKey.js';
import { getSelfUserId } from '../client/gramClient.js';
import { getChannelChatIdSync } from '../discussion.js';
import type { ReactionCountUpdate, MessageReactionUpdate, IReaction, ICommentReactionActor } from '../../types/index.js';

/**
 * message_reaction_count (анонимный агрегат, может лагать минуты):
 * авторитетный снапшот — перезаписываем reactions целиком, зеркало
 * processReactionUpdate, но по ключу комментария.
 */
export async function processCommentReactionCount(update: ReactionCountUpdate): Promise<void> {
  if (!update.reactions || !Array.isArray(update.reactions)) {
    console.warn('[CommentReactions] нет данных о реакциях в обновлении для сообщения:', update.message_id);
    return;
  }

  const reactions: IReaction[] = update.reactions.map(r => ({
    reaction: reactionKey(r.type),
    count: r.total_count || 0,
  }));

  const res = await Comment.updateOne(
    { discussionChatId: update.chat.id, messageId: update.message_id },
    { $set: { reactions, updatedAt: new Date() } }
  );

  if ((res as { matchedCount?: number }).matchedCount === 0) {
    // Скелетов из реакций не создаём — реконсиляция за воркером.
    console.warn(`[CommentReactions] комментарий ${update.chat.id}#${update.message_id} не найден, снапшот пропущен`);
  } else {
    console.log(`[CommentReactions] снапшот реакций для комментария ${update.message_id}:`, reactions);
  }
}

/**
 * Идентичность владельца канала для isOwner (issue #86):
 * личный аккаунт — CHANNEL_OWNER_USER_ID (env) либо me.id GramJS-сессии
 * (юзербот и есть аккаунт владельца); «как канал» — actor_chat.id == id канала.
 */
function resolveOwnerUserId(): number | null {
  const raw = process.env.CHANNEL_OWNER_USER_ID;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && Number.isInteger(n) && n > 0) return n;
    console.warn(`[CommentReactions] CHANNEL_OWNER_USER_ID='${raw}' не число, использую me.id юзербота`);
  }
  return getSelfUserId();
}

/**
 * Текущее состояние реакций актора (issue #86): replace-семантика — строка
 * актора целиком заменяется new_reaction, снятие оставляет reactions: [].
 * Реплеи и дубли сходятся сами (upsert по unique-ключу + замена массива).
 * Никогда не является источником агрегатов: анонимные реакции сюда не попадают.
 */
async function persistReactionActor(update: MessageReactionUpdate): Promise<void> {
  let actor: ICommentReactionActor['actor'];
  let isOwner = false;

  if (update.user) {
    actor = {
      id: update.user.id,
      type: 'user',
      username: update.user.username ?? null,
      firstName: update.user.first_name ?? null,
      lastName: update.user.last_name ?? null,
      title: null,
      isBot: update.user.is_bot ?? false,
    };
    const ownerId = resolveOwnerUserId();
    isOwner = ownerId !== null && ownerId === update.user.id;
  } else if (update.actor_chat) {
    const type = update.actor_chat.id === update.chat.id ? 'group_anonymous' : 'channel';
    actor = {
      id: update.actor_chat.id,
      type,
      username: update.actor_chat.username ?? null,
      firstName: null,
      lastName: null,
      title: update.actor_chat.title ?? null,
      isBot: false,
    };
    const channelId = getChannelChatIdSync();
    isOwner = type === 'channel' && channelId !== null && update.actor_chat.id === channelId;
  } else {
    // Telegram не раскрыл актора — агрегаты всё равно обновятся, строку не создаём.
    console.warn(`[CommentReactions] message_reaction без user/actor_chat для ${update.chat.id}#${update.message_id}, актор не сохранён`);
    return;
  }

  const reactions = (update.new_reaction ?? []).map(r => reactionKey(r));
  const now = new Date();
  const filter = {
    discussionChatId: update.chat.id,
    messageId: update.message_id,
    'actor.id': actor.id,
    'actor.type': actor.type,
  };
  const change = {
    $set: { actor, isOwner, reactions, updatedAt: now },
    $setOnInsert: { firstSeenAt: now },
  };
  try {
    await CommentReactionActor.updateOne(filter, change, { upsert: true });
  } catch (err) {
    // гонка двух реплеев на общем unique-ключе — один ретрай
    if ((err as { code?: number }).code === 11000) {
      await CommentReactionActor.updateOne(filter, change, { upsert: true });
    } else {
      throw err;
    }
  }
  console.log(
    `[CommentReactions] актор ${actor.type}:${actor.id}${isOwner ? ' (владелец)' : ''} -> [${reactions.join(', ')}] на комментарии ${update.message_id}`
  );
}

/**
 * message_reaction (по-пользовательский дифф — основной сигнал в супергруппе):
 * оптимистичный фолд old/new в счётчики + подтяжка сверки треда воркером.
 * Фолд может дрейфовать на пропущенных апдейтах, поэтому после каждого фолда
 * discussion.nextCommentsRefreshAt поста выставляется в now — ближайший тик
 * CommentsRefresher подтвердит точные значения.
 */
export async function processCommentReaction(update: MessageReactionUpdate): Promise<void> {
  // Состояние актора самодостаточно (не зависит от наличия комментария в базе)
  // и не должно падать вместе с фолдом агрегатов — свой try/catch.
  try {
    await persistReactionActor(update);
  } catch (err) {
    console.warn('[CommentReactions] не удалось сохранить актора:', (err as Error).message);
  }

  const filter = { discussionChatId: update.chat.id, messageId: update.message_id };
  const comment = await Comment.findOne(filter).select('reactions threadRootId').lean();
  if (!comment) {
    console.warn(`[CommentReactions] комментарий ${update.chat.id}#${update.message_id} не найден, дифф пропущен`);
    return;
  }

  const counts = new Map<string, number>();
  for (const r of (comment.reactions as IReaction[] | undefined) ?? []) {
    counts.set(r.reaction, r.count);
  }
  for (const r of update.old_reaction ?? []) {
    const key = reactionKey(r);
    counts.set(key, (counts.get(key) ?? 0) - 1);
  }
  for (const r of update.new_reaction ?? []) {
    const key = reactionKey(r);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const reactions: IReaction[] = [...counts.entries()]
    .filter(([, count]) => count > 0)
    .map(([reaction, count]) => ({ reaction, count }));

  await Comment.updateOne(filter, { $set: { reactions, updatedAt: new Date() } });

  // Подтянуть сверку: поле, которое воркер РЕАЛЬНО читает (не per-comment).
  await Post.updateOne(
    { 'discussion.chatId': update.chat.id, 'discussion.rootMessageId': comment.threadRootId },
    { $set: { 'discussion.nextCommentsRefreshAt': new Date() } }
  );

  console.log(`[CommentReactions] дифф реакций для комментария ${update.message_id}:`, reactions);
}
