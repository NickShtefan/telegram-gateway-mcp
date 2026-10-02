/**
 * Поиск сообщений: по всем чатам аккаунта, по хэштегу в публичных постах и
 * внутри одного чата.
 *
 * Пагинация глобального поиска взята из channel-scope `globalSearchService.ts`
 * (PaginationState: offsetRate, offsetPeer, offsetId). Там обе функции
 * выбрасывали сообщения и оставляли только каналы; агенту нужны сообщения.
 *
 * Важно: `messages.SearchGlobal` ищет только по чатам аккаунта (каналы, группы или личные диалоги),
 * а `channels.SearchPosts` шлюз использует только для поиска по
 * хэштегу. Полнотекстового поиска по всему Telegram здесь нет.
 */
import bigInt from 'big-integer';
import { Api } from 'teleproto';
import type { AccountIdentity } from '../core/clientPool.js';
import { toInputPeer } from '../core/entities.js';
import type { Tg, TgCallOptions } from '../core/tg.js';
import type { EntitiesRepo, EntityRecord } from '../storage/port.js';
import { PAGE_MAX } from './history.js';
import { normalizeMessages, totalCount, type MessageDto } from './messages.js';

export interface GlobalPosition {
  offsetRate: number;
  offsetPeerKey: string;
  offsetId: number;
}

export interface GlobalSearchParams {
  query: string;
  limit: number;
  minDate?: number;
  maxDate?: number;
  /**
   * Где искать: в каналах, в группах или в личных чатах. Что из найденного в личных
   * чатах отдать агенту, решает инструмент по скоупам: закрытые диалоги отбрасываются.
   */
  where: 'channels' | 'groups' | 'private';
  position?: GlobalPosition;
}

export interface GlobalSearchPage {
  messages: MessageDto[];
  next: GlobalPosition | null;
}

export interface ChatSearchParams {
  query: string;
  limit: number;
  offsetId?: number;
  minDate?: number;
  maxDate?: number;
  /** Только сообщения этого автора. */
  from?: EntityRecord;
  topicId?: number;
}

export interface ChatSearchPage {
  messages: MessageDto[];
  raw: unknown[];
  total: number | null;
  nextOffsetId: number | null;
}

interface SliceLike {
  nextRate?: number;
  messages?: unknown[];
}

export class SearchService {
  constructor(
    private readonly tg: Tg,
    private readonly entities: EntitiesRepo,
  ) {}

  async global(accountId: string, params: GlobalSearchParams, options?: TgCallOptions): Promise<GlobalSearchPage> {
    const limit = Math.min(Math.max(1, params.limit), PAGE_MAX);
    const result = await this.tg.invoke(
      accountId,
      new Api.messages.SearchGlobal({
        q: params.query,
        filter: new Api.InputMessagesFilterEmpty(),
        minDate: params.minDate ?? 0,
        maxDate: params.maxDate ?? 0,
        offsetRate: params.position?.offsetRate ?? 0,
        offsetPeer: this.offsetPeer(accountId, params.position),
        offsetId: params.position?.offsetId ?? 0,
        limit,
        broadcastsOnly: params.where === 'channels' ? true : undefined,
        groupsOnly: params.where === 'groups' ? true : undefined,
        usersOnly: params.where === 'private' ? true : undefined,
      }),
      options,
    );
    // В личных чатах свои сообщения приходят без автора и подписываются аккаунтом.
    return this.globalPage(result, params.where === 'private' ? await this.tg.whoami(accountId) : undefined);
  }

  /** Поиск по хэштегу в публичных постах каналов. */
  async hashtag(accountId: string, hashtag: string, limit: number, position?: GlobalPosition, options?: TgCallOptions): Promise<GlobalSearchPage> {
    const capped = Math.min(Math.max(1, limit), PAGE_MAX);
    const result = await this.tg.invoke(
      accountId,
      new Api.channels.SearchPosts({
        hashtag: hashtag.replace(/^#/, ''),
        offsetRate: position?.offsetRate ?? 0,
        offsetPeer: this.offsetPeer(accountId, position),
        offsetId: position?.offsetId ?? 0,
        limit: capped,
      }),
      options,
    );
    return this.globalPage(result);
  }

  async inChat(accountId: string, chat: EntityRecord, params: ChatSearchParams, options?: TgCallOptions): Promise<ChatSearchPage> {
    const limit = Math.min(Math.max(1, params.limit), PAGE_MAX);
    const result = await this.tg.invoke(
      accountId,
      new Api.messages.Search({
        peer: toInputPeer(chat),
        q: params.query,
        filter: new Api.InputMessagesFilterEmpty(),
        minDate: params.minDate ?? 0,
        maxDate: params.maxDate ?? 0,
        offsetId: params.offsetId ?? 0,
        addOffset: 0,
        limit,
        maxId: 0,
        minId: 0,
        hash: bigInt.zero,
        fromId: params.from ? toInputPeer(params.from) : undefined,
        topMsgId: params.topicId,
      }),
      options,
    );
    const raw = Array.isArray((result as SliceLike).messages) ? ((result as SliceLike).messages as unknown[]) : [];
    // Поиск в личном чате: свои сообщения приходят без fromId и подписываются аккаунтом.
    const self = chat.kind === 'user' ? await this.tg.whoami(accountId) : undefined;
    const messages = normalizeMessages(result, chat.peerKey, self);
    const last = raw[raw.length - 1] as { id?: number } | undefined;
    return {
      messages,
      raw,
      total: totalCount(result),
      nextOffsetId: raw.length < limit || typeof last?.id !== 'number' ? null : last.id,
    };
  }

  private offsetPeer(accountId: string, position?: GlobalPosition): Api.TypeInputPeer {
    if (!position) return new Api.InputPeerEmpty();
    const entity = this.entities.get(accountId, position.offsetPeerKey);
    // Без accessHash позицию не восстановить: начинаем с начала той же оценки.
    return entity && (entity.kind === 'chat' || entity.accessHash !== null) ? toInputPeer(entity) : new Api.InputPeerEmpty();
  }

  private globalPage(result: unknown, self?: AccountIdentity): GlobalSearchPage {
    const slice = result as SliceLike;
    const messages = normalizeMessages(result, undefined, self);
    const rawCount = Array.isArray(slice.messages) ? slice.messages.length : 0;
    const last = messages[messages.length - 1];
    // Telegram может вернуть неполную страницу и при этом иметь продолжение: признак конца это отсутствие nextRate.
    const hasMore = rawCount > 0 && last !== undefined && typeof slice.nextRate === 'number';
    return {
      messages,
      next: hasMore ? { offsetRate: slice.nextRate!, offsetPeerKey: last.chatKey, offsetId: last.id } : null,
    };
  }
}
