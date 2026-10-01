import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../client/gramClient.js', () => ({
  getGramClient: vi.fn(),
  resolvePeer: vi.fn(),
}));

vi.mock('../../../config/telegram.js', () => ({
  default: {
    telegram: {
      botToken: 'x',
      channelName: 'testchannel',
      reactionEmojis: ['🔥', '👍', '❤️'],
    },
  },
}));

import { sendRandomReaction } from '../sendRandomReaction.js';
import { getGramClient, resolvePeer } from '../../client/gramClient.js';

const mockedGetClient = vi.mocked(getGramClient);
const mockedResolvePeer = vi.mocked(resolvePeer);

describe('sendRandomReaction', () => {
  const fakePeer = { _: 'inputPeerChannel' } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedResolvePeer.mockResolvedValue(fakePeer);
  });

  it('picks an emoji from config and calls messages.SendReaction', async () => {
    const invoke = vi.fn().mockResolvedValue({});
    mockedGetClient.mockReturnValue({ invoke } as never);

    const result = await sendRandomReaction('testchannel', 42);

    expect(['🔥', '👍', '❤️']).toContain(result);
    expect(mockedResolvePeer).toHaveBeenCalledWith('testchannel');
    expect(invoke).toHaveBeenCalledTimes(1);

    const request = invoke.mock.calls[0][0];
    expect(request.className).toBe('messages.SendReaction');
    expect(request.peer).toBe(fakePeer);
    expect(request.msgId).toBe(42);
    expect(request.reaction).toHaveLength(1);
    expect(request.reaction[0].emoticon).toBe(result);
  });

  it('returns null and logs when emoji list is empty', async () => {
    const config = (await import('../../../config/telegram.js')).default;
    const original = config.telegram.reactionEmojis;
    config.telegram.reactionEmojis = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await sendRandomReaction('testchannel', 42);

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    expect(mockedResolvePeer).not.toHaveBeenCalled();

    config.telegram.reactionEmojis = original;
    warnSpy.mockRestore();
  });

  it('returns null and logs on invoke error (generic)', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('boom'));
    mockedGetClient.mockReturnValue({ invoke } as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await sendRandomReaction('testchannel', 42);

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed for msg 42'),
      'boom',
    );
    errorSpy.mockRestore();
  });

  it('returns null and logs warning on FLOOD_WAIT', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('FLOOD_WAIT_60'));
    mockedGetClient.mockReturnValue({ invoke } as never);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await sendRandomReaction('testchannel', 42);

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('flood wait'),
      'FLOOD_WAIT_60',
    );
    warnSpy.mockRestore();
  });
});
