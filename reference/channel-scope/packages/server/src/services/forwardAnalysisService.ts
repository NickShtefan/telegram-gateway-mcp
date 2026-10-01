import { getChannelUsername, getExistingChannelIds } from './telegramUtils.js';
import bigInt from 'big-integer';
import { Api } from 'telegram';
import { rateLimiter } from './rateLimiter.js';
import { clientManager } from './clientManager.js';
import type { DiscoverResult } from './discoverService.js';

export interface ForwardSource {
  channel: DiscoverResult;
  forwardCount: number;
}

const DEFAULT_POST_LIMIT = 200;
const MIN_FORWARD_COUNT = 2;
const PAGE_SIZE = 100;

/**
 * Analyze forwarded messages in a channel to discover source channels.
 * Returns light results (no GetFullChannel) — enrich on frontend via /enrich.
 */
export async function analyzeForwards(
  channelUsername: string,
  postLimit = DEFAULT_POST_LIMIT,
): Promise<ForwardSource[]> {
  const client = await clientManager.getFirstActiveClient();
  if (!client) throw new Error('No active Telegram client available');

  const resolveResult = await client.invoke(
    new Api.contacts.ResolveUsername({ username: channelUsername }),
  ) as Api.contacts.ResolvedPeer;

  const peer = resolveResult.peer;
  if (!(peer instanceof Api.PeerChannel)) {
    throw new Error(`"${channelUsername}" is not a channel`);
  }

  const targetChannel = resolveResult.chats.find(
    c => c instanceof Api.Channel && c.id.toString() === peer.channelId.toString(),
  ) as Api.Channel | undefined;

  if (!targetChannel?.accessHash) {
    throw new Error(`Cannot resolve accessHash for "${channelUsername}"`);
  }

  const inputChannel = new Api.InputPeerChannel({
    channelId: peer.channelId,
    accessHash: targetChannel.accessHash,
  });

  // Paginated GetHistory
  const allMessages: Api.Message[] = [];
  const chatMap = new Map<string, Api.Channel>();
  let offsetId = 0;
  let fetched = 0;

  while (fetched < postLimit) {
    const batchSize = Math.min(PAGE_SIZE, postLimit - fetched);
    const history = await client.invoke(
      new Api.messages.GetHistory({
        peer: inputChannel,
        limit: batchSize,
        offsetId,
        offsetDate: 0,
        addOffset: 0,
        maxId: 0,
        minId: 0,
        hash: bigInt(0),
      }),
    ) as Api.messages.ChannelMessages;

    const messages = history.messages.filter(
      (m): m is Api.Message => m instanceof Api.Message,
    );

    if (messages.length === 0) break;

    allMessages.push(...messages);

    for (const chat of history.chats) {
      if (chat instanceof Api.Channel) {
        chatMap.set(chat.id.toString(), chat);
      }
    }

    fetched += messages.length;
    offsetId = messages[messages.length - 1].id;

    if (messages.length < batchSize) break;
  }

  // Count forwards per source channel
  const forwardCounts = new Map<string, number>();

  for (const msg of allMessages) {
    const fwdFrom = msg.fwdFrom;
    if (!fwdFrom) continue;

    const fromId = fwdFrom.fromId;
    if (!fromId || !(fromId instanceof Api.PeerChannel)) continue;

    const sourceId = fromId.channelId.toString();
    forwardCounts.set(sourceId, (forwardCounts.get(sourceId) || 0) + 1);
  }

  const qualifiedSources = [...forwardCounts.entries()]
    .filter(([, count]) => count >= MIN_FORWARD_COUNT)
    .sort((a, b) => b[1] - a[1]);

  if (qualifiedSources.length === 0) return [];

  const { existingIds, researchIds } = await getExistingChannelIds();

  const results: ForwardSource[] = [];

  for (const [sourceChannelId, forwardCount] of qualifiedSources) {
    try {
      let channel = chatMap.get(sourceChannelId);

      if (!channel) {
        // Channel not in history response — try resolving via API with its accessHash from chatMap
        // Without a valid accessHash, Telegram rejects InputChannel, so skip unknown channels
        console.warn(`[Forwards] Source channel ${sourceChannelId} not in chatMap, skipping`);
        continue;
      }

      const channelId = getChannelUsername(channel) || channel.id.toString();

      const discoverResult: DiscoverResult = {
        channelId,
        title: channel.title || '',
        username: getChannelUsername(channel),
        description: '',
        subscriberCount: (channel as unknown as { participantsCount?: number }).participantsCount ?? 0,
        hasAvatar: false,
        linkedGroup: null,
        alreadyAdded: existingIds.has(channelId) || researchIds.has(channelId),
        alreadyResearched: researchIds.has(channelId),
        telegramId: channel.id.toString(),
        accessHash: channel.accessHash != null ? channel.accessHash.toString() : undefined,
      };

      results.push({ channel: discoverResult, forwardCount });
    } catch (err) {
      console.warn(`[Forwards] Failed to process source ${sourceChannelId}:`, (err as Error).message);
      continue;
    }
  }

  return results;
}
