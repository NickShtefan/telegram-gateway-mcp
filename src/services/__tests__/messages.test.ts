import { describe, expect, it } from 'vitest';
import { extractHiddenLinks, indexEntities, normalizeMedia, normalizeMessage, normalizeMessages, totalCount } from '../messages.js';

const response = {
  count: 240,
  users: [
    { className: 'User', id: 42n, username: 'seller', firstName: 'Ivan', lastName: 'Petrov' },
    { className: 'User', id: 43n, firstName: 'Bot', bot: true, usernames: [{ username: 'helper_bot', active: true }] },
  ],
  chats: [
    { className: 'Channel', id: 500n, title: 'Stonks', username: 'stonksnws', broadcast: true },
    { className: 'Channel', id: 600n, title: 'Stonks chat', megagroup: true },
  ],
  messages: [
    {
      className: 'Message',
      id: 10,
      peerId: { className: 'PeerChannel', channelId: 500n },
      post: true,
      date: 1_790_000_000,
      editDate: 1_790_000_100,
      message: 'Новый пост https://example.com и ссылка',
      entities: [
        { className: 'MessageEntityUrl', offset: 11, length: 19 },
        { className: 'MessageEntityTextUrl', offset: 33, length: 6, url: 'https://hidden.example/x' },
      ],
      views: 12_345,
      forwards: 7,
      replies: { replies: 14, comments: true },
      reactions: { results: [{ reaction: { emoticon: '👍' }, count: 12 }, { reaction: { emoticon: '🔥' }, count: 30 }] },
      media: { className: 'MessageMediaPhoto', photo: { className: 'Photo', sizes: [{ w: 320, h: 240 }, { w: 1280, h: 960 }] } },
      groupedId: 9001n,
      pinned: true,
    },
    {
      className: 'Message',
      id: 77,
      peerId: { className: 'PeerChannel', channelId: 600n },
      fromId: { className: 'PeerUser', userId: 42n },
      date: 1_790_000_500,
      message: 'Продам велосипед',
      replyTo: { replyToMsgId: 70, replyToTopId: 5, forumTopic: true },
      fwdFrom: { fromId: { className: 'PeerChannel', channelId: 500n }, channelPost: 10 },
    },
    {
      className: 'Message',
      id: 78,
      peerId: { className: 'PeerChannel', channelId: 600n },
      fromId: { className: 'PeerChannel', channelId: 600n },
      date: 1_790_000_600,
      message: 'от имени группы',
      replyTo: { replyToMsgId: 77 },
    },
    { className: 'MessageService', id: 79, peerId: { className: 'PeerChannel', channelId: 600n }, date: 1, action: { className: 'MessageActionChatAddUser' } },
    { className: 'MessageEmpty', id: 80 },
  ],
};

describe('normalizeMessages', () => {
  const messages = normalizeMessages(response);

  it('пропускает MessageEmpty и сохраняет порядок', () => {
    expect(messages.map(m => m.id)).toEqual([10, 77, 78, 79]);
    expect(totalCount(response)).toBe(240);
  });

  it('пост канала: автор это сам канал, счётчики и альбом на месте', () => {
    expect(messages[0]).toMatchObject({
      chatKey: '-1000000000500',
      author: { kind: 'channel', peerKey: '-1000000000500', name: 'Stonks', username: 'stonksnws' },
      views: 12_345,
      forwards: 7,
      replies: 14,
      hasComments: true,
      groupedId: '9001',
      pinned: true,
      editDate: 1_790_000_100,
      media: { kind: 'photo', width: 1280, height: 960, downloadable: true },
      hiddenLinks: [{ text: 'ссылка', url: 'https://hidden.example/x' }],
    });
    expect(messages[0]!.reactions[0]).toEqual({ reaction: '🔥', count: 30 });
  });

  it('сообщение в теме форума: автор, тема, ответ и пересылка', () => {
    expect(messages[1]).toMatchObject({
      author: { kind: 'user', peerKey: '42', name: 'Ivan Petrov', username: 'seller', bot: false },
      topicId: 5,
      replyToId: 70,
      forwardedFrom: { name: 'Stonks', peerKey: '-1000000000500', postId: 10 },
      views: null,
      replies: null,
      hasComments: false,
    });
  });

  it('анонимный админ и служебное сообщение', () => {
    expect(messages[2]!.author).toMatchObject({ kind: 'channel', name: 'Stonks chat' });
    expect(messages[2]!.topicId).toBeNull();
    expect(messages[3]).toMatchObject({ service: 'MessageActionChatAddUser', text: '' });
  });

  it('личный чат без peerId берёт запасной ключ', () => {
    const index = indexEntities(response);
    expect(normalizeMessage({ className: 'Message', id: 1, date: 5, message: 'hi' }, index, '42')?.chatKey).toBe('42');
    expect(normalizeMessage({ className: 'Message', id: 1, date: 5 }, index)).toBeNull();
    expect(normalizeMessages(null)).toEqual([]);
  });

  it('username из коллекционных имён', () => {
    const index = indexEntities(response);
    const dto = normalizeMessage({ className: 'Message', id: 2, peerId: { userId: 43n }, fromId: { className: 'PeerUser', userId: 43n }, date: 1, message: '' }, index);
    expect(dto?.author).toMatchObject({ username: 'helper_bot', bot: true });
  });
});

describe('личный чат: fromId не приходит', () => {
  const ME = { tgUserId: '1001', username: 'agent_acc', displayName: 'Test Account' };
  const peer = { className: 'PeerUser', userId: 42n };
  const dialog = {
    users: [{ className: 'User', id: 42n, username: 'seller', firstName: 'Ivan', lastName: 'Petrov' }],
    messages: [
      { className: 'Message', id: 6, peerId: peer, out: true, date: 1_790_000_100, message: 'Здравствуйте, ещё продаёте?' },
      { className: 'Message', id: 5, peerId: peer, date: 1_790_000_000, message: 'Привет' },
    ],
  };

  it('входящее написал собеседник, исходящее сам аккаунт', () => {
    const [mine, theirs] = normalizeMessages(dialog, '42', ME);
    expect(theirs).toMatchObject({ out: false, author: { kind: 'user', peerKey: '42', name: 'Ivan Petrov', username: 'seller' } });
    expect(mine).toMatchObject({ out: true, author: { kind: 'user', peerKey: '1001', name: 'Test Account', username: 'agent_acc' } });
  });

  it('свой аккаунт из ответа Telegram важнее сохранённой личности', () => {
    const withSelf = { ...dialog, users: [...dialog.users, { className: 'User', id: 1001n, self: true, username: 'renamed_acc', firstName: 'Nick' }] };
    expect(normalizeMessages(withSelf, '42', ME)[0]!.author).toMatchObject({ peerKey: '1001', name: 'Nick', username: 'renamed_acc' });
  });

  it('без личности аккаунта исходящее остаётся человеком без имени, а не анонимом', () => {
    expect(normalizeMessages(dialog, '42')[0]!.author).toEqual({ kind: 'user', peerKey: null, name: null, username: null, bot: false });
  });

  it('служебное сообщение и сообщение без peerId подписаны так же', () => {
    const index = indexEntities(dialog);
    expect(normalizeMessage({ className: 'MessageService', id: 7, peerId: peer, date: 1, action: { className: 'MessageActionPhoneCall' } }, index)?.author.peerKey).toBe('42');
    expect(normalizeMessage({ className: 'Message', id: 8, date: 1, message: 'hi' }, index, '42')?.author.username).toBe('seller');
  });

  it('группа без fromId остаётся анонимной: это админ от имени группы', () => {
    const dto = normalizeMessage({ className: 'Message', id: 9, peerId: { className: 'PeerChannel', channelId: 600n }, out: true, date: 1, message: 'x', postAuthor: 'Админ' }, indexEntities(response), undefined, ME);
    expect(dto?.author).toMatchObject({ kind: 'anonymous', peerKey: null, name: 'Админ' });
  });
});

describe('normalizeMedia', () => {
  const doc = (attributes: unknown[], extra: Record<string, unknown> = {}) => ({
    className: 'MessageMediaDocument',
    document: { className: 'Document', mimeType: 'video/mp4', size: 1_500_000n, attributes, ...extra },
  });

  it('различает видео, gif, голосовое, стикер и файл', () => {
    expect(normalizeMedia(doc([{ className: 'DocumentAttributeVideo', duration: 42, w: 720, h: 1280 }]))).toMatchObject({
      kind: 'video',
      durationSec: 42,
      width: 720,
      sizeBytes: 1_500_000,
      downloadable: true,
    });
    expect(normalizeMedia(doc([{ className: 'DocumentAttributeVideo' }, { className: 'DocumentAttributeAnimated' }]))?.kind).toBe('gif');
    expect(normalizeMedia(doc([{ className: 'DocumentAttributeAudio', voice: true, duration: 7 }]))).toMatchObject({ kind: 'voice', durationSec: 7 });
    expect(normalizeMedia(doc([{ className: 'DocumentAttributeSticker' }]))?.kind).toBe('sticker');
    expect(normalizeMedia(doc([{ className: 'DocumentAttributeFilename', fileName: 'price.pdf' }]))).toMatchObject({ kind: 'document', fileName: 'price.pdf' });
  });

  it('превью ссылки, опрос и пустое медиа', () => {
    expect(normalizeMedia({ className: 'MessageMediaWebPage', webpage: { className: 'WebPage', url: 'https://x.io', title: 'X' } })).toEqual({
      kind: 'webpage',
      url: 'https://x.io',
      title: 'X',
      downloadable: false,
    });
    expect(normalizeMedia({ className: 'MessageMediaWebPage', webpage: { className: 'WebPageEmpty' } })).toBeNull();
    expect(normalizeMedia({ className: 'MessageMediaPoll' })?.kind).toBe('poll');
    expect(normalizeMedia({ className: 'MessageMediaPhoto', photo: { className: 'PhotoEmpty' } })).toEqual({ kind: 'photo', downloadable: false });
    expect(normalizeMedia(null)).toBeNull();
    expect(normalizeMedia({ className: 'MessageMediaEmpty' })).toBeNull();
  });

  it('extractHiddenLinks: только спрятанные адреса, со словами из текста и без повторов', () => {
    const entities = [
      { className: 'MessageEntityUrl', offset: 2, length: 12 },
      { className: 'MessageEntityTextUrl', offset: 17, length: 3, url: 'https://x.io' },
      { className: 'MessageEntityTextUrl', offset: 21, length: 5, url: 'https://x.io' },
      { className: 'MessageEntityTextUrl', url: 'https://y.io' },
    ];
    expect(extractHiddenLinks('a https://x.io b тут здесь', entities)).toEqual([
      { text: 'тут', url: 'https://x.io' },
      { text: '', url: 'https://y.io' },
    ]);
    expect(extractHiddenLinks('text', undefined)).toEqual([]);
  });
});
