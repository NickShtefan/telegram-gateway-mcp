import 'dotenv/config';
import type { TelegramConfig } from '../types/index.js';
import { envBool } from '../telegram/utils/env.js';

const config: TelegramConfig = {
  telegram: {
    botToken: process.env.TELEGRAM_TOKEN,
    channelName: process.env.CHANNEL_USERNAME || 'stonksnws',
    // Набор эмодзи для автоматической реакции на новые посты.
    // Выбирается случайный элемент через processors/sendRandomReaction.
    reactionEmojis: ['🔥', '👍', '❤️', '🤔', '🎉', '😁']
  },
  comments: {
    enabled: envBool('COMMENTS_ENABLED', true),
    downloadMedia: envBool('COMMENTS_DOWNLOAD_MEDIA', false),
  }
};

export default config;
