import type TelegramBot from 'node-telegram-bot-api';
import type { Message } from 'node-telegram-bot-api';
import Post from '../../db/models/Post.js';
import processMedia from './processMediaBot.js';
import { sendRandomReaction } from './sendRandomReaction.js';
import type { MediaItem } from '../../types/index.js';

async function savePost(message: Message, media: MediaItem[] | null, isEdit: boolean = false): Promise<void> {
  const text = message.text || message.caption || '';
  const mediaData = media || [];

  if (isEdit) {
    const updated = await Post.findOneAndUpdate(
      { telegramId: message.message_id, channelId: message.chat.username },
      {
        $set: {
          text: text,
          entities: message.entities || []
        }
      },
      { new: true }
    );
    if (updated) {
      console.log('[DB] Пост обновлен в базе данных, id:', updated._id);
    } else {
      console.log('[DB] Измененный пост не найден в базе, пропускаем:', message.message_id);
    }
    return;
  }

  const newPost = new Post({
    telegramId: message.message_id,
    channelId: message.chat.username,
    text: text,
    entities: message.entities || [],
    media: mediaData,
    stats: {
      views: (message as Message & { views?: number }).views || 0,
      reactions: [],
    },
    date: new Date(message.date * 1000),
  });

  await newPost.save();
  console.log('[DB] Новый пост сохранён в базе данных, id:', newPost._id);
}

/**
 * Ставит авто-реакцию на пост и сохраняет выбранный эмодзи в Post.ownReaction.
 * Для edited-постов реакция ставится только если её ещё нет (idempotent).
 * Любые ошибки на этом шаге гасим — пост уже сохранён, реакция некритична.
 */
async function setAutoReaction(message: Message, isEdit: boolean): Promise<void> {
  const channelUsername = message.chat.username;
  if (!channelUsername) {
    console.warn('[Reaction] chat.username is missing, skipping reaction for msg:', message.message_id);
    return;
  }

  if (isEdit) {
    const existing = await Post.findOne({
      telegramId: message.message_id,
      channelId: channelUsername,
    }).select('ownReaction').lean();
    if (existing?.ownReaction) {
      console.log(`[Reaction] skipped (already set: ${existing.ownReaction}) for msg ${message.message_id}`);
      return;
    }
  }

  const emoji = await sendRandomReaction(channelUsername, message.message_id);
  if (!emoji) return;

  await Post.updateOne(
    { telegramId: message.message_id, channelId: channelUsername },
    { $set: { ownReaction: emoji } }
  );
}

export default async function processPost(message: Message, bot: TelegramBot, isEdit: boolean = false): Promise<void> {
  try {
    console.log('[ProcessPost] Обработка сообщения с id:', message.message_id, isEdit ? '(EDIT)' : '');
    const media = isEdit ? null : await processMedia(message, bot);
    await savePost(message, media, isEdit);

    try {
      await setAutoReaction(message, isEdit);
    } catch (err) {
      console.error('[ProcessPost] Ошибка при установке авто-реакции:', (err as Error).message);
    }
  } catch (err) {
    console.error('[ProcessPost] Ошибка при обработке поста:', (err as Error).message);
  }
}
