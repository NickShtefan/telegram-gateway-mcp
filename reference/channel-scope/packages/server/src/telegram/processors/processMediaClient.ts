import fs from 'fs';
import path from 'path';
import { Api } from 'telegram';
import { ROOT_DIR } from '../../config/paths.js';
import type { MediaItem } from 'channel-scope-shared';
import type { GramJSClient, GramJSMessage } from '../../types/index.js';

function getDocFilename(doc: Api.Document): string | undefined {
  for (const attr of doc.attributes || []) {
    if (attr instanceof Api.DocumentAttributeFilename) {
      return attr.fileName;
    }
  }
  return undefined;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;
const DC_REDIRECT_DELAY_MS = 5000;

/**
 * Check if an error is related to DC redirect / file lives in another DC.
 * GramJS may throw various forms of this error.
 */
export function isDcRedirectError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /file.*(another|different)\s*dc/i.test(msg)
    || /dc.*redirect/i.test(msg)
    || /FILE_MIGRATE/i.test(msg)
    || /NETWORK_MIGRATE/i.test(msg);
}

async function downloadWithRetry(
  client: GramJSClient,
  media: unknown,
  retries: number = MAX_RETRIES,
): Promise<Buffer> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const fileBuffer = await client.downloadMedia(media);
      return Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(fileBuffer);
    } catch (err) {
      const isDcError = isDcRedirectError(err);
      if (attempt < retries) {
        const delay = isDcError ? DC_REDIRECT_DELAY_MS : RETRY_DELAY_MS;
        console.warn(
          `[Media] Download attempt ${attempt + 1} failed${isDcError ? ' (DC redirect)' : ''}, retrying in ${delay}ms...`,
        );
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw err;
      }
    }
  }
  throw new Error('Unreachable');
}

/**
 * Extracts media metadata from a GramJS message WITHOUT downloading any files.
 * Used in Phase 1 of the two-pass architecture for fast metadata collection.
 * Items already on disk are marked downloaded: true; others are downloaded: false.
 */
export function extractMediaMetadata(
  message: GramJSMessage,
  channelName?: string,
): MediaItem[] {
  const mediaArray: MediaItem[] = [];
  const channel = channelName
    || (message.chat && (message.chat.username || message.chat.title))
    || 'unknown_channel';

  const postDir = path.resolve(ROOT_DIR, 'media', channel, String(message.id));

  // Photos
  if (message.media instanceof Api.MessageMediaPhoto) {
    const photo = (message.media as Api.MessageMediaPhoto).photo as Api.Photo;
    const filename = `${message.id}.jpg`;
    const filePath = path.join(postDir, filename);
    const alreadyExists = fs.existsSync(filePath);

    mediaArray.push({
      fileId: photo.id ? photo.id.toString() : '',
      fileType: 'photo',
      caption: message.message || '',
      filename,
      filePath,
      downloaded: alreadyExists,
    });
  }

  // Documents: GIF, video, and other files
  if (
    message.media instanceof Api.MessageMediaDocument
    && (message.media as Api.MessageMediaDocument).document
  ) {
    const doc = (message.media as Api.MessageMediaDocument).document as Api.Document;
    const attributes = doc.attributes || [];
    const isAnimated = attributes.some(attr => attr instanceof Api.DocumentAttributeAnimated);
    const isVideo = attributes.some(attr => attr instanceof Api.DocumentAttributeVideo);

    if (isAnimated || isVideo) {
      const docFilename = getDocFilename(doc);
      const ext = docFilename ? path.extname(docFilename) : '.mp4';
      const fileType = isAnimated ? 'gif' : 'video';
      const filename = `${message.id}${ext}`;
      const filePath = path.join(postDir, filename);
      const alreadyExists = fs.existsSync(filePath);

      // Extract dimensions/duration from video attributes
      const videoAttr = attributes.find(attr => attr instanceof Api.DocumentAttributeVideo) as
        | { w?: number; h?: number; duration?: number }
        | undefined;

      mediaArray.push({
        fileId: message.id.toString(),
        fileType: fileType as 'gif' | 'video',
        caption: message.message || '',
        filename,
        filePath,
        downloaded: alreadyExists,
        ...(videoAttr?.w ? { width: videoAttr.w } : {}),
        ...(videoAttr?.h ? { height: videoAttr.h } : {}),
        ...(videoAttr?.duration ? { duration: videoAttr.duration } : {}),
        ...(doc.mimeType ? { mime_type: doc.mimeType } : {}),
      });
    }
  }

  return mediaArray;
}

/**
 * Downloads media files for a post that was saved with downloaded: false.
 * Used in Phase 2 of the two-pass architecture.
 * Returns the updated media array and count of newly downloaded items.
 */
export async function downloadPostMedia(
  post: { telegramId: number; channelId: string; media: MediaItem[] },
  client: GramJSClient,
  channelName: string,
): Promise<{ media: MediaItem[]; newDownloads: number }> {
  let newDownloads = 0;
  const updatedMedia: MediaItem[] = [];

  // Fetch the message once to get a fresh media reference for download
  const msgs = await client.getMessages(channelName, { ids: post.telegramId });
  const message = msgs && msgs.length > 0 ? msgs[0] : null;

  for (const item of post.media) {
    if (item.downloaded) {
      updatedMedia.push(item);
      continue;
    }

    if (!message || !message.media) {
      updatedMedia.push(item);
      continue;
    }

    const postDir = path.resolve(ROOT_DIR, 'media', channelName, String(post.telegramId));
    const filePath = item.filePath || path.join(postDir, item.filename);

    try {
      await fs.promises.mkdir(postDir, { recursive: true });
      const buffer = await downloadWithRetry(client, message.media);
      await fs.promises.writeFile(filePath, buffer);
      updatedMedia.push({ ...item, filePath, downloaded: true });
      newDownloads++;
      console.log(`[Media] Phase 2 downloaded: ${filePath}`);
    } catch (err) {
      const errorMsg = (err as Error).message;
      const dcError = isDcRedirectError(err);
      console.error(
        `[Media] Phase 2 download failed for post #${post.telegramId}${dcError ? ' (DC redirect - skipping)' : ''}:`,
        errorMsg,
      );
      updatedMedia.push({
        ...item,
        downloaded: false,
        error: dcError ? `DC redirect failed after ${MAX_RETRIES + 1} attempts` : errorMsg,
      });
    }
  }

  return { media: updatedMedia, newDownloads };
}

/**
 * Downloads and saves media from a GramJS message.
 * Files are saved to: media/<channelName>/<postId>/<filename>
 * Skips files that already exist on disk.
 * On failure, records the media item with downloaded=false so it can be retried.
 */
export default async function processMedia(
  message: GramJSMessage,
  client: GramJSClient,
  channelName?: string,
): Promise<MediaItem[]> {
  const mediaArray: MediaItem[] = [];
  const channel = channelName
    || (message.chat && (message.chat.username || message.chat.title))
    || 'unknown_channel';

  const postDir = path.resolve(ROOT_DIR, 'media', channel, String(message.id));

  // Photos
  if (message.media instanceof Api.MessageMediaPhoto) {
    const photo = (message.media as Api.MessageMediaPhoto).photo as Api.Photo;
    const filename = `${message.id}.jpg`;
    const filePath = path.join(postDir, filename);

    if (fs.existsSync(filePath)) {
      console.log(`[Media] Photo already exists, skipping: ${filePath}`);
      mediaArray.push({
        fileId: photo.id ? photo.id.toString() : '',
        fileType: 'photo',
        caption: message.message || '',
        filename,
        filePath,
        downloaded: true,
      });
    } else {
      try {
        await fs.promises.mkdir(postDir, { recursive: true });
        const buffer = await downloadWithRetry(client, message.media);
        await fs.promises.writeFile(filePath, buffer);
        mediaArray.push({
          fileId: photo.id ? photo.id.toString() : '',
          fileType: 'photo',
          caption: message.message || '',
          filename,
          filePath,
          downloaded: true,
        });
        console.log('[Media] Photo saved:', filePath);
      } catch (err) {
        const errorMsg = (err as Error).message;
        console.error(`[Media] Error downloading photo for message ${message.id}:`, errorMsg);
        // Record failed media so it can be retried later
        mediaArray.push({
          fileId: photo.id ? photo.id.toString() : '',
          fileType: 'photo',
          caption: message.message || '',
          filename,
          filePath,
          downloaded: false,
          error: isDcRedirectError(err) ? `DC redirect failed after ${MAX_RETRIES + 1} attempts` : errorMsg,
        });
      }
    }
  }

  // Documents: GIF, video, and other files
  if (
    message.media instanceof Api.MessageMediaDocument
    && (message.media as Api.MessageMediaDocument).document
  ) {
    const doc = (message.media as Api.MessageMediaDocument).document as Api.Document;
    const attributes = doc.attributes || [];
    const isAnimated = attributes.some(attr => attr instanceof Api.DocumentAttributeAnimated);
    const isVideo = attributes.some(attr => attr instanceof Api.DocumentAttributeVideo);

    if (isAnimated || isVideo) {
      const docFilename = getDocFilename(doc);
      const ext = docFilename ? path.extname(docFilename) : '.mp4';
      const fileType = isAnimated ? 'gif' : 'video';
      const filename = `${message.id}${ext}`;
      const filePath = path.join(postDir, filename);

      if (fs.existsSync(filePath)) {
        console.log(`[Media] ${fileType} already exists, skipping: ${filePath}`);
        mediaArray.push({
          fileId: message.id.toString(),
          fileType: fileType as 'gif' | 'video',
          caption: message.message || '',
          filename,
          filePath,
          downloaded: true,
        });
      } else {
        try {
          await fs.promises.mkdir(postDir, { recursive: true });
          const buffer = await downloadWithRetry(client, message.media);
          await fs.promises.writeFile(filePath, buffer);
          mediaArray.push({
            fileId: message.id.toString(),
            fileType: fileType as 'gif' | 'video',
            caption: message.message || '',
            filename,
            filePath,
            downloaded: true,
          });
          console.log(`[Media] ${fileType} saved:`, filePath);
        } catch (err) {
          const errorMsg = (err as Error).message;
          console.error(
            `[Media] Error saving ${fileType} for message ${message.id}:`,
            errorMsg,
          );
          // Record failed media so it can be retried later
          mediaArray.push({
            fileId: message.id.toString(),
            fileType: fileType as 'gif' | 'video',
            caption: message.message || '',
            filename,
            filePath,
            downloaded: false,
            error: isDcRedirectError(err) ? `DC redirect failed after ${MAX_RETRIES + 1} attempts` : errorMsg,
          });
        }
      }
    }
  }

  return mediaArray;
}
