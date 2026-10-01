/**
 * Действия: ответ в комментариях, сообщение, вступление в чат. Вызываются
 * только исполнителями согласований (`automation/approvals.ts`), то есть после
 * того, как человек нажал кнопку в боте.
 *
 * Ответ под постом: `GetDiscussionMessage` находит копию поста в группе
 * обсуждений, дальше `SendMessage` ответом на неё (helper `commentsRefresher.ts:311`).
 * Лимиты консервативные: сообщения незнакомым людям самое опасное действие для
 * аккаунта (см. risks.md).
 */
import { randomBytes } from 'node:crypto';
import bigInt from 'big-integer';
import { Api } from 'telegram';
import type { AutomationStore } from '../automation/store.js';
import { toInputChannel, toInputPeer } from '../core/entities.js';
import { GatewayError, isGatewayError } from '../core/errors.js';
import { createLogger, type Logger } from '../core/log.js';
import type { Tg } from '../core/tg.js';
import type { EntityRecord } from '../storage/port.js';
import type { CommentsService } from './comments.js';
import { messageLink } from './links.js';

export interface WriteLimits {
  repliesPerDay: number;
  /** Новые диалоги: люди, которым аккаунт ещё не писал. */
  newDialogsPerDay: number;
  joinsPerDay: number;
}

export const DEFAULT_WRITE_LIMITS: WriteLimits = { repliesPerDay: 20, newDialogsPerDay: 5, joinsPerDay: 5 };

export interface WriteContext {
  userId: string;
  accountId: string;
  /** tool, rule:<id> или task:<id>. */
  source: string;
}

/** joined: вступил; requested: заявка ждёт админа чата; already: аккаунт уже был участником. */
export type JoinOutcome = 'joined' | 'requested' | 'already';

export interface SentMessage {
  messageId: number | null;
  link: string | null;
}

/** Предел длины сообщения Telegram. */
export const MESSAGE_MAX_CHARS = 4096;

export function assertMessageText(text: unknown): string {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new GatewayError('INVALID_ARGUMENT', 'Message text is empty.');
  }
  if (text.length > MESSAGE_MAX_CHARS) {
    throw new GatewayError('INVALID_ARGUMENT', `Message text is ${text.length} characters, the Telegram limit is ${MESSAGE_MAX_CHARS}.`);
  }
  return text;
}

function randomId(): bigInt.BigInteger {
  return bigInt(randomBytes(8).readBigInt64BE().toString());
}

interface UpdatesLike {
  className?: string;
  id?: number;
  updates?: Array<{ className?: string; id?: number; message?: { id?: number } }>;
}

/** id отправленного сообщения из ответа Telegram. */
export function sentMessageId(result: unknown): number | null {
  const r = result as UpdatesLike | null;
  if (!r || typeof r !== 'object') return null;
  if (r.className === 'UpdateShortSentMessage' && typeof r.id === 'number') return r.id;
  for (const update of r.updates ?? []) {
    if (update?.className === 'UpdateMessageID' && typeof update.id === 'number') return update.id;
  }
  for (const update of r.updates ?? []) {
    if (typeof update?.message?.id === 'number') return update.message.id;
  }
  return null;
}

function dayStart(now: number): number {
  return now - (now % 86_400_000);
}

export interface WriteServiceDeps {
  tg: Tg;
  store: AutomationStore;
  comments: CommentsService;
  limits?: Partial<WriteLimits>;
  now?: () => number;
  log?: Logger;
}

/** Telegram уже принял сообщение с этим random_id: повтор после обрыва связи, сообщение доставлено. */
function isDuplicateSend(err: unknown): boolean {
  return isGatewayError(err) && err.telegramCode === 'RANDOM_ID_DUPLICATE';
}

export class WriteService {
  private readonly limits: WriteLimits;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly deps: WriteServiceDeps) {
    this.limits = { ...DEFAULT_WRITE_LIMITS, ...deps.limits };
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? createLogger('write');
  }

  /**
   * Запись в журнал после того, как действие уже выполнено. Сбой базы здесь не должен
   * превращать отправленное сообщение в «ошибку»: агент повторил бы отправку.
   */
  private record(entry: Parameters<AutomationStore['recordWrite']>[0]): void {
    try {
      this.deps.store.recordWrite(entry);
    } catch (err) {
      this.log.error('could not record a completed write', { kind: entry.kind, chat: entry.chatKey, error: (err as Error).message });
    }
  }

  private async sendMessage(accountId: string, request: Api.messages.SendMessage): Promise<number | null> {
    try {
      return sentMessageId(await this.deps.tg.invoke(accountId, request, { write: true }));
    } catch (err) {
      if (isDuplicateSend(err)) return null;
      throw err;
    }
  }

  /** Можно ли ещё ответить на этот пост с этого аккаунта: один ответ на пост, чьё бы правило ни сработало. */
  assertCanReply(accountId: string, chatKey: string, postId: number): void {
    if (this.deps.store.hasReply(accountId, chatKey, postId)) {
      throw new GatewayError('LIMIT_REACHED', 'This account has already replied to this post. Only one reply per post is allowed.');
    }
    if (this.deps.store.writesSince(accountId, 'reply', dayStart(this.now())) >= this.limits.repliesPerDay) {
      throw new GatewayError('LIMIT_REACHED', `Daily limit of ${this.limits.repliesPerDay} replies for this account is reached.`);
    }
  }

  /** Ответ в комментариях к посту канала. */
  async reply(context: WriteContext, channel: EntityRecord, postId: number, text: string, sendAs: 'account' | 'channel' = 'account'): Promise<SentMessage> {
    const message = assertMessageText(text);
    this.assertCanReply(context.accountId, channel.peerKey, postId);
    const root = await this.deps.comments.root(context.accountId, channel, postId);

    const messageId = await this.sendMessage(
      context.accountId,
      new Api.messages.SendMessage({
        peer: toInputPeer(root.discussion),
        message,
        replyTo: new Api.InputReplyToMessage({ replyToMsgId: root.rootId }),
        randomId: randomId(),
        noWebpage: true,
        sendAs: sendAs === 'channel' ? toInputPeer(channel) : undefined,
      }),
    );

    this.record({
      ts: this.now(),
      userId: context.userId,
      accountId: context.accountId,
      kind: 'reply',
      chatKey: channel.peerKey,
      postId,
      sentMessageId: messageId,
      source: context.source,
    });
    return {
      messageId,
      link: messageId !== null ? messageLink({ username: channel.username, peerKey: channel.peerKey, messageId: postId, commentId: messageId }) : null,
    };
  }

  /** Можно ли начать диалог с человеком, которому аккаунт ещё не писал. */
  assertCanMessage(accountId: string, peer: EntityRecord): void {
    if (peer.kind !== 'user') return;
    if (peer.meta.bot === true) return;
    if (this.deps.store.hasWrittenTo(accountId, peer.peerKey)) return;
    if (this.deps.store.newDialogsSince(accountId, dayStart(this.now())) >= this.limits.newDialogsPerDay) {
      throw new GatewayError(
        'LIMIT_REACHED',
        `Daily limit of ${this.limits.newDialogsPerDay} new dialogs for this account is reached. Messages to new people are the riskiest action for a Telegram account.`,
      );
    }
  }

  /** Сообщение в чат или человеку. */
  async send(context: WriteContext, peer: EntityRecord, text: string, replyToId?: number): Promise<SentMessage> {
    const message = assertMessageText(text);
    this.assertCanMessage(context.accountId, peer);
    const messageId = await this.sendMessage(
      context.accountId,
      new Api.messages.SendMessage({
        peer: toInputPeer(peer),
        message,
        randomId: randomId(),
        noWebpage: true,
        replyTo: replyToId ? new Api.InputReplyToMessage({ replyToMsgId: replyToId }) : undefined,
      }),
    );
    this.record({
      ts: this.now(),
      userId: context.userId,
      accountId: context.accountId,
      kind: 'send',
      chatKey: peer.peerKey,
      postId: null,
      sentMessageId: messageId,
      source: context.source,
    });
    return {
      messageId,
      link: messageId !== null && peer.kind === 'channel' ? messageLink({ username: peer.username, peerKey: peer.peerKey, messageId }) : null,
    };
  }

  /** Вступление в публичный чат или по инвайту. Капчу привратника шлюз не проходит. */
  async join(context: WriteContext, target: { chat?: EntityRecord; inviteHash?: string }): Promise<{ chatKey: string | null; outcome: JoinOutcome }> {
    if (this.deps.store.writesSince(context.accountId, 'join', dayStart(this.now())) >= this.limits.joinsPerDay) {
      throw new GatewayError('LIMIT_REACHED', `Daily limit of ${this.limits.joinsPerDay} joins for this account is reached.`);
    }
    let chatKey: string | null = null;
    let outcome: JoinOutcome = 'joined';
    try {
      if (target.inviteHash) {
        await this.deps.tg.invoke(context.accountId, new Api.messages.ImportChatInvite({ hash: target.inviteHash }), { write: true });
      } else if (target.chat && target.chat.kind === 'channel') {
        chatKey = target.chat.peerKey;
        await this.deps.tg.invoke(context.accountId, new Api.channels.JoinChannel({ channel: toInputChannel(target.chat) }), { write: true });
      } else {
        throw new GatewayError('INVALID_ARGUMENT', 'Only channels, supergroups and invite links can be joined.');
      }
    } catch (err) {
      // Telegram сообщает эти исходы ошибкой, хотя действие состоялось.
      const code = isGatewayError(err) ? err.telegramCode : undefined;
      if (code === 'INVITE_REQUEST_SENT') outcome = 'requested';
      else if (code === 'USER_ALREADY_PARTICIPANT') return { chatKey, outcome: 'already' };
      else throw err;
    }
    this.record({
      ts: this.now(),
      userId: context.userId,
      accountId: context.accountId,
      kind: 'join',
      chatKey: chatKey ?? `invite:${target.inviteHash}`,
      postId: null,
      sentMessageId: null,
      source: context.source,
    });
    return { chatKey, outcome };
  }
}
