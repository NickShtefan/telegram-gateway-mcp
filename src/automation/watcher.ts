/**
 * Наблюдатель: замечает новые посты в чатах, которые добавил агент (решение 15).
 *
 * Сейчас это медленный слой из helper (`statsRefresher.ts`, `ageTiers.ts`):
 * опрос истории по расписанию с последним виденным id в базе. Рестарт не даёт
 * ни дублей, ни пропусков, а читать можно и каналы, где аккаунт не состоит.
 * Быстрый слой на обновлениях GramJS можно добавить поверх: он только будит
 * опрос раньше срока.
 *
 * Один чат, который наблюдают несколько пользователей через один аккаунт,
 * опрашивается один раз.
 */
import { GatewayError, isGatewayError } from '../core/errors.js';
import { createLogger, type Logger } from '../core/log.js';
import { TickWatchdog } from '../core/recovery.js';
import { sleep } from '../core/time.js';
import { oneLine, safeLabel } from '../policy/envelope.js';
import type { HistoryService } from '../services/history.js';
import { messageLink } from '../services/links.js';
import type { MessageDto } from '../services/messages.js';
import type { EntityRecord, Storage } from '../storage/port.js';
import type { AutomationStore, WatchState } from './store.js';

export interface NewPostEvent {
  accountId: string;
  chat: EntityRecord;
  message: MessageDto;
  link: string | null;
}

export interface WatcherOptions {
  store: AutomationStore;
  storage: Storage;
  history: HistoryService;
  /** Вызывается на каждый новый пост: сюда подключаются правила. */
  onNewPost?: (event: NewPostEvent) => void | Promise<void>;
  /** Зависший опрос: процесс должен выйти. */
  onStuck?: (reason: string) => void;
  /** Открыт ли чат пользователю сейчас. Наблюдение не должно пережить доступ. */
  allowed?: (userId: string, accountId: string, chat: EntityRecord) => boolean;
  maxChatsPerAccount?: number;
  baseIntervalMs?: number;
  maxIntervalMs?: number;
  /** Сколько чатов опрашивается за один тик. */
  batch?: number;
  log?: Logger;
  now?: () => number;
}

const PAGE = 20;
const MAX_CATCHUP_PAGES = 5;
const PREVIEW_CHARS = 300;

export class Watcher {
  private readonly store: AutomationStore;
  private readonly storage: Storage;
  private readonly history: HistoryService;
  private readonly onNewPost?: (event: NewPostEvent) => void | Promise<void>;
  private readonly allowed: (userId: string, accountId: string, chat: EntityRecord) => boolean;
  private readonly maxChats: number;
  private readonly baseIntervalMs: number;
  private readonly maxIntervalMs: number;
  private readonly batch: number;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly watchdog: TickWatchdog;

  constructor(options: WatcherOptions) {
    this.store = options.store;
    this.storage = options.storage;
    this.history = options.history;
    this.onNewPost = options.onNewPost;
    this.allowed = options.allowed ?? (() => true);
    this.maxChats = options.maxChatsPerAccount ?? 30;
    this.baseIntervalMs = options.baseIntervalMs ?? 60_000;
    this.maxIntervalMs = options.maxIntervalMs ?? 15 * 60_000;
    this.batch = options.batch ?? 5;
    this.log = options.log ?? createLogger('watcher');
    this.now = options.now ?? (() => Date.now());
    this.watchdog = new TickWatchdog({
      name: 'watcher',
      maxMissedTicks: 60,
      onStuck: missed => options.onStuck?.(`watcher tick is stuck (${missed} ticks missed)`),
      log: this.log,
    });
  }

  /** Добавляет чат в наблюдение пользователя. Подтверждения не требует: наблюдение ничего не пишет. */
  add(userId: string, accountId: string, chat: EntityRecord): { created: boolean; watched: number } {
    const already = this.store.watchState(accountId, chat.peerKey) !== null;
    if (!already && this.store.watchedChatCount(accountId) >= this.maxChats) {
      throw new GatewayError(
        'LIMIT_REACHED',
        `Account "${accountId}" already watches ${this.maxChats} chats, which is the limit: polling more would eat its Telegram rate limit. Remove one with tg_watch first.`,
      );
    }
    const created = this.store.addWatch(userId, accountId, chat.peerKey);
    return { created, watched: this.store.watchedChatCount(accountId) };
  }

  remove(userId: string, accountId: string, chatKey: string): boolean {
    return this.store.removeWatch(userId, accountId, chatKey);
  }

  /** Интервал опроса растёт с числом чатов на аккаунте: бюджет запросов у аккаунта один. */
  private baseFor(accountId: string): number {
    return Math.max(this.baseIntervalMs, this.store.watchedChatCount(accountId) * 6_000);
  }

  /** Опрашивает чаты, которым пришло время. Возвращает число новых постов. */
  async tick(): Promise<number> {
    if (!this.watchdog.begin()) return 0;
    let found = 0;
    try {
      for (const state of this.store.dueWatchStates(this.batch)) {
        found += await this.poll(state);
      }
    } finally {
      this.watchdog.end();
    }
    return found;
  }

  private async poll(state: WatchState): Promise<number> {
    const { accountId, chatKey } = state;
    const chat = this.storage.entities.get(accountId, chatKey);
    const base = this.baseFor(accountId);
    if (!chat) {
      this.store.updateWatchState(accountId, chatKey, { nextPollAt: this.now() + 60 * 60_000, lastError: 'chat is no longer in the entity cache' });
      return 0;
    }

    // Доступ могли закрыть после того, как чат добавили в наблюдение: такие наблюдения снимаются.
    for (const userId of this.store.watchersOf(accountId, chatKey)) {
      if (!this.allowed(userId, accountId, chat)) this.store.removeWatch(userId, accountId, chatKey);
    }
    if (this.store.watchersOf(accountId, chatKey).length === 0) return 0;

    try {
      const fresh: MessageDto[] = [];
      let offsetId = 0;
      let newest = state.lastSeenId;
      for (let page = 0; page < (state.baselineDone ? MAX_CATCHUP_PAGES : 1); page++) {
        const result = await this.history.page(accountId, chat, { limit: PAGE, offsetId }, { priority: 'background' });
        if (result.messages.length === 0) break;
        newest = Math.max(newest, ...result.messages.map(m => m.id));
        const unseen = result.messages.filter(m => m.id > state.lastSeenId);
        fresh.push(...unseen);
        // Вся страница новая: возможно, пропущено больше, читаем дальше.
        if (unseen.length < result.messages.length || result.nextOffsetId === null) break;
        offsetId = result.nextOffsetId;
      }

      if (!state.baselineDone) {
        // Первый опрос: запоминаем, где сейчас конец ленты, и о старых постах не сообщаем.
        this.store.updateWatchState(accountId, chatKey, { lastSeenId: newest, baselineDone: true, nextPollAt: this.now() + base, intervalMs: base, lastError: null });
        return 0;
      }

      const posts = this.collapseAlbums(fresh.filter(m => m.service === null)).sort((a, b) => a.id - b.id);
      const watchers = this.store.watchersOf(accountId, chatKey);
      for (const message of posts) {
        const link = messageLink({ username: chat.username, peerKey: chat.peerKey, messageId: message.id, topicId: message.topicId ?? undefined });
        for (const userId of watchers) {
          this.store.addInbox({
            userId,
            kind: 'new_post',
            accountId,
            chatKey,
            messageId: message.id,
            payload: {
              link,
              date: message.date,
              preview: oneLine(message.text, PREVIEW_CHARS),
              media: message.media?.kind ?? null,
              chat: chat.username ? `@${chat.username}` : safeLabel(chat.title, 60) || chatKey,
            },
          });
        }
        try {
          await this.onNewPost?.({ accountId, chat, message, link });
        } catch (err) {
          this.log.error('rule handling failed', { chat: chatKey, message: message.id, error: (err as Error).message });
        }
      }

      // Тихий чат опрашивается всё реже, чат с новыми постами возвращается к базовому интервалу.
      const interval = posts.length > 0 ? base : Math.min(this.maxIntervalMs, Math.max(base, Math.round(state.intervalMs * 1.5)));
      this.store.updateWatchState(accountId, chatKey, { lastSeenId: newest, nextPollAt: this.now() + interval, intervalMs: interval, lastError: null });
      return posts.length;
    } catch (err) {
      const retryMs = isGatewayError(err, 'FLOOD_WAIT')
        ? ((err.retryAfter ?? 60) + 5) * 1000
        : isGatewayError(err, 'CHAT_PRIVATE') || isGatewayError(err, 'CHAT_NOT_FOUND') || isGatewayError(err, 'ACCOUNT_UNAUTHORIZED')
          ? 60 * 60_000
          : Math.min(this.maxIntervalMs, base * 2);
      this.log.warn('poll failed', { account: accountId, chat: chatKey, error: (err as Error).message });
      this.store.updateWatchState(accountId, chatKey, { nextPollAt: this.now() + retryMs, lastError: (err as Error).message.slice(0, 200) });
      return 0;
    }
  }

  /** Альбом из нескольких сообщений это один пост: остаётся первое сообщение, текст берётся у того, где он есть. */
  private collapseAlbums(messages: MessageDto[]): MessageDto[] {
    const albums = new Map<string, MessageDto>();
    const out: MessageDto[] = [];
    for (const message of [...messages].sort((a, b) => a.id - b.id)) {
      if (message.groupedId === null) {
        out.push(message);
        continue;
      }
      const first = albums.get(message.groupedId);
      if (!first) {
        albums.set(message.groupedId, message);
        out.push(message);
      } else if (!first.text && message.text) {
        first.text = message.text;
      }
    }
    return out;
  }

  /** Цикл опроса до остановки. */
  async run(signal: AbortSignal, tickMs = 5_000): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.tick();
      } catch (err) {
        this.log.error('watcher tick failed', { error: (err as Error).message });
      }
      await sleep(tickMs);
    }
  }
}
