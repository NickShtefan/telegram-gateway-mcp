import type TelegramBot from 'node-telegram-bot-api';
import { Api } from 'telegram';
import config from '../config/telegram.js';
import { getGramClient, resolvePeer } from './client/gramClient.js';
import { toBotApiChatId, toMtprotoChannelId, isBotApiChannelId } from './utils/chatId.js';
import { envNumber } from './utils/env.js';

/**
 * Единственный источник истины о группе обсуждений для ОБОИХ стеков
 * (Bot API listener и GramJS-воркер) — docs/comments-collection-design.md §5.2.
 * Разъезд двух независимых резолвов — прямой путь к тому, что realtime и
 * рефрешер смотрят на разные чаты и никогда не сходятся в одну строку.
 *
 * DISCUSSION_CHAT_ID (env, опционально) переопределяет ОБА пути:
 * Bot API-роутинг берёт его как есть, GramJS сверяет с ним фактический
 * linkedChatId и при расхождении отказывается работать (громкая ошибка).
 */

interface DiscussionIds {
  botApiChatId: number;     // -100…
  mtprotoChannelId: number; // голый положительный
}

const RETRY_COOLDOWN_MS = 60_000;
const DEFAULT_LINK_RECHECK_MIN = 60;

let ids: DiscussionIds | null = null;
// id самого КАНАЛА (Bot API форма) — нужен, чтобы отличать реакции
// «от имени канала» (actor_chat.id == id канала) от прочих channel-акторов.
let channelChatId: number | null = null;
let overrideLogged = false;
let discoveryInFlight: Promise<number | null> | null = null;
let lastAttemptAt = 0;
let startupTimer: NodeJS.Timeout | null = null;

// GramJS-сторона: InputPeer группы + null-кэш «у канала нет привязанной группы»
let cachedPeer: Api.TypeInputPeer | null = null;
let peerNullCachedAt: number | null = null;
let peerResolveInFlight: Promise<Api.TypeInputPeer | null> | null = null;

function readOverride(): number | null {
  const raw = process.env.DISCUSSION_CHAT_ID;
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n === 0) {
    if (!overrideLogged) {
      overrideLogged = true;
      console.error(
        `[Discussion] DISCUSSION_CHAT_ID='${raw}' не число — игнорирую override, нужен id в форме -100…`
      );
    }
    return null;
  }
  if (n > 0) {
    // Владелец скопировал голый MTProto-id из логов — конвертируем сами.
    const converted = toBotApiChatId(n);
    if (!overrideLogged) {
      overrideLogged = true;
      console.warn(
        `[Discussion] DISCUSSION_CHAT_ID=${n} задан в MTProto-форме, конвертирую в ${converted} (Bot API-форма)`
      );
    }
    return converted;
  }
  if (!isBotApiChannelId(n)) {
    if (!overrideLogged) {
      overrideLogged = true;
      console.error(
        `[Discussion] DISCUSSION_CHAT_ID=${n} не похож на id супергруппы (-100…) — игнорирую override`
      );
    }
    return null;
  }
  return n;
}

function setIds(botApiChatId: number, source: string): void {
  ids = { botApiChatId, mtprotoChannelId: toMtprotoChannelId(botApiChatId) };
  console.info(
    `[Discussion] группа обсуждений: ${ids.botApiChatId} (MTProto: ${ids.mtprotoChannelId}), источник: ${source}`
  );
}

export function getDiscussionChatIdSync(): number | null {
  return ids ? ids.botApiChatId : null;
}

export function getDiscussionIdsSync(): DiscussionIds | null {
  return ids;
}

/** id канала (Bot API форма) — заполняется при резолве группы любым путём. */
export function getChannelChatIdSync(): number | null {
  return channelChatId;
}

/**
 * Ленивый резолв id группы через Bot API (getChat канала -> linked_chat_id)
 * с кулдауном, чтобы не долбить getChat на каждом сообщении при сбоях.
 */
export async function ensureDiscussionChatId(bot: TelegramBot): Promise<number | null> {
  if (ids) return ids.botApiChatId;

  const override = readOverride();
  if (override !== null) {
    setIds(override, 'DISCUSSION_CHAT_ID (env override)');
    return override;
  }

  if (discoveryInFlight) return discoveryInFlight;
  if (Date.now() - lastAttemptAt < RETRY_COOLDOWN_MS) return null;
  lastAttemptAt = Date.now();

  discoveryInFlight = (async (): Promise<number | null> => {
    try {
      const chat = (await bot.getChat(`@${config.telegram.channelName}`)) as { id?: number; linked_chat_id?: number };
      if (typeof chat.id === 'number' && channelChatId === null) {
        channelChatId = chat.id;
      }
      if (typeof chat.linked_chat_id === 'number') {
        setIds(chat.linked_chat_id, `getChat(@${config.telegram.channelName}).linked_chat_id`);
        return chat.linked_chat_id;
      }
      console.warn('[Discussion] у канала нет привязанной группы обсуждений — комментарии не собираются');
      return null;
    } catch (err) {
      console.error('[Discussion] getChat не удался:', (err as Error).message);
      return null;
    } finally {
      discoveryInFlight = null;
    }
  })();
  return discoveryInFlight;
}

/**
 * id канала нужен независимо от способа обнаружения группы: при
 * DISCUSSION_CHAT_ID-override ensureDiscussionChatId не зовёт getChat, и без
 * этого вызова реакции владельца «как канал» помечались бы isOwner=false до
 * первого GramJS-резолва (окно переоткрывается на каждом рестарте).
 */
async function captureChannelChatId(bot: TelegramBot): Promise<void> {
  if (channelChatId !== null) return;
  try {
    const chat = (await bot.getChat(`@${config.telegram.channelName}`)) as { id?: number };
    if (typeof chat.id === 'number') {
      channelChatId = chat.id;
      console.info(`[Discussion] id канала: ${channelChatId}`);
    }
  } catch (err) {
    console.warn('[Discussion] не удалось получить id канала:', (err as Error).message);
  }
}

/**
 * Стартовая инициализация: резолв с ретраем по таймеру (НЕ лениво от первого
 * сообщения — иначе после рестарта на тихой группе реакции молча дропаются),
 * затем проверка админства бота. Только логи, без exit: канал должен
 * продолжать архивироваться даже при сломанной группе.
 */
export async function initDiscussionChat(bot: TelegramBot): Promise<void> {
  const id = await ensureDiscussionChatId(bot);
  await captureChannelChatId(bot); // override-путь минует getChat — добираем id канала явно
  if (id === null) {
    if (!startupTimer) {
      startupTimer = setInterval(() => {
        void ensureDiscussionChatId(bot).then(resolved => {
          if (resolved !== null && startupTimer) {
            clearInterval(startupTimer);
            startupTimer = null;
            void checkBotIsAdmin(bot, resolved);
          }
        });
      }, RETRY_COOLDOWN_MS);
    }
    return;
  }
  await checkBotIsAdmin(bot, id);
}

async function checkBotIsAdmin(bot: TelegramBot, chatId: number): Promise<void> {
  try {
    const me = await bot.getMe();
    const member = await bot.getChatMember(chatId, me.id);
    if (member.status !== 'administrator' && member.status !== 'creator') {
      console.error(
        `[Discussion] БОТ НЕ АДМИН в группе обсуждений (status=${member.status}): ` +
        'реакции не будут приходить, а при включённом privacy mode — и сами комментарии. ' +
        'Realtime-слой деградирует, останется только GramJS-рефрешер.'
      );
    } else {
      console.info(`[Discussion] бот — ${member.status} группы обсуждений, realtime-слой активен`);
    }
  } catch (err) {
    console.warn('[Discussion] не удалось проверить права бота в группе:', (err as Error).message);
  }
}

interface FullChannelResultLike {
  fullChat?: { id?: unknown; linkedChatId?: unknown };
  chats?: Array<{ id?: unknown; accessHash?: unknown; className?: string }>;
}

/**
 * GramJS-сторона: InputPeer привязанной группы обсуждений.
 * Кэш в памяти; «группы нет» кэшируется с TTL COMMENTS_LINK_RECHECK_MIN (60 мин),
 * чтобы владелец мог привязать группу без рестарта. Таймауты на invoke навешивает
 * вызывающий воркер (runStage), здесь только логика резолва.
 */
export async function resolveDiscussionPeer(channelUsername: string): Promise<Api.TypeInputPeer | null> {
  if (cachedPeer) return cachedPeer;
  const recheckMs = envNumber('COMMENTS_LINK_RECHECK_MIN', DEFAULT_LINK_RECHECK_MIN) * 60 * 1000;
  if (peerNullCachedAt !== null && Date.now() - peerNullCachedAt < recheckMs) return null;
  if (peerResolveInFlight) return peerResolveInFlight;

  peerResolveInFlight = (async (): Promise<Api.TypeInputPeer | null> => {
    try {
      const client = getGramClient();
      const channelPeer = await resolvePeer(channelUsername);
      const res = (await client.invoke(
        new Api.channels.GetFullChannel({ channel: channelPeer })
      )) as unknown as FullChannelResultLike;

      if (res.fullChat?.id !== undefined && res.fullChat.id !== null && channelChatId === null) {
        channelChatId = toBotApiChatId(Number(res.fullChat.id));
      }
      const linked = res.fullChat?.linkedChatId;
      if (linked === undefined || linked === null) {
        peerNullCachedAt = Date.now();
        console.warn(
          `[Discussion] у канала ${channelUsername} нет привязанной группы (GetFullChannel), ` +
          `перепроверка через ${envNumber('COMMENTS_LINK_RECHECK_MIN', DEFAULT_LINK_RECHECK_MIN)} мин`
        );
        return null;
      }

      const mtprotoId = Number(linked);
      const botApiId = toBotApiChatId(mtprotoId);

      const override = readOverride();
      if (override !== null && override !== botApiId) {
        console.error(
          `[Discussion] DISCUSSION_CHAT_ID=${override} не совпадает с фактической привязанной группой ` +
          `${botApiId} — GramJS-сторона отключена, проверьте override`
        );
        peerNullCachedAt = Date.now();
        return null;
      }

      const chat = (res.chats ?? []).find(c => Number(c.id) === mtprotoId);
      if (!chat || chat.accessHash === undefined) {
        console.warn(
          `[Discussion] GetFullChannel не вернул чат ${mtprotoId} с accessHash — не могу построить InputPeer`
        );
        peerNullCachedAt = Date.now();
        return null;
      }

      cachedPeer = new Api.InputPeerChannel({
        channelId: chat.id as never,
        accessHash: chat.accessHash as never,
      });
      // Заполняем общие id, если Bot API-сторона ещё не успела (единый источник для обоих стеков).
      if (!ids) setIds(botApiId, 'channels.GetFullChannel.linkedChatId');
      return cachedPeer;
    } catch (err) {
      console.warn(
        `[Discussion] резолв группы обсуждений через GramJS не удался для ${channelUsername}:`,
        (err as Error).message
      );
      return null;
    } finally {
      peerResolveInFlight = null;
    }
  })();
  return peerResolveInFlight;
}

/** Сброс всего состояния модуля — для юнит-тестов. */
export function __resetDiscussionForTests(): void {
  ids = null;
  channelChatId = null;
  overrideLogged = false;
  discoveryInFlight = null;
  lastAttemptAt = 0;
  if (startupTimer) {
    clearInterval(startupTimer);
    startupTimer = null;
  }
  cachedPeer = null;
  peerNullCachedAt = null;
  peerResolveInFlight = null;
}
