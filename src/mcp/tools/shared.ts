/**
 * Общие части инструментов: описания повторяющихся аргументов, подписи чатов,
 * поиск сообщения по ссылке или по паре «чат и id».
 */
import { z } from 'zod';
import { GatewayError } from '../../core/errors.js';
import { safeLabel } from '../../policy/envelope.js';
import { messageLink, parseRef } from '../../services/links.js';
import type { MessageDto } from '../../services/messages.js';
import { chatTypeOf } from '../../services/resolve.js';
import type { EntityRecord } from '../../storage/port.js';
import type { ToolContext } from '../tool.js';

export const accountArg = z
  .string()
  .optional()
  .describe('Gateway account to use. Omit for your default account; tg_status lists your accounts.');

export const chatArg = z.string().describe('Chat: @username, t.me link, invite link, or a numeric chat id printed by other tools.');

export const sinceArg = z.string().optional().describe('Start of the time window: 30d, 12h, 2w (that long ago), 2026-09-01, or ISO date-time (UTC).');
export const untilArg = z.string().optional().describe('End of the time window, same formats as "since". Default: now.');
export const cursorArg = z.string().optional().describe('next_cursor from the previous call of this tool, to get the next page.');
export const topicArg = z.number().int().positive().optional().describe('Forum topic id from tg_list_topics.');

/** Подпись чата для заголовков: `@username` или название в кавычках. */
export function chatLabel(chat: Pick<EntityRecord, 'username' | 'title' | 'peerKey'>): string {
  if (chat.username) return `@${safeLabel(chat.username, 40)}`;
  const title = safeLabel(chat.title, 60);
  return title ? `"${title}" (id ${chat.peerKey})` : `id ${chat.peerKey}`;
}

export function chatHeader(chat: EntityRecord): string {
  return `${chatLabel(chat)} [${chatTypeOf(chat)}]`;
}

/** Ссылка на сообщение чата; для чатов без ссылок null. */
export function linkBuilder(chat: EntityRecord, topicId?: number): (m: MessageDto) => string | null {
  return m => messageLink({ username: chat.username, peerKey: chat.peerKey, messageId: m.id, topicId: topicId ?? m.topicId ?? undefined });
}

export interface MessageLocation {
  accountId: string;
  /** Чат, в котором лежит сообщение. Для комментария это группа обсуждений. */
  chat: EntityRecord;
  messageId: number;
  topicId?: number;
  /** Если запрошен комментарий: канал и пост, под которым он оставлен. */
  commentOf?: { chat: EntityRecord; postId: number };
}

/**
 * Сообщение по ссылке t.me или по паре «чат и id». Ссылка вида
 * `t.me/name/123?comment=45` ведёт к комментарию в группе обсуждений.
 */
export async function locateMessage(
  context: ToolContext,
  args: { link?: string; chat?: string; id?: number; account?: string },
): Promise<MessageLocation> {
  const accountId = context.account(args.account);

  if (args.link) {
    const parsed = parseRef(args.link);
    if (parsed.messageId === undefined) {
      throw new GatewayError('INVALID_ARGUMENT', 'The link points to a chat, not to a message. Pass a message link like https://t.me/name/123.');
    }
    const { chat } = await context.openChat(args.link, accountId);
    if (parsed.commentId !== undefined) {
      const root = await context.services.comments.root(accountId, chat, parsed.messageId);
      return { accountId, chat: root.discussion, messageId: parsed.commentId, commentOf: { chat, postId: parsed.messageId } };
    }
    return { accountId, chat, messageId: parsed.messageId, topicId: parsed.topicId };
  }

  if (!args.chat || args.id === undefined) {
    throw new GatewayError('INVALID_ARGUMENT', 'Pass either "link" (a t.me message link) or both "chat" and "id".');
  }
  const { chat, parsed } = await context.openChat(args.chat, accountId);
  return { accountId, chat, messageId: args.id, topicId: parsed.topicId };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
