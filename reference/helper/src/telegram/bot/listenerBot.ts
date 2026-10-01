import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import processPost from '../processors/processPost.js';
import { processReactionUpdate } from '../processors/processReactions.js';
import processComment, { processDiscussionRoot } from '../processors/processComment.js';
import { processCommentReaction, processCommentReactionCount } from '../processors/processCommentReactions.js';
import { ensureDiscussionChatId, initDiscussionChat } from '../discussion.js';
import config from '../../config/telegram.js';
import type { ReactionCountUpdate, MessageReactionUpdate, MessageExtraFields } from '../../types/index.js';
import type { Message } from 'node-telegram-bot-api';

dotenv.config();

const { TELEGRAM_TOKEN } = process.env;

if (!TELEGRAM_TOKEN) {
  console.error('Отсутствует TELEGRAM_TOKEN в переменных окружения.');
  process.exit(1);
}

const BASE_UPDATES = ['channel_post', 'edited_channel_post', 'message_reaction_count'];
// message/edited_message — комментарии в группе обсуждений;
// message_reaction — по-пользовательский дифф реакций (нужен бот-админ в группе).
const COMMENT_UPDATES = ['message', 'edited_message', 'message_reaction'];

export function startListenerBot(): void {
  const commentsEnabled = config.comments.enabled;
  const allowedUpdates = commentsEnabled ? [...BASE_UPDATES, ...COMMENT_UPDATES] : BASE_UPDATES;

  const bot = new TelegramBot(TELEGRAM_TOKEN as string, {
    polling: {
      params: {
        allowed_updates: JSON.stringify(allowedUpdates) as unknown as string[],
      },
    },
  });

  bot.on('polling_error', (err) => console.error('[Bot] Polling error:', err.message));

  bot.on('edited_channel_post', async (msg) => {
    try {
      console.info('[Bot] Получено ИЗМЕНЕННОЕ сообщение в канале:', msg.message_id);
      await processPost(msg, bot, true);
    } catch (error) {
      console.error('[Bot] Ошибка при обработке измененного сообщения:', error);
    }
  });

  bot.on('channel_post', async (msg) => {
    try {
      console.info('[Bot] Получено новое сообщение в канале, id:', msg.message_id);
      await processPost(msg, bot);
    } catch (error) {
      console.error('[Bot] Ошибка при обработке сообщения из канала:', error);
    }
  });

  // Обработчик обновления реакций (канал И группа обсуждений).
  // Роутинг только позитивный: бот-админ группы получает эти апдейты из обоих
  // чатов, а message_id канала и группы — независимые последовательности.
  bot.on('message_reaction_count' as 'message', async (u) => {
    try {
      const update = u as unknown as ReactionCountUpdate;
      if (update.chat?.username === config.telegram.channelName) {
        console.info('[Bot] Обновление реакций для поста канала:', update.message_id);
        await processReactionUpdate(update);
        return;
      }
      if (commentsEnabled && update.chat?.id === await ensureDiscussionChatId(bot)) {
        await processCommentReactionCount(update);
        return;
      }
      console.warn('[Bot] Реакции из неопознанного чата, пропускаем:', update.chat?.id);
    } catch (error) {
      console.error('[Bot] Ошибка при обработке реакций:', error);
    }
  });

  if (commentsEnabled) {
    // Сообщения в группе обсуждений: корни-автофорварды и комментарии.
    bot.on('message', async (msg) => {
      try {
        const discussionId = await ensureDiscussionChatId(bot);
        if (discussionId === null || msg.chat.id !== discussionId) return; // не наша группа
        if ((msg as Message & MessageExtraFields).is_automatic_forward) {
          await processDiscussionRoot(msg);
          return;
        }
        await processComment(msg, bot, false);
      } catch (error) {
        console.error('[Bot] Ошибка при обработке сообщения из группы обсуждений:', error);
      }
    });

    bot.on('edited_message', async (msg) => {
      try {
        const discussionId = await ensureDiscussionChatId(bot);
        if (discussionId === null || msg.chat.id !== discussionId) return;
        // правка поста канала уже пришла как edited_channel_post
        if ((msg as Message & MessageExtraFields).is_automatic_forward) return;
        await processComment(msg, bot, true);
      } catch (error) {
        console.error('[Bot] Ошибка при обработке изменённого комментария:', error);
      }
    });

    bot.on('message_reaction' as 'message', async (u) => {
      try {
        const update = u as unknown as MessageReactionUpdate;
        // в канале реакции анонимны и приходят как message_reaction_count
        if (update.chat?.id !== await ensureDiscussionChatId(bot)) return;
        await processCommentReaction(update);
      } catch (error) {
        console.error('[Bot] Ошибка при обработке пользовательской реакции:', error);
      }
    });

    // Стартовый резолв группы + проверка админства (с ретраем по таймеру внутри).
    void initDiscussionChat(bot);
  }

  console.info(
    '[Bot] Телеграм-бот запущен и готов к работе.' +
    (commentsEnabled ? ' Сбор комментариев включён.' : ' Сбор комментариев выключен (COMMENTS_ENABLED=false).')
  );
}
