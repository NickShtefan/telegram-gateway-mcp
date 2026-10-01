import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../db/models/Post.js', () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(null),
  };
  return {
    default: {
      findOne: vi.fn(() => chain),
      updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
      __chain: chain,
    },
  };
});

vi.mock('../../../db/models/Comment.js', () => ({
  default: {
    updateOne: vi.fn().mockResolvedValue({ acknowledged: true }),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
  },
}));

vi.mock('../../../config/telegram.js', () => ({
  default: {
    telegram: { botToken: 't', channelName: 'testchannel', reactionEmojis: [] },
    comments: { enabled: true, downloadMedia: false },
  },
}));

vi.mock('../processMediaBot.js', () => ({
  default: vi.fn().mockResolvedValue([]),
  processCommentMedia: vi.fn().mockResolvedValue([]),
}));

import Post from '../../../db/models/Post.js';
import Comment from '../../../db/models/Comment.js';
import { processCommentMedia } from '../processMediaBot.js';
import processComment, {
  processDiscussionRoot,
  linkRootToPost,
  __resetCommentStateForTests,
} from '../processComment.js';
import type TelegramBot from 'node-telegram-bot-api';

type MockedModel = { updateOne: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
const MockPost = Post as unknown as MockedModel & {
  findOne: ReturnType<typeof vi.fn>;
  __chain: { select: ReturnType<typeof vi.fn>; lean: ReturnType<typeof vi.fn> };
};
const MockComment = Comment as unknown as MockedModel;

const bot = {} as TelegramBot;
const GROUP_ID = -1001782171896;

function makeRootMsg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: 500,
    chat: { id: GROUP_ID, type: 'supergroup' },
    date: 1700000000,
    is_automatic_forward: true,
    forward_origin: {
      type: 'channel',
      chat: { id: -1001188822563, username: 'testchannel' },
      message_id: 123,
    },
    text: 'пост из канала',
    ...overrides,
  };
}

function makeCommentMsg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: 501,
    chat: { id: GROUP_ID, type: 'supergroup' },
    date: 1700000100,
    message_thread_id: 500,
    from: { id: 777, is_bot: false, first_name: 'Ivan', username: 'ivan' },
    text: 'первый!',
    ...overrides,
  };
}

describe('processDiscussionRoot / linkRootToPost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetCommentStateForTests();
    MockPost.updateOne.mockResolvedValue({ matchedCount: 1 });
    MockPost.__chain.lean.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('линкует корень к посту и подцепляет сирот', async () => {
    MockComment.updateMany.mockResolvedValue({ modifiedCount: 2 });

    await processDiscussionRoot(makeRootMsg() as never);

    expect(MockPost.updateOne).toHaveBeenCalledWith(
      { telegramId: 123, channelId: 'testchannel' },
      {
        $set: {
          'discussion.chatId': GROUP_ID,
          'discussion.rootMessageId': 500,
          'discussion.state': 'linked',
          'discussion.resolveAttempts': 0,
          // возвращает в расписание пост, запаркованный воркером до автофорварда
          'discussion.nextCommentsRefreshAt': expect.any(Date),
        },
      }
    );
    expect(MockComment.updateMany).toHaveBeenCalledWith(
      { discussionChatId: GROUP_ID, threadRootId: 500, postTelegramId: null },
      { $set: { postTelegramId: 123, channelId: 'testchannel' } }
    );
  });

  it('автофорвард без forward_origin -> warn и пропуск', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await processDiscussionRoot(makeRootMsg({ forward_origin: undefined }) as never);
    expect(MockPost.updateOne).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('без forward_origin'), 500);
  });

  it('пост ещё не сохранён -> ретрай по таймеру', async () => {
    vi.useFakeTimers();
    MockPost.updateOne
      .mockResolvedValueOnce({ matchedCount: 0 })
      .mockResolvedValue({ matchedCount: 1 });

    await linkRootToPost(
      { postTelegramId: 123, channelId: 'testchannel', rootMessageId: 500, discussionChatId: GROUP_ID },
      0
    );
    expect(MockPost.updateOne).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(MockPost.updateOne).toHaveBeenCalledTimes(2);
    expect(MockComment.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('processComment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetCommentStateForTests();
    MockPost.updateOne.mockResolvedValue({ matchedCount: 1 });
    MockPost.__chain.select.mockReturnThis();
    MockPost.__chain.lean.mockResolvedValue(null);
    MockComment.updateOne.mockResolvedValue({ acknowledged: true });
    MockComment.updateMany.mockResolvedValue({ modifiedCount: 0 });
    // restoreAllMocks в afterEach сбрасывает реализацию фабричных vi.fn — переприваиваем
    vi.mocked(processCommentMedia).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('self-resolve: reply_to_message — корень-автофорвард', async () => {
    const msg = makeCommentMsg({ reply_to_message: makeRootMsg() });

    await processComment(msg as never, bot, false);

    expect(MockComment.updateOne).toHaveBeenCalledWith(
      { discussionChatId: GROUP_ID, messageId: 501 },
      expect.objectContaining({
        $set: expect.objectContaining({
          threadRootId: 500,
          parentCommentId: null, // reply на корень = верхний уровень
          postTelegramId: 123,
          channelId: 'testchannel',
          text: 'первый!',
          deletedAt: null,
        }),
        $setOnInsert: expect.objectContaining({ reactions: [] }),
      }),
      { upsert: true }
    );
    // Post.findOne не понадобился — резолв мгновенный
    expect(MockPost.findOne).not.toHaveBeenCalled();
  });

  it('резолв через сохранённый маппинг Post.discussion', async () => {
    MockPost.__chain.lean.mockResolvedValue({ telegramId: 123, channelId: 'testchannel' });
    const msg = makeCommentMsg({
      message_id: 502,
      reply_to_message: { message_id: 501, text: 'первый!' }, // вложенный ответ на комментарий
    });

    await processComment(msg as never, bot, false);

    expect(MockPost.findOne).toHaveBeenCalledWith({
      'discussion.chatId': GROUP_ID,
      'discussion.rootMessageId': 500,
    });
    expect(MockComment.updateOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: expect.objectContaining({ parentCommentId: 501, postTelegramId: 123 }),
      }),
      { upsert: true }
    );
  });

  it('резолв через буфер свежих корней (гонка с linkRootToPost)', async () => {
    // корень пришёл, но Post.updateOne ещё не отработал: буфер уже знает
    MockPost.updateOne.mockResolvedValue({ matchedCount: 0 });
    await processDiscussionRoot(makeRootMsg() as never);
    MockPost.__chain.lean.mockResolvedValue(null); // в базе маппинга ещё нет

    await processComment(makeCommentMsg() as never, bot, false);

    expect(MockComment.updateOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: expect.objectContaining({ postTelegramId: 123, channelId: 'testchannel' }),
      }),
      { upsert: true }
    );
  });

  it('неизвестный тред (чужая реплай-цепочка) -> drop без записи', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await processComment(makeCommentMsg({ message_thread_id: 9999 }) as never, bot, false);
    expect(MockComment.updateOne).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('вне известных тредов'));
  });

  it('сообщение без message_thread_id и сервисные сообщения -> drop', async () => {
    await processComment(makeCommentMsg({ message_thread_id: undefined }) as never, bot, false);
    await processComment(
      makeCommentMsg({ text: undefined, new_chat_members: [{ id: 1 }] }) as never,
      bot,
      false
    );
    expect(MockComment.updateOne).not.toHaveBeenCalled();
  });

  it('edit: выставляет editedAt и не затирает медиа пустотой', async () => {
    MockPost.__chain.lean.mockResolvedValue({ telegramId: 123, channelId: 'testchannel' });
    const msg = makeCommentMsg({ text: 'исправлено', edit_date: 1700000200 });

    await processComment(msg as never, bot, true);

    const updateArg = MockComment.updateOne.mock.calls[0][1] as { $set: Record<string, unknown> };
    expect(updateArg.$set.editedAt).toEqual(new Date(1700000200 * 1000));
    expect(updateArg.$set).not.toHaveProperty('media');
  });

  it('анонимный админ и комментарий от имени канала различаются', async () => {
    MockPost.__chain.lean.mockResolvedValue({ telegramId: 123, channelId: 'testchannel' });

    await processComment(
      makeCommentMsg({ sender_chat: { id: GROUP_ID, title: 'Крипто друзья' }, from: undefined }) as never,
      bot, false
    );
    let updateArg = MockComment.updateOne.mock.calls[0][1] as { $set: { author: { type: string } } };
    expect(updateArg.$set.author.type).toBe('group_anonymous');

    MockComment.updateOne.mockClear();
    await processComment(
      makeCommentMsg({ sender_chat: { id: -100555, title: 'Другой канал' }, from: undefined }) as never,
      bot, false
    );
    updateArg = MockComment.updateOne.mock.calls[0][1] as { $set: { author: { type: string } } };
    expect(updateArg.$set.author.type).toBe('channel');
  });

  it('E11000 при гонке upsert\'ов -> один ретрай', async () => {
    MockPost.__chain.lean.mockResolvedValue({ telegramId: 123, channelId: 'testchannel' });
    MockComment.updateOne
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }))
      .mockResolvedValueOnce({ acknowledged: true });

    await processComment(makeCommentMsg() as never, bot, false);

    expect(MockComment.updateOne).toHaveBeenCalledTimes(2);
  });
});
