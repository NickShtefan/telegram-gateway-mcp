// src/telegram/telegram.js
const { TelegramBot } = require('node-telegram-bot-api');
const config = require('../config');

const bot = new TelegramBot(config.telegram.token, { polling: false });

// Inline-кнопка подписки на канал. Telegram показывает по ней статистику кликов
// в аналитике канала, поэтому отдельный трекинг не нужен.
const subscribeKeyboard = {
  inline_keyboard: [[
    { text: config.telegram.subscribeText, url: config.telegram.channelUrl }
  ]]
};

// Служебное/статусное сообщение (ошибки БД и т.п.) — без кнопки подписки.
function sendMessage(message) {
  return bot.sendMessage(config.telegram.chatId, message, { parse_mode: 'Markdown' });
}

// Публичный отчёт с графиком — с кнопкой подписки на канал.
function sendPhotoWithText(photoUrl, caption, options = {}) {
  return bot.sendPhoto(config.telegram.chatId, photoUrl, {
    caption,
    parse_mode: 'Markdown',
    reply_markup: subscribeKeyboard,
    ...options
  });
}

module.exports = { sendMessage, sendPhotoWithText };
