import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Load .env from monorepo root (5 levels up from packages/server/src/db/export/)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..', '..', '..', '..', '..');
dotenv.config({ path: path.join(ROOT_DIR, '.env') });
import Post from '../models/Post.js';

const MONGO_URI = process.env.MONGO_URI;
const mediaDir = path.resolve(__dirname, '../../../media/stonksnws');
const outputDir = path.join(__dirname, '../../../output/stonksnws');

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

if (!MONGO_URI) {
  console.error('Отсутствует MONGO_URI в переменных окружения.');
  process.exit(1);
}

interface FormattedEntity {
  type: string;
  offset: number;
  length: number;
  url: string | null;
}

interface FormattedLink {
  url: string;
  offset: number;
  length: number;
}

interface FormattedMedia {
  filename: string;
  filePath: string;
}

interface FormattedPost {
  id: string;
  telegramId: number;
  channelId: string;
  text: string;
  stats: {
    views: number;
    reactions: Record<string, number>;
  };
  entities: FormattedEntity[];
  links: FormattedLink[];
  date: string;
  createdAt: string;
  updatedAt: string;
  media: FormattedMedia[];
}

async function startApp(): Promise<void> {
  try {
    await mongoose.connect(MONGO_URI!);
    console.info('Подключение к MongoDB успешно установлено.');
    await fetchAndSavePosts();
  } catch (error) {
    console.error('Ошибка подключения к MongoDB:', error);
    process.exit(1);
  }
}

async function fetchAndSavePosts(): Promise<void> {
  try {
    const posts = await Post.find();
    const formattedPosts: FormattedPost[] = posts.map(post => ({
      id: post._id.toString(),
      telegramId: post.telegramId,
      channelId: post.channelId,
      text: post.text,
      stats: {
        views: post.stats.views,
        reactions: post.stats.reactions.reduce((acc: Record<string, number>, reaction) => {
          acc[reaction.reaction] = reaction.count;
          return acc;
        }, {})
      },
      entities: (post.entities as Array<{ className?: string; offset?: number; length?: number; originalArgs?: { url?: string } }>).map(entity => ({
        type: entity.className || '',
        offset: entity.offset || 0,
        length: entity.length || 0,
        url: entity.originalArgs?.url || null
      })),
      links: (post.entities as Array<{ className?: string; offset?: number; length?: number; originalArgs?: { url?: string } }>)
        .filter(entity => entity.className === 'MessageEntityTextUrl')
        .map(entity => ({
          url: entity.originalArgs?.url || '',
          offset: entity.offset || 0,
          length: entity.length || 0
        })),
      date: new Date(post.date).toISOString(),
      createdAt: new Date(post.createdAt).toISOString(),
      updatedAt: new Date(post.updatedAt).toISOString(),
      media: post.media.map(media => ({
        filename: media.filename,
        filePath: path.join(outputDir, media.filename)
      }))
    }));

    fs.writeFileSync(path.join(outputDir, 'formattedPosts.json'), JSON.stringify(formattedPosts, null, 2));

    posts.forEach(post => {
      post.media.forEach(media => {
        const sourcePath = path.join(mediaDir, media.filename);
        const destPath = path.join(outputDir, media.filename);
        fs.copyFileSync(sourcePath, destPath);
      });
    });

    console.log('Data processing and saving completed successfully.');
  } catch (error) {
    console.error('Error while fetching and saving posts:', error);
  }
}

startApp();
