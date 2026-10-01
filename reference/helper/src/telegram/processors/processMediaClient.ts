import fs from 'fs';
import path from 'path';
import { Api } from 'telegram';
import type { GramJSClient, GramJSMessage, MediaItem } from '../../types/index.js';

function getDocFilename(doc: Api.Document): string | undefined {
  for (const attr of doc.attributes || []) {
    if (attr instanceof Api.DocumentAttributeFilename) {
      return attr.fileName;
    }
  }
  return undefined;
}

/**
 * Downloads and saves media from a GramJS message.
 * Files are saved to: media/<channelName>/<postId>/<filename>
 * Skips files that already exist on disk.
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

  const postDir = path.resolve(process.cwd(), 'media', channel, String(message.id));

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
        const fileBuffer = await client.downloadMedia(message.media);
        const buffer = Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(fileBuffer);
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
        console.error(`[Media] Error downloading photo for message ${message.id}:`, err);
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
          const fileBuffer = await client.downloadMedia(message.media);
          const buffer = Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(fileBuffer);
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
          console.error(
            `[Media] Error saving ${fileType} for message ${message.id}:`,
            (err as Error).message,
          );
        }
      }
    }
  }

  return mediaArray;
}
