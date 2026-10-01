import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Channel model
const mockChannelFindOne = vi.fn();
const mockChannelFindByIdAndUpdate = vi.fn();
const mockChannelCountDocuments = vi.fn();
const mockPostFind = vi.fn();
const mockPostUpdateOne = vi.fn();
const mockPostCountDocuments = vi.fn();
const mockClientGetClient = vi.fn();
const mockClientInvoke = vi.fn();

vi.mock('../../db/models/Channel.js', () => ({
  default: {
    findOne: (...args: unknown[]) => mockChannelFindOne(...args),
    findByIdAndUpdate: (...args: unknown[]) => mockChannelFindByIdAndUpdate(...args),
    countDocuments: (...args: unknown[]) => mockChannelCountDocuments(...args),
  },
}));

vi.mock('../../db/models/Post.js', () => ({
  default: {
    find: (...args: unknown[]) => mockPostFind(...args),
    updateOne: (...args: unknown[]) => mockPostUpdateOne(...args),
    countDocuments: (...args: unknown[]) => mockPostCountDocuments(...args),
  },
}));

vi.mock('../../services/clientManager.js', () => ({
  clientManager: {
    getClient: (...args: unknown[]) => mockClientGetClient(...args),
  },
}));

import { ViewsSyncService } from '../../services/viewsSyncService.js';

function makeChannel(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'chan123',
    channelId: 'stonksnws',
    settings: {
      viewsSync: {
        enabled: true,
        syncRunCount: 0,
        strategy: 'decay',
      },
    },
    stats: {
      lastViewsSyncDate: null,
    },
    ...overrides,
  };
}

describe('ViewsSyncService', () => {
  let service: ViewsSyncService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ViewsSyncService();

    // Default mock: return empty arrays for posts
    mockPostFind.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([]),
      }),
    });
    mockPostFind.mockImplementation(() => ({
      select: vi.fn().mockReturnThis(),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([]),
    }));

    mockChannelFindByIdAndUpdate.mockResolvedValue(null);
    mockPostUpdateOne.mockResolvedValue({ modifiedCount: 1 });

    mockClientGetClient.mockResolvedValue({
      invoke: mockClientInvoke,
    });

    mockClientInvoke.mockResolvedValue({ messages: [] });
  });

  it('skips sync when viewsSync.enabled is false', async () => {
    mockChannelFindOne.mockResolvedValue(
      makeChannel({ settings: { viewsSync: { enabled: false, syncRunCount: 0, strategy: 'decay' } } })
    );

    await service.syncChannel('stonksnws', 'client1');

    expect(mockChannelFindByIdAndUpdate).not.toHaveBeenCalled();
    expect(mockClientGetClient).not.toHaveBeenCalled();
  });

  it('throws when channel not found', async () => {
    mockChannelFindOne.mockResolvedValue(null);
    await expect(service.syncChannel('unknown', 'client1')).rejects.toThrow('Channel not found');
  });

  it('increments syncRunCount on each sync', async () => {
    mockChannelFindOne.mockResolvedValue(makeChannel());
    await service.syncChannel('stonksnws', 'client1');

    expect(mockChannelFindByIdAndUpdate).toHaveBeenCalledWith(
      'chan123',
      expect.objectContaining({
        'settings.viewsSync.syncRunCount': 1,
      })
    );
  });

  it('syncs hot+warm posts every run', async () => {
    mockChannelFindOne.mockResolvedValue(makeChannel());

    const hotWarmPosts = [{ telegramId: 101 }, { telegramId: 102 }];
    mockPostFind.mockImplementation(() => ({
      select: vi.fn().mockReturnThis(),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue(hotWarmPosts),
    }));

    mockClientInvoke.mockResolvedValue({
      messages: [
        { id: 101, views: 500 },
        { id: 102, views: 300 },
      ],
    });

    await service.syncChannel('stonksnws', 'client1');

    expect(mockClientGetClient).toHaveBeenCalledWith('client1');
    expect(mockClientInvoke).toHaveBeenCalled();
    expect(mockPostUpdateOne).toHaveBeenCalledTimes(2);
  });

  it('does not sync cool tier until 3rd run', async () => {
    // syncRunCount starts at 0, after increment = 1 → should not sync cool
    mockChannelFindOne.mockResolvedValue(makeChannel({ settings: { viewsSync: { enabled: true, syncRunCount: 0, strategy: 'decay' } } }));

    const callsToFind: Array<Parameters<typeof mockPostFind>> = [];
    mockPostFind.mockImplementation((...args: unknown[]) => {
      callsToFind.push(args as Parameters<typeof mockPostFind>);
      return {
        select: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      };
    });

    await service.syncChannel('stonksnws', 'client1');

    // On run 1 (syncRunCount becomes 1): only hot+warm (1 Post.find call for warm range)
    // Cool skips because 1 % 3 !== 0
    // Cold skips because 1 % 10 !== 0
    expect(callsToFind.length).toBe(1); // only hot+warm query
  });

  it('syncs cool tier on 3rd run', async () => {
    // syncRunCount at 2, after increment = 3, 3 % 3 === 0
    mockChannelFindOne.mockResolvedValue(makeChannel({ settings: { viewsSync: { enabled: true, syncRunCount: 2, strategy: 'decay' } } }));

    const callsToFind: Array<unknown[]> = [];
    mockPostFind.mockImplementation((...args: unknown[]) => {
      callsToFind.push(args);
      return {
        select: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      };
    });

    await service.syncChannel('stonksnws', 'client1');

    // Run 3: hot+warm + cool (2 queries)
    expect(callsToFind.length).toBe(2);
  });

  it('syncs cold tier on 10th run (cool skips since 10 % 3 !== 0)', async () => {
    // syncRunCount at 9, after increment = 10
    // 10 % 10 === 0 → cold syncs
    // 10 % 3 === 1 → cool skips
    // Result: hot+warm (1 query) + cold (1 query) = 2 queries
    mockChannelFindOne.mockResolvedValue(makeChannel({ settings: { viewsSync: { enabled: true, syncRunCount: 9, strategy: 'decay' } } }));

    const callsToFind: Array<unknown[]> = [];
    mockPostFind.mockImplementation((...args: unknown[]) => {
      callsToFind.push(args);
      return {
        select: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      };
    });

    await service.syncChannel('stonksnws', 'client1');

    // Run 10: hot+warm + cold = 2 queries (cool skips)
    expect(callsToFind.length).toBe(2);
  });

  it('syncs both cool and cold on 30th run (30 % 3 === 0 && 30 % 10 === 0)', async () => {
    // syncRunCount at 29, after increment = 30
    // 30 % 3 === 0 → cool syncs
    // 30 % 10 === 0 → cold syncs
    // Result: 3 queries
    mockChannelFindOne.mockResolvedValue(makeChannel({ settings: { viewsSync: { enabled: true, syncRunCount: 29, strategy: 'decay' } } }));

    const callsToFind: Array<unknown[]> = [];
    mockPostFind.mockImplementation((...args: unknown[]) => {
      callsToFind.push(args);
      return {
        select: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      };
    });

    await service.syncChannel('stonksnws', 'client1');

    // Run 30: hot+warm + cool + cold = 3 queries
    expect(callsToFind.length).toBe(3);
  });

  it('updates views in DB from GramJS response', async () => {
    mockChannelFindOne.mockResolvedValue(makeChannel());

    mockPostFind.mockImplementation(() => ({
      select: vi.fn().mockReturnThis(),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([{ telegramId: 999 }]),
    }));

    mockClientInvoke.mockResolvedValue({
      messages: [{ id: 999, views: 1234 }],
    });

    await service.syncChannel('stonksnws', 'client1');

    expect(mockPostUpdateOne).toHaveBeenCalledWith(
      { telegramId: 999, channelId: 'stonksnws' },
      { 'stats.views': 1234 }
    );
  });

  it('getSyncStatus returns tier counts', async () => {
    mockChannelFindOne.mockResolvedValue(makeChannel({ settings: { viewsSync: { enabled: true, syncRunCount: 5, strategy: 'decay' } } }));
    mockPostCountDocuments.mockResolvedValue(10);

    const status = await service.getSyncStatus('stonksnws');

    expect(status.syncRunCount).toBe(5);
    expect(status.tierCounts.hot).toBe(10);
    expect(status.tierCounts.warm).toBe(10);
    expect(status.tierCounts.cool).toBe(10);
    expect(status.tierCounts.cold).toBe(10);
  });
});
