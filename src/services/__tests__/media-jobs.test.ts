import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTg } from '../../__tests__/helpers/fakeTg.js';
import { GatewayError } from '../../core/errors.js';
import { createLogger } from '../../core/log.js';
import { SqliteStorage } from '../../storage/sqlite.js';
import { JobManager } from '../jobs.js';
import { chatDirName, isDcRedirectError, MediaService, pickThumbType } from '../media.js';

const silent = createLogger('test', { level: 'silent' });
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tgmcp-media-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const photoSizes = [
  { className: 'PhotoStrippedSize', type: 'i' },
  { className: 'PhotoSize', type: 's', w: 90, h: 67 },
  { className: 'PhotoSize', type: 'm', w: 320, h: 240 },
  { className: 'PhotoSize', type: 'x', w: 800, h: 600 },
  { className: 'PhotoSizeProgressive', type: 'y', w: 1280, h: 960 },
];

const photoMessage = (id: number) => ({ className: 'Message', id, media: { className: 'MessageMediaPhoto', photo: { className: 'Photo', sizes: photoSizes } } });
const videoMessage = (id: number, size: number, thumbs: unknown[] = [{ className: 'PhotoSize', type: 'm', w: 320, h: 180 }]) => ({
  className: 'Message',
  id,
  media: {
    className: 'MessageMediaDocument',
    document: { className: 'Document', mimeType: 'video/mp4', size: BigInt(size), thumbs, attributes: [{ className: 'DocumentAttributeVideo', duration: 12, w: 1280, h: 720 }] },
  },
});

describe('pickThumbType', () => {
  it('берёт размер около 320 px и не берёт заглушки', () => {
    expect(pickThumbType(photoSizes)).toBe('m');
    expect(pickThumbType(photoSizes.filter(s => s.type !== 'm'))).toBe('x');
    expect(pickThumbType([{ className: 'PhotoSize', type: 's', w: 90, h: 67 }])).toBe('s');
    expect(pickThumbType([{ className: 'PhotoStrippedSize', type: 'i' }])).toBeNull();
    expect(pickThumbType(undefined)).toBeNull();
  });
});

describe('MediaService', () => {
  function setup(downloadMedia = vi.fn(async (_message: unknown, _params?: unknown) => Buffer.from('JPEGDATA'))) {
    const tg = new FakeTg();
    tg.client = { downloadMedia } as never;
    return { tg, downloadMedia, media: new MediaService({ tg, filesDir: dir, log: silent, maxFullBytes: 1000 }) };
  }

  it('скачивает превью, кладёт файл с правами для чтения агентами', async () => {
    const { media, downloadMedia } = setup();
    const result = await media.download('agent', '-1000000000500', [photoMessage(10)], 'thumb');
    expect(result.skipped).toEqual([]);
    const file = result.files[0]!;
    expect(file).toMatchObject({ messageId: 10, kind: 'photo', size: 'thumb', bytes: 8, mime: 'image/jpeg', cached: false });
    expect(file.path).toBe(join(dir, 'media', 'n1000000000500', '10-thumb.jpg'));
    expect(readFileSync(file.path, 'utf8')).toBe('JPEGDATA');
    expect(statSync(file.path).mode & 0o777).toBe(0o644);
    expect(downloadMedia.mock.calls[0]![1]).toEqual({ thumb: 'm' });
  });

  it('повторный запрос берётся с диска без обращения к Telegram', async () => {
    const { media, downloadMedia } = setup();
    await media.download('agent', '-1000000000500', [photoMessage(10)], 'thumb');
    const again = await media.download('agent', '-1000000000500', [photoMessage(10)], 'thumb');
    expect(again.files[0]!.cached).toBe(true);
    expect(downloadMedia).toHaveBeenCalledTimes(1);
  });

  it('полный размер фото качается без параметра thumb', async () => {
    const { media, downloadMedia } = setup();
    const result = await media.download('agent', '42', [photoMessage(7)], 'full');
    expect(result.files[0]!.path).toBe(join(dir, 'media', 'u42', '7-full.jpg'));
    expect(downloadMedia.mock.calls[0]![1]).toEqual({});
  });

  it('видео: превью скачивается, полный файл сверх лимита пропускается', async () => {
    const { media, downloadMedia } = setup();
    const thumb = await media.download('agent', '-1000000000500', [videoMessage(20, 50_000_000)], 'thumb');
    expect(thumb.files[0]).toMatchObject({ kind: 'video', size: 'thumb', mime: 'image/jpeg' });
    const full = await media.download('agent', '-1000000000500', [videoMessage(21, 50_000_000), videoMessage(22, 500)], 'full');
    expect(full.skipped[0]).toMatchObject({ messageId: 21, reason: expect.stringContaining('over the 0 MB limit') });
    expect(full.files[0]).toMatchObject({ messageId: 22, size: 'full', mime: 'video/mp4' });
    expect(full.files[0]!.path.endsWith('22-full.mp4')).toBe(true);
    expect(downloadMedia).toHaveBeenCalledTimes(2);
  });

  it('сообщения без медиа и без превью пропускаются с причиной', async () => {
    const { media } = setup();
    const result = await media.download(
      'agent',
      '-1000000000500',
      [{ className: 'Message', id: 1 }, { className: 'Message', id: 2, media: { className: 'MessageMediaPoll' } }, videoMessage(3, 10, [])],
      'thumb',
    );
    expect(result.files).toEqual([]);
    expect(result.skipped.map(s => s.reason)).toEqual(['no media', 'poll cannot be downloaded', 'no preview available']);
  });

  it('ошибка «файл в другом дата-центре» повторяется один раз', async () => {
    vi.useFakeTimers();
    try {
      const downloadMedia = vi.fn().mockRejectedValueOnce(new Error('FILE_MIGRATE_4')).mockResolvedValueOnce(Buffer.from('OK'));
      const { media } = setup(downloadMedia as never);
      const p = media.download('agent', '-1000000000500', [photoMessage(10)], 'thumb');
      await vi.advanceTimersByTimeAsync(2_100);
      expect((await p).files).toHaveLength(1);
      expect(downloadMedia).toHaveBeenCalledTimes(2);
      expect(isDcRedirectError(new Error('socket hang up'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('сбой скачивания одного файла не ломает остальные', async () => {
    const downloadMedia = vi.fn().mockRejectedValueOnce(new GatewayError('TIMEOUT', 'download timed out')).mockResolvedValueOnce(Buffer.from('OK'));
    const { media } = setup(downloadMedia as never);
    const result = await media.download('agent', '-1000000000500', [photoMessage(1), photoMessage(2)], 'thumb');
    expect(result.skipped).toEqual([{ messageId: 1, reason: 'download timed out' }]);
    expect(result.files.map(f => f.messageId)).toEqual([2]);
  });

  it('квота удаляет самые старые файлы', () => {
    const tg = new FakeTg();
    const media = new MediaService({ tg, filesDir: dir, log: silent, quotaBytes: 250 });
    const base = join(dir, 'media', 'n1');
    rmSync(base, { recursive: true, force: true });
    mkdirSync(base, { recursive: true });
    ['a', 'b', 'c'].forEach((name, i) => {
      const p = join(base, `${name}.jpg`);
      writeFileSync(p, 'x'.repeat(100));
      utimesSync(p, 1000 + i, 1000 + i);
    });
    const outcome = media.enforceQuota();
    expect(outcome.removed).toBe(1);
    expect(existsSync(join(base, 'a.jpg'))).toBe(false);
    expect(existsSync(join(base, 'c.jpg'))).toBe(true);
    expect(chatDirName('-4321')).toBe('n4321');
  });
});

describe('JobManager', () => {
  let storage: SqliteStorage;

  beforeEach(() => {
    storage = new SqliteStorage({ path: ':memory:' });
  });

  afterEach(() => storage.close());

  it('задача выполняется, прогресс и результат видны её хозяину', async () => {
    const jobs = new JobManager({ storage, log: silent });
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    jobs.register('export', async ctx => {
      ctx.progress({ rows: 100 });
      await gate;
      return { path: '/x.jsonl', rows: 400 };
    });
    const job = jobs.start({ userId: 'nick', accountId: 'agent', kind: 'export', params: { chat: '-1001' } });
    expect(job.id).toMatch(/^job_[0-9a-f]{12}$/);
    await vi.waitFor(() => expect(jobs.get(job.id, 'nick')).toMatchObject({ state: 'running', progress: { rows: 100 } }));
    release();
    const done = await jobs.waitFor(job.id, 'nick', 1_000);
    expect(done).toMatchObject({ state: 'done', result: { path: '/x.jsonl', rows: 400 } });
    expect(() => jobs.get(job.id, 'partner')).toThrow(/not found/);
  });

  it('waitFor возвращает состояние по таймауту, не дожидаясь конца', async () => {
    const jobs = new JobManager({ storage, log: silent });
    jobs.register('slow', () => new Promise(() => undefined));
    const job = jobs.start({ userId: 'nick', kind: 'slow', params: {} });
    const state = await jobs.waitFor(job.id, 'nick', 20);
    expect(state.state).toBe('running');
    jobs.stop();
  });

  it('ошибка исполнителя сохраняется с кодом', async () => {
    const jobs = new JobManager({ storage, log: silent });
    jobs.register('export', async () => {
      throw new GatewayError('FLOOD_WAIT', 'wait 400 seconds', { retryAfter: 400 });
    });
    const job = jobs.start({ userId: 'nick', kind: 'export', params: {} });
    const done = await jobs.waitFor(job.id, 'nick', 1_000);
    expect(done).toMatchObject({ state: 'failed', error: 'FLOOD_WAIT: wait 400 seconds' });
    expect(() => jobs.start({ userId: 'nick', kind: 'unknown', params: {} })).toThrow(/Unknown job kind/);
  });

  it('одновременно идёт не больше заданного числа задач', async () => {
    const jobs = new JobManager({ storage, log: silent, concurrency: 1 });
    const releases: Array<() => void> = [];
    let running = 0;
    let maxRunning = 0;
    jobs.register('export', async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise<void>(r => releases.push(r));
      running--;
      return {};
    });
    const a = jobs.start({ userId: 'nick', kind: 'export', params: { n: 1 } });
    const b = jobs.start({ userId: 'nick', kind: 'export', params: { n: 2 } });
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(jobs.get(b.id, 'nick').state).toBe('queued');
    releases[0]!();
    await jobs.waitFor(a.id, 'nick', 1_000);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]!();
    await jobs.waitFor(b.id, 'nick', 1_000);
    expect(maxRunning).toBe(1);
  });

  it('отмена: задача в очереди снимается сразу, выполняемая видит флаг', async () => {
    const jobs = new JobManager({ storage, log: silent, concurrency: 1 });
    let sawCancel = false;
    jobs.register('export', async ctx => {
      while (!ctx.cancelled()) await new Promise(r => setTimeout(r, 5));
      sawCancel = true;
      return { rows: 10 };
    });
    const running = jobs.start({ userId: 'nick', kind: 'export', params: {} });
    const queued = jobs.start({ userId: 'nick', kind: 'export', params: {} });
    await vi.waitFor(() => expect(jobs.get(running.id, 'nick').state).toBe('running'));
    expect(jobs.cancel(queued.id, 'nick').state).toBe('cancelled');
    jobs.cancel(running.id, 'nick');
    const done = await jobs.waitFor(running.id, 'nick', 1_000);
    expect(sawCancel).toBe(true);
    expect(done).toMatchObject({ state: 'cancelled', result: { rows: 10 } });
  });

  it('после рестарта прерванная задача возвращается в очередь и выполняется', async () => {
    storage.jobs.create({ id: 'job_old', userId: 'nick', kind: 'export', params: { chat: '-1001' } });
    storage.jobs.update('job_old', { state: 'running', progress: { rows: 50 } });
    const jobs = new JobManager({ storage, log: silent });
    jobs.register('export', async ctx => ({ resumedFrom: ctx.job.progress.rows }));
    expect(jobs.resume()).toBe(1);
    const done = await jobs.waitFor('job_old', 'nick', 1_000);
    expect(done).toMatchObject({ state: 'done', result: { resumedFrom: 50 } });
  });
});
