import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../config/telegram.js', () => ({
  default: { telegram: { botToken: 't', channelName: 'testchannel', reactionEmojis: [] } },
}));

vi.mock('../client/gramClient.js', () => {
  const invoke = vi.fn();
  const resolvePeer = vi.fn(async (username: string) => ({ username, _peer: true }));
  return {
    getGramClient: () => ({ invoke }),
    resolvePeer,
    __mockInvoke: invoke,
    __mockResolvePeer: resolvePeer,
  };
});

vi.mock('telegram', () => {
  class GetFullChannel {
    channel: unknown;
    constructor(args: { channel: unknown }) {
      this.channel = args.channel;
    }
  }
  class InputPeerChannel {
    channelId: unknown;
    accessHash: unknown;
    constructor(args: { channelId: unknown; accessHash: unknown }) {
      this.channelId = args.channelId;
      this.accessHash = args.accessHash;
    }
  }
  return { Api: { channels: { GetFullChannel }, InputPeerChannel } };
});

import * as gramClientModule from '../client/gramClient.js';
import {
  ensureDiscussionChatId,
  getDiscussionChatIdSync,
  getChannelChatIdSync,
  initDiscussionChat,
  resolveDiscussionPeer,
  __resetDiscussionForTests,
} from '../discussion.js';
import type TelegramBot from 'node-telegram-bot-api';

const mockInvoke = (gramClientModule as unknown as { __mockInvoke: ReturnType<typeof vi.fn> }).__mockInvoke;

const GROUP_MTPROTO_ID = 1782171896;
const GROUP_BOT_API_ID = -1001782171896;

function makeBot(overrides: Partial<Record<'getChat' | 'getMe' | 'getChatMember', unknown>> = {}): TelegramBot {
  return {
    getChat: vi.fn().mockResolvedValue({ id: -100123, linked_chat_id: GROUP_BOT_API_ID }),
    getMe: vi.fn().mockResolvedValue({ id: 42, username: 'testbot' }),
    getChatMember: vi.fn().mockResolvedValue({ status: 'administrator' }),
    ...overrides,
  } as unknown as TelegramBot;
}

describe('discussion — обнаружение группы обсуждений', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockReset();
    delete process.env.DISCUSSION_CHAT_ID;
    __resetDiscussionForTests();
  });

  afterEach(() => {
    delete process.env.DISCUSSION_CHAT_ID;
    __resetDiscussionForTests();
    vi.restoreAllMocks();
  });

  it('резолвит id через getChat().linked_chat_id и кэширует', async () => {
    const bot = makeBot();
    expect(getDiscussionChatIdSync()).toBeNull();
    const id = await ensureDiscussionChatId(bot);
    expect(id).toBe(GROUP_BOT_API_ID);
    expect(getDiscussionChatIdSync()).toBe(GROUP_BOT_API_ID);

    await ensureDiscussionChatId(bot);
    expect((bot.getChat as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('канал без привязанной группы -> null + warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bot = makeBot({ getChat: vi.fn().mockResolvedValue({ id: -100123 }) });
    expect(await ensureDiscussionChatId(bot)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('нет привязанной группы'));
  });

  it('сбой getChat -> null, повтор в пределах кулдауна не дёргает getChat снова', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const getChat = vi.fn().mockRejectedValue(new Error('network down'));
    const bot = makeBot({ getChat });
    expect(await ensureDiscussionChatId(bot)).toBeNull();
    expect(await ensureDiscussionChatId(bot)).toBeNull();
    expect(getChat).toHaveBeenCalledTimes(1);
  });

  it('DISCUSSION_CHAT_ID в форме -100… используется без getChat', async () => {
    process.env.DISCUSSION_CHAT_ID = String(GROUP_BOT_API_ID);
    const bot = makeBot();
    expect(await ensureDiscussionChatId(bot)).toBe(GROUP_BOT_API_ID);
    expect((bot.getChat as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('положительный DISCUSSION_CHAT_ID автоконвертируется с warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.DISCUSSION_CHAT_ID = String(GROUP_MTPROTO_ID);
    expect(await ensureDiscussionChatId(makeBot())).toBe(GROUP_BOT_API_ID);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('конвертирую'));
  });

  it('мусорный DISCUSSION_CHAT_ID игнорируется, идём через getChat', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.DISCUSSION_CHAT_ID = 'garbage';
    const bot = makeBot();
    expect(await ensureDiscussionChatId(bot)).toBe(GROUP_BOT_API_ID);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('не число'));
  });

  it('initDiscussionChat: бот не админ -> console.error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bot = makeBot({ getChatMember: vi.fn().mockResolvedValue({ status: 'member' }) });
    await initDiscussionChat(bot);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('НЕ АДМИН'));
  });

  it('initDiscussionChat при DISCUSSION_CHAT_ID всё равно добирает id канала через getChat', async () => {
    // Иначе реакции владельца «как канал» помечаются isOwner=false до первого
    // GramJS-резолва — окно переоткрывается на каждом рестарте (#86 review).
    process.env.DISCUSSION_CHAT_ID = String(GROUP_BOT_API_ID);
    const bot = makeBot({ getChat: vi.fn().mockResolvedValue({ id: -1001188822563, linked_chat_id: GROUP_BOT_API_ID }) });

    await initDiscussionChat(bot);

    expect(getDiscussionChatIdSync()).toBe(GROUP_BOT_API_ID); // из override, без getChat
    expect((bot.getChat as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1); // только ради id канала
    expect(getChannelChatIdSync()).toBe(-1001188822563);
  });

  it('обычный путь: id канала захватывается из того же getChat, что и linked_chat_id', async () => {
    const bot = makeBot({ getChat: vi.fn().mockResolvedValue({ id: -1001188822563, linked_chat_id: GROUP_BOT_API_ID }) });
    await ensureDiscussionChatId(bot);
    expect(getChannelChatIdSync()).toBe(-1001188822563);
  });

  it('initDiscussionChat: админ -> info без ошибок', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    await initDiscussionChat(makeBot());
    expect(errorSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('realtime-слой активен'));
  });
});

describe('discussion — GramJS-сторона (resolveDiscussionPeer)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockReset();
    delete process.env.DISCUSSION_CHAT_ID;
    __resetDiscussionForTests();
  });

  afterEach(() => {
    delete process.env.DISCUSSION_CHAT_ID;
    __resetDiscussionForTests();
    vi.restoreAllMocks();
  });

  it('строит InputPeerChannel из GetFullChannel и заполняет общий id', async () => {
    mockInvoke.mockResolvedValue({
      fullChat: { linkedChatId: GROUP_MTPROTO_ID },
      chats: [{ id: GROUP_MTPROTO_ID, accessHash: 'hash123', className: 'Channel' }],
    });
    const peer = await resolveDiscussionPeer('testchannel');
    expect(peer).toMatchObject({ channelId: GROUP_MTPROTO_ID, accessHash: 'hash123' });
    // единый источник: Bot API-сторона видит id без собственного резолва
    expect(getDiscussionChatIdSync()).toBe(GROUP_BOT_API_ID);

    // кэш: второй вызов без invoke
    await resolveDiscussionPeer('testchannel');
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('нет привязанной группы -> null-кэш с TTL (второй вызов без invoke)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockInvoke.mockResolvedValue({ fullChat: { linkedChatId: null }, chats: [] });
    expect(await resolveDiscussionPeer('testchannel')).toBeNull();
    expect(await resolveDiscussionPeer('testchannel')).toBeNull();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('нет привязанной группы'));
  });

  it('override не совпадает с фактической группой -> null + громкая ошибка', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.DISCUSSION_CHAT_ID = '-1009999999999';
    mockInvoke.mockResolvedValue({
      fullChat: { linkedChatId: GROUP_MTPROTO_ID },
      chats: [{ id: GROUP_MTPROTO_ID, accessHash: 'hash123' }],
    });
    expect(await resolveDiscussionPeer('testchannel')).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('не совпадает'));
  });

  it('сбой GramJS -> null без кэширования ошибки навсегда', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockInvoke.mockRejectedValueOnce(new Error('TIMEOUT'));
    expect(await resolveDiscussionPeer('testchannel')).toBeNull();
    expect(warnSpy).toHaveBeenCalled();

    mockInvoke.mockResolvedValue({
      fullChat: { linkedChatId: GROUP_MTPROTO_ID },
      chats: [{ id: GROUP_MTPROTO_ID, accessHash: 'hash123' }],
    });
    expect(await resolveDiscussionPeer('testchannel')).not.toBeNull();
  });
});
