import 'dotenv/config';
import mongoose from 'mongoose';
import { startListenerBot } from './telegram/bot/listenerBot.js';
import { initGramClient } from './telegram/client/gramClient.js';
import { initGramClientOrExit } from './telegram/client/gramStartup.js';
import { startStatsRefresher } from './telegram/workers/statsRefresher.js';
import { startCommentsRefresher } from './telegram/workers/commentsRefresher.js';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('Отсутствует MONGO_URI в переменных окружения.');
  process.exit(1);
}

async function startApp(): Promise<void> {
  try {
    await mongoose.connect(MONGO_URI!);
    console.info('Подключение к MongoDB успешно установлено.');
  } catch (error) {
    console.error('Ошибка подключения к MongoDB:', error);
    process.exit(1);
  }

  await initGramClientOrExit(initGramClient);

  startListenerBot();
  startStatsRefresher().catch(err => {
    console.error('[StatsRefresher] failed to start:', err);
  });
  startCommentsRefresher().catch(err => {
    console.error('[CommentsRefresher] failed to start:', err);
  });
}

startApp();
