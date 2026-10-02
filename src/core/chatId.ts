/**
 * Единая форма id чатов. Внутри шлюза чат всегда записан «помеченным» id
 * в форме Bot API: пользователь `123`, обычная группа `-123`, канал или
 * супергруппа `-100…`.
 */
const CHANNEL_OFFSET = 1_000_000_000_000n;

export type PeerKind = 'user' | 'chat' | 'channel';

export interface PeerRef {
  kind: PeerKind;
  /** «Голый» положительный id из MTProto. */
  id: bigint;
}

function toBigInt(value: number | bigint | string, what: string): bigint {
  try {
    const b = typeof value === 'bigint' ? value : BigInt(typeof value === 'number' ? Math.trunc(value) : value.trim());
    if (typeof value === 'number' && (!Number.isFinite(value) || !Number.isInteger(value))) {
      throw new Error('not an integer');
    }
    return b;
  } catch {
    throw new Error(`${what}: expected an integer id, got ${String(value)}`);
  }
}

/** MTProto channel_id -> Bot API id (`-100…`). */
export function toBotApiChatId(mtprotoChannelId: number | bigint | string): string {
  const id = toBigInt(mtprotoChannelId, 'toBotApiChatId');
  if (id <= 0n) throw new Error(`toBotApiChatId: expected a positive MTProto channel id, got ${String(mtprotoChannelId)}`);
  return (-(CHANNEL_OFFSET + id)).toString();
}

/** Bot API id (`-100…`) -> MTProto channel_id. */
export function toMtprotoChannelId(botApiChatId: number | bigint | string): bigint {
  const id = toBigInt(botApiChatId, 'toMtprotoChannelId');
  if (id >= -CHANNEL_OFFSET) {
    throw new Error(`toMtprotoChannelId: expected a Bot API chat id in the -100… form, got ${String(botApiChatId)}`);
  }
  return -id - CHANNEL_OFFSET;
}

export function isBotApiChannelId(value: number | bigint | string): boolean {
  try {
    return toBigInt(value, 'isBotApiChannelId') < -CHANNEL_OFFSET;
  } catch {
    return false;
  }
}

/** Ключ чата для хранения и вывода: помеченный id строкой. */
export function peerKey(ref: PeerRef): string {
  if (ref.id <= 0n) throw new Error(`peerKey: expected a positive id, got ${ref.id}`);
  switch (ref.kind) {
    case 'user':
      return ref.id.toString();
    case 'chat':
      return (-ref.id).toString();
    case 'channel':
      return (-(CHANNEL_OFFSET + ref.id)).toString();
  }
}

/** Обратное преобразование: помеченный id -> тип и «голый» id. */
export function parsePeerKey(key: string | number | bigint): PeerRef {
  const id = toBigInt(key, 'parsePeerKey');
  if (id === 0n) throw new Error('parsePeerKey: id must not be zero');
  if (id > 0n) return { kind: 'user', id };
  if (id < -CHANNEL_OFFSET) return { kind: 'channel', id: -id - CHANNEL_OFFSET };
  return { kind: 'chat', id: -id };
}

/** Похожа ли строка на помеченный id чата (а не на username или ссылку). */
export function looksLikePeerKey(value: string): boolean {
  return /^-?\d{1,20}$/.test(value.trim());
}
