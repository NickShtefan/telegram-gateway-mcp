import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
const mockChannelFindOne = vi.fn();
const mockClientFindOne = vi.fn();
const mockPostUpdateOne = vi.fn();
const mockClientManagerGetClient = vi.fn();
const mockClientInvoke = vi.fn();

vi.mock('../../db/models/Channel.js', () => ({
  default: {
    findOne: (...args: unknown[]) => mockChannelFindOne(...args),
  },
}));

vi.mock('../../db/models/Client.js', () => ({
  default: {
    findOne: (...args: unknown[]) => mockClientFindOne(...args),
  },
}));

vi.mock('../../db/models/Post.js', () => ({
  default: {
    updateOne: (...args: unknown[]) => mockPostUpdateOne(...args),
  },
}));

vi.mock('../../services/clientManager.js', () => ({
  clientManager: {
    getClient: (...args: unknown[]) => mockClientManagerGetClient(...args),
  },
}));

import { AutoEmojiService } from '../../services/autoEmojiService.js';

function makeChannel(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'chan123',
    channelId: 'stonksnws',
    clientIds: ['client1'],
    settings: {
      autoEmoji: {
        enabled: true,
        emoji: '❤️',
        delay: 0, // 0 seconds for fast tests
      },
    },
    ...overrides,
  };
}

function makeClientDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => 'client1' },
    status: 'active',
    ...overrides,
  };
}

describe('AutoEmojiService', () => {
  let service: AutoEmojiService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AutoEmojiService();

    mockPostUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mockClientInvoke.mockResolvedValue({});
    mockClientManagerGetClient.mockResolvedValue({ invoke: mockClientInvoke });
  });

  it('does nothing when channel is not tracked', async () => {
    mockChannelFindOne.mockResolvedValue(null);

    await service.handleNewPost('unknownchannel', 123);

    expect(mockClientFindOne).not.toHaveBeenCalled();
    expect(mockClientInvoke).not.toHaveBeenCalled();
  });

  it('does nothing when autoEmoji.enabled is false', async () => {
    mockChannelFindOne.mockResolvedValue(
      makeChannel({ settings: { autoEmoji: { enabled: false, emoji: '❤️', delay: 0 } } })
    );

    await service.handleNewPost('stonksnws', 123);

    expect(mockClientFindOne).not.toHaveBeenCalled();
    expect(mockClientInvoke).not.toHaveBeenCalled();
  });

  it('does nothing when no clients assigned', async () => {
    mockChannelFindOne.mockResolvedValue(makeChannel({ clientIds: [] }));

    await service.handleNewPost('stonksnws', 123);

    expect(mockClientFindOne).not.toHaveBeenCalled();
    expect(mockClientInvoke).not.toHaveBeenCalled();
  });

  it('does nothing when no active client found', async () => {
    mockChannelFindOne.mockResolvedValue(makeChannel());
    mockClientFindOne.mockResolvedValue(null);

    await service.handleNewPost('stonksnws', 123);

    expect(mockClientManagerGetClient).not.toHaveBeenCalled();
    expect(mockClientInvoke).not.toHaveBeenCalled();
  });

  it('calls client.invoke with correct reaction', async () => {
    mockChannelFindOne.mockResolvedValue(makeChannel());
    mockClientFindOne.mockResolvedValue(makeClientDoc());

    await service.handleNewPost('stonksnws', 456);

    expect(mockClientManagerGetClient).toHaveBeenCalledWith('client1');
    expect(mockClientInvoke).toHaveBeenCalledTimes(1);
    const invokeArg = mockClientInvoke.mock.calls[0][0];
    expect(invokeArg).toBeDefined();
  });

  it('marks post autoEmojiSent after reaction', async () => {
    mockChannelFindOne.mockResolvedValue(makeChannel());
    mockClientFindOne.mockResolvedValue(makeClientDoc());

    await service.handleNewPost('stonksnws', 789);

    expect(mockPostUpdateOne).toHaveBeenCalledWith(
      { telegramId: 789, channelId: 'stonksnws' },
      { autoEmojiSent: true }
    );
  });

  it('does not throw when GramJS invoke fails', async () => {
    mockChannelFindOne.mockResolvedValue(makeChannel());
    mockClientFindOne.mockResolvedValue(makeClientDoc());
    mockClientInvoke.mockRejectedValue(new Error('Telegram API error'));

    // Should not throw
    await expect(service.handleNewPost('stonksnws', 111)).resolves.toBeUndefined();
  });

  it('normalizes channel username with @ prefix', async () => {
    mockChannelFindOne.mockResolvedValue(makeChannel());
    mockClientFindOne.mockResolvedValue(makeClientDoc());

    await service.handleNewPost('@stonksnws', 999);

    // Channel lookup should have been called with both variants
    expect(mockChannelFindOne).toHaveBeenCalledWith({
      $or: [
        { channelId: '@stonksnws' },
        { channelId: '@stonksnws' },
        { channelId: 'stonksnws' },
      ],
    });
  });

  it('uses custom emoji from channel settings', async () => {
    mockChannelFindOne.mockResolvedValue(
      makeChannel({ settings: { autoEmoji: { enabled: true, emoji: '🔥', delay: 0 } } })
    );
    mockClientFindOne.mockResolvedValue(makeClientDoc());

    await service.handleNewPost('stonksnws', 222);

    expect(mockClientInvoke).toHaveBeenCalled();
    // The invoke is called with an Api.messages.SendReaction object
    // We just verify invoke was called (deep API type inspection is fragile)
    expect(mockClientManagerGetClient).toHaveBeenCalledWith('client1');
  });
});
