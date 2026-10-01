/**
 * Изображения и медиа: фото, альбом, превью видео. Файлы кладутся в общую
 * папку, которую читают агенты; в ответе пути.
 *
 * Из channel-scope `processMediaClient.ts` взяты разбор медиа, повтор при
 * ошибке «файл в другом дата-центре» (`isDcRedirectError`) и кэш по наличию
 * файла на диске. Добавлены выбор размера, предел размера файла и квота папки.
 */
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { Api } from 'teleproto';
import { createLogger, type Logger } from '../core/log.js';
import { ensureTrustedDir, isOwnRegularFile, writeNewFile } from '../core/safeFs.js';
import { sleep } from '../core/time.js';
import type { Tg, TgCallOptions } from '../core/tg.js';
import { normalizeMedia, type MediaKind } from './messages.js';

export type MediaSize = 'thumb' | 'full';

export interface MediaFile {
  messageId: number;
  kind: MediaKind;
  size: MediaSize;
  path: string;
  bytes: number;
  mime: string;
  /** Файл уже лежал на диске: Telegram не тревожили. */
  cached: boolean;
}

export interface MediaSkip {
  messageId: number;
  reason: string;
}

export interface MediaResult {
  files: MediaFile[];
  skipped: MediaSkip[];
}

export interface MediaServiceOptions {
  tg: Tg;
  /** Общая папка шлюза; медиа лежат в `<filesDir>/media`. */
  filesDir: string;
  /** Предел размера файла в полном размере. */
  maxFullBytes?: number;
  /** Предел суммарного размера папки с медиа. */
  quotaBytes?: number;
  log?: Logger;
  now?: () => number;
}

const DEFAULT_MAX_FULL_BYTES = 20 * 1024 * 1024;
const DEFAULT_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
const QUOTA_CHECK_EVERY = 50;

/** Файл лежит в другом дата-центре: GramJS иногда бросает это вместо того, чтобы перейти сам. */
export function isDcRedirectError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Так выглядит настоящий FileMigrateError в GramJS: «The file to be accessed is currently stored in DC N».
  return /stored in DC/i.test(msg) || /file.*(another|different)\s*dc/i.test(msg) || /dc.*redirect/i.test(msg) || /FILE_MIGRATE/i.test(msg) || /NETWORK_MIGRATE/i.test(msg);
}

interface RawSize {
  className?: string;
  type?: string;
  w?: number;
  h?: number;
}

/**
 * Тип размера для превью: около 320 px по длинной стороне. Возвращает букву
 * типа (`m`, `x`, ...), которую понимает параметр `thumb` в GramJS, или null.
 */
export function pickThumbType(sizes: unknown): string | null {
  if (!Array.isArray(sizes)) return null;
  const usable = (sizes as RawSize[]).filter(
    s => s && typeof s.type === 'string' && typeof s.w === 'number' && typeof s.h === 'number' && s.className !== 'PhotoStrippedSize' && s.className !== 'PhotoPathSize',
  );
  if (usable.length === 0) return null;
  const side = (s: RawSize): number => Math.max(s.w ?? 0, s.h ?? 0);
  const sorted = [...usable].sort((a, b) => side(a) - side(b));
  const medium = sorted.find(s => s.type === 'm') ?? sorted.find(s => side(s) >= 320) ?? sorted[sorted.length - 1]!;
  return medium.type ?? null;
}

const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'application/pdf': '.pdf',
};

interface RawMessage {
  id?: number;
  media?: {
    className?: string;
    photo?: { sizes?: unknown };
    document?: { thumbs?: unknown; mimeType?: string };
  } | null;
}

/** Имя папки чата на диске: ключ чата без минуса в начале. */
export function chatDirName(chatKey: string): string {
  return chatKey.startsWith('-') ? `n${chatKey.slice(1)}` : `u${chatKey}`;
}

export class MediaService {
  private readonly tg: Tg;
  private readonly filesDir: string;
  private readonly root: string;
  private readonly maxFullBytes: number;
  private readonly quotaBytes: number;
  private readonly log: Logger;
  private readonly now: () => number;
  private writesSinceQuotaCheck = 0;

  constructor(options: MediaServiceOptions) {
    this.tg = options.tg;
    this.filesDir = options.filesDir;
    this.root = join(options.filesDir, 'media');
    this.maxFullBytes = options.maxFullBytes ?? DEFAULT_MAX_FULL_BYTES;
    this.quotaBytes = options.quotaBytes ?? DEFAULT_QUOTA_BYTES;
    this.log = options.log ?? createLogger('media');
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Скачивает медиа сырых сообщений GramJS. По умолчанию превью: картинки
   * дорогие для модели, полный размер только по явному запросу.
   */
  async download(accountId: string, chatKey: string, rawMessages: unknown[], size: MediaSize, options?: TgCallOptions): Promise<MediaResult> {
    const result: MediaResult = { files: [], skipped: [] };

    for (const raw of rawMessages as RawMessage[]) {
      const messageId = raw?.id;
      if (typeof messageId !== 'number') continue;
      const media = normalizeMedia(raw.media);
      if (!media || !media.downloadable) {
        result.skipped.push({ messageId, reason: media ? `${media.kind} cannot be downloaded` : 'no media' });
        continue;
      }

      const isPhoto = media.kind === 'photo';
      let thumb: string | undefined;
      let ext = '.jpg';
      let mime = 'image/jpeg';

      if (size === 'thumb') {
        const sizes = isPhoto ? raw.media?.photo?.sizes : raw.media?.document?.thumbs;
        const type = pickThumbType(sizes);
        if (!type) {
          result.skipped.push({ messageId, reason: 'no preview available' });
          continue;
        }
        thumb = type;
      } else if (!isPhoto) {
        if (media.sizeBytes !== undefined && media.sizeBytes > this.maxFullBytes) {
          result.skipped.push({
            messageId,
            reason: `file is ${Math.round(media.sizeBytes / 1024 / 1024)} MB, over the ${Math.round(this.maxFullBytes / 1024 / 1024)} MB limit; use size=thumb for a preview`,
          });
          continue;
        }
        mime = media.mime ?? 'application/octet-stream';
        // Имя файла приходит из Telegram: расширение берётся только простое, иначе по типу.
        const named = media.fileName ? extname(media.fileName).toLowerCase() : '';
        ext = /^\.[a-z0-9]{1,8}$/.test(named) ? named : (MIME_EXT[mime] ?? '.bin');
      }

      // id сообщений в личных чатах свои у каждого аккаунта: кэш раздельный.
      const path = join(this.root, accountId, chatDirName(chatKey), `${messageId}-${thumb ? 'thumb' : 'full'}${ext}`);
      // Кэшем считается только свой обычный файл: по подложенной ссылке шлюз не пойдёт.
      if (isOwnRegularFile(path) && lstatSync(path).size > 0) {
        result.files.push({ messageId, kind: media.kind, size: thumb ? 'thumb' : 'full', path, bytes: lstatSync(path).size, mime, cached: true });
        continue;
      }

      try {
        const buffer = await this.fetch(accountId, raw, thumb, options);
        if (!buffer || buffer.length === 0) {
          result.skipped.push({ messageId, reason: 'Telegram returned an empty file' });
          continue;
        }
        this.write(path, buffer);
        result.files.push({ messageId, kind: media.kind, size: thumb ? 'thumb' : 'full', path, bytes: buffer.length, mime, cached: false });
      } catch (err) {
        result.skipped.push({ messageId, reason: (err as Error).message });
      }
    }

    return result;
  }

  private async fetch(accountId: string, raw: RawMessage, thumb: string | undefined, options?: TgCallOptions): Promise<Buffer | null> {
    const attempt = (): Promise<Buffer | null> =>
      this.tg.withClient(
        accountId,
        'downloadMedia',
        async client => {
          const data = await client.downloadMedia(raw as unknown as Api.Message, thumb ? { thumb: thumb as never } : {});
          if (!data) return null;
          return Buffer.isBuffer(data) ? data : Buffer.from(data as string, 'binary');
        },
        // Скачивание дольше обычного вызова, а его таймаут не повод ронять процесс.
        { deadlineMs: 60_000, onHang: 'error', ...options },
      );

    try {
      return await attempt();
    } catch (err) {
      if (!isDcRedirectError(err)) throw err;
      this.log.warn('file lives in another DC, retrying', { account: accountId, message: raw.id });
      await sleep(2_000);
      return attempt();
    }
  }

  /** Пишет файл так, чтобы его могли прочитать агенты под другим пользователем macOS. */
  private write(path: string, buffer: Buffer): void {
    ensureTrustedDir(dirname(path), this.filesDir);
    writeNewFile(path, buffer, 0o644);

    if (++this.writesSinceQuotaCheck >= QUOTA_CHECK_EVERY) {
      this.writesSinceQuotaCheck = 0;
      this.enforceQuota();
    }
  }

  /** Удаляет самые старые файлы, пока папка не уложится в 80% квоты. */
  enforceQuota(): { removed: number; bytes: number } {
    const files: Array<{ path: string; size: number; mtime: number }> = [];
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        // Ссылки не учитываются и не обходятся: чужое шлюз не удаляет.
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          const st = lstatSync(full);
          files.push({ path: full, size: st.size, mtime: st.mtimeMs });
        }
      }
    };
    walk(this.root);

    let total = files.reduce((sum, f) => sum + f.size, 0);
    if (total <= this.quotaBytes) return { removed: 0, bytes: total };

    const target = this.quotaBytes * 0.8;
    let removed = 0;
    for (const file of files.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= target) break;
      try {
        rmSync(file.path);
        total -= file.size;
        removed++;
      } catch {
        // файл мог исчезнуть сам
      }
    }
    this.log.info('media quota enforced', { removed, bytes: total, at: this.now() });
    return { removed, bytes: total };
  }
}
