import { getChannelUsername, getExistingChannelIds } from './telegramUtils.js';
import bigInt from 'big-integer';
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import { clientManager } from './clientManager.js';
import type { DiscoverResult } from './discoverService.js';

/**
 * Get channel recommendations (similar channels) for a given channel.
 * Returns light results (no GetFullChannel) — enrich on frontend via /enrich.
 */
export async function getRecommendations(
  channelUsername: string,
  clientId?: string,
  depth: number = 1,
): Promise<DiscoverResult[]> {
  const client = clientId
    ? await clientManager.getClient(clientId)
    : await clientManager.getFirstActiveClient();

  if (!client) {
    throw new Error('No active Telegram client available');
  }

  // Resolve and get recommendations using the SAME client
  let resolvedChannel: Api.Channel;
  try {
    const resolved = await client.invoke(
      new Api.contacts.ResolveUsername({ username: channelUsername.replace(/^@/, '') }),
    ) as Api.contacts.ResolvedPeer;
    const chat = resolved.chats[0];
    if (!chat || !(chat instanceof Api.Channel)) {
      throw new Error(`"${channelUsername}" is not a channel`);
    }
    resolvedChannel = chat;
  } catch (err) {
    if ((err as Error).message?.includes('not a channel')) throw err;
    throw new Error(`Channel not found: ${channelUsername}`);
  }

  // For depth > 1, recursive crawl handles its own GetChannelRecommendations calls
  let allChats: Api.Channel[];
  if (depth > 1) {
    allChats = await getRecursiveRecommendationsLight(resolvedChannel, depth, 100, 3);
  } else {
    const result = await client.invoke(
      new Api.channels.GetChannelRecommendations({ channel: new Api.InputChannel({
        channelId: resolvedChannel.id,
        accessHash: resolvedChannel.accessHash ?? bigInt(0),
      }) }),
    ) as Api.messages.Chats;
    allChats = (result.chats || []).filter((c): c is Api.Channel => c.className === 'Channel');
  }

  if (allChats.length === 0) return [];

  const { existingIds, researchIds } = await getExistingChannelIds();

  return allChats.map(ch => {
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
      accessHash: ch.accessHash?.toString(),
    };
  });
}

/**
 * Fetch recommendations for a single resolved channel using a specific client.
 * Returns raw Api.Channel[] without enrichment.
 */
async function fetchRecsForChannel(
  channel: Api.Channel,
  client: TelegramClient,
): Promise<Api.Channel[]> {
  const result = await client.invoke(
    new Api.channels.GetChannelRecommendations({ channel: new Api.InputChannel({
      channelId: channel.id,
      accessHash: channel.accessHash ?? bigInt(0),
    }) }),
  ) as Api.messages.Chats;
  return (result.chats || []).filter((c): c is Api.Channel => c.className === 'Channel');
}

/**
 * Recursive recommendations — multi-level graph crawl (light, no GetFullChannel).
 * Uses a single client for all calls (accessHash is session-bound).
 */
export async function getRecursiveRecommendationsLight(
  seedChannel: Api.Channel,
  depth: number = 2,
  maxTotal: number = 50,
  topPerLevel: number = 3,
): Promise<Api.Channel[]> {
  const client = await clientManager.getFirstActiveClient();
  if (!client) return [];

  const clampedDepth = Math.min(Math.max(depth, 1), 3);
  const seen = new Set<string>();
  seen.add(seedChannel.id.toString());

  const allChannels: Api.Channel[] = [];

  // Resolve seed to get correct accessHash
  const username = getChannelUsername(seedChannel);
  let resolvedSeed = seedChannel;
  if (username) {
    try {
      const resolved = await client.invoke(
        new Api.contacts.ResolveUsername({ username }),
      ) as Api.contacts.ResolvedPeer;
      const chat = resolved.chats.find(c => c instanceof Api.Channel) as Api.Channel | undefined;
      if (chat) resolvedSeed = chat;
    } catch (err) { console.warn('[Reco] Seed resolution failed:', (err as Error).message); }
  }

  // BFS by level
  let currentLevel: Api.Channel[] = [resolvedSeed];

  for (let level = 0; level < clampedDepth; level++) {
    if (allChannels.length >= maxTotal || currentLevel.length === 0) break;

    const nextLevel: Api.Channel[] = [];

    for (const ch of currentLevel) {
      if (allChannels.length >= maxTotal) break;

      try {
        const recs = await fetchRecsForChannel(ch, client);
        for (const rec of recs) {
          const id = rec.id.toString();
          if (seen.has(id)) continue;
          seen.add(id);
          allChannels.push(rec);
          nextLevel.push(rec);
          if (allChannels.length >= maxTotal) break;
        }
      } catch (err) {
        console.warn('[Reco] Failed for channel:', (err as Error).message);
      }
    }

    // For next level, pick top N by subscriber count
    currentLevel = nextLevel
      .filter(c => getChannelUsername(c))
      .sort((a, b) =>
        ((b as unknown as { participantsCount?: number }).participantsCount || 0) -
        ((a as unknown as { participantsCount?: number }).participantsCount || 0)
      )
      .slice(0, topPerLevel);
  }

  return allChannels;
}
