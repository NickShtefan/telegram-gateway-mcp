/**
 * Ошибки шлюза. Любая ошибка Telegram превращается в GatewayError с кодом и
 * текстом, который понятен агенту: что случилось и что делать дальше.
 * Разбор FLOOD_WAIT и классификация перенесены из helper `refreshShared.ts`
 * и channel-scope `rateLimiter.ts`.
 */
import { DeadlineError } from './time.js';

export type GatewayErrorCode =
  | 'FLOOD_WAIT'
  | 'TIMEOUT'
  | 'CHAT_PRIVATE'
  | 'CHAT_NOT_FOUND'
  | 'MESSAGE_NOT_FOUND'
  | 'COMMENTS_UNAVAILABLE'
  | 'INVITE_INVALID'
  | 'JOIN_REQUIRED'
  | 'WRITE_FORBIDDEN'
  | 'PEER_FLOOD'
  | 'PAYMENT_REQUIRED'
  | 'ACCOUNT_UNAUTHORIZED'
  | 'ACCOUNT_FROZEN'
  | 'ACCESS_DENIED'
  | 'CONFIRMATION_REQUIRED'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'LIMIT_REACHED'
  | 'UNAVAILABLE'
  | 'TELEGRAM_ERROR';

export interface GatewayErrorOptions {
  retryAfter?: number;
  /** Для записи: действие могло примениться, результат неизвестен. */
  outcomeUnknown?: boolean;
  /** Исходный код ошибки Telegram, например CHANNEL_PRIVATE. */
  telegramCode?: string;
  cause?: unknown;
}

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly retryAfter?: number;
  readonly outcomeUnknown: boolean;
  readonly telegramCode?: string;

  constructor(code: GatewayErrorCode, message: string, options: GatewayErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'GatewayError';
    this.code = code;
    this.retryAfter = options.retryAfter;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
    this.telegramCode = options.telegramCode;
  }
}

interface TelegramErrorLike {
  seconds?: number;
  message?: string;
  errorMessage?: string;
}

function errorText(err: unknown): string {
  const e = err as TelegramErrorLike | null;
  if (!e || typeof e !== 'object') return typeof err === 'string' ? err : '';
  const parts = [e.errorMessage, e.message].filter((p): p is string => typeof p === 'string' && p.length > 0);
  return parts.join(' ');
}

const WAIT_RE = /(?:FLOOD_PREMIUM_WAIT|FLOOD_TEST_PHONE_WAIT|FLOOD_WAIT|SLOWMODE_WAIT)[_ ]?(\d+)/;

/**
 * Секунды ожидания из ошибки FLOOD_WAIT (и родственных). null, если это не
 * FLOOD_WAIT; 0, если тип ошибки понятен, а число не разобрать.
 */
export function getFloodWaitSeconds(err: unknown): number | null {
  const e = err as TelegramErrorLike | null;
  if (!e || typeof e !== 'object') return null;
  const text = errorText(err);
  const isWait = /FLOOD_PREMIUM_WAIT|FLOOD_TEST_PHONE_WAIT|FLOOD_WAIT|SLOWMODE_WAIT/.test(text);
  if (typeof e.seconds === 'number' && Number.isFinite(e.seconds) && e.seconds >= 0) {
    // GramJS кладёт seconds и в FloodWaitError, и в ошибки миграции: без текста не доверяем.
    if (isWait || text === '') return e.seconds;
  }
  if (!isWait) return null;
  const m = text.match(WAIT_RE);
  return m ? parseInt(m[1]!, 10) : 0;
}

/** Код ошибки Telegram в верхнем регистре, если он есть в тексте. */
export function telegramErrorCode(err: unknown): string | undefined {
  const e = err as TelegramErrorLike | null;
  if (e && typeof e === 'object' && typeof e.errorMessage === 'string' && e.errorMessage) {
    return e.errorMessage;
  }
  const m = errorText(err).match(/\b([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+)\b/);
  return m ? m[1] : undefined;
}

interface Rule {
  match: RegExp;
  code: GatewayErrorCode;
  message: string;
}

const RULES: Rule[] = [
  {
    match: /CHANNEL_PRIVATE|CHAT_ADMIN_REQUIRED|CHANNEL_PUBLIC_GROUP_NA/,
    code: 'CHAT_PRIVATE',
    message:
      'This chat is private or the account is not a member. The owner has to join it first (joining goes through tg_join with confirmation).',
  },
  {
    match: /USERNAME_NOT_OCCUPIED|USERNAME_INVALID|CHANNEL_INVALID|PEER_ID_INVALID|CHAT_ID_INVALID|USER_ID_INVALID/,
    code: 'CHAT_NOT_FOUND',
    message: 'Chat or user not found. Check the username or link, then resolve it again with tg_resolve.',
  },
  {
    match: /MSG_ID_INVALID|MESSAGE_ID_INVALID/,
    code: 'MESSAGE_NOT_FOUND',
    message: 'Message not found: it was deleted, or comments are disabled for this post.',
  },
  {
    match: /INVITE_HASH_EXPIRED|INVITE_HASH_INVALID|INVITE_HASH_EMPTY/,
    code: 'INVITE_INVALID',
    message: 'The invite link is invalid or expired.',
  },
  {
    match: /USER_NOT_PARTICIPANT|CHANNEL_JOIN_REQUIRED/,
    code: 'JOIN_REQUIRED',
    message: 'The account has to be a member of this chat for this action.',
  },
  {
    match: /PEER_FLOOD/,
    code: 'PEER_FLOOD',
    message:
      'Telegram restricted this account from messaging people who are not its contacts (PEER_FLOOD). Stop writing to new people and tell the owner.',
  },
  {
    match: /ALLOW_PAYMENT_REQUIRED|PRIVACY_PREMIUM_REQUIRED|PAYMENT_REQUIRED|STARS_|BALANCE_TOO_LOW/,
    code: 'PAYMENT_REQUIRED',
    message:
      'This action costs Telegram Stars or needs Premium. The gateway never pays automatically: ask the owner.',
  },
  {
    match: /CHAT_WRITE_FORBIDDEN|USER_BANNED_IN_CHANNEL|CHAT_RESTRICTED|CHAT_SEND_PLAIN_FORBIDDEN|USER_IS_BLOCKED|YOU_BLOCKED_USER|CHAT_GUEST_SEND_FORBIDDEN|SEND_AS_PEER_INVALID/,
    code: 'WRITE_FORBIDDEN',
    message: 'The account is not allowed to write here.',
  },
  {
    match: /AUTH_KEY_UNREGISTERED|AUTH_KEY_DUPLICATED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|AUTH_KEY_INVALID/,
    code: 'ACCOUNT_UNAUTHORIZED',
    message: 'The Telegram session of this account is no longer valid. The owner has to log in again (tg-mcp login).',
  },
  {
    match: /FROZEN_/,
    code: 'ACCOUNT_FROZEN',
    message: 'This Telegram account is frozen by Telegram (read-only). Tell the owner: the appeal goes through @SpamBot.',
  },
];

/** Превращает любую ошибку в GatewayError. Уже классифицированные возвращает как есть. */
export function classifyError(err: unknown, context: { write?: boolean } = {}): GatewayError {
  if (err instanceof GatewayError) return err;

  if (err instanceof DeadlineError) {
    return new GatewayError(
      'TIMEOUT',
      context.write
        ? `${err.message}. The outcome is UNKNOWN: the action may already have been applied. Check before repeating it.`
        : `${err.message}. Try again later or narrow the request.`,
      { outcomeUnknown: context.write === true, cause: err },
    );
  }

  const wait = getFloodWaitSeconds(err);
  if (wait !== null) {
    return new GatewayError(
      'FLOOD_WAIT',
      `Telegram rate limit: wait ${wait} seconds. Do NOT retry before retry_after.`,
      { retryAfter: wait, telegramCode: telegramErrorCode(err), cause: err },
    );
  }

  const text = errorText(err);
  for (const rule of RULES) {
    if (rule.match.test(text)) {
      return new GatewayError(rule.code, rule.message, { telegramCode: telegramErrorCode(err), cause: err });
    }
  }

  const code = telegramErrorCode(err);
  const detail = code ?? (text || 'unknown error');
  return new GatewayError('TELEGRAM_ERROR', `Telegram error: ${detail}`, { telegramCode: code, cause: err });
}

export function isGatewayError(err: unknown, code?: GatewayErrorCode): err is GatewayError {
  return err instanceof GatewayError && (code === undefined || err.code === code);
}
