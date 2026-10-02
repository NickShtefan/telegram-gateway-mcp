/**
 * Чтение: лента чата с курсором, окно по датам, тема форума, сообщения по id,
 * контекст вокруг сообщения, альбом целиком.
 *
 * Циклы пагинации взяты из channel-scope: `forwardAnalysisService.ts`
 * (GetHistory с offsetId), `archiveService.ts` (отсечка по дате),
 * `refreshService.ts` (GetMessages пачками по 100).
 */
import bigInt from 'big-integer';
import { Api } from 'teleproto';
import type { AccountIdentity } from '../core/clientPool.js';
import { toInputChannel, toInputPeer } from '../core/entities.js';
import { GatewayError } from '../core/errors.js';
import type { Tg, TgCallOptions } from '../core/tg.js';
import type { EntityRecord } from '../storage/port.js';
import { normalizeMessages, totalCount, type MessageDto } from './messages.js';

/** Предел Telegram на одну страницу истории и на один GetMessages. */
export const PAGE_MAX = 100;

export interface HistoryParams {
  limit: number;
  /** Читать сообщения старше этого id; 0 или не задано: с самого нового. */
  offsetId?: number;
  /** Unix-секунды: не старше и не новее. */
  minDate?: number;
  maxDate?: number;
  topicId?: number;
}

export interface HistoryPage {
  messages: MessageDto[];
  /** Сырые сообщения teleproto в том же порядке: нужны для скачивания медиа. */
  raw: unknown[];
  total: number | null;
  /** id для следующей страницы; null, если дальше ничего нет. */
  nextOffsetId: number | null;
}

interface RawMessage {
  id?: number;
}

function rawMessages(result: unknown): RawMessage[] {
  const messages = (result as { messages?: unknown } | null)?.messages;
  return Array.isArray(messages) ? (messages as RawMessage[]) : [];
}

export class HistoryService {
  constructor(private readonly tg: Tg) {}

  /** В личном чате автора своих сообщений Telegram не присылает: нормализатору нужен сам аккаунт. */
  private async selfIn(accountId: string, chat: EntityRecord): Promise<AccountIdentity | undefined> {
    return chat.kind === 'user' ? this.tg.whoami(accountId) : undefined;
  }

  async page(accountId: string, chat: EntityRecord, params: HistoryParams, options?: TgCallOptions): Promise<HistoryPage> {
    const limit = Math.min(Math.max(1, params.limit), PAGE_MAX);
    const offsetId = params.offsetId ?? 0;
    // offsetDate работает только для первой страницы: дальше позицию задаёт offsetId.
    const offsetDate = offsetId === 0 && params.maxDate ? params.maxDate : 0;
    const peer = toInputPeer(chat);

    const common = { peer, offsetId, offsetDate, addOffset: 0, limit, maxId: 0, minId: 0, hash: bigInt.zero };
    const result = params.topicId
      ? await this.tg.invoke(accountId, new Api.messages.GetReplies({ ...common, msgId: params.topicId }), options)
      : await this.tg.invoke(accountId, new Api.messages.GetHistory(common), options);

    const fetched = rawMessages(result);
    const dtos = normalizeMessages(result, chat.peerKey, await this.selfIn(accountId, chat));

    let reachedMinDate = false;
    let kept = dtos;
    if (params.minDate) {
      kept = dtos.filter(m => m.date >= params.minDate!);
      reachedMinDate = kept.length < dtos.length;
    }
    const keptIds = new Set(kept.map(m => m.id));
    const last = fetched[fetched.length - 1];

    return {
      messages: kept,
      raw: fetched.filter(m => typeof m.id === 'number' && keptIds.has(m.id)),
      total: totalCount(result),
      nextOffsetId: reachedMinDate || fetched.length < limit || typeof last?.id !== 'number' ? null : last.id,
    };
  }

  /** Сообщения по id, до 100 за вызов. Сообщения из других чатов отбрасываются. */
  async byIds(accountId: string, chat: EntityRecord, ids: number[], options?: TgCallOptions): Promise<HistoryPage> {
    const unique = [...new Set(ids)].filter(id => Number.isInteger(id) && id > 0);
    if (unique.length === 0) return { messages: [], raw: [], total: 0, nextOffsetId: null };
    if (unique.length > PAGE_MAX) {
      throw new GatewayError('INVALID_ARGUMENT', `At most ${PAGE_MAX} message ids per call.`);
    }
    const inputIds = unique.map(id => new Api.InputMessageID({ id }));
    const result =
      chat.kind === 'channel'
        ? await this.tg.invoke(accountId, new Api.channels.GetMessages({ channel: toInputChannel(chat), id: inputIds }), options)
        : await this.tg.invoke(accountId, new Api.messages.GetMessages({ id: inputIds }), options);

    // messages.GetMessages ищет по id во всех личных чатах и группах аккаунта:
    // оставляем только сообщения запрошенного чата, иначе это обход скоупов.
    const self = await this.selfIn(accountId, chat);
    const dtos = normalizeMessages(result, chat.kind === 'channel' ? chat.peerKey : undefined, self).filter(m => m.chatKey === chat.peerKey);
    const keptIds = new Set(dtos.map(m => m.id));
    return {
      messages: dtos,
      raw: rawMessages(result).filter(m => typeof m.id === 'number' && keptIds.has(m.id)),
      total: dtos.length,
      nextOffsetId: null,
    };
  }

  /** Сообщение и его окружение: `before` более старых и `after` более новых. */
  async around(
    accountId: string,
    chat: EntityRecord,
    messageId: number,
    before: number,
    after: number,
    topicId?: number,
    options?: TgCallOptions,
  ): Promise<HistoryPage> {
    const b = Math.min(Math.max(0, before), 50);
    const a = Math.min(Math.max(0, after), 50);
    if (a === 0 && b === 0) return this.byIds(accountId, chat, [messageId], options);

    const common = {
      peer: toInputPeer(chat),
      offsetId: messageId,
      // Отрицательный addOffset сдвигает окно к более новым сообщениям.
      addOffset: -(a + 1),
      offsetDate: 0,
      limit: a + b + 1,
      maxId: 0,
      minId: 0,
      hash: bigInt.zero,
    };
    const result = topicId
      ? await this.tg.invoke(accountId, new Api.messages.GetReplies({ ...common, msgId: topicId }), options)
      : await this.tg.invoke(accountId, new Api.messages.GetHistory(common), options);
    const self = await this.selfIn(accountId, chat);
    return { messages: normalizeMessages(result, chat.peerKey, self), raw: rawMessages(result), total: null, nextOffsetId: null };
  }

  /**
   * Альбом целиком по одному его сообщению: соседи с тем же groupedId.
   * В альбоме до 10 сообщений подряд, поэтому хватает окна в 9 в обе стороны.
   */
  async album(accountId: string, chat: EntityRecord, messageId: number, options?: TgCallOptions): Promise<HistoryPage> {
    const window = await this.around(accountId, chat, messageId, 9, 9, undefined, options);
    const anchor = window.messages.find(m => m.id === messageId);
    if (!anchor) {
      throw new GatewayError('MESSAGE_NOT_FOUND', `Message ${messageId} not found in this chat.`);
    }
    if (anchor.groupedId === null) {
      return { ...window, messages: [anchor], raw: window.raw.filter(m => (m as RawMessage).id === messageId) };
    }
    const messages = window.messages.filter(m => m.groupedId === anchor.groupedId).sort((x, y) => x.id - y.id);
    const ids = new Set(messages.map(m => m.id));
    const raw = window.raw
      .filter(m => typeof (m as RawMessage).id === 'number' && ids.has((m as RawMessage).id!))
      .sort((x, y) => (x as RawMessage).id! - (y as RawMessage).id!);
    return { messages, raw, total: messages.length, nextOffsetId: null };
  }
}
