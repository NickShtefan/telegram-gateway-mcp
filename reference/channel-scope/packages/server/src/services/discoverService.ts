import { getChannelUsername } from './telegramUtils.js';
import fs from 'fs';
import path from 'path';
import { Api } from 'telegram';
import { ROOT_DIR } from '../config/paths.js';
import type { TelegramClient } from 'telegram';
import Channel from '../db/models/Channel.js';
import type { LinkedGroup } from 'channel-scope-shared';

export interface DiscoverResult {
  channelId: string;
  title: string;
  username: string;
  description: string;
  subscriberCount: number;
  hasAvatar: boolean;
  linkedGroup: LinkedGroup | null;
  alreadyAdded: boolean;
  alreadyResearched?: boolean;
  /** Numeric Telegram channel ID — for enrichment when username is unavailable */
  telegramId?: string;
  /** Session-bound access hash — required to resolve channels without username */
  accessHash?: string;
}

export async function searchChannels(query: string, client: TelegramClient): Promise<DiscoverResult[]> {
  const result = await client.invoke(new Api.contacts.Search({
    q: query,
    limit: 10,
  }));

  const existingChannels = await Channel.find().lean();
  const existingIds = new Set(existingChannels.map(c => c.channelId));

  const channels: DiscoverResult[] = [];

  for (const chat of result.chats) {
    if (chat.className !== 'Channel') continue;
    const ch = chat as Api.Channel;

    let linkedGroup: LinkedGroup | null = null;
    let description = '';
    try {
      const full = await client.invoke(new Api.channels.GetFullChannel({ channel: ch }));
      const fullChat = full.fullChat as Api.ChannelFull;
      description = (fullChat as unknown as { about?: string }).about || '';
      if (fullChat.linkedChatId) {
        const linkedChat = result.chats.find(
          c => c.id?.toString() === fullChat.linkedChatId?.toString()
        ) as Api.Channel | Api.Chat | undefined;
        linkedGroup = {
          chatId: fullChat.linkedChatId.toString(),
          title: linkedChat ? (linkedChat as { title?: string }).title || '' : '',
          username: linkedChat && 'username' in linkedChat ? (linkedChat as Api.Channel).username || null : null,
        };
      }
    } catch { /* getFullChannel can fail for restricted channels */ }

    let hasAvatar = false;
    try {
      if (ch.photo && ch.photo.className === 'ChatPhoto') {
        const avatarDir = path.join(ROOT_DIR, 'data', 'avatars');
        if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir, { recursive: true });
        const avatarPath = path.join(avatarDir, `${getChannelUsername(ch) || ch.id}.jpg`);
        const buffer = await client.downloadProfilePhoto(ch);
        if (buffer && Buffer.byteLength(buffer) > 0) {
          fs.writeFileSync(avatarPath, buffer);
          hasAvatar = true;
        }
      }
    } catch { /* avatar download is optional */ }

    const channelId = getChannelUsername(ch) || ch.id.toString();
    channels.push({
      channelId,
      title: ch.title || '',
      username: getChannelUsername(ch),
      description,
      subscriberCount: (ch as unknown as { participantsCount?: number }).participantsCount || 0,
      hasAvatar,
      linkedGroup,
      alreadyAdded: existingIds.has(channelId),
    });
  }

  return channels;
}
