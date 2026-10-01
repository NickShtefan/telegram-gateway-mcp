import { Api } from 'telegram';
import { getGramClient, resolvePeer } from '../client/gramClient.js';
import config from '../../config/telegram.js';

function pickRandom<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * Ставит случайную эмодзи-реакцию из config.telegram.reactionEmojis
 * на указанное сообщение канала.
 *
 * @returns выбранный эмодзи при успехе, либо null при любой ошибке
 *          (ошибки логируем, но не кидаем наверх — обработка поста не должна падать).
 */
export async function sendRandomReaction(
  channelUsername: string,
  messageId: number
): Promise<string | null> {
  const emojis = config.telegram.reactionEmojis;
  if (!emojis || emojis.length === 0) {
    console.warn('[Reaction] reactionEmojis is empty in config, skipping');
    return null;
  }

  const emoji = pickRandom(emojis);

  try {
    const peer = await resolvePeer(channelUsername);
    const client = getGramClient();

    await client.invoke(
      new Api.messages.SendReaction({
        peer,
        msgId: messageId,
        reaction: [new Api.ReactionEmoji({ emoticon: emoji })],
      })
    );

    console.info(`[Reaction] sent ${emoji} for msg ${messageId} in @${channelUsername}`);
    return emoji;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('FLOOD_WAIT') || message.includes('FloodWait')) {
      console.warn(`[Reaction] flood wait for msg ${messageId}:`, message);
    } else {
      console.error(`[Reaction] failed for msg ${messageId}:`, message);
    }
    return null;
  }
}
