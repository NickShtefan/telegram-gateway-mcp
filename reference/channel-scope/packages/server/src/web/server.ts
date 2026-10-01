import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cookieParser from 'cookie-parser';
import mongoose from 'mongoose';
import routes from './routes/index.js';
import { getJwtSecret, authMiddleware } from './middleware/auth.js';
import Channel from '../db/models/Channel.js';
import ResearchChannel from '../db/models/ResearchChannel.js';
import ResearchCollection, { DEFAULT_COLLECTION_NAME } from '../db/models/ResearchCollection.js';

// Resolve monorepo root relative to this file: src/web/server.ts → packages/server/src/web/
// Go up 4 levels: web → src → server → packages → root
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..', '..', '..');

export function createApp(): express.Application {
  // Validate required env vars
  getJwtSecret();

  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  // Auth middleware — before static files and routes
  app.use(authMiddleware);

  // Serve React build from packages/web/dist (production) or legacy from packages/server/src/web/public
  app.use(express.static(path.join(ROOT_DIR, 'packages', 'web', 'dist')));
  app.use(express.static(path.join(ROOT_DIR, 'packages', 'server', 'src', 'web', 'public')));

  // Serve downloaded media files
  app.use('/media', express.static(path.join(ROOT_DIR, 'media')));

  // Serve cached avatars
  app.use('/data/avatars', express.static(path.join(ROOT_DIR, 'data', 'avatars')));

  // API routes
  app.use(routes);

  // SPA fallback: serve React index.html for any non-API, non-file routes
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) {
      const reactIndex = path.join(ROOT_DIR, 'packages', 'web', 'dist', 'index.html');
      if (fs.existsSync(reactIndex)) {
        res.sendFile(reactIndex);
      } else {
        res.sendFile(path.join(ROOT_DIR, 'packages', 'server', 'src', 'web', 'public', 'index.html'));
      }
    } else {
      next();
    }
  });

  return app;
}

export async function runMigration(): Promise<void> {
  try {
    const db = mongoose.connection.db;
    if (!db) return;

    // Migrate channelInfos → channels
    const collections = await db.listCollections({ name: 'channelinfos' }).toArray();
    if (collections.length > 0) {
      const channelInfos = await db.collection('channelinfos').find().toArray();
      if (channelInfos.length > 0) {
        console.log(`[Migration] Found ${channelInfos.length} channelInfos to migrate`);
        for (const info of channelInfos) {
          await Channel.updateOne(
            { channelId: info.channelId },
            {
              $set: {
                username: info.username || '',
                description: info.description || '',
                subscriberCount: info.subscriberCount || 0,
                hasAvatar: info.hasAvatar || false,
              },
            },
          );
        }
        console.log('[Migration] channelInfos migrated to channels');
      }
    }

    // Migrate clients.channels[] → channels.clientIds[]
    const clientsWithChannels = await db.collection('clients').find({ channels: { $exists: true, $ne: [] } }).toArray();
    if (clientsWithChannels.length > 0) {
      console.log(`[Migration] Found ${clientsWithChannels.length} clients with channels to migrate`);
      for (const clientDoc of clientsWithChannels) {
        const channelIds = clientDoc.channels as string[];
        for (const channelId of channelIds) {
          await Channel.updateOne(
            { channelId },
            { $addToSet: { clientIds: clientDoc._id } },
          );
        }
        // Remove channels field from client
        await db.collection('clients').updateOne(
          { _id: clientDoc._id },
          { $unset: { channels: '' } },
        );
      }
      console.log('[Migration] clients.channels migrated to channels.clientIds');
    }
  } catch (err) {
    console.error('[Migration] Error:', err);
  }
}

/**
 * Ensure a "Default" ResearchCollection exists and that every ResearchChannel
 * without any collection membership is placed into it. Idempotent.
 */
export async function ensureDefaultCollection(): Promise<void> {
  try {
    let defaultCollection = await ResearchCollection.findOne({ name: DEFAULT_COLLECTION_NAME });
    if (!defaultCollection) {
      defaultCollection = await ResearchCollection.create({
        name: DEFAULT_COLLECTION_NAME,
        description: 'Default collection for existing research channels',
        color: '',
      });
      console.log('[Migration] Created "Default" research collection');
    }

    const result = await ResearchChannel.updateMany(
      { $or: [{ collectionIds: { $exists: false } }, { collectionIds: { $size: 0 } }] },
      { $addToSet: { collectionIds: defaultCollection._id } },
    );
    if (result.modifiedCount > 0) {
      console.log(`[Migration] Added ${result.modifiedCount} research channel(s) to "Default" collection`);
    }
  } catch (err) {
    console.error('[Migration] ensureDefaultCollection error:', err);
  }
}

export async function resetStuckResearch(): Promise<void> {
  const stuck = await ResearchChannel.updateMany({ status: 'downloading' }, { status: 'discovered' });
  if (stuck.modifiedCount > 0) {
    console.log(`[Startup] Reset ${stuck.modifiedCount} stuck research channel(s) from "downloading" to "discovered"`);
  }
}
