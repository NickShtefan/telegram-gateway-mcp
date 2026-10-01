/**
 * Темы форумов. Многие барахолки устроены как форум: «Продам», «Куплю»,
 * «Обмен». Список тем нужен, чтобы поиск, лента и выгрузка не смешивали
 * продажу с покупкой.
 */
import { Api } from 'telegram';
import { toInputChannel } from '../core/entities.js';
import { GatewayError, isGatewayError } from '../core/errors.js';
import type { Tg, TgCallOptions } from '../core/tg.js';
import type { EntityRecord } from '../storage/port.js';

export interface TopicDto {
  id: number;
  title: string;
  /** id последнего сообщения в теме. */
  topMessageId: number | null;
  closed: boolean;
  pinned: boolean;
  hidden: boolean;
  /** Unix-секунды создания темы. */
  date: number | null;
}

export interface TopicsPage {
  topics: TopicDto[];
  total: number | null;
}

interface RawTopic {
  className?: string;
  id?: number;
  title?: string;
  topMessage?: number;
  closed?: boolean;
  pinned?: boolean;
  hidden?: boolean;
  date?: number;
}

export class TopicsService {
  constructor(private readonly tg: Tg) {}

  async list(accountId: string, chat: EntityRecord, params: { query?: string; limit: number }, options?: TgCallOptions): Promise<TopicsPage> {
    if (chat.kind !== 'channel') {
      throw new GatewayError('INVALID_ARGUMENT', 'Forum topics exist only in supergroups with topics enabled.');
    }
    let result: { count?: number; topics?: RawTopic[] };
    try {
      result = (await this.tg.invoke(
        accountId,
        new Api.channels.GetForumTopics({
          channel: toInputChannel(chat),
          q: params.query || undefined,
          offsetDate: 0,
          offsetId: 0,
          offsetTopic: 0,
          limit: Math.min(Math.max(1, params.limit), 100),
        }),
        options,
      )) as unknown as { count?: number; topics?: RawTopic[] };
    } catch (err) {
      if (isGatewayError(err, 'TELEGRAM_ERROR') && /FORUM/.test(err.telegramCode ?? '')) {
        throw new GatewayError('INVALID_ARGUMENT', 'This chat is not a forum: it has no topics. Read it with tg_read_history without topic.', {
          cause: err,
        });
      }
      throw err;
    }

    const topics = (result.topics ?? [])
      .filter(t => t && t.className === 'ForumTopic' && typeof t.id === 'number')
      .map(t => ({
        id: t.id!,
        title: t.title ?? '',
        topMessageId: typeof t.topMessage === 'number' ? t.topMessage : null,
        closed: t.closed === true,
        pinned: t.pinned === true,
        hidden: t.hidden === true,
        date: typeof t.date === 'number' ? t.date : null,
      }));
    return { topics, total: typeof result.count === 'number' ? result.count : null };
  }
}
