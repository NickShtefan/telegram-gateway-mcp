/**
 * Шлюз записи: всё, что меняет что-то в Telegram. Действие сначала
 * оформляется запросом с предпросмотром, выполняется после `tg_confirm`.
 * Сам по себе шлюз ничего не пишет и никого не запускает.
 */
import { GatewayError } from '../core/errors.js';
import type { Runtime } from '../runtime.js';
import type { CommentsService } from '../services/comments.js';
import { WriteService } from '../services/write.js';
import type { EntityRecord } from '../storage/port.js';
import { SqliteStorage } from '../storage/sqlite.js';
import { Approvals } from './approvals.js';
import { WriteStore } from './store.js';

export interface WriteGate {
  store: WriteStore;
  approvals: Approvals;
  write: WriteService;
}

export interface WriteGateDeps {
  runtime: Runtime;
  comments: CommentsService;
  now?: () => number;
}

export function buildWriteGate(deps: WriteGateDeps): WriteGate {
  const { runtime } = deps;
  const { storage, log } = runtime;
  if (!(storage instanceof SqliteStorage)) {
    throw new GatewayError('UNAVAILABLE', 'The write gate needs the SQLite storage.');
  }
  const now = deps.now ?? (() => Date.now());
  const store = new WriteStore(storage, now);
  const approvals = new Approvals({ store, log: log.child('approvals'), now });
  const write = new WriteService({ tg: runtime.tg, store, comments: deps.comments, now, log: log.child('write') });

  const chatOf = (accountId: string, chatKey: string): EntityRecord => {
    const chat = storage.entities.get(accountId, chatKey);
    if (!chat) throw new GatewayError('CHAT_NOT_FOUND', `Chat ${chatKey} is no longer known to account ${accountId}.`);
    return chat;
  };

  approvals.register(
    'reply',
    async approval => {
      const p = approval.payload as { accountId: string; chatKey: string; postId: number; text: string; sendAs?: 'account' | 'channel' };
      const sent = await write.reply({ userId: approval.userId, accountId: p.accountId }, chatOf(p.accountId, p.chatKey), p.postId, p.text, p.sendAs ?? 'account');
      return { summary: sent.link ? `Sent: ${sent.link}` : 'Sent', data: { link: sent.link, message_id: sent.messageId } };
    },
    { editable: true },
  );

  approvals.register(
    'send',
    async approval => {
      const p = approval.payload as { accountId: string; chatKey: string; text: string };
      const sent = await write.send({ userId: approval.userId, accountId: p.accountId }, chatOf(p.accountId, p.chatKey), p.text);
      return { summary: sent.link ? `Sent: ${sent.link}` : 'Sent', data: { message_id: sent.messageId } };
    },
    { editable: true },
  );

  approvals.register('react', async approval => {
    const p = approval.payload as { accountId: string; chatKey: string; messageId: number; emoji: string | null; where: string };
    await write.react({ userId: approval.userId, accountId: p.accountId }, chatOf(p.accountId, p.chatKey), p.messageId, p.emoji);
    return { summary: p.emoji ? `Reaction ${p.emoji} is set on ${p.where}` : `The reaction is removed from ${p.where}` };
  });

  approvals.register('join', async approval => {
    const p = approval.payload as { accountId: string; chatKey?: string; inviteHash?: string; label: string };
    const joined = await write.join(
      { userId: approval.userId, accountId: p.accountId },
      { chat: p.chatKey ? chatOf(p.accountId, p.chatKey) : undefined, inviteHash: p.inviteHash },
    );
    if (joined.outcome === 'requested') return { summary: `A join request to ${p.label} is sent: an admin of the chat has to accept it.`, data: { outcome: joined.outcome } };
    if (joined.outcome === 'already') return { summary: `The account is already a member of ${p.label}.`, data: { outcome: joined.outcome } };
    return { summary: `The account joined ${p.label}. If the chat asks to pass a check, the owner has to do it.`, data: { outcome: joined.outcome } };
  });

  return { store, approvals, write };
}
