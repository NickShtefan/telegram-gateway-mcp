/**
 * Поиск каналов: по названию, по рекомендациям Telegram и по источникам
 * репостов.
 *
 * Идеи взяты из channel-scope (`recommendationsService.ts`: обход рекомендаций
 * по уровням, `forwardAnalysisService.ts`: подсчёт `fwdFrom` по ленте). Там эти
 * функции брали клиента напрямую; здесь каждый вызов идёт через лимитер, а
 * чаты из ответов попадают в кэш аккаунта, поэтому найденный канал можно сразу
 * открыть другими инструментами.
 */
import { Api } from 'telegram';
import { entityFromApi, peerKeyOfPeer, toInputChannel, type EntityInfo } from '../core/entities.js';
import type { Tg, TgCallOptions } from '../core/tg.js';
import type { EntitiesRepo, EntityRecord } from '../storage/port.js';
import { PAGE_MAX, type HistoryService } from './history.js';
import { chatTypeOf, type ChatType } from './resolve.js';

export interface FoundChat {
  chat: EntityInfo;
  type: ChatType;
  members: number | null;
  /** Аккаунт уже состоит в этом чате. */
  member: boolean;
  verified: boolean;
  scam: boolean;
}

export interface SimilarResult {
  chats: FoundChat[];
  /** Сколько похожих каналов Telegram знает всего: без Premium он показывает только часть. */
  total: number | null;
}

export interface ForwardSource {
  peerKey: string;
  chat: EntityRecord | null;
  count: number;
  /** Unix-секунды самого свежего репоста из этого источника. */
  lastDate: number;
}

export interface ForwardSourcesResult {
  scanned: number;
  forwards: number;
  /** Репосты от людей и из источников, которые скрыли себя. */
  hidden: number;
  sources: ForwardSource[];
  /** Дата самого старого просмотренного сообщения. */
  oldestDate: number | null;
}

export const FIND_MAX = 30;
export const FORWARD_SCAN_MAX = 500;
/** На втором уровне рекомендации берутся только у самых крупных каналов первого. */
const SIMILAR_TOP_PER_LEVEL = 3;
const SIMILAR_MAX = 60;

function toFound(info: EntityInfo, memberHint?: boolean): FoundChat {
  return {
    chat: info,
    type: chatTypeOf(info),
    members: typeof info.meta.participants === 'number' ? info.meta.participants : null,
    member: memberHint ?? info.meta.member === true,
    verified: info.meta.verified === true,
    scam: info.meta.scam === true,
  };
}

function chatInfos(result: unknown): Map<string, EntityInfo> {
  const out = new Map<string, EntityInfo>();
  const chats = (result as { chats?: unknown[] } | null)?.chats;
  for (const item of Array.isArray(chats) ? chats : []) {
    const info = entityFromApi(item);
    if (info && info.kind !== 'user') out.set(info.peerKey, info);
  }
  return out;
}

export class DiscoverService {
  constructor(
    private readonly tg: Tg,
    private readonly entities: EntitiesRepo,
    private readonly history: HistoryService,
  ) {}

  /**
   * Публичные каналы и группы по словам из названия или username. Telegram ищет
   * по именам, а не по содержимому постов.
   */
  async find(accountId: string, query: string, limit: number, options?: TgCallOptions): Promise<FoundChat[]> {
    const result = (await this.tg.invoke(
      accountId,
      new Api.contacts.Search({ q: query, limit: Math.min(Math.max(1, limit), FIND_MAX) }),
      options,
    )) as unknown as { myResults?: unknown[]; results?: unknown[] };
    const infos = chatInfos(result);
    const found: FoundChat[] = [];
    const seen = new Set<string>();
    for (const [peers, mine] of [
      [result.myResults ?? [], true],
      [result.results ?? [], false],
    ] as const) {
      for (const peer of peers) {
        const key = peerKeyOfPeer(peer);
        const info = key !== null ? infos.get(key) : undefined;
        if (!info || seen.has(info.peerKey)) continue;
        seen.add(info.peerKey);
        found.push(toFound(info, mine ? true : undefined));
      }
    }
    return found.slice(0, limit);
  }

  /** Каналы, которые Telegram считает похожими. `depth = 2` добавляет похожие на самые крупные из найденных. */
  async similar(accountId: string, channel: EntityRecord, depth: 1 | 2, options?: TgCallOptions): Promise<SimilarResult> {
    const fetch = async (target: { peerKey: string; accessHash: string | null }): Promise<{ infos: EntityInfo[]; total: number | null }> => {
      const result = await this.tg.invoke(accountId, new Api.channels.GetChannelRecommendations({ channel: toInputChannel(target) }), options);
      const count = (result as { count?: number }).count;
      return { infos: [...chatInfos(result).values()], total: typeof count === 'number' ? count : null };
    };

    const first = await fetch(channel);
    const seen = new Set<string>([channel.peerKey]);
    const chats: FoundChat[] = [];
    const add = (infos: EntityInfo[]): void => {
      for (const info of infos) {
        if (seen.has(info.peerKey) || chats.length >= SIMILAR_MAX) continue;
        seen.add(info.peerKey);
        chats.push(toFound(info));
      }
    };
    add(first.infos);

    if (depth === 2) {
      const seeds = [...chats]
        .filter(c => c.chat.accessHash !== null)
        .sort((a, b) => (b.members ?? 0) - (a.members ?? 0))
        .slice(0, SIMILAR_TOP_PER_LEVEL);
      for (const seed of seeds) {
        try {
          add((await fetch(seed.chat)).infos);
        } catch {
          // Один канал без рекомендаций не должен ломать весь обход.
        }
      }
    }
    return { chats, total: first.total };
  }

  /** Откуда канал репостит: считает источники пересланных сообщений в последних постах. */
  async forwardSources(
    accountId: string,
    chat: EntityRecord,
    params: { posts: number; minDate?: number },
    options?: TgCallOptions,
  ): Promise<ForwardSourcesResult> {
    const wanted = Math.min(Math.max(1, params.posts), FORWARD_SCAN_MAX);
    const counts = new Map<string, { count: number; lastDate: number }>();
    let scanned = 0;
    let forwards = 0;
    let hidden = 0;
    let oldestDate: number | null = null;
    let offsetId = 0;

    while (scanned < wanted) {
      const page = await this.history.page(accountId, chat, { limit: Math.min(PAGE_MAX, wanted - scanned), offsetId, minDate: params.minDate }, options);
      for (const m of page.messages) {
        if (m.service !== null) continue;
        scanned++;
        oldestDate = oldestDate === null ? m.date : Math.min(oldestDate, m.date);
        if (!m.forwardedFrom) continue;
        forwards++;
        const source = m.forwardedFrom.peerKey;
        // Источник репоста интересен, только если это канал или группа, а не человек и не сам чат.
        if (source === null || !source.startsWith('-') || source === chat.peerKey) {
          hidden++;
          continue;
        }
        const entry = counts.get(source) ?? { count: 0, lastDate: 0 };
        entry.count++;
        entry.lastDate = Math.max(entry.lastDate, m.date);
        counts.set(source, entry);
      }
      if (page.nextOffsetId === null) break;
      offsetId = page.nextOffsetId;
    }

    const sources = [...counts.entries()]
      .map(([peerKey, v]) => ({ peerKey, chat: this.entities.get(accountId, peerKey), count: v.count, lastDate: v.lastDate }))
      .sort((a, b) => b.count - a.count || b.lastDate - a.lastDate);
    return { scanned, forwards, hidden, sources, oldestDate };
  }
}
