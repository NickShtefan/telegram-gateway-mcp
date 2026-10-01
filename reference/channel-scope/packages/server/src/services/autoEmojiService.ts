import { Api } from 'telegram';
import Channel from '../db/models/Channel.js';
import Client from '../db/models/Client.js';
import Post from '../db/models/Post.js';
import { clientManager } from './clientManager.js';

export class AutoEmojiService {
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async handleNewPost(channelUsername: string, messageId: number): Promise<void> {
    try {
      // Normalize username — try with and without @
      const bare = channelUsername.replace(/^@/, '');
      const withAt = '@' + bare;

      const channel = await Channel.findOne({
        $or: [
          { channelId: channelUsername },
          { channelId: withAt },
          { channelId: bare },
        ],
      });

      if (!channel) {
        // Not a tracked channel — silently skip
        return;
      }

      if (!channel.settings.autoEmoji.enabled) {
        return;
      }

      if (!channel.clientIds || channel.clientIds.length === 0) {
        console.warn(`[AutoEmoji] No clients assigned to channel ${channel.channelId}`);
        return;
      }

      // Find first active client
      const clientDoc = await Client.findOne({
        _id: { $in: channel.clientIds },
        status: 'active',
      });

      if (!clientDoc) {
        console.warn(`[AutoEmoji] No active client found for channel ${channel.channelId}`);
        return;
      }

      const delayMs = (channel.settings.autoEmoji.delay ?? 30) * 1000;
      await this.sleep(delayMs);

      const client = await clientManager.getClient(clientDoc._id.toString());
      const emoji = channel.settings.autoEmoji.emoji || '❤️';

      await client.invoke(
        new Api.messages.SendReaction({
          peer: channelUsername,
          msgId: messageId,
          reaction: [new Api.ReactionEmoji({ emoticon: emoji })],
        })
      );

      // Mark post as emoji-sent
      await Post.updateOne(
        { telegramId: messageId, channelId: channel.channelId },
        { autoEmojiSent: true }
      );

      console.info(`[AutoEmoji] Sent ${emoji} reaction to message ${messageId} in ${channel.channelId}`);
    } catch (err) {
      console.error(`[AutoEmoji] Error for message ${messageId}:`, (err as Error).message);
      // Non-fatal — do not re-throw
    }
  }
}

export const autoEmojiService = new AutoEmojiService();
