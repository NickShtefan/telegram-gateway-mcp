import fs from 'fs';
import path from 'path';
import { Api } from 'telegram';
import bigInt from 'big-integer';
import { ROOT_DIR } from '../config/paths.js';
import { searchChannels, type DiscoverResult } from './discoverService.js';
import { clientManager } from './clientManager.js';
import { rateLimiter } from './rateLimiter.js';
import { getChannelUsername, getChannelFullInfo, getExistingChannelIds } from './telegramUtils.js';
import { getRecursiveRecommendationsLight } from './recommendationsService.js';

export interface UniversalSearchResult extends DiscoverResult {
  source: 'search' | 'recommendations' | 'hashtag';
}

/**
 * Light channel info — extracted from Api.Channel without GetFullChannel.
 */
interface LightChannel {
  channel: Api.Channel;
  source: UniversalSearchResult['source'];
}

/**
 * Phase 1: Collect channels from all sources WITHOUT calling GetFullChannel.
 * Fast — only search/list API calls.
 */
async function collectChannels(
  query: string,
  limit: number,
  clientId: string | null,
): Promise<LightChannel[]> {
  const isUsername = query.startsWith('@');
  const isHashtag = query.startsWith('#');
  const cleanQuery = query.replace(/^[@#]/, '');
  const seen = new Set<string>();
  const channels: LightChannel[] = [];

  function addChannel(ch: Api.Channel, source: UniversalSearchResult['source']) {
    const key = ch.id.toString();
    if (seen.has(key)) return;
    seen.add(key);
    channels.push({ channel: ch, source });
  }

  const client = await clientManager.getFirstActiveClient();
  if (!client) throw new Error('No active Telegram client available');

  // Step 1: Keyword search first (fast, gives us seed channels for recommendations)
  try {
    const searchResults = await Promise.race([
      searchChannelsLight(cleanQuery, clientId),
      new Promise<Api.Channel[]>(resolve => setTimeout(() => resolve([]), 10_000)),
    ]);
    searchResults.forEach(ch => addChannel(ch, 'search'));
  } catch (err) { console.warn('[Search] Error:', (err as Error).message); }

  // Step 2: Recursive recommendations (depth=2) — highest-quality results
  if (isUsername) {
    try {
      const resolveResult = await rateLimiter.invoke<Api.contacts.ResolvedPeer>(
        new Api.contacts.ResolveUsername({ username: cleanQuery }),
        clientId,
      );
      const chat = resolveResult.chats[0];
      if (chat && chat instanceof Api.Channel) {
        const recs = await getRecursiveRecommendationsLight(chat, 2, limit, 3);
        console.log(`[Universal] Got ${recs.length} recursive recommendations for @${cleanQuery}`);
        recs.forEach(ch => addChannel(ch, 'recommendations'));
      }
    } catch (err) { console.warn('[Search] Error:', (err as Error).message); }
  } else if (!isHashtag) {
    // Try recursive recommendations from the largest channel with username
    const candidates = channels
      .filter(c => getChannelUsername(c.channel) && ((c.channel as unknown as { participantsCount?: number }).participantsCount || 0) > 500)
      .sort((a, b) =>
        ((b.channel as unknown as { participantsCount?: number }).participantsCount || 0) -
        ((a.channel as unknown as { participantsCount?: number }).participantsCount || 0)
      )
      .slice(0, 3);

    let gotRecs = false;
    for (const candidate of candidates) {
      try {
        const username = getChannelUsername(candidate.channel);
        console.log(`[Universal] Trying recursive recommendations for @${username}`);
        const recs = await getRecursiveRecommendationsLight(candidate.channel, 2, limit, 3);
        if (recs.length > 0) {
          console.log(`[Universal] Got ${recs.length} recursive recommendations from @${username}`);
          recs.forEach(ch => addChannel(ch, 'recommendations'));
          gotRecs = true;
          break;
        }
      } catch (err) {
        console.warn('[Search] Candidate resolution failed:', (err as Error).message);
      }
    }

    // Fallback: personal recommendations based on user's subscriptions
    if (!gotRecs) {
      try {
        console.log('[Universal] Falling back to personal recommendations');
        const personal = await getPersonalRecommendations(clientId);
        console.log(`[Universal] Got ${personal.length} personal recommendations`);
        personal.forEach(ch => addChannel(ch, 'recommendations'));
      } catch (err) { console.warn('[Search] Error:', (err as Error).message); }
    }
  }

  // Step 3: Hashtag search (lower priority, after recommendations)
  if (isHashtag || !isUsername) {
    const hashtagQuery = isHashtag ? cleanQuery : cleanQuery;
    try {
      const hashtagResults = await Promise.race([
        searchByHashtagLight(hashtagQuery, Math.min(limit, 20), clientId),
        new Promise<Api.Channel[]>(resolve => setTimeout(() => resolve([]), 30_000)),
      ]);
      hashtagResults.forEach(ch => addChannel(ch, 'hashtag'));
    } catch (err) { console.warn('[Search] Error:', (err as Error).message); }
  }

  return channels.slice(0, limit);
}

// --- Light search functions (return Api.Channel[], no GetFullChannel) ---

async function searchChannelsLight(query: string, clientId: string | null): Promise<Api.Channel[]> {
  const result = await rateLimiter.invoke<Api.contacts.Found>(
    new Api.contacts.Search({ q: query, limit: 10 }),
    clientId,
  );
  return result.chats.filter((c): c is Api.Channel => c.className === 'Channel');
}

/**
 * Get personalized recommendations based on user's subscriptions.
 * Calls GetChannelRecommendations without channel parameter.
 */
async function getPersonalRecommendations(clientId: string | null): Promise<Api.Channel[]> {
  const result = await rateLimiter.invoke<Api.messages.Chats | Api.messages.ChatsSlice>(
    new Api.channels.GetChannelRecommendations({}),
    clientId,
  );
  return (result.chats || []).filter((c): c is Api.Channel => c.className === 'Channel');
}

async function searchByHashtagLight(hashtag: string, limit: number, clientId: string | null): Promise<Api.Channel[]> {
  const tag = hashtag.startsWith('#') ? hashtag : `#${hashtag}`;
  const seen = new Set<string>();
  const channels: Api.Channel[] = [];

  let offsetRate = 0;
  let offsetPeer: Api.TypeInputPeer = new Api.InputPeerEmpty();
  let offsetId = 0;

  while (channels.length < limit) {
    const searchResult: Api.messages.TypeMessages = await rateLimiter.invoke(
      new Api.channels.SearchPosts({
        hashtag: tag,
        offsetRate,
        offsetPeer,
        offsetId,
        limit: 20,
      }),
      clientId,
    );

    if (!('chats' in searchResult) || !searchResult.chats || searchResult.chats.length === 0) break;

    for (const chat of searchResult.chats) {
      if (chat.className !== 'Channel') continue;
      const ch = chat as Api.Channel;
      const id = ch.id.toString();
      if (!seen.has(id)) {
        seen.add(id);
        channels.push(ch);
      }
    }

    if (!('messages' in searchResult) || !searchResult.messages || searchResult.messages.length === 0) break;
    const lastMsg = searchResult.messages[searchResult.messages.length - 1];
    if (!lastMsg || lastMsg.className === 'MessageEmpty') break;

    const msg = lastMsg as Api.Message;
    const nextRate = ('nextRate' in searchResult && typeof searchResult.nextRate === 'number') ? searchResult.nextRate : 0;
    if (nextRate === 0 && searchResult.messages.length < 20) break;

    const peerId = msg.peerId;
    offsetPeer = new Api.InputPeerEmpty();
    if (peerId && peerId.className === 'PeerChannel') {
      const peerCh = peerId as Api.PeerChannel;
      const matchedChat = searchResult.chats.find((c: Api.TypeChat) => c.id.toString() === peerCh.channelId.toString());
      if (matchedChat && matchedChat.className === 'Channel') {
        offsetPeer = new Api.InputPeerChannel({
          channelId: (matchedChat as Api.Channel).id,
          accessHash: (matchedChat as Api.Channel).accessHash ?? bigInt(0),
        });
      }
    }
    offsetRate = nextRate;
    offsetId = msg.id;
  }

  return channels.slice(0, limit);
}

/**
 * Convert light channels to UniversalSearchResult without GetFullChannel.
 * Uses data already available in Api.Channel object.
 */
async function lightToResults(
  lightChannels: LightChannel[],
): Promise<UniversalSearchResult[]> {
  const { existingIds, researchIds } = await getExistingChannelIds();

  return lightChannels.map(({ channel: ch, source }) => {
    const username = getChannelUsername(ch);
    const channelId = username || ch.id.toString();
    return {
      channelId,
      title: ch.title || '',
      username,
      description: '', // enriched later
      subscriberCount: (ch as unknown as { participantsCount?: number }).participantsCount ?? 0,
      hasAvatar: false,
      linkedGroup: null,
      alreadyAdded: existingIds.has(channelId) || researchIds.has(channelId),
      telegramId: ch.id.toString(),
      accessHash: ch.accessHash != null ? ch.accessHash.toString() : undefined,
      source,
    };
  });
}

/**
 * Universal search — returns light results FAST (no GetFullChannel).
 * Phase 1 only: keyword search → recommendations → hashtag.
 * Description and linkedGroup will be empty — enrich via /api/channels/:id/enrich.
 */
export async function universalSearch(
  input: string,
  limit = 50,
): Promise<UniversalSearchResult[]> {
  const query = input.trim();
  if (!query) return [];

  // Phase 1: Collect (fast — no GetFullChannel)
  const lightChannels = await collectChannels(query, limit, null);

  // Sort by participantsCount (biggest first)
  lightChannels.sort((a, b) =>
    ((b.channel as unknown as { participantsCount?: number }).participantsCount || 0) -
    ((a.channel as unknown as { participantsCount?: number }).participantsCount || 0)
  );

  // Convert to results without enrichment
  return lightToResults(lightChannels);
}

/**
 * Enrich a single channel with GetFullChannel (description, subscriber count, linked group).
 * Supports both username-based and numeric ID + accessHash resolution.
 */
export async function enrichChannelById(
  channelId: string,
  telegramId?: string,
  accessHash?: string,
): Promise<DiscoverResult | null> {
  // Pick one client from the active pool and run the whole sequence on it.
  // GetChannels/GetFullChannel share a session-specific access_hash, so they
  // must stay on the same client. Picking round-robin (instead of always the
  // first active client) is what lets N parallel enrich calls actually run
  // across N accounts — the parallelism bug from 1c06db8.
  const clientId = await rateLimiter.pickActiveClientId();
  if (!clientId) return null;
  const client = await clientManager.getClient(clientId);

  try {
    let entity: Api.Channel | null = null;

    // Prefer InputChannel with accessHash — avoids contacts.ResolveUsername (heavily rate-limited)
    if (telegramId && accessHash) {
      try {
        const result = await rateLimiter.invoke<Api.messages.Chats>(
          new Api.channels.GetChannels({
            id: [new Api.InputChannel({
              channelId: bigInt(telegramId),
              accessHash: bigInt(accessHash),
            })],
          }),
          clientId,
        );
        const chat = result.chats[0];
        if (chat instanceof Api.Channel) entity = chat;
      } catch (err) {
        // CHANNEL_INVALID / CHANNEL_PRIVATE etc. — fall through to username resolve if possible
        const msg = (err as Error).message || '';
        if (!/CHANNEL_INVALID|CHANNEL_PRIVATE|USER_BANNED_IN_CHANNEL/.test(msg)) throw err;
      }
    }

    // Fallback: ResolveUsername — when we don't have accessHash, or InputChannel rejected.
    // client.getEntity caches access_hash on this session.
    if (!entity) {
      const looksNumeric = /^\d+$/.test(channelId);
      if (looksNumeric) return null; // no username to resolve
      const resolved = await client.getEntity(channelId);
      if (!(resolved instanceof Api.Channel)) return null;
      entity = resolved;
    }

    const { description, linkedGroup, subscriberCount } = await getChannelFullInfo(entity, clientId);
    // Fallback: if GetFullChannel returned 0, use participantsCount from entity
    const finalSubCount = subscriberCount ?? (entity as unknown as { participantsCount?: number }).participantsCount ?? 0;
    const username = getChannelUsername(entity);
    const resolvedId = username || entity.id.toString();

    // Download avatar if not yet on disk
    let hasAvatar = false;
    try {
      if (entity.photo && entity.photo.className === 'ChatPhoto') {
        const avatarDir = path.join(ROOT_DIR, 'data', 'avatars');
        if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir, { recursive: true });
        const avatarPath = path.join(avatarDir, `${resolvedId}.jpg`);
        if (fs.existsSync(avatarPath)) {
          hasAvatar = true;
        } else {
          const buffer = await client.downloadProfilePhoto(entity);
          if (buffer && Buffer.byteLength(buffer) > 0) {
            await fs.promises.writeFile(avatarPath, buffer);
            hasAvatar = true;
          }
        }
      }
    } catch (err) { console.warn('[Enrich] Avatar download failed:', (err as Error).message); }

    return {
      channelId: resolvedId,
      title: entity.title || '',
      username,
      description,
      subscriberCount: finalSubCount,
      hasAvatar,
      linkedGroup,
      alreadyAdded: false,
    };
  } catch (err) {
    console.warn(`[Enrich] Failed to enrich "${channelId}":`, (err as Error).message);
    return null;
  }
}
