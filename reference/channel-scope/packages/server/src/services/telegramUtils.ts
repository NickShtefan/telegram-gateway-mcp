import bigInt from 'big-integer';
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import type { LinkedGroup } from 'channel-scope-shared';
import { rateLimiter } from './rateLimiter.js';
import Channel from '../db/models/Channel.js';
import ResearchChannel from '../db/models/ResearchChannel.js';

/**
 * Extract username from Api.Channel — checks both `username` and `usernames` array.
 * Some channels have their username only in the `usernames` array (collectible usernames).
 */
export function getChannelUsername(ch: Api.Channel): string {
  if (ch.username) return ch.username;
  const usernames = (ch as unknown as { usernames?: Array<{ username: string; active?: boolean }> }).usernames;
  if (usernames && usernames.length > 0) {
    const active = usernames.find(u => u.active !== false);
    return active?.username || usernames[0].username;
  }
  return '';
}

export interface ChannelFullInfo {
  description: string;
  linkedGroup: LinkedGroup | null;
  subscriberCount: number;
}

/**
 * Get full channel info (description, linked group, subscriber count).
 * If a TelegramClient is provided, uses it directly (required when accessHash
 * is session-bound to that client). Otherwise uses rateLimiter.
 * Returns empty defaults if GetFullChannel fails (restricted channels, etc.).
 */
export async function getChannelFullInfo(
  ch: Api.Channel,
  clientId: string | null,
  client?: TelegramClient,
): Promise<ChannelFullInfo> {
  try {
    const request = new Api.channels.GetFullChannel({ channel: new Api.InputChannel({
      channelId: ch.id,
      accessHash: ch.accessHash ?? bigInt(0),
    }) });
    const full = client
      ? await client.invoke(request) as Api.messages.ChatFull
      : await rateLimiter.invoke<Api.messages.ChatFull>(request, clientId);
    const fullChat = full.fullChat as Api.ChannelFull;
    const description = (fullChat as unknown as { about?: string }).about || '';
    const subscriberCount = (fullChat as unknown as { participantsCount?: number }).participantsCount ?? 0;

    let linkedGroup: LinkedGroup | null = null;
    if (fullChat.linkedChatId) {
      const linkedChat = full.chats.find(
        c => c.id?.toString() === fullChat.linkedChatId?.toString(),
      ) as Api.Channel | Api.Chat | undefined;
      linkedGroup = {
        chatId: fullChat.linkedChatId.toString(),
        title: linkedChat ? (linkedChat as { title?: string }).title || '' : '',
        username: linkedChat && 'username' in linkedChat
          ? (linkedChat as Api.Channel).username || null
          : null,
      };
    }

    return { description, linkedGroup, subscriberCount };
  } catch (err) {
    console.warn('[TelegramUtils] GetFullChannel failed:', (err as Error).message);
    return { description: '', linkedGroup: null, subscriberCount: 0 };
  }
}

/**
 * Fetch existing channel IDs and research channel IDs for alreadyAdded/alreadyResearched flags.
 * Uses projection to only load channelId field.
 */
export async function getExistingChannelIds(): Promise<{ existingIds: Set<string>; researchIds: Set<string> }> {
  const [existingChannels, researchChannels] = await Promise.all([
    Channel.find({}, { channelId: 1 }).lean(),
    ResearchChannel.find({}, { channelId: 1 }).lean(),
  ]);
  return {
    existingIds: new Set(existingChannels.map(c => c.channelId)),
    researchIds: new Set(researchChannels.map(c => c.channelId)),
  };
}
