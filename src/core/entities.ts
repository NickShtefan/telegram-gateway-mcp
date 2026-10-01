/**
 * Сущности Telegram: превращение объектов teleproto в записи кэша и обратно в
 * InputPeer. accessHash привязан к сессии, поэтому кэш ведётся отдельно для
 * каждого аккаунта (см. channel-scope `universalSearchService.ts:269`).
 */
import bigInt from 'big-integer';
import { Api } from 'teleproto';
import { parsePeerKey, peerKey, type PeerKind } from './chatId.js';
import { GatewayError } from './errors.js';

export interface EntityInfo {
  peerKey: string;
  kind: PeerKind;
  accessHash: string | null;
  username: string | null;
  title: string | null;
  meta: Record<string, unknown>;
}

interface ApiEntityLike {
  className?: string;
  id?: unknown;
  accessHash?: unknown;
  username?: string | null;
  usernames?: Array<{ username?: string; active?: boolean }> | null;
  title?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  min?: boolean;
  bot?: boolean;
  deleted?: boolean;
  broadcast?: boolean;
  megagroup?: boolean;
  forum?: boolean;
  left?: boolean;
  scam?: boolean;
  fake?: boolean;
  verified?: boolean;
  participantsCount?: number | null;
}

function idToBigInt(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  try {
    return BigInt(String(value));
  } catch {
    return null;
  }
}

/** Активный username: обычный или первый активный из коллекционных. */
function pickUsername(e: ApiEntityLike): string | null {
  if (typeof e.username === 'string' && e.username) return e.username;
  if (Array.isArray(e.usernames)) {
    const active = e.usernames.find(u => u && u.active && typeof u.username === 'string' && u.username);
    if (active?.username) return active.username;
  }
  return null;
}

/** Объект User, Chat или Channel из ответа Telegram -> запись для кэша. null для всего остального. */
export function entityFromApi(obj: unknown): EntityInfo | null {
  const e = obj as ApiEntityLike | null;
  if (!e || typeof e !== 'object' || typeof e.className !== 'string') return null;
  const id = idToBigInt(e.id);
  if (id === null || id <= 0n) return null;
  // У «min»-объектов accessHash годится не для всех запросов: в кэш его не кладём.
  const hash = e.min ? null : e.accessHash !== undefined && e.accessHash !== null ? String(e.accessHash) : null;

  switch (e.className) {
    case 'User': {
      const name = [e.firstName, e.lastName].filter(Boolean).join(' ').trim();
      return {
        peerKey: peerKey({ kind: 'user', id }),
        kind: 'user',
        accessHash: hash,
        username: pickUsername(e),
        title: name || null,
        meta: e.min ? {} : { bot: e.bot === true, deleted: e.deleted === true },
      };
    }
    case 'Chat':
    case 'ChatForbidden':
      return {
        peerKey: peerKey({ kind: 'chat', id }),
        kind: 'chat',
        accessHash: null,
        username: null,
        title: e.title ?? null,
        meta: e.className === 'Chat' ? { participants: e.participantsCount ?? null } : { forbidden: true },
      };
    case 'Channel':
      return {
        peerKey: peerKey({ kind: 'channel', id }),
        kind: 'channel',
        accessHash: hash,
        username: pickUsername(e),
        title: e.title ?? null,
        meta: e.min
          ? {}
          : {
              broadcast: e.broadcast === true,
              megagroup: e.megagroup === true,
              forum: e.forum === true,
              member: e.left !== true,
              scam: e.scam === true || e.fake === true,
              verified: e.verified === true,
              participants: e.participantsCount ?? null,
            },
      };
    case 'ChannelForbidden':
      return {
        peerKey: peerKey({ kind: 'channel', id }),
        kind: 'channel',
        accessHash: hash,
        username: null,
        title: e.title ?? null,
        meta: { forbidden: true, broadcast: e.broadcast === true, megagroup: e.megagroup === true },
      };
    default:
      return null;
  }
}

/** Собирает все сущности из ответа: поля `users` и `chats` есть почти у каждого метода. */
export function harvestEntities(result: unknown): EntityInfo[] {
  const r = result as { users?: unknown; chats?: unknown; user?: unknown; chat?: unknown } | null;
  if (!r || typeof r !== 'object') return [];
  const out: EntityInfo[] = [];
  for (const list of [r.users, r.chats]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const info = entityFromApi(item);
      if (info) out.push(info);
    }
  }
  for (const single of [r.user, r.chat]) {
    const info = entityFromApi(single);
    if (info) out.push(info);
  }
  return out;
}

interface PeerLike {
  className?: string;
  userId?: unknown;
  chatId?: unknown;
  channelId?: unknown;
}

/** Peer из сообщения (PeerUser, PeerChat, PeerChannel) -> ключ чата. */
export function peerKeyOfPeer(peer: unknown): string | null {
  const p = peer as PeerLike | null;
  if (!p || typeof p !== 'object') return null;
  const pairs: Array<[PeerKind, unknown]> = [
    ['user', p.userId],
    ['chat', p.chatId],
    ['channel', p.channelId],
  ];
  for (const [kind, raw] of pairs) {
    const id = idToBigInt(raw);
    if (id !== null && id > 0n) return peerKey({ kind, id });
  }
  return null;
}

export interface PeerHandle {
  peerKey: string;
  accessHash: string | null;
}

function requireHash(handle: PeerHandle): string {
  if (handle.accessHash === null) {
    throw new GatewayError(
      'CHAT_NOT_FOUND',
      `Chat ${handle.peerKey} is not known to this account yet. Resolve it by username or link with tg_resolve first.`,
    );
  }
  return handle.accessHash;
}

export function toInputPeer(handle: PeerHandle): Api.TypeInputPeer {
  const ref = parsePeerKey(handle.peerKey);
  const id = bigInt(ref.id.toString());
  switch (ref.kind) {
    case 'user':
      return new Api.InputPeerUser({ userId: id, accessHash: bigInt(requireHash(handle)) });
    case 'chat':
      return new Api.InputPeerChat({ chatId: id });
    case 'channel':
      return new Api.InputPeerChannel({ channelId: id, accessHash: bigInt(requireHash(handle)) });
  }
}

export function toInputChannel(handle: PeerHandle): Api.InputChannel {
  const ref = parsePeerKey(handle.peerKey);
  if (ref.kind !== 'channel') {
    throw new GatewayError('INVALID_ARGUMENT', `Chat ${handle.peerKey} is not a channel or supergroup.`);
  }
  return new Api.InputChannel({ channelId: bigInt(ref.id.toString()), accessHash: bigInt(requireHash(handle)) });
}

export function toInputUser(handle: PeerHandle): Api.InputUser {
  const ref = parsePeerKey(handle.peerKey);
  if (ref.kind !== 'user') {
    throw new GatewayError('INVALID_ARGUMENT', `Peer ${handle.peerKey} is not a user.`);
  }
  return new Api.InputUser({ userId: bigInt(ref.id.toString()), accessHash: bigInt(requireHash(handle)) });
}
