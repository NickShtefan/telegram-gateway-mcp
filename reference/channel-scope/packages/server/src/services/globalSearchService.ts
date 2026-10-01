import { getChannelUsername, getExistingChannelIds } from './telegramUtils.js';
import bigInt from 'big-integer';
import { Api } from 'telegram';
import { rateLimiter } from './rateLimiter.js';
import type { DiscoverResult } from './discoverService.js';

const DEFAULT_LIMIT = 50;
const SEARCH_PAGE_SIZE = 20;

interface PaginationState {
  offsetRate: number;
  offsetPeer: Api.TypeInputPeer;
  offsetId: number;
}

/**
 * Extract unique Api.Channel objects from a list of chats by channel ID.
 */
function extractUniqueChannels(
  chats: Api.TypeChat[],
  seen: Set<string>,
): Api.Channel[] {
  const channels: Api.Channel[] = [];
  for (const chat of chats) {
    if (chat.className !== 'Channel') continue;
    const ch = chat as Api.Channel;
    const id = ch.id.toString();
    if (seen.has(id)) continue;
    seen.add(id);
    channels.push(ch);
  }
  return channels;
}

/**
 * Map Api.Channel objects to light DiscoverResult[] (no GetFullChannel).
 * Description and linkedGroup will be empty — enriched on frontend via /enrich.
 */
async function mapToLightResults(channels: Api.Channel[]): Promise<DiscoverResult[]> {
  const { existingIds, researchIds } = await getExistingChannelIds();

  return channels.map(ch => {
    const channelId = getChannelUsername(ch) || ch.id.toString();
    return {
      channelId,
      title: ch.title || '',
      username: getChannelUsername(ch),
      description: '',
      subscriberCount: (ch as unknown as { participantsCount?: number }).participantsCount ?? 0,
      hasAvatar: false,
      linkedGroup: null,
      alreadyAdded: existingIds.has(channelId) || researchIds.has(channelId),
      telegramId: ch.id.toString(),
      accessHash: ch.accessHash != null ? ch.accessHash.toString() : undefined,
    };
  });
}

/**
 * Global text search across public Telegram channels (broadcasts only).
 * Uses Api.messages.SearchGlobal with pagination.
 * Returns light results — enrich on frontend via /api/channels/:id/enrich.
 */
export async function searchGlobal(
  query: string,
  limit: number = DEFAULT_LIMIT,
  clientId: string | null = null,
): Promise<DiscoverResult[]> {
  const seenIds = new Set<string>();
  const allChannels: Api.Channel[] = [];

  let pagination: PaginationState = {
    offsetRate: 0,
    offsetPeer: new Api.InputPeerEmpty(),
    offsetId: 0,
  };

  while (allChannels.length < limit) {
    const result = await rateLimiter.invoke<Api.messages.TypeMessages>(
      new Api.messages.SearchGlobal({
        q: query,
        filter: new Api.InputMessagesFilterEmpty(),
        minDate: 0,
        maxDate: 0,
        offsetRate: pagination.offsetRate,
        offsetPeer: pagination.offsetPeer,
        offsetId: pagination.offsetId,
        limit: SEARCH_PAGE_SIZE,
        broadcastsOnly: true,
      }),
      clientId,
    );

    if (!('chats' in result) || !result.chats || result.chats.length === 0) break;

    const newChannels = extractUniqueChannels(result.chats, seenIds);
    allChannels.push(...newChannels);

    // Check if we have more pages
    if (!('messages' in result) || !result.messages || result.messages.length === 0) break;

    const messages = result.messages;
    const lastMessage = messages[messages.length - 1];

    if (!lastMessage || lastMessage.className === 'MessageEmpty') break;

    const msg = lastMessage as Api.Message;
    const nextOffsetRate = ('nextRate' in result && typeof result.nextRate === 'number')
      ? result.nextRate
      : 0;

    if (nextOffsetRate === 0 && messages.length < SEARCH_PAGE_SIZE) break;

    const peerId = msg.peerId;
    let offsetPeer: Api.TypeInputPeer = new Api.InputPeerEmpty();
    if (peerId && peerId.className === 'PeerChannel') {
      const peerChannel = peerId as Api.PeerChannel;
      const matchedChat = result.chats.find(c => c.id.toString() === peerChannel.channelId.toString());
      if (matchedChat && matchedChat.className === 'Channel') {
        const matchedCh = matchedChat as Api.Channel;
        offsetPeer = new Api.InputPeerChannel({
          channelId: matchedCh.id,
          accessHash: matchedCh.accessHash ?? bigInt(0),
        });
      }
    }

    pagination = {
      offsetRate: nextOffsetRate,
      offsetPeer,
      offsetId: msg.id,
    };
  }

  const trimmed = allChannels.slice(0, limit);
  return mapToLightResults(trimmed);
}

/**
 * Search for channels by hashtag using Api.channels.SearchPosts.
 * Accepts hashtag with or without # prefix.
 * Returns light results — enrich on frontend via /api/channels/:id/enrich.
 */
export async function searchByHashtag(
  hashtag: string,
  limit: number = DEFAULT_LIMIT,
  clientId: string | null = null,
): Promise<DiscoverResult[]> {
  const tag = hashtag.startsWith('#') ? hashtag : `#${hashtag}`;
  const seenIds = new Set<string>();
  const allChannels: Api.Channel[] = [];

  let pagination: PaginationState = {
    offsetRate: 0,
    offsetPeer: new Api.InputPeerEmpty(),
    offsetId: 0,
  };

  while (allChannels.length < limit) {
    const result = await rateLimiter.invoke<Api.messages.TypeMessages>(
      new Api.channels.SearchPosts({
        hashtag: tag,
        offsetRate: pagination.offsetRate,
        offsetPeer: pagination.offsetPeer,
        offsetId: pagination.offsetId,
        limit: SEARCH_PAGE_SIZE,
      }),
      clientId,
    );

    if (!('chats' in result) || !result.chats || result.chats.length === 0) break;

    const newChannels = extractUniqueChannels(result.chats, seenIds);
    allChannels.push(...newChannels);

    if (!('messages' in result) || !result.messages || result.messages.length === 0) break;

    const messages = result.messages;
    const lastMessage = messages[messages.length - 1];

    if (!lastMessage || lastMessage.className === 'MessageEmpty') break;

    const msg = lastMessage as Api.Message;
    const nextOffsetRate = ('nextRate' in result && typeof result.nextRate === 'number')
      ? result.nextRate
      : 0;

    if (nextOffsetRate === 0 && messages.length < SEARCH_PAGE_SIZE) break;

    const peerId = msg.peerId;
    let offsetPeer: Api.TypeInputPeer = new Api.InputPeerEmpty();
    if (peerId && peerId.className === 'PeerChannel') {
      const peerChannel = peerId as Api.PeerChannel;
      const matchedChat = result.chats.find(c => c.id.toString() === peerChannel.channelId.toString());
      if (matchedChat && matchedChat.className === 'Channel') {
        const matchedCh = matchedChat as Api.Channel;
        offsetPeer = new Api.InputPeerChannel({
          channelId: matchedCh.id,
          accessHash: matchedCh.accessHash ?? bigInt(0),
        });
      }
    }

    pagination = {
      offsetRate: nextOffsetRate,
      offsetPeer,
      offsetId: msg.id,
    };
  }

  const trimmed = allChannels.slice(0, limit);
  return mapToLightResults(trimmed);
}
