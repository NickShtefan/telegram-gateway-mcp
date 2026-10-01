import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../../db/models/Post.js', () => {
  const chain = {
    limit: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue([]),
  };
  const find = vi.fn(() => chain);
  const updateOne = vi.fn().mockResolvedValue({ acknowledged: true });
  const updateMany = vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 0 });
  return {
    default: { find, updateOne, updateMany, __chain: chain },
  };
});

vi.mock('../../client/gramClient.js', () => {
  const invoke = vi.fn();
  const resolvePeer = vi.fn(async (channelId: string) => ({ channelId, _peer: true }));
  return {
    getGramClient: () => ({ invoke }),
    resolvePeer,
    __mockInvoke: invoke,
    __mockResolvePeer: resolvePeer,
  };
});

const requestGramProcessRestart = vi.hoisted(() => vi.fn(() => undefined as never));

vi.mock('../../client/gramFatalRecovery.js', () => ({ requestGramProcessRestart }));

// Stubs for Api.channels.GetMessages + Api.InputMessageID — мы просто
// проверяем, с какими аргументами конструкторы вызвались.
vi.mock('telegram', () => {
  class GetMessages {
    channel: unknown;
    id: unknown;
    constructor(args: { channel: unknown; id: unknown }) {
      this.channel = args.channel;
      this.id = args.id;
    }
  }
  class InputMessageID {
    id: number;
    constructor(args: { id: number }) {
      this.id = args.id;
    }
  }
  return {
    Api: {
      channels: { GetMessages },
      InputMessageID,
    },
  };
});

import Post from '../../../db/models/Post.js';
import * as gramClientModule from '../../client/gramClient.js';
import { startStatsRefresher, stopStatsRefresher, __testables } from '../statsRefresher.js';

const mockInvoke = (gramClientModule as unknown as { __mockInvoke: ReturnType<typeof vi.fn> }).__mockInvoke;
const mockResolvePeer = (gramClientModule as unknown as { __mockResolvePeer: ReturnType<typeof vi.fn> }).__mockResolvePeer;

type MockedPost = typeof Post & {
  find: ReturnType<typeof vi.fn>;
  updateOne: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
  __chain: { limit: ReturnType<typeof vi.fn>; lean: ReturnType<typeof vi.fn> };
};
const MockPost = Post as unknown as MockedPost;

// ─── helpers ────────────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<{ id: number; views: number; reactions: unknown; date: number; className: string }> = {}): unknown {
  return {
    className: 'Message',
    id: overrides.id ?? 100,
    date: overrides.date ?? Math.floor(Date.now() / 1000),
    views: overrides.views ?? 0,
    reactions: overrides.reactions,
    ...overrides,
  };
}

function stubCandidates(candidates: Array<{ telegramId: number; channelId: string; date: Date }>): void {
  MockPost.__chain.lean.mockResolvedValueOnce(candidates);
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('statsRefresher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockReset();
    mockResolvePeer.mockClear();
    requestGramProcessRestart.mockClear();
    MockPost.__chain.limit.mockReturnThis();
    MockPost.__chain.lean.mockResolvedValue([]);
  });

  afterEach(() => {
    stopStatsRefresher();
  });

  it('returns early when no candidates', async () => {
    stubCandidates([]);

    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    await __testables.runTick();

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(MockPost.updateOne).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('tick: 0 candidates')
    );
    infoSpy.mockRestore();
  });

  it('single channel, 2 posts: calls GetMessages with correct ids and updates each post', async () => {
    const now = new Date();
    stubCandidates([
      { telegramId: 10, channelId: 'chan1', date: new Date(now.getTime() - 30 * 60 * 1000) },
      { telegramId: 11, channelId: 'chan1', date: new Date(now.getTime() - 30 * 60 * 1000) },
    ]);
    mockInvoke.mockResolvedValueOnce({
      messages: [
        makeMessage({ id: 10, views: 42, reactions: { results: [{ reaction: { emoticon: '👍' }, count: 3 }] } }),
        makeMessage({ id: 11, views: 7 }),
      ],
    });

    await __testables.runTick();

    expect(mockResolvePeer).toHaveBeenCalledWith('chan1');
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const call = mockInvoke.mock.calls[0][0] as { channel: unknown; id: Array<{ id: number }> };
    expect(call.id.map(x => x.id)).toEqual([10, 11]);

    expect(MockPost.updateOne).toHaveBeenCalledWith(
      { telegramId: 10, channelId: 'chan1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          'stats.views': 42,
          'stats.reactions': [{ reaction: '👍', count: 3 }],
        }),
      })
    );
    expect(MockPost.updateOne).toHaveBeenCalledWith(
      { telegramId: 11, channelId: 'chan1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          'stats.views': 7,
          'stats.reactions': [],
        }),
      })
    );
  });

  it('two channels are batched into separate GetMessages calls', async () => {
    const now = new Date();
    stubCandidates([
      { telegramId: 10, channelId: 'chan1', date: new Date(now.getTime() - 30 * 60 * 1000) },
      { telegramId: 20, channelId: 'chan2', date: new Date(now.getTime() - 30 * 60 * 1000) },
    ]);
    mockInvoke
      .mockResolvedValueOnce({ messages: [makeMessage({ id: 10, views: 1 })] })
      .mockResolvedValueOnce({ messages: [makeMessage({ id: 20, views: 2 })] });

    await __testables.runTick();

    expect(mockResolvePeer).toHaveBeenCalledWith('chan1');
    expect(mockResolvePeer).toHaveBeenCalledWith('chan2');
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it('FLOOD_WAIT sleeps and retries once; retry success triggers updateOne', async () => {
    const now = new Date();
    stubCandidates([
      { telegramId: 10, channelId: 'chan1', date: new Date(now.getTime() - 30 * 60 * 1000) },
    ]);

    const floodErr = Object.assign(new Error('FLOOD_WAIT_2'), { seconds: 0 });
    mockInvoke
      .mockRejectedValueOnce(floodErr)
      .mockResolvedValueOnce({ messages: [makeMessage({ id: 10, views: 99 })] });

    await __testables.runTick();

    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(MockPost.updateOne).toHaveBeenCalledWith(
      { telegramId: 10, channelId: 'chan1' },
      expect.objectContaining({
        $set: expect.objectContaining({ 'stats.views': 99 }),
      })
    );
  });

  it('CHANNEL_INVALID sets nextRefreshAt=null for all posts in that channel', async () => {
    const now = new Date();
    stubCandidates([
      { telegramId: 10, channelId: 'chan1', date: new Date(now.getTime() - 30 * 60 * 1000) },
      { telegramId: 11, channelId: 'chan1', date: new Date(now.getTime() - 30 * 60 * 1000) },
    ]);
    mockInvoke.mockRejectedValueOnce(new Error('CHANNEL_INVALID'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await __testables.runTick();

    expect(MockPost.updateMany).toHaveBeenCalledWith(
      { channelId: 'chan1', telegramId: { $in: [10, 11] } },
      { $set: { nextRefreshAt: null } }
    );
    warnSpy.mockRestore();
  });

  it('post older than cutoff (30d): getNextRefreshAt returns null and updateOne sets nextRefreshAt=null', async () => {
    const now = new Date();
    const oldDate = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);
    stubCandidates([
      { telegramId: 77, channelId: 'chan1', date: oldDate },
    ]);
    mockInvoke.mockResolvedValueOnce({
      messages: [makeMessage({ id: 77, views: 500 })],
    });

    await __testables.runTick();

    expect(MockPost.updateOne).toHaveBeenCalledWith(
      { telegramId: 77, channelId: 'chan1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          nextRefreshAt: null,
          'stats.views': 500,
        }),
      })
    );
  });

  it('skips non-Message className entries from the response', async () => {
    const now = new Date();
    stubCandidates([
      { telegramId: 10, channelId: 'chan1', date: new Date(now.getTime() - 30 * 60 * 1000) },
    ]);
    mockInvoke.mockResolvedValueOnce({
      messages: [
        { className: 'MessageEmpty', id: 10 },
      ],
    });

    await __testables.runTick();

    // Единственный updateOne — это "advance nextRefreshAt", без stats.views в $set.
    const calls = MockPost.updateOne.mock.calls;
    expect(calls.length).toBe(1);
    const [, update] = calls[0] as [unknown, { $set: Record<string, unknown> }];
    expect(update.$set).not.toHaveProperty('stats.views');
    expect(update.$set).toHaveProperty('nextRefreshAt');
  });
});

describe('statsRefresher timeouts (#81)', () => {
  const recentDate = () => new Date(Date.now() - 30 * 60 * 1000);
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockReset();
    mockResolvePeer.mockClear();
    requestGramProcessRestart.mockClear();
    MockPost.__chain.limit.mockReturnThis();
    MockPost.__chain.lean.mockResolvedValue([]);
    process.env.STATS_REFRESH_GRAM_TIMEOUT_MS = '20';
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.STATS_REFRESH_GRAM_TIMEOUT_MS;
    delete process.env.STATS_REFRESH_FLOOD_WAIT_MAX_S;
    warnSpy.mockRestore();
    infoSpy.mockRestore();
    errorSpy.mockRestore();
    stopStatsRefresher();
  });

  it('never-settling resolvePeer requests a clean process restart', async () => {
    stubCandidates([{ telegramId: 10, channelId: 'chan1', date: recentDate() }]);
    mockResolvePeer.mockImplementationOnce(() => new Promise(() => {}));

    await __testables.runTick();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('resolvePeer timed out for channel chan1 (1 posts)')
    );
    expect(requestGramProcessRestart).toHaveBeenCalledWith(
      'StatsRefresher resolvePeer timed out for channel chan1 (1 posts)'
    );
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('never-settling client.invoke(GetMessages) requests a clean process restart', async () => {
    stubCandidates([{ telegramId: 10, channelId: 'chan1', date: recentDate() }]);
    mockInvoke.mockImplementationOnce(() => new Promise(() => {}));

    await __testables.runTick();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('GetMessages timed out for channel chan1 (1 posts)')
    );
    expect(requestGramProcessRestart).toHaveBeenCalledWith(
      'StatsRefresher GetMessages timed out for channel chan1 (1 posts)'
    );
  });

  it('never-settling FLOOD_WAIT retry requests a clean process restart', async () => {
    stubCandidates([{ telegramId: 10, channelId: 'chan1', date: recentDate() }]);
    const floodErr = Object.assign(new Error('FLOOD_WAIT_0'), { seconds: 0 });
    mockInvoke
      .mockRejectedValueOnce(floodErr)
      .mockImplementationOnce(() => new Promise(() => {}));

    await __testables.runTick();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('GetMessages retry after FLOOD_WAIT timed out for channel chan1')
    );
    expect(requestGramProcessRestart).toHaveBeenCalledWith(
      'StatsRefresher GetMessages retry after FLOOD_WAIT timed out for channel chan1 (1 posts)'
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('retry after FLOOD_WAIT failed for chan1'),
      expect.stringContaining('timed out')
    );
  });

  it('timeout in one channel does not prevent processing of other channels in the same tick', async () => {
    stubCandidates([
      { telegramId: 10, channelId: 'chan1', date: recentDate() },
      { telegramId: 20, channelId: 'chan2', date: recentDate() },
    ]);
    // chan1 висит, chan2 резолвится штатно (base impl после Once).
    mockResolvePeer.mockImplementationOnce(() => new Promise(() => {}));
    mockInvoke.mockResolvedValueOnce({ messages: [makeMessage({ id: 20, views: 2 })] });

    await __testables.runTick();

    expect(MockPost.updateOne).toHaveBeenCalledWith(
      { telegramId: 20, channelId: 'chan2' },
      expect.objectContaining({
        $set: expect.objectContaining({ 'stats.views': 2 }),
      })
    );
  });

  it('FLOOD_WAIT above the cap skips the batch without retrying', async () => {
    process.env.STATS_REFRESH_FLOOD_WAIT_MAX_S = '1';
    stubCandidates([{ telegramId: 10, channelId: 'chan1', date: recentDate() }]);
    const floodErr = Object.assign(new Error('FLOOD_WAIT_9999'), { seconds: 9999 });
    mockInvoke.mockRejectedValueOnce(floodErr);

    await __testables.runTick();

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('FLOOD_WAIT 9999s exceeds cap 1s on channel chan1')
    );
    expect(MockPost.updateOne).not.toHaveBeenCalled();
  });

  it('watchdog escalates to console.error after consecutive skipped ticks', async () => {
    process.env.STATS_REFRESH_GRAM_TIMEOUT_MS = '100';
    stubCandidates([{ telegramId: 10, channelId: 'chan1', date: recentDate() }]);
    mockResolvePeer.mockImplementationOnce(() => new Promise(() => {}));

    const inFlight = __testables.runTick();

    await __testables.runTick(); // skip 1 → info
    await __testables.runTick(); // skip 2 → info
    expect(errorSpy).not.toHaveBeenCalled();
    await __testables.runTick(); // skip 3 → error
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('worker looks stuck')
    );

    await inFlight; // первый tick добегает по таймауту, guard снимается
  });
});

describe('startStatsRefresher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockPost.__chain.limit.mockReturnThis();
    MockPost.__chain.lean.mockResolvedValue([]);
  });

  afterEach(() => {
    stopStatsRefresher();
  });

  it('runs init migration before first tick', async () => {
    await startStatsRefresher();
    // даём первому awaited-тику добежать
    await new Promise(r => setImmediate(r));

    expect(MockPost.updateMany).toHaveBeenCalledWith(
      { nextRefreshAt: { $exists: false } },
      { $set: { nextRefreshAt: expect.any(Date) } }
    );
    stopStatsRefresher();
  });
});
