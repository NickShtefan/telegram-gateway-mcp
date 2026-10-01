/**
 * Единый вид сообщения для всех инструментов. Объекты teleproto разбираются по
 * `className`, поэтому тестам хватает простых объектов.
 *
 * Разбор медиа перенесён из channel-scope `processMediaClient.ts`
 * (extractMediaMetadata), авторы из helper `commentsRefresher.ts` (authorFromPeer).
 */
import { peerKeyOfPeer } from '../core/entities.js';
import { normalizeReactions, type ReactionCount } from '../core/reactions.js';

export type AuthorKind = 'user' | 'channel' | 'chat' | 'anonymous';

export interface AuthorDto {
  kind: AuthorKind;
  peerKey: string | null;
  name: string | null;
  username: string | null;
  bot: boolean;
}

export type MediaKind =
  | 'photo'
  | 'video'
  | 'gif'
  | 'voice'
  | 'audio'
  | 'sticker'
  | 'document'
  | 'webpage'
  | 'poll'
  | 'geo'
  | 'contact'
  | 'other';

export interface MediaDto {
  kind: MediaKind;
  mime?: string;
  fileName?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  durationSec?: number;
  /** Для ссылок с превью: адрес и заголовок страницы. */
  url?: string;
  title?: string;
  /** Можно ли скачать через tg_get_media. */
  downloadable: boolean;
}

export interface ForwardDto {
  name: string | null;
  peerKey: string | null;
  postId: number | null;
}

export interface MessageDto {
  id: number;
  chatKey: string;
  /** Unix-время, секунды. */
  date: number;
  editDate: number | null;
  text: string;
  author: AuthorDto;
  views: number | null;
  forwards: number | null;
  /** Число комментариев у поста канала или ответов в ветке. */
  replies: number | null;
  /** У поста канала включены комментарии. */
  hasComments: boolean;
  reactions: ReactionCount[];
  media: MediaDto | null;
  /** Альбом: общий id у всех его сообщений. */
  groupedId: string | null;
  replyToId: number | null;
  /** Тема форума. */
  topicId: number | null;
  forwardedFrom: ForwardDto | null;
  /** Ссылки из текста и из скрытых гиперссылок. */
  links: string[];
  /** Служебное сообщение: имя действия, например MessageActionChatAddUser. */
  service: string | null;
  pinned: boolean;
  out: boolean;
}

interface RawUser {
  id?: unknown;
  username?: string | null;
  usernames?: Array<{ username?: string; active?: boolean }> | null;
  firstName?: string | null;
  lastName?: string | null;
  bot?: boolean;
  deleted?: boolean;
}

interface RawChat {
  id?: unknown;
  username?: string | null;
  usernames?: Array<{ username?: string; active?: boolean }> | null;
  title?: string | null;
}

export interface EntityIndex {
  /** По «голому» id строкой. */
  users: Map<string, RawUser>;
  chats: Map<string, RawChat>;
}

/** Индекс пользователей и чатов из ответа Telegram: нужен, чтобы подписать авторов. */
export function indexEntities(result: unknown): EntityIndex {
  const r = result as { users?: unknown; chats?: unknown } | null;
  const index: EntityIndex = { users: new Map(), chats: new Map() };
  if (!r || typeof r !== 'object') return index;
  if (Array.isArray(r.users)) {
    for (const u of r.users as RawUser[]) if (u && u.id !== undefined && u.id !== null) index.users.set(String(u.id), u);
  }
  if (Array.isArray(r.chats)) {
    for (const c of r.chats as RawChat[]) if (c && c.id !== undefined && c.id !== null) index.chats.set(String(c.id), c);
  }
  return index;
}

function activeUsername(e: { username?: string | null; usernames?: Array<{ username?: string; active?: boolean }> | null }): string | null {
  if (typeof e.username === 'string' && e.username) return e.username;
  const active = Array.isArray(e.usernames) ? e.usernames.find(u => u?.active && u.username) : undefined;
  return active?.username ?? null;
}

interface RawPeer {
  className?: string;
  userId?: unknown;
  chatId?: unknown;
  channelId?: unknown;
}

/** Автор по `fromId`: человек, канал или аноним (админ, пишущий от имени группы). */
export function authorFromPeer(fromId: unknown, index: EntityIndex, postAuthor?: string | null): AuthorDto {
  const peer = fromId as RawPeer | null;
  if (peer && peer.userId !== undefined && peer.userId !== null) {
    const user = index.users.get(String(peer.userId));
    const name = user ? [user.firstName, user.lastName].filter(Boolean).join(' ').trim() : '';
    return {
      kind: 'user',
      peerKey: peerKeyOfPeer(peer),
      name: name || (user?.deleted ? 'Deleted Account' : null),
      username: user ? activeUsername(user) : null,
      bot: user?.bot === true,
    };
  }
  if (peer && (peer.channelId !== undefined || peer.chatId !== undefined)) {
    const raw = peer.channelId ?? peer.chatId;
    const chat = index.chats.get(String(raw));
    return {
      kind: peer.channelId !== undefined ? 'channel' : 'chat',
      peerKey: peerKeyOfPeer(peer),
      name: chat?.title ?? null,
      username: chat ? activeUsername(chat) : null,
      bot: false,
    };
  }
  return { kind: 'anonymous', peerKey: null, name: postAuthor ?? null, username: null, bot: false };
}

interface RawAttribute {
  className?: string;
  fileName?: string;
  duration?: number;
  w?: number;
  h?: number;
  voice?: boolean;
  roundMessage?: boolean;
}

interface RawMedia {
  className?: string;
  photo?: { className?: string; sizes?: Array<{ w?: number; h?: number }> } | null;
  document?: { className?: string; mimeType?: string; size?: unknown; attributes?: RawAttribute[] } | null;
  webpage?: { className?: string; url?: string; title?: string; siteName?: string } | null;
}

export function normalizeMedia(media: unknown): MediaDto | null {
  const m = media as RawMedia | null;
  if (!m || typeof m !== 'object' || !m.className || m.className === 'MessageMediaEmpty') return null;

  if (m.className === 'MessageMediaPhoto') {
    if (!m.photo || m.photo.className !== 'Photo') return { kind: 'photo', downloadable: false };
    const sizes = (m.photo.sizes ?? []).filter(s => typeof s.w === 'number' && typeof s.h === 'number');
    const largest = sizes.sort((a, b) => (b.w ?? 0) * (b.h ?? 0) - (a.w ?? 0) * (a.h ?? 0))[0];
    return { kind: 'photo', width: largest?.w, height: largest?.h, downloadable: true };
  }

  if (m.className === 'MessageMediaDocument') {
    const doc = m.document;
    if (!doc || doc.className !== 'Document') return { kind: 'document', downloadable: false };
    const attrs = doc.attributes ?? [];
    const has = (name: string): RawAttribute | undefined => attrs.find(a => a.className === name);
    const video = has('DocumentAttributeVideo');
    const audio = has('DocumentAttributeAudio');
    const fileName = has('DocumentAttributeFilename')?.fileName;
    const sizeBytes = doc.size !== undefined && doc.size !== null ? Number(doc.size) : undefined;

    let kind: MediaKind = 'document';
    if (has('DocumentAttributeSticker')) kind = 'sticker';
    else if (has('DocumentAttributeAnimated')) kind = 'gif';
    else if (video) kind = 'video';
    else if (audio) kind = audio.voice ? 'voice' : 'audio';

    return {
      kind,
      mime: doc.mimeType,
      fileName,
      sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : undefined,
      width: video?.w,
      height: video?.h,
      durationSec: video?.duration ?? audio?.duration,
      downloadable: true,
    };
  }

  if (m.className === 'MessageMediaWebPage') {
    if (!m.webpage || m.webpage.className !== 'WebPage') return null;
    return { kind: 'webpage', url: m.webpage.url, title: m.webpage.title ?? m.webpage.siteName, downloadable: false };
  }

  if (m.className === 'MessageMediaPoll') return { kind: 'poll', downloadable: false };
  if (m.className === 'MessageMediaGeo' || m.className === 'MessageMediaGeoLive' || m.className === 'MessageMediaVenue') {
    return { kind: 'geo', downloadable: false };
  }
  if (m.className === 'MessageMediaContact') return { kind: 'contact', downloadable: false };
  return { kind: 'other', downloadable: false };
}

interface RawEntity {
  className?: string;
  offset?: number;
  length?: number;
  url?: string;
}

/** Ссылки из entities: явные URL в тексте и скрытые гиперссылки. */
export function extractLinks(text: string, entities: unknown): string[] {
  if (!Array.isArray(entities)) return [];
  const links: string[] = [];
  for (const e of entities as RawEntity[]) {
    if (!e) continue;
    if (e.className === 'MessageEntityTextUrl' && typeof e.url === 'string' && e.url) {
      links.push(e.url);
    } else if (e.className === 'MessageEntityUrl' && typeof e.offset === 'number' && typeof e.length === 'number') {
      const url = text.slice(e.offset, e.offset + e.length).trim();
      if (url) links.push(url);
    }
  }
  return [...new Set(links)];
}

interface RawMessage {
  className?: string;
  id?: number;
  peerId?: unknown;
  fromId?: unknown;
  date?: number;
  editDate?: number;
  message?: string;
  entities?: unknown;
  media?: unknown;
  views?: number;
  forwards?: number;
  replies?: { replies?: number; comments?: boolean } | null;
  reactions?: unknown;
  groupedId?: unknown;
  replyTo?: { replyToMsgId?: number; replyToTopId?: number; forumTopic?: boolean } | null;
  fwdFrom?: { fromId?: unknown; fromName?: string; channelPost?: number; postAuthor?: string } | null;
  postAuthor?: string;
  post?: boolean;
  pinned?: boolean;
  out?: boolean;
  action?: { className?: string } | null;
}

/**
 * Сообщение teleproto -> MessageDto. Возвращает null для MessageEmpty и мусора.
 * `chatKeyFallback` нужен для личных чатов, где у сообщения может не быть peerId.
 */
export function normalizeMessage(raw: unknown, index: EntityIndex, chatKeyFallback?: string): MessageDto | null {
  const m = raw as RawMessage | null;
  if (!m || typeof m !== 'object' || typeof m.id !== 'number') return null;
  if (m.className !== 'Message' && m.className !== 'MessageService') return null;

  const chatKey = peerKeyOfPeer(m.peerId) ?? chatKeyFallback;
  if (!chatKey) return null;

  const text = typeof m.message === 'string' ? m.message : '';
  // Пост канала без fromId написан самим каналом.
  const author = m.fromId
    ? authorFromPeer(m.fromId, index, m.postAuthor)
    : m.post
      ? authorFromPeer(m.peerId, index, m.postAuthor)
      : authorFromPeer(null, index, m.postAuthor);

  let topicId: number | null = null;
  if (m.replyTo?.forumTopic) {
    topicId = m.replyTo.replyToTopId ?? m.replyTo.replyToMsgId ?? null;
  }

  let forwardedFrom: ForwardDto | null = null;
  if (m.fwdFrom) {
    const from = m.fwdFrom.fromId ? authorFromPeer(m.fwdFrom.fromId, index) : null;
    forwardedFrom = {
      name: from?.name ?? m.fwdFrom.fromName ?? m.fwdFrom.postAuthor ?? null,
      peerKey: from?.peerKey ?? null,
      postId: m.fwdFrom.channelPost ?? null,
    };
  }

  return {
    id: m.id,
    chatKey,
    date: typeof m.date === 'number' ? m.date : 0,
    editDate: typeof m.editDate === 'number' ? m.editDate : null,
    text,
    author,
    views: typeof m.views === 'number' ? m.views : null,
    forwards: typeof m.forwards === 'number' ? m.forwards : null,
    replies: typeof m.replies?.replies === 'number' ? m.replies.replies : null,
    hasComments: m.replies?.comments === true,
    reactions: normalizeReactions(m.reactions),
    media: normalizeMedia(m.media),
    groupedId: m.groupedId !== undefined && m.groupedId !== null ? String(m.groupedId) : null,
    replyToId: m.replyTo?.replyToMsgId ?? null,
    topicId,
    forwardedFrom,
    links: extractLinks(text, m.entities),
    service: m.className === 'MessageService' ? (m.action?.className ?? 'MessageService') : null,
    pinned: m.pinned === true,
    out: m.out === true,
  };
}

/** Все сообщения из ответа Telegram, в исходном порядке. */
export function normalizeMessages(result: unknown, chatKeyFallback?: string): MessageDto[] {
  const r = result as { messages?: unknown } | null;
  if (!r || !Array.isArray(r.messages)) return [];
  const index = indexEntities(result);
  const out: MessageDto[] = [];
  for (const raw of r.messages) {
    const dto = normalizeMessage(raw, index, chatKeyFallback);
    if (dto) out.push(dto);
  }
  return out;
}

/** Общее число сообщений в выборке, если Telegram его сообщил (messages.MessagesSlice, ChannelMessages). */
export function totalCount(result: unknown): number | null {
  const r = result as { count?: unknown; messages?: unknown } | null;
  if (!r || typeof r !== 'object') return null;
  if (typeof r.count === 'number') return r.count;
  return Array.isArray(r.messages) ? r.messages.length : null;
}
