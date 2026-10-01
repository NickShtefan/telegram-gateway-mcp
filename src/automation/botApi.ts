/**
 * Тонкий клиент Bot API для бота согласований. Без библиотеки: нужны пять
 * методов, а новые поля Bot API (Business-обновления) доступны сразу.
 * Образец отправки с inline-кнопками: canary `src/telegram/telegram.js`,
 * приём обновлений: helper `listenerBot.ts`.
 *
 * Текст всегда отправляется без parse_mode: в черновиках чужой текст, и
 * разметка в нём не должна ничего менять.
 */

export interface InlineButton {
  text: string;
  /** До 64 байт. */
  data: string;
}

export interface BotUser {
  id: number;
  username?: string;
  first_name?: string;
}

export interface BotMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string };
  from?: BotUser;
  text?: string;
  reply_to_message?: { message_id: number };
  business_connection_id?: string;
}

export interface BotCallbackQuery {
  id: string;
  from: BotUser;
  message?: { message_id: number; chat: { id: number; type: string } };
  data?: string;
}

export interface BotUpdate {
  update_id: number;
  message?: BotMessage;
  callback_query?: BotCallbackQuery;
  business_connection?: Record<string, unknown>;
  business_message?: BotMessage;
}

export interface SendOptions {
  buttons?: InlineButton[][];
  replyTo?: number;
  /** Просит клиент Telegram сразу открыть ответ на это сообщение. */
  forceReply?: boolean;
  businessConnectionId?: string;
}

export class BotApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(`Bot API ${method} failed: ${code} ${description}`);
    this.name = 'BotApiError';
  }

  /** Другой процесс уже забирает обновления этого бота. */
  get isConflict(): boolean {
    return this.code === 409;
  }

  /** Человек ещё не нажал Start или заблокировал бота. */
  get cannotReach(): boolean {
    return this.code === 403;
  }
}

export interface BotApi {
  getMe(): Promise<BotUser>;
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<BotUpdate[]>;
  sendMessage(chatId: string | number, text: string, options?: SendOptions): Promise<{ message_id: number }>;
  editMessageText(chatId: string | number, messageId: number, text: string, options?: { buttons?: InlineButton[][] }): Promise<void>;
  answerCallbackQuery(id: string, text?: string): Promise<void>;
}

/** Предел длины сообщения Bot API. */
export const BOT_TEXT_MAX = 4096;

export function clipBotText(text: string): string {
  return text.length <= BOT_TEXT_MAX ? text : text.slice(0, BOT_TEXT_MAX - 1) + '…';
}

function keyboard(buttons?: InlineButton[][]): Record<string, unknown> | undefined {
  if (!buttons) return undefined;
  return { inline_keyboard: buttons.map(row => row.map(b => ({ text: b.text, callback_data: b.data }))) };
}

export class HttpBotApi implements BotApi {
  private readonly base: string;

  constructor(
    token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    baseUrl = 'https://api.telegram.org',
  ) {
    if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) {
      throw new Error('approval bot token has an unexpected format');
    }
    this.base = `${baseUrl}/bot${token}`;
  }

  private async call<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 30_000): Promise<T> {
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) if (value !== undefined) body[key] = value;
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await this.fetchImpl(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: T;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    } | null;
    if (!payload || payload.ok !== true) {
      // Токен в текст ошибки не попадает: в нём только метод, код и описание.
      throw new BotApiError(method, payload?.error_code ?? response.status, payload?.description ?? 'no response body', payload?.parameters?.retry_after);
    }
    return payload.result as T;
  }

  getMe(): Promise<BotUser> {
    return this.call<BotUser>('getMe', {});
  }

  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<BotUpdate[]> {
    return this.call<BotUpdate[]>(
      'getUpdates',
      { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query', 'business_connection', 'business_message'] },
      signal,
      (timeoutSec + 10) * 1000,
    );
  }

  sendMessage(chatId: string | number, text: string, options: SendOptions = {}): Promise<{ message_id: number }> {
    const replyMarkup = options.buttons ? keyboard(options.buttons) : options.forceReply ? { force_reply: true, selective: true } : undefined;
    return this.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text: clipBotText(text),
      reply_markup: replyMarkup,
      reply_parameters: options.replyTo ? { message_id: options.replyTo, allow_sending_without_reply: true } : undefined,
      business_connection_id: options.businessConnectionId,
      link_preview_options: { is_disabled: true },
    });
  }

  async editMessageText(chatId: string | number, messageId: number, text: string, options: { buttons?: InlineButton[][] } = {}): Promise<void> {
    try {
      await this.call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: clipBotText(text),
        reply_markup: keyboard(options.buttons ?? []),
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      // «message is not modified» не ошибка: карточка уже в нужном виде.
      if (err instanceof BotApiError && /not modified/i.test(err.description)) return;
      throw err;
    }
  }

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: id, text });
  }
}
