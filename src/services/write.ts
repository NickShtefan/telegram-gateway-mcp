/**
 * Действия: ответ в комментариях, сообщение, реакция, вступление в чат, нажатие
 * inline-кнопки. Вызываются
 * только исполнителями шлюза записи (`writegate/index.ts`), то есть после
 * того, как владелец подтвердил действие через своего агента (`tg_confirm`).
 *
 * Ответ под постом: `GetDiscussionMessage` находит копию поста в группе
 * обсуждений, дальше `SendMessage` ответом на неё (helper `commentsRefresher.ts:311`).
 * Лимиты консервативные: сообщения незнакомым людям самое опасное действие для
 * аккаунта (см. risks.md).
 */
import { randomBytes } from 'node:crypto';
import bigInt from 'big-integer';
import { Api } from 'teleproto';
import type { WriteStore } from '../writegate/store.js';
import { toInputChannel, toInputPeer } from '../core/entities.js';
import { GatewayError, isGatewayError } from '../core/errors.js';
import { createLogger, type Logger } from '../core/log.js';
import type { Tg } from '../core/tg.js';
import type { EntityRecord } from '../storage/port.js';
import { buttonAt, type LocatedButton } from './buttons.js';
import type { CommentsService } from './comments.js';
import type { HistoryService } from './history.js';
import { messageLink } from './links.js';
import type { MessageDto } from './messages.js';

export interface WriteLimits {
  repliesPerDay: number;
  /** Новые диалоги: люди, которым аккаунт ещё не писал. */
  newDialogsPerDay: number;
  joinsPerDay: number;
  reactionsPerDay: number;
}

/**
 * Пределы по умолчанию. Это осторожные числа шлюза, а не правила Telegram:
 * Telegram своих порогов не публикует и наказывает за массовые сообщения
 * незнакомым людям, вступления и реакции (PEER_FLOOD, заморозка аккаунта).
 * Владелец меняет пределы переменными TG_MCP_LIMIT_*; 0 снимает предел.
 */
export const DEFAULT_WRITE_LIMITS: WriteLimits = { repliesPerDay: 20, newDialogsPerDay: 5, joinsPerDay: 5, reactionsPerDay: 30 };

/** Достигнут ли дневной предел; 0 значит, что предела нет. */
function reached(count: number, limit: number): boolean {
  return limit > 0 && count >= limit;
}

const VARIATION_SELECTOR = String.fromCharCode(0xfe0f);

/**
 * Эмодзи реакции в том виде, в каком его принимает Telegram: без селектора
 * варианта (сердце приходит с клавиатуры с ним, а в списке реакций оно без него).
 */
export function normalizeReactionEmoji(raw: unknown): string {
  const emoji = typeof raw === 'string' ? raw.trim().split(VARIATION_SELECTOR).join('') : '';
  if (!emoji || emoji.length > 16 || !/^\p{Extended_Pictographic}/u.test(emoji) || /[\p{L}\p{N}\s]/u.test(emoji)) {
    throw new GatewayError('INVALID_ARGUMENT', 'A reaction is one emoji, for example a thumbs up or a heart.');
  }
  return emoji;
}

export interface WriteContext {
  userId: string;
  accountId: string;
}

/** joined: вступил; requested: заявка ждёт админа чата; already: аккаунт уже был участником. */
export type JoinOutcome = 'joined' | 'requested' | 'already';

export interface SentMessage {
  messageId: number | null;
  link: string | null;
}

export interface ReplyOptions {
  sendAs?: 'account' | 'channel';
  /** Ответить на этот комментарий в ветке поста, а не на сам пост. */
  commentId?: number;
  /** Показать превью первой ссылки из текста. По умолчанию выключено: уходит ровно то, что было в предпросмотре. */
  linkPreview?: boolean;
}

export interface SendOptions {
  /** id сообщения в этом чате, на которое отвечаем. */
  replyToId?: number;
  linkPreview?: boolean;
}

/** Какая кнопка была в предпросмотре: место в клавиатуре и отпечаток. */
export interface ButtonTarget {
  messageId: number;
  row: number;
  position: number;
  fingerprint: string;
}

export interface PressOutcome {
  /** Текст, которым бот ответил на нажатие (всплывающая строка или окно). Чужой текст. */
  answer: string | null;
  alert: boolean;
  /** Ссылка из ответа бота. Шлюз её не открывает. */
  url: string | null;
  /** Нажатие ушло, но бот не ответил Telegram вовремя (BOT_RESPONSE_TIMEOUT). */
  botSilent: boolean;
}

/** Бот отвечает на нажатие не сразу: Telegram сам ждёт его и возвращает BOT_RESPONSE_TIMEOUT. */
const PRESS_DEADLINE_MS = 30_000;

const BUTTON_KIND_TEXT: Record<LocatedButton['kind'], string> = {
  callback: 'a callback button',
  url: 'a link button',
  login: 'a login button',
  webapp: 'a web app button',
  switch_inline: 'an inline query button',
  game: 'a game button',
  buy: 'a payment button',
  profile: 'a profile button',
  copy: 'a copy-text button',
  disabled: 'a disabled button',
  other: 'a button of an unknown kind',
};

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
  store: WriteStore;
  comments: CommentsService;
  history: HistoryService;
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
    // undefined из настроек не должен затирать значение по умолчанию.
    const custom = Object.fromEntries(Object.entries(deps.limits ?? {}).filter(([, v]) => typeof v === 'number'));
    this.limits = { ...DEFAULT_WRITE_LIMITS, ...custom };
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? createLogger('write');
  }

  /** Действующие дневные пределы на аккаунт; 0 значит без предела. */
  get dailyLimits(): WriteLimits {
    return { ...this.limits };
  }

  /**
   * Запись в журнал после того, как действие уже выполнено. Сбой базы здесь не должен
   * превращать отправленное сообщение в «ошибку»: агент повторил бы отправку.
   */
  private record(entry: Parameters<WriteStore['recordWrite']>[0]): void {
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

  /** Дневной предел ответов под постами. Сколько раз отвечать под одним постом, решает владелец. */
  assertCanReply(accountId: string): void {
    if (reached(this.deps.store.writesSince(accountId, 'reply', dayStart(this.now())), this.limits.repliesPerDay)) {
      throw new GatewayError('LIMIT_REACHED', `Daily limit of ${this.limits.repliesPerDay} replies for this account is reached.`);
    }
  }

  /** Ответ в комментариях к посту канала: на сам пост или на один из комментариев под ним. */
  async reply(context: WriteContext, channel: EntityRecord, postId: number, text: string, options: ReplyOptions = {}): Promise<SentMessage> {
    const message = assertMessageText(text);
    this.assertCanReply(context.accountId);
    const root = await this.deps.comments.root(context.accountId, channel, postId);

    const messageId = await this.sendMessage(
      context.accountId,
      new Api.messages.SendMessage({
        peer: toInputPeer(root.discussion),
        message,
        // Ответ на комментарий остаётся в ветке поста: корень ветки передаётся как topMsgId.
        replyTo: options.commentId
          ? new Api.InputReplyToMessage({ replyToMsgId: options.commentId, topMsgId: root.rootId })
          : new Api.InputReplyToMessage({ replyToMsgId: root.rootId }),
        randomId: randomId(),
        noWebpage: options.linkPreview === true ? undefined : true,
        sendAs: options.sendAs === 'channel' ? toInputPeer(channel) : undefined,
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
    if (reached(this.deps.store.newDialogsSince(accountId, dayStart(this.now())), this.limits.newDialogsPerDay)) {
      throw new GatewayError(
        'LIMIT_REACHED',
        `Daily limit of ${this.limits.newDialogsPerDay} new dialogs for this account is reached: messages to people the account has not written to before. The limit is a gateway setting (TG_MCP_LIMIT_NEW_DIALOGS), only the owner can change it.`,
      );
    }
  }

  /** Сообщение в чат или человеку. */
  async send(context: WriteContext, peer: EntityRecord, text: string, options: SendOptions = {}): Promise<SentMessage> {
    const message = assertMessageText(text);
    this.assertCanMessage(context.accountId, peer);
    const messageId = await this.sendMessage(
      context.accountId,
      new Api.messages.SendMessage({
        peer: toInputPeer(peer),
        message,
        randomId: randomId(),
        noWebpage: options.linkPreview === true ? undefined : true,
        replyTo: options.replyToId ? new Api.InputReplyToMessage({ replyToMsgId: options.replyToId }) : undefined,
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
    });
    return {
      messageId,
      link: messageId !== null && peer.kind === 'channel' ? messageLink({ username: peer.username, peerKey: peer.peerKey, messageId }) : null,
    };
  }

  /** Дневной предел реакций: реакции под каждым постом подряд выглядят как накрутка. */
  assertCanReact(accountId: string): void {
    if (reached(this.deps.store.writesSince(accountId, 'react', dayStart(this.now())), this.limits.reactionsPerDay)) {
      throw new GatewayError('LIMIT_REACHED', `Daily limit of ${this.limits.reactionsPerDay} reactions for this account is reached.`);
    }
  }

  /** Ставит реакцию на сообщение; `emoji = null` снимает свою реакцию. */
  async react(context: WriteContext, chat: EntityRecord, messageId: number, emoji: string | null): Promise<void> {
    if (emoji !== null) this.assertCanReact(context.accountId);
    await this.deps.tg.invoke(
      context.accountId,
      new Api.messages.SendReaction({
        peer: toInputPeer(chat),
        msgId: messageId,
        reaction: emoji !== null ? [new Api.ReactionEmoji({ emoticon: normalizeReactionEmoji(emoji) })] : [],
      }),
      { write: true },
    );
    if (emoji === null) return;
    this.record({
      ts: this.now(),
      userId: context.userId,
      accountId: context.accountId,
      kind: 'react',
      chatKey: chat.peerKey,
      postId: messageId,
      sentMessageId: null,
    });
  }

  /**
   * Кнопка сообщения, которую шлюз может нажать. Нажимаются только кнопки callback:
   * ссылки, веб-приложения, вход, оплату и игры шлюз не открывает, пароль 2FA не вводит.
   */
  async findButton(accountId: string, chat: EntityRecord, messageId: number, row: number, position: number): Promise<{ button: LocatedButton; message: MessageDto }> {
    const found = await this.deps.history.byIds(accountId, chat, [messageId]);
    const message = found.messages[0];
    if (!message) throw new GatewayError('MESSAGE_NOT_FOUND', `Message ${messageId} not found in this chat: it was deleted or the id is wrong.`);
    if (message.buttons.length === 0) throw new GatewayError('INVALID_ARGUMENT', `Message ${messageId} has no inline buttons.`);
    const button = buttonAt(found.raw[0], row, position);
    if (!button) {
      throw new GatewayError('INVALID_ARGUMENT', `Message ${messageId} has no button at row ${row}, position ${position}. tg_get_message lists its buttons as row.position.`);
    }
    if (button.kind !== 'callback' || button.data === null) {
      throw new GatewayError(
        'INVALID_ARGUMENT',
        `This is ${BUTTON_KIND_TEXT[button.kind]}. The gateway presses only callback buttons and never opens links, web apps, logins, payments or games: the owner can press it in Telegram.`,
      );
    }
    if (button.needsPassword) {
      throw new GatewayError('INVALID_ARGUMENT', 'This button asks for the 2FA password of the account. The gateway never enters it: the owner can press the button in Telegram.');
    }
    return { button, message };
  }

  /**
   * Нажимает кнопку callback. Сообщение читается заново: если бот его изменил и на
   * этом месте уже другая кнопка, нажатия не будет. Байты callback берутся только из сообщения.
   */
  async press(context: WriteContext, chat: EntityRecord, target: ButtonTarget): Promise<PressOutcome> {
    const found = await this.deps.history.byIds(context.accountId, chat, [target.messageId]);
    if (found.messages.length === 0) {
      throw new GatewayError('MESSAGE_NOT_FOUND', `Message ${target.messageId} is gone: it was deleted. Nothing was pressed.`);
    }
    const button = buttonAt(found.raw[0], target.row, target.position);
    if (!button || button.fingerprint !== target.fingerprint || button.data === null || button.needsPassword) {
      throw new GatewayError('NOT_FOUND', 'The button changed since the preview: the message was edited. Nothing was pressed. Read the message again and prepare a new request.');
    }

    try {
      const reply = (await this.deps.tg.invoke(
        context.accountId,
        new Api.messages.GetBotCallbackAnswer({ peer: toInputPeer(chat), msgId: target.messageId, data: button.data }),
        { write: true, deadlineMs: PRESS_DEADLINE_MS },
      )) as { message?: string; alert?: boolean; url?: string } | null;
      return {
        answer: typeof reply?.message === 'string' && reply.message !== '' ? reply.message : null,
        alert: reply?.alert === true,
        url: typeof reply?.url === 'string' && reply.url !== '' ? reply.url : null,
        botSilent: false,
      };
    } catch (err) {
      // Нажатие дошло до бота, он не ответил вовремя: это исход, а не сбой.
      if (isGatewayError(err) && err.telegramCode === 'BOT_RESPONSE_TIMEOUT') return { answer: null, alert: false, url: null, botSilent: true };
      throw err;
    }
  }

  /** Вступление в публичный чат или по инвайту. Капчу привратника шлюз не проходит. */
  async join(context: WriteContext, target: { chat?: EntityRecord; inviteHash?: string }): Promise<{ chatKey: string | null; outcome: JoinOutcome }> {
    if (reached(this.deps.store.writesSince(context.accountId, 'join', dayStart(this.now())), this.limits.joinsPerDay)) {
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
    });
    return { chatKey, outcome };
  }
}
