import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock TelegramClient
vi.mock('telegram', () => {
  const mockStart = vi.fn().mockResolvedValue(undefined);
  const mockSession = { save: vi.fn().mockReturnValue('saved-session-string') };
  const MockClient = vi.fn().mockImplementation(() => ({
    start: mockStart,
    session: mockSession,
    iterMessages: vi.fn(),
  }));
  (MockClient as Record<string, unknown>)._mockStart = mockStart;
  return { TelegramClient: MockClient };
});

// Mock Post model
vi.mock('../../db/models/Post.js', () => {
  const mockSave = vi.fn().mockResolvedValue(undefined);
  const MockPost = vi.fn().mockImplementation((data: Record<string, unknown>) => ({
    ...data,
    _id: 'new-id',
    save: mockSave,
  }));
  (MockPost as Record<string, unknown>).findOne = vi.fn().mockResolvedValue(null);
  (MockPost as Record<string, unknown>).aggregate = vi.fn().mockResolvedValue([]);
  (MockPost as Record<string, unknown>).find = vi.fn().mockReturnValue({
    sort: vi.fn().mockReturnValue({
      skip: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue([]),
    }),
  });
  (MockPost as Record<string, unknown>).countDocuments = vi.fn().mockResolvedValue(0);
  (MockPost as Record<string, unknown>)._mockSave = mockSave;
  return { default: MockPost };
});

// Mock processMediaClient
vi.mock('../../telegram/processors/processMediaClient.js', () => ({
  default: vi.fn().mockResolvedValue([]),
}));

import Post from '../../db/models/Post.js';
import { archiveService, ArchiveProgress } from '../../services/archiveService.js';

type MockFn = ReturnType<typeof vi.fn>;
const MockPost = Post as unknown as MockFn & {
  findOne: MockFn;
  aggregate: MockFn;
  find: MockFn;
  countDocuments: MockFn;
  _mockSave: MockFn;
};

describe('ArchiveService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (archiveService as unknown as { progress: ArchiveProgress }).progress.status = 'idle';
  });

  describe('getProgress', () => {
    it('should return a copy of progress', () => {
      const p = archiveService.getProgress();
      expect(p).toHaveProperty('status');
      expect(p).toHaveProperty('channel');
      expect(p).toHaveProperty('totalProcessed');
    });
  });

  describe('getHistory', () => {
    it('should return mapped channel stats from aggregation', async () => {
      MockPost.aggregate.mockResolvedValue([
        { _id: 'testchan', postCount: 100, mediaCount: 50, firstPost: new Date('2024-01-01'), lastPost: new Date('2024-06-01'), totalViews: 5000 },
      ]);

      const result = await archiveService.getHistory();

      expect(result).toEqual([
        { channelId: 'testchan', postCount: 100, mediaCount: 50, firstPost: expect.any(Date), lastPost: expect.any(Date), totalViews: 5000 },
      ]);
      expect(MockPost.aggregate).toHaveBeenCalled();
    });

    it('should return empty array when no channels exist', async () => {
      MockPost.aggregate.mockResolvedValue([]);
      const result = await archiveService.getHistory();
      expect(result).toEqual([]);
    });
  });

  describe('getPosts', () => {
    it('should return paginated posts', async () => {
      const mockPosts = [{ telegramId: 1, text: 'hello' }];
      MockPost.find.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          skip: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              lean: vi.fn().mockResolvedValue(mockPosts),
            }),
          }),
        }),
      });
      MockPost.countDocuments.mockResolvedValue(1);

      const result = await archiveService.getPosts('testchan', 1, 20);

      expect(result).toEqual({ posts: mockPosts, total: 1, page: 1, pages: 1 });
    });
  });

  describe('startArchive', () => {
    it('should throw when archive is already in progress', async () => {
      (archiveService as unknown as { progress: ArchiveProgress }).progress.status = 'downloading';
      await expect(archiveService.startArchive('chan')).rejects.toThrow('Archive already in progress');
    });

    it('should throw when no client is provided and none exists', async () => {
      await expect(archiveService.startArchive('chan')).rejects.toThrow('No connected Telegram account');
    });
  });
});
