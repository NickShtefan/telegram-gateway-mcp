import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../../db/models/Post.js', () => {
  const chain = {
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue([]),
  };
  return {
    default: {
      find: vi.fn(() => chain),
      updateOne: vi.fn().mockResolvedValue({ acknowledged: true }),
      updateMany: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 0 }),
      __chain: chain,
    },
  };
});

vi.mock('../../../db/models/Comment.js', () => {
  const chain = {
    lean: vi.fn().mockResolvedValue([]),
  };
  return {
    default: {
      find: vi.fn(() => chain),
      updateMany: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 0 }),
      bulkWrite: vi.fn().mockResolvedValue({ ok: 1 }),
      __chain: chain,
    },
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

vi.mock('../../discussion.js', () => {
  const resolveDiscussionPeer = vi.fn(async () => ({ _dpeer: true }));
  return { resolveDiscussionPeer, __mockResolveDiscussionPeer: resolveDiscussionPeer };
});

vi.mock('../../../config/telegram.js', () => ({
  default: {
    telegram: { botToken: 't', channelName: 'chan', reactionEmojis: [] },
    comments: { enabled: true, downloadMedia: false },
  },
}));

vi.mock('telegram', () => {
  class GetDiscussionMessage {
    peer: unknown;
    msgId: number;
    constructor(args: { peer: unknown; msgId: number }) {
      this.peer = args.peer;
      this.msgId = args.msgId;
    }
  }
  class GetReplies {
    args: unknown;
    constructor(args: unknown) {
      this.args = args;
    }
  }
  return { Api: { messages: { GetDiscussionMessage, GetReplies } } };
});

import Post from '../../../db/models/Post.js';
import Comment from '../../../db/models/Comment.js';
import * as gramClientModule from '../../client/gramClient.js';
import * as discussionModule from '../../discussion.js';
import { stopCommentsRefresher, buildTombstoneFilter, __testables } from '../commentsRefresher.js';

const mockInvoke = (gramClientModule as unknown as { __mockInvoke: ReturnType<typeof vi.fn> }).__mockInvoke;
const mockResolveDiscussionPeer = (discussionModule as unknown as { __mockResolveDiscussionPeer: ReturnType<typeof vi.fn> }).__mockResolveDiscussionPeer;

type MockedPost = typeof Post & {
  find: ReturnType<typeof vi.fn>;
  updateOne: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
  __chain: { sort: ReturnType<typeof vi.fn>; limit: ReturnType<typeof vi.fn>; lean: ReturnType<typeof vi.fn> };
};
type MockedComment = typeof Comment & {
  find: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
  bulkWrite: ReturnType<typeof vi.fn>;
  __chain: { lean: ReturnType<typeof vi.fn> };
};
const MockPost = Post as unknown as MockedPost;
const MockComment = Comment as unknown as MockedComment;

const GROUP_MTPROTO = 1782171896;
const GROUP_BOT_API = -1001782171896;

function makeDuePost(overrides: Partial<{
  state: string; rootMessageId: number | null; chatId: number | null;
}> = {}): Record<string, unknown> {
  return {
    telegramId: 123,
    channelId: 'chan',
    date: new Date(Date.now() - 60 * 60 * 1000),
    discussion: {
      chatId: overrides.chatId ?? null,
      rootMessageId: overrides.rootMessageId ?? null,
      state: overrides.state ?? 'pending',
      commentsCount: 0,
      resolveAttempts: 0,
      lastCommentsRefreshedAt: null,
    },
  };
}

function makeLinkedPost(): Record<string, unknown> {
  return makeDuePost({ state: 'linked', rootMessageId: 500, chatId: GROUP_BOT_API });
}

function discussionMessageResult(): unknown {
  return {
    messages: [
      {
        className: 'Message',
        id: 500,
        date: 1700000000,
        peerId: { className: 'PeerChannel', channelId: GROUP_MTPROTO },
        fwdFrom: { savedFromMsgId: 123 },
      },
    ],
    chats: [{ id: GROUP_MTPROTO, title: 'Крипто друзья' }],
  };
}

function repliesPage(messages: unknown[], count: number, users: unknown[] = [], chats: unknown[] = []): unknown {
  return { count, messages, users, chats };
}

function makeGramComment(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    className: 'Message',
    id,
    date: 1700000000 + id,
    message: `comment ${id}`,
    fromId: { className: 'PeerUser', userId: 777 },
    replyTo: { replyToMsgId: 500 },
    ...overrides,
  };
}

describe('commentsRefresher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.COMMENTS_REFRESH_PAGE_GAP_MS = '1';
    mockInvoke.mockReset();
    mockResolveDiscussionPeer.mockReset();
    mockResolveDiscussionPeer.mockResolvedValue({ _dpeer: true });
    MockPost.__chain.sort.mockReturnThis();
    MockPost.__chain.limit.mockReturnThis();
    MockPost.__chain.lean.mockResolvedValue([]);
    MockPost.updateOne.mockResolvedValue({ acknowledged: true });
    MockPost.updateMany.mockResolvedValue({ acknowledged: true, modifiedCount: 0 });
    MockComment.__chain.lean.mockResolvedValue([]);
    MockComment.updateMany.mockResolvedValue({ acknowledged: true, modifiedCount: 0 });
    MockComment.bulkWrite.mockResolvedValue({ ok: 1 });
  });

  afterEach(() => {
    delete process.env.COMMENTS_REFRESH_PAGE_GAP_MS;
    stopCommentsRefresher();
    vi.restoreAllMocks();
  });

  it('нет due-постов -> ни одного MTProto-вызова', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    await __testables.runTick();
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('tick: 0 due posts'));
  });

  it('pending пост: резолв корня + обход + upsert + расписание', async () => {
    MockPost.__chain.lean.mockResolvedValueOnce([makeDuePost()]);
    mockInvoke
      .mockResolvedValueOnce(discussionMessageResult()) // GetDiscussionMessage
      .mockResolvedValueOnce(repliesPage(
        [
          makeGramComment(502, { replyTo: { replyToMsgId: 501 } }),
          makeGramComment(501),
        ],
        2,
        [{ id: 777, firstName: 'Ivan', username: 'ivan' }]
      )); // GetReplies, raw < 100 -> exhausted

    await __testables.runTick();

    // корень персистится в Bot API-форме id
    expect(MockPost.updateOne).toHaveBeenCalledWith(
      { telegramId: 123, channelId: 'chan' },
      {
        $set: {
          'discussion.chatId': GROUP_BOT_API,
          'discussion.rootMessageId': 500,
          'discussion.state': 'linked',
          'discussion.resolveAttempts': 0,
        },
      }
    );

    // upsert обоих комментариев с правильной identity и parent-маппингом
    expect(MockComment.bulkWrite).toHaveBeenCalledTimes(1);
    const ops = MockComment.bulkWrite.mock.calls[0][0] as Array<{
      updateOne: { filter: Record<string, unknown>; update: { $set: Record<string, unknown> } };
    }>;
    expect(ops).toHaveLength(2);
    const byId = new Map(ops.map(o => [o.updateOne.filter.messageId, o.updateOne]));
    expect(byId.get(501)?.filter).toEqual({ discussionChatId: GROUP_BOT_API, messageId: 501 });
    expect(byId.get(501)?.update.$set.parentCommentId).toBeNull(); // reply на корень
    expect(byId.get(502)?.update.$set.parentCommentId).toBe(501);  // вложенный
    expect(byId.get(501)?.update.$set['author.username']).toBe('ivan');
    // линковка — first-writer-wins ($setOnInsert), а не $set: альбомы не
    // должны перезаписывать postTelegramId туда-обратно
    const insertOnly = (byId.get(501)?.update as unknown as { $setOnInsert: Record<string, unknown> }).$setOnInsert;
    expect(insertOnly.postTelegramId).toBe(123);
    expect(insertOnly.threadRootId).toBe(500);
    expect(byId.get(501)?.update.$set).not.toHaveProperty('postTelegramId');
    // сироты realtime досвязываются отдельным проходом
    expect(MockComment.updateMany).toHaveBeenCalledWith(
      { discussionChatId: GROUP_BOT_API, threadRootId: 500, postTelegramId: null },
      { $set: { postTelegramId: 123, channelId: 'chan' } }
    );

    // финализация: счётчик + расписание
    expect(MockPost.updateOne).toHaveBeenCalledWith(
      { telegramId: 123, channelId: 'chan' },
      {
        $set: expect.objectContaining({
          'discussion.commentsCount': 2,
          'discussion.lastCommentsRefreshedAt': expect.any(Date),
          'discussion.nextCommentsRefreshAt': expect.any(Date),
        }),
      }
    );
  });

  it('MSG_ID_INVALID на GetDiscussionMessage -> state=none, парковка, без GetReplies', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    MockPost.__chain.lean.mockResolvedValueOnce([makeDuePost()]);
    mockInvoke.mockRejectedValueOnce(new Error('400: MSG_ID_INVALID (caused by messages.GetDiscussionMessage)'));

    await __testables.runTick();

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(MockPost.updateOne).toHaveBeenCalledWith(
      { telegramId: 123, channelId: 'chan' },
      { $set: { 'discussion.state': 'none', 'discussion.nextCommentsRefreshAt': null } }
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('comments unavailable'));
  });

  it('MSG_ID_INVALID на GetReplies -> state=gone, tombstone всего треда', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    MockPost.__chain.lean.mockResolvedValueOnce([makeLinkedPost()]);
    MockComment.updateMany.mockResolvedValueOnce({ modifiedCount: 12 });
    mockInvoke.mockRejectedValueOnce(new Error('400: MSG_ID_INVALID (caused by messages.GetReplies)'));

    await __testables.runTick();

    expect(MockComment.updateMany).toHaveBeenCalledWith(
      { discussionChatId: GROUP_BOT_API, threadRootId: 500, deletedAt: null },
      { $set: { deletedAt: expect.any(Date) } }
    );
    expect(MockPost.updateOne).toHaveBeenCalledWith(
      { telegramId: 123, channelId: 'chan' },
      { $set: { 'discussion.state': 'gone', 'discussion.nextCommentsRefreshAt': null } }
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('root gone'));
  });

  it('FLOOD_WAIT выше капа -> тик прерывается, остальные посты переносятся', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    MockPost.__chain.lean.mockResolvedValueOnce([makeLinkedPost()]);
    mockInvoke.mockRejectedValueOnce(Object.assign(new Error('FLOOD_WAIT_400'), { seconds: 400 }));

    await __testables.runTick();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('exceeds cap'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('tick aborted by FLOOD_WAIT'));
    // текущий пост тоже переносится на следующий слот
    expect(MockPost.updateOne).toHaveBeenCalledWith(
      { telegramId: 123, channelId: 'chan' },
      { $set: { 'discussion.nextCommentsRefreshAt': expect.any(Date) } }
    );
    expect(MockComment.bulkWrite).not.toHaveBeenCalled();
  });

  it('аномалия: пустой fetch при count>0 -> tombstone-сверка пропущена', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    MockPost.__chain.lean.mockResolvedValueOnce([makeLinkedPost()]);
    mockInvoke.mockResolvedValueOnce(repliesPage([], 44));

    await __testables.runTick();

    expect(MockComment.updateMany).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skipping tombstone pass'));
  });

  it('провальный обход (ни одной страницы) НЕ финализируется как успех с count=0', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    MockPost.__chain.lean.mockResolvedValueOnce([makeLinkedPost()]);
    mockInvoke.mockRejectedValueOnce(new Error('ECONNRESET'));

    await __testables.runTick();

    expect(MockComment.bulkWrite).not.toHaveBeenCalled();
    // lastCommentsRefreshedAt НЕ выставляется — пост остаётся в бэкфилл-ветке
    const finalized = MockPost.updateOne.mock.calls.some(call =>
      Object.keys((call[1] as { $set: Record<string, unknown> }).$set).includes('discussion.lastCommentsRefreshedAt')
    );
    expect(finalized).toBe(false);
    // расписание переносится
    expect(MockPost.updateOne).toHaveBeenCalledWith(
      { telegramId: 123, channelId: 'chan' },
      { $set: { 'discussion.nextCommentsRefreshAt': expect.any(Date) } }
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('GetReplies failed'), expect.anything());
  });

  it('транзиентный сбой на старом небэкфилленном посте НЕ паркует его (ретрай вместо null)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const oldPost = makeDuePost();
    (oldPost as { date: Date }).date = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 дней
    MockPost.__chain.lean.mockResolvedValueOnce([oldPost]);
    mockInvoke.mockRejectedValueOnce(new Error('Timeout on GetDiscussionMessage'));

    await __testables.runTick();

    // лесенка для 60-дневного поста дала бы null — но небэкфилленный пост
    // обязан получить ретрай-дату, иначе он навсегда выпадает из очереди
    expect(MockPost.updateOne).toHaveBeenCalledWith(
      { telegramId: 123, channelId: 'chan' },
      { $set: { 'discussion.nextCommentsRefreshAt': expect.any(Date) } }
    );
  });

  it('CHANNEL_PRIVATE не паркует пост терминально и даёт человеческую подсказку', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    MockPost.__chain.lean.mockResolvedValueOnce([makeDuePost()]);
    mockInvoke.mockRejectedValueOnce(new Error('400: CHANNEL_PRIVATE (caused by messages.GetDiscussionMessage)'));

    await __testables.runTick();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('не участник приватной группы'));
    // state не тронут, расписание перенесено (не null)
    const parked = MockPost.updateOne.mock.calls.some(call =>
      (call[1] as { $set: Record<string, unknown> }).$set['discussion.state'] === 'none'
    );
    expect(parked).toBe(false);
    expect(MockPost.updateOne).toHaveBeenCalledWith(
      { telegramId: 123, channelId: 'chan' },
      { $set: { 'discussion.nextCommentsRefreshAt': expect.any(Date) } }
    );
  });

  it('editedAt-гард: более свежая realtime-правка не затирается снапшотом', async () => {
    MockPost.__chain.lean.mockResolvedValueOnce([makeLinkedPost()]);
    // stored: правка от 1700005000; fetched: editDate 1700000300 (старее)
    MockComment.__chain.lean.mockResolvedValueOnce([
      { messageId: 501, editedAt: new Date(1700005000 * 1000) },
    ]);
    mockInvoke.mockResolvedValueOnce(repliesPage(
      [makeGramComment(501, { editDate: 1700000300 })],
      1
    ));

    await __testables.runTick();

    const ops = MockComment.bulkWrite.mock.calls[0][0] as Array<{
      updateOne: { update: { $set: Record<string, unknown> } };
    }>;
    expect(ops[0].updateOne.update.$set).not.toHaveProperty('text');
    expect(ops[0].updateOne.update.$set).not.toHaveProperty('editedAt');
    // реакции при этом обновляются (last-writer-wins за воркером)
    expect(ops[0].updateOne.update.$set).toHaveProperty('reactions');
  });
});

describe('buildTombstoneFilter', () => {
  const base = {
    discussionChatId: GROUP_BOT_API,
    threadRootId: 500,
    walkStartedAt: new Date('2026-08-13T12:00:00Z'),
  };

  it('полный обход: $nin + $lte max, без $gte', () => {
    const filter = buildTombstoneFilter({
      ...base, fetchedIds: [501, 502, 510], pagesExhausted: true, knownCount: 3,
    });
    expect(filter).toEqual({
      discussionChatId: GROUP_BOT_API,
      threadRootId: 500,
      deletedAt: null,
      messageId: { $nin: [501, 502, 510], $lte: 510 },
    });
  });

  it('частичный обход: добавляется $gte min (ниже окна не судим)', () => {
    const filter = buildTombstoneFilter({
      ...base, fetchedIds: [505, 510], pagesExhausted: false, knownCount: 100,
    });
    expect((filter?.messageId as Record<string, unknown>).$gte).toBe(505);
    expect((filter?.messageId as Record<string, unknown>).$lte).toBe(510);
  });

  it('пустой fetch при count>0 -> null (аномалия)', () => {
    expect(buildTombstoneFilter({
      ...base, fetchedIds: [], pagesExhausted: true, knownCount: 44,
    })).toBeNull();
    expect(buildTombstoneFilter({
      ...base, fetchedIds: [], pagesExhausted: false, knownCount: null,
    })).toBeNull();
  });

  it('тред реально пуст: tombstone только старше начала обхода', () => {
    const filter = buildTombstoneFilter({
      ...base, fetchedIds: [], pagesExhausted: true, knownCount: 0,
    });
    expect(filter).toEqual({
      discussionChatId: GROUP_BOT_API,
      threadRootId: 500,
      deletedAt: null,
      date: { $lt: base.walkStartedAt },
    });
  });

  it('комментарий, пришедший mid-pass (id выше окна), не попадает под фильтр', () => {
    const filter = buildTombstoneFilter({
      ...base, fetchedIds: [501, 502], pagesExhausted: true, knownCount: 2,
    });
    const cond = filter?.messageId as { $lte: number };
    expect(cond.$lte).toBe(502); // id 503+ вне окна суда
  });
});
