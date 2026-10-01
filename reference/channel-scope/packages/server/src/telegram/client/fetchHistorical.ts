import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Load .env from monorepo root (5 levels up from packages/server/src/telegram/client/)
const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(__filename), '..', '..', '..', '..', '..');
dotenv.config({ path: path.join(ROOT_DIR, '.env') });
import mongoose from 'mongoose';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import input from 'input';
import Post from '../../db/models/Post.js';
import processMedia from '../processors/processMediaClient.js';
import type { Reaction } from 'channel-scope-shared';
import type { GramJSReactions, GramJSClient, GramJSMessage } from '../../types/index.js';

const SESSION_FILE = process.env.SESSION_FILE || path.resolve(ROOT_DIR, '.session');

function parseArgs(): { channel: string; limit: number } {
  const args = process.argv.slice(2);
  let channel = process.env.CHANNEL_USERNAME || 'stonksnws';
  let limit = 0; // 0 = unlimited

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--channel' && args[i + 1]) {
      channel = args[i + 1];
      i++;
    } else if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    }
  }

  return { channel, limit };
}

function loadSession(): string {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const session = fs.readFileSync(SESSION_FILE, 'utf-8').trim();
      if (session) {
        console.log('Session loaded from', SESSION_FILE);
        return session;
      }
    }
  } catch {
    // ignore read errors, will create new session
  }
  return process.env.STRING_SESSION || '';
}

function saveSession(session: string): void {
  try {
    fs.writeFileSync(SESSION_FILE, session, 'utf-8');
    console.log('Session saved to', SESSION_FILE);
  } catch (err) {
    console.error('Failed to save session:', err);
  }
}

function processReactions(messageReactions: GramJSReactions | undefined | null): Reaction[] {
  if (
    !messageReactions ||
    !Array.isArray(messageReactions.results) ||
    messageReactions.results.length === 0
  ) {
    return [];
  }
  const reactionsArray: Reaction[] = [];
  for (const result of messageReactions.results) {
    if (result && result.reaction && typeof result.count === 'number') {
      const reactionKey = result.reaction.emoticon
        ? result.reaction.emoticon.toString()
        : result.reaction.className === 'ReactionPaid'
          ? '⭐'
          : JSON.stringify(result.reaction);
      reactionsArray.push({ reaction: reactionKey, count: result.count });
    }
  }
  return reactionsArray;
}

async function getResumeMinId(channel: string): Promise<number> {
  const latest = await Post.findOne({ channelId: channel })
    .sort({ telegramId: -1 })
    .select('telegramId')
    .lean();
  if (latest && typeof latest.telegramId === 'number') {
    console.log(`Resuming after telegramId ${latest.telegramId}`);
    return latest.telegramId;
  }
  return 0;
}

async function fetchHistoricalData(
  channel: string,
  client: GramJSClient,
  limit: number
): Promise<void> {
  const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

  const minId = await getResumeMinId(channel);

  let totalSaved = 0;
  let countInChunk = 0;

  const iterOpts: { limit: number; chunkSize: number; minId?: number } = {
    limit,
    chunkSize: 20,
  };
  if (minId > 0) {
    iterOpts.minId = minId;
  }

  for await (const message of client.iterMessages(channel, iterOpts)) {
    const exists = await Post.findOne({ telegramId: message.id, channelId: channel });
    if (!exists) {
      const media = await processMedia(message, client, channel);
      const newPost = new Post({
        telegramId: message.id,
        channelId: channel,
        text: message.message || '',
        entities: message.entities || [],
        media: media,
        stats: {
          views: message.views || 0,
          reactions: processReactions(message.reactions),
        },
        date: new Date(message.date * 1000),
      });
      await newPost.save();
      totalSaved++;
      console.log(`Post ${message.id} saved`);
    }
    countInChunk++;
    if (countInChunk % 20 === 0) {
      console.log('Processed 20 messages, pausing 5 seconds...');
      await sleep(5000);
    }
  }
  console.log(`Total saved: ${totalSaved} posts`);
}

async function startClient(): Promise<void> {
  const { channel, limit } = parseArgs();
  console.log(`Channel: ${channel}, Limit: ${limit || 'unlimited'}`);

  try {
    await mongoose.connect(process.env.MONGO_URI!);
    console.log('Database connected');
  } catch (err) {
    console.error('Database connection error:', err);
    process.exit(1);
  }

  const apiId = parseInt(process.env.API_ID!, 10);
  const apiHash = process.env.API_HASH!;
  const sessionString = loadSession();
  const stringSession = new StringSession(sessionString);

  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  console.log('Starting Telegram client...');
  await client.start({
    phoneNumber: process.env.PHONE_NUMBER!,
    password: async () => await input.text('Enter password: '),
    phoneCode: async () => await input.text('Enter confirmation code: '),
    onError: (err: Error) => console.log(err),
  });
  console.log('Telegram client started');

  // Save session after successful auth
  const savedSession = client.session.save() as unknown as string;
  saveSession(savedSession);

  await fetchHistoricalData(channel, client as unknown as GramJSClient, limit);
  console.log('Historical data fetch complete.');

  process.exit(0);
}

startClient();
