import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeAccount } from '../../cli/admin.js';
import { createLogger } from '../../core/log.js';
import { writePrivateMode } from '../../policy/scopes.js';
import { HistoryService } from '../../services/history.js';
import { JobManager } from '../../services/jobs.js';
import { buildMatch, IndexStore, LocalIndexService } from '../../services/localIndex.js';
import { collapseAlbums, computeStats } from '../../services/stats.js';
import { normalizeMessages } from '../../services/messages.js';
import { makeTestGateway, type TestClient, type TestGateway } from '../../__tests__/helpers/gateway.js';
import { rawChannel, rawMessage, rawUser } from '../../__tests__/helpers/fakeTg.js';

let gw: TestGateway;
let nick: TestClient;
let clock: number;

const DAY = 86_400;
const NOW_SEC = Math.floor(Date.UTC(2026, 9, 1, 12, 0, 0) / 1000);

beforeEach(async () => {
  clock = NOW_SEC * 1000;
  gw = makeTestGateway({ now: () => clock });
  nick = await gw.client('nick');
});

afterEach(async () => {
  await nick.close();
  gw.cleanup();
});

/** Диалог с каналом или супергруппой и его последнее сообщение. */
function channelDialog(id: number, topMessage: number, date: number, extra: Record<string, unknown> = {}) {
  return {
    dialog: { className: 'Dialog', peer: { className: 'PeerChannel', channelId: BigInt(id) }, topMessage, unreadCount: 0, ...extra },
    message: { className: 'Message', id: topMessage, date, peerId: { className: 'PeerChannel', channelId: BigInt(id) } },
  };
}

interface DialogsRequest {
  folderId?: number;
  offsetDate: number;
  offsetId: number;
  offsetPeer: { className: string; channelId?: unknown };
  limit: number;
}

describe('tg_list_dialogs: чаты аккаунта', () => {
  const pinned = channelDialog(500, 90, NOW_SEC - 40 * DAY, { pinned: true });
  const flea = channelDialog(700, 5000, NOW_SEC - 3600, { unreadCount: 12 });
  const news = channelDialog(800, 77, NOW_SEC - 2 * DAY);
  const archived = channelDialog(900, 15, NOW_SEC - 90 * DAY);
  const friend = {
    dialog: { className: 'Dialog', peer: { className: 'PeerUser', userId: 42n }, topMessage: 9, unreadCount: 1 },
    message: { className: 'Message', id: 9, date: NOW_SEC - 60, peerId: { className: 'PeerUser', userId: 42n } },
  };
  const chats = [
    rawChannel(500, { username: 'stonksnws', title: 'Stonks', participantsCount: 289 }),
    rawChannel(700, { username: 'baraholka_cy', title: 'Барахолка Кипр', broadcast: false, megagroup: true, forum: true, participantsCount: 12_400 }),
    rawChannel(800, { title: 'Новости без ссылки' }),
    rawChannel(900, { username: 'old_channel', title: 'Старый канал' }),
  ];

  beforeEach(() => {
    gw.tg.on('messages.GetDialogs', (req: DialogsRequest) => {
      if (req.folderId === 1) {
        return { className: 'messages.Dialogs', dialogs: [archived.dialog], messages: [archived.message], chats, users: [] };
      }
      const main = [pinned, friend, flea, news];
      return {
        className: 'messages.Dialogs',
        dialogs: [{ className: 'DialogFolder', folder: { id: 1 } }, ...main.map(d => d.dialog)],
        messages: main.map(d => d.message),
        chats,
        users: [rawUser(42, { username: 'friend', firstName: 'Друг' })],
      };
    });
  });

  it('показывает каналы и группы вместе с архивом, личные переписки не показывает', async () => {
    const reply = await nick.call('tg_list_dialogs');
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.text).toContain('Chats of account agent: 4 shown (scanned 5)');
    expect(reply.text).toContain('@stonksnws "Stonks" | channel | 289 members | last message 2026-08-22 | pinned | id -1000000000500');
    expect(reply.text).toContain('@baraholka_cy "Барахолка Кипр" | forum | 12.4k members | unread 12 | last message 2026-10-01 | id -1000000000700');
    expect(reply.text).toContain('"Новости без ссылки" (id -1000000000800) | channel | last message 2026-09-29');
    expect(reply.text).toContain('@old_channel "Старый канал" | channel | last message 2026-07-03 | archived | id -1000000000900');
    expect(reply.text).not.toContain('friend');
    expect(reply.text).not.toContain('Друг');
    expect(reply.text).not.toContain('next_cursor');

    // основной список, затем архив; первая страница без смещения
    const calls = gw.tg.callsOf('messages.GetDialogs').map(c => c.request as DialogsRequest);
    expect(calls.map(c => c.folderId)).toEqual([0, 1]);
    expect(calls[0]!.offsetPeer.className).toBe('InputPeerEmpty');
    expect(calls[0]!.limit).toBe(100);
    // запросы собраны настоящими классами teleproto и сериализуются
    for (const call of gw.tg.callsOf('messages.GetDialogs')) expect(() => call.request.getBytes()).not.toThrow();
  });

  it('type=private показывает только те личные чаты, которые владелец открыл на чтение', async () => {
    const closed = await nick.call('tg_list_dialogs', { type: 'private' });
    expect(closed.text).toContain('0 shown, private only');
    expect(closed.text).not.toContain('friend');

    // режим send чтения не открывает
    writePrivateMode(gw.storage, 'nick', 'agent', 'send');
    expect((await nick.call('tg_list_dialogs', { type: 'private' })).text).not.toContain('friend');

    writePrivateMode(gw.storage, 'nick', 'agent', 'open');
    const open = await nick.call('tg_list_dialogs', { type: 'private' });
    expect(open.text).toContain('1 shown, private only');
    expect(open.text).toContain('@friend "Друг" | user | unread 1');
    expect(open.text).not.toContain('@stonksnws');
    // в общем списке людей по-прежнему нет
    expect((await nick.call('tg_list_dialogs')).text).not.toContain('friend');

    // один чат, открытый правилом, тоже виден
    writePrivateMode(gw.storage, 'nick', 'agent', 'closed');
    gw.storage.scopes.put({ userId: 'nick', accountId: 'agent', target: 'friend', effect: 'allow' });
    expect((await nick.call('tg_list_dialogs', { type: 'private' })).text).toContain('@friend');
  });

  it('фильтр по названию и типу; чат из списка дальше открывается по id', async () => {
    const byName = await nick.call('tg_list_dialogs', { query: 'барахол' });
    expect(byName.text).toContain('1 shown, matching "барахол"');
    expect(byName.text).toContain('@baraholka_cy');
    expect(byName.text).not.toContain('@stonksnws');

    const groups = await nick.call('tg_list_dialogs', { type: 'groups' });
    expect(groups.text).toContain('1 shown, groups only');
    const channels = await nick.call('tg_list_dialogs', { type: 'channels' });
    expect(channels.text).toContain('3 shown, channels only');
    expect(channels.text).not.toContain('baraholka_cy');

    expect((await nick.call('tg_list_dialogs', { query: 'нет такого' })).text).toContain('Nothing matched.');

    // чат без username теперь известен аккаунту: его можно читать по id из списка
    gw.tg.on('messages.GetHistory', () => ({ messages: [], chats: [], users: [] }));
    const history = await nick.call('tg_read_history', { chat: '-1000000000800' });
    expect(history.isError, history.text).toBe(false);
  });

  it('чат, закрытый владельцем, в список не попадает; запуск по правилу список не видит', async () => {
    gw.storage.scopes.put({ userId: 'nick', accountId: 'agent', target: '-1000000000700', effect: 'deny' });
    const reply = await nick.call('tg_list_dialogs');
    expect(reply.text).not.toContain('baraholka_cy');
    expect(reply.text).toContain('3 shown');
  });

  it('длинный список читается страницами: курсор продолжает с последнего показанного чата', async () => {
    const many = Array.from({ length: 150 }, (_, i) => channelDialog(2000 + i, 10 + i, NOW_SEC - i * 600));
    const manyChats = many.map((_, i) => rawChannel(2000 + i, { username: `chan${i}`, title: `Канал ${i}` }));
    gw.tg.on('messages.GetDialogs', (req: DialogsRequest) => {
      if (req.folderId === 1) return { className: 'messages.Dialogs', dialogs: [], messages: [], chats: [], users: [] };
      const start = req.offsetId === 0 ? 0 : many.findIndex(d => d.dialog.topMessage === req.offsetId) + 1;
      const slice = many.slice(start, start + req.limit);
      return { className: 'messages.DialogsSlice', count: 150, dialogs: slice.map(d => d.dialog), messages: slice.map(d => d.message), chats: manyChats, users: [] };
    });

    const first = await nick.call('tg_list_dialogs', { limit: 60 });
    expect(first.text).toContain('60 shown');
    expect(first.text).toContain('@chan59');
    expect(first.text).not.toContain('@chan60 ');
    const cursor = first.text.match(/next_cursor: (\S+)/)![1]!;

    const second = await nick.call('tg_list_dialogs', { limit: 100, cursor });
    expect(second.text).toContain('90 shown');
    expect(second.text).toContain('@chan60 ');
    expect(second.text).toContain('@chan149');
    expect(second.text).not.toContain('next_cursor');
    // продолжение запрошено от 60-го чата: его дата, id сообщения и сам чат
    const resumed = gw.tg.callsOf('messages.GetDialogs').map(c => c.request as DialogsRequest).find(r => r.offsetId === 69)!;
    expect(resumed.offsetDate).toBe(NOW_SEC - 59 * 600);
    expect(resumed.offsetPeer.className).toBe('InputPeerChannel');
    expect(String(resumed.offsetPeer.channelId)).toBe('2059');
  });
});

describe('набор discover: поиск каналов', () => {
  const DISCOVER = ['core', 'discover'];
  let agent: TestClient;
  const peer = (id: number) => ({ className: 'PeerChannel', channelId: BigInt(id) });
  const mine = rawChannel(500, { username: 'stonksnws', title: 'Stonks', participantsCount: 289 });
  const big = rawChannel(3001, { username: 'crypto_news', title: 'Крипто новости', participantsCount: 54_000, verified: true, left: true });
  const group = rawChannel(3002, { username: 'crypto_chat', title: 'Крипто чат', broadcast: false, megagroup: true, participantsCount: 9_100, scam: true, left: true });

  beforeEach(async () => {
    agent = await gw.client('nick', DISCOVER);
    gw.tg.on('contacts.ResolveUsername', (req: { username: string }) => {
      if (req.username.toLowerCase() === 'crypto_chat') return { peer: peer(3002), chats: [group], users: [] };
      return { peer: peer(500), chats: [mine], users: [] };
    });
  });

  afterEach(async () => {
    await agent.close();
  });

  it('инструменты набора есть только когда он включён', async () => {
    const names = (await agent.tools()).map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['tg_find_channels', 'tg_similar_channels', 'tg_forward_sources']));
    expect((await nick.tools()).map(t => t.name)).not.toContain('tg_find_channels');
    for (const tool of (await agent.tools()).filter(t => /find_channels|similar|forward_sources/.test(t.name))) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true });
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/anyOf|oneOf|allOf/);
    }
  });

  it('tg_find_channels: каналы и группы по названию, люди в выдачу не попадают', async () => {
    gw.tg.on('contacts.Search', () => ({
      className: 'contacts.Found',
      myResults: [peer(500)],
      results: [peer(3001), { className: 'PeerUser', userId: 77n }, peer(3002)],
      chats: [mine, big, group],
      users: [rawUser(77, { username: 'crypto_guy', firstName: 'Crypto' })],
    }));
    const reply = await agent.call('tg_find_channels', { query: 'крипто' });
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.text).toContain('Channels and groups matching "крипто": 3');
    expect(reply.text).toContain('@stonksnws "Stonks" | channel | 289 members | the account is a member');
    expect(reply.text).toContain('@crypto_news "Крипто новости" | channel | 54k members | verified');
    expect(reply.text).toContain('@crypto_chat "Крипто чат" | supergroup | 9.1k members | SCAM or FAKE');
    expect(reply.text).not.toContain('crypto_guy');
    const call = gw.tg.last('contacts.Search');
    expect(call.request).toMatchObject({ q: 'крипто', limit: 20 });
    expect(() => call.request.getBytes()).not.toThrow();

    // найденный канал уже известен аккаунту: читать его можно без нового поиска по username
    gw.tg.on('messages.GetHistory', () => ({ messages: [], chats: [], users: [] }));
    const before = gw.tg.callsOf('contacts.ResolveUsername').length;
    expect((await agent.call('tg_read_history', { chat: '@crypto_news' })).isError).toBe(false);
    expect(gw.tg.callsOf('contacts.ResolveUsername')).toHaveLength(before);

    // канал из списка запрета владельца не показывается
    gw.storage.scopes.put({ userId: 'nick', accountId: 'agent', target: 'crypto_news', effect: 'deny' });
    expect((await agent.call('tg_find_channels', { query: 'крипто' })).text).not.toContain('crypto_news');
    expect((await agent.call('tg_find_channels', { query: 'я' })).isError).toBe(true);
  });

  it('tg_similar_channels: рекомендации Telegram, второй уровень от трёх крупнейших', async () => {
    const rec = (id: number, members: number) => rawChannel(id, { username: `rec${id}`, title: `Rec ${id}`, participantsCount: members, left: true });
    gw.tg.on('channels.GetChannelRecommendations', (req: { channel: { channelId: unknown } }) => {
      const id = Number(req.channel.channelId);
      if (id === 500) return { className: 'messages.ChatsSlice', count: 40, chats: [rec(3001, 54_000), rec(3002, 10_000), rec(3003, 200_000), rec(3004, 1_000)] };
      if (id === 3003) return { className: 'messages.Chats', chats: [rec(3010, 5_000), rec(3001, 54_000)] };
      if (id === 3001) throw new Error('CHANNEL_PRIVATE');
      return { className: 'messages.Chats', chats: [rec(3011, 700)] };
    });

    const one = await agent.call('tg_similar_channels', { chat: '@stonksnws' });
    expect(one.isError, one.text).toBe(false);
    expect(one.text).toContain('Channels similar to @stonksnws: 4');
    // сначала самые крупные
    expect(one.text.indexOf('@rec3003')).toBeLessThan(one.text.indexOf('@rec3001'));
    expect(one.text).toContain('@rec3003 "Rec 3003" | channel | 200k members');
    expect(one.text).toContain('Telegram knows 40 similar channels but shows the full list only to Premium accounts.');
    expect(gw.tg.callsOf('channels.GetChannelRecommendations')).toHaveLength(1);
    expect(() => gw.tg.last('channels.GetChannelRecommendations').request.getBytes()).not.toThrow();

    const two = await agent.call('tg_similar_channels', { chat: '@stonksnws', depth: 2 });
    expect(two.text).toContain('6 (two levels)');
    expect(two.text).toContain('@rec3010');
    expect(two.text).toContain('@rec3011');
    // сам канал и повторы не добавляются; сбой одного соседа не ломает обход
    expect(two.text.match(/@rec3001 /g)).toHaveLength(1);
    expect(gw.tg.callsOf('channels.GetChannelRecommendations')).toHaveLength(1 + 4);

    const notChannel = await agent.call('tg_similar_channels', { chat: '@crypto_chat' });
    expect(notChannel.isError).toBe(true);
    expect(notChannel.text).toContain('only for broadcast channels');
  });

  it('tg_forward_sources: считает, откуда канал репостит', async () => {
    const posts = [
      rawMessage(500, 20, { fwdFrom: { fromId: peer(3001), channelPost: 7 } }),
      rawMessage(500, 19),
      rawMessage(500, 18, { fwdFrom: { fromId: peer(3001), channelPost: 6 } }),
      rawMessage(500, 17, { fwdFrom: { fromId: peer(3002), channelPost: 3 } }),
      rawMessage(500, 16, { fwdFrom: { fromName: 'Скрытый автор' } }),
      rawMessage(500, 15, { fwdFrom: { fromId: { className: 'PeerUser', userId: 77n } } }),
      { className: 'MessageService', id: 14, peerId: peer(500), date: 1_790_000_000, action: { className: 'MessageActionPinMessage' } },
      rawMessage(500, 13, { fwdFrom: { fromId: peer(3999), channelPost: 1 } }),
    ];
    gw.tg.on('messages.GetHistory', () => ({ messages: posts, chats: [mine, big, group], users: [rawUser(77, { firstName: 'Кто-то' })] }));

    const reply = await agent.call('tg_forward_sources', { chat: '@stonksnws' });
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.text).toContain('Forward sources of @stonksnws: 6 forwards in 7 posts (86%)');
    const lines = reply.text.split('\n');
    expect(lines.find(l => l.startsWith('2x'))).toContain('@crypto_news "Крипто новости" | 54k members | last ');
    expect(lines.find(l => l.includes('@crypto_chat'))).toMatch(/^1x \| @crypto_chat/);
    expect(reply.text).toContain('1x | id -1000000003999 (not resolvable: private or deleted)');
    expect(reply.text).toContain('2 more forward(s) came from people or from sources that hide themselves.');
    expect(reply.text).not.toContain('Скрытый автор');
  });

  it('tg_forward_sources читает ленту страницами до заданного числа постов', async () => {
    const all = Array.from({ length: 260 }, (_, i) => rawMessage(500, 1000 - i, i % 10 === 0 ? { fwdFrom: { fromId: peer(3001), channelPost: i } } : {}));
    gw.tg.on('messages.GetHistory', (req: { offsetId: number; limit: number }) => {
      const start = req.offsetId === 0 ? 0 : all.findIndex(m => m.id === req.offsetId) + 1;
      return { messages: all.slice(start, start + req.limit), chats: [mine, big], users: [] };
    });
    const reply = await agent.call('tg_forward_sources', { chat: '@stonksnws', posts: 150 });
    expect(reply.text).toContain('15 forwards in 150 posts (10%)');
    expect(gw.tg.callsOf('messages.GetHistory').map(c => (c.request as { limit: number }).limit)).toEqual([100, 50]);
    expect((await agent.call('tg_forward_sources', { chat: '@stonksnws', posts: 5000 })).text).toContain('in 260 posts');
  });
});

describe('набор analytics: статистика канала', () => {
  let agent: TestClient;
  let members: number;
  const chan = () => rawChannel(500, { username: 'stonksnws', title: 'Stonks' });
  const reaction = (emoticon: string, count: number) => ({ reaction: { className: 'ReactionEmoji', emoticon }, count });
  const at = (daysAgo: number) => NOW_SEC - Math.round(daysAgo * DAY);
  const post = (id: number, daysAgo: number, views: number, extra: Record<string, unknown> = {}) =>
    rawMessage(500, id, { post: true, date: at(daysAgo), views, message: `Пост ${id}`, ...extra });

  const feed = () => [
    post(70, 0.2, 50, { reactions: { results: [reaction('👍', 1)] } }),
    post(60, 2, 400, { reactions: { results: [reaction('👍', 8), reaction('❤', 2)] }, replies: { replies: 4, comments: true }, forwards: 2 }),
    post(50, 5, 300, { reactions: { results: [reaction('👍', 6)] }, replies: { replies: 2, comments: true }, forwards: 1 }),
    post(40, 9, 200, { reactions: { results: [reaction('🔥', 4)] }, replies: { replies: 0, comments: true }, forwards: 0, fwdFrom: { fromId: { className: 'PeerChannel', channelId: 3001n }, channelPost: 5 } }),
    post(30, 20, 100, { message: 'Реклама. Купите курс erid: 2Vtzq', replies: { replies: 0, comments: true }, forwards: 1 }),
    { className: 'MessageService', id: 25, peerId: { className: 'PeerChannel', channelId: 500n }, date: at(22), action: { className: 'MessageActionPinMessage' } },
    post(21, 25, 190, { message: '', groupedId: 9n }),
    post(20, 25, 200, { message: 'Подпись альбома', groupedId: 9n }),
    post(10, 28, 150),
  ];

  beforeEach(async () => {
    members = 1000;
    agent = await gw.client('nick', ['core', 'analytics']);
    gw.tg.on('contacts.ResolveUsername', () => ({ peer: { className: 'PeerChannel', channelId: 500n }, chats: [chan()], users: [] }));
    gw.tg.on('channels.GetFullChannel', () => ({ fullChat: { participantsCount: members, about: 'about' }, chats: [chan()], users: [] }));
    gw.tg.on('messages.GetHistory', () => ({ messages: feed(), chats: [chan()], users: [] }));
  });

  afterEach(async () => {
    await agent.close();
  });

  it('расчёт: охват, вовлечённость, разброс, тренд, альбом это один пост', () => {
    const stats = computeStats(normalizeMessages({ messages: feed(), chats: [chan()], users: [] }, '-1000000000500'), 1000, NOW_SEC, NOW_SEC - 30 * DAY);
    expect(stats).toMatchObject({
      posts: 7,
      settledPosts: 6,
      postsPerWeek: 1.8,
      avgViews: 225,
      medianViews: 200,
      viewsSpread: 44,
      reachRate: 22.5,
      err: 1.48,
      reactionsPerPost: 3,
      commentsPerPost: 1.5,
      sharesPerPost: 1,
      reactionKinds: 3,
      forwardedShare: 14,
      viewsTrend: 100,
    });
    expect(stats.topReactions).toEqual([{ reaction: '👍', share: 71 }, { reaction: '🔥', share: 19 }, { reaction: '❤', share: 10 }]);
    expect(stats.topPosts.map(p => p.id)).toEqual([60, 50, 40]);
    // альбом: одно сообщение с подписью и наибольшими просмотрами
    const album = collapseAlbums(normalizeMessages({ messages: feed(), chats: [chan()], users: [] }, '-1000000000500')).filter(m => m.groupedId !== null);
    expect(album).toHaveLength(1);
    expect(album[0]).toMatchObject({ text: 'Подпись альбома', views: 200 });
  });

  it('мало данных: без устоявшихся постов считает по всем, без подписчиков не считает охват', () => {
    const few = normalizeMessages({ messages: [post(2, 0.1, 30), post(1, 0.5, 60)], chats: [chan()], users: [] }, '-1000000000500');
    const stats = computeStats(few, null, NOW_SEC, NOW_SEC - 7 * DAY);
    expect(stats).toMatchObject({ posts: 2, settledPosts: 2, avgViews: 45, reachRate: null, viewsTrend: null, err: 0 });
    expect(computeStats([], 100, NOW_SEC, NOW_SEC - 7 * DAY)).toMatchObject({ posts: 0, avgViews: null, medianViews: null, err: null, postsPerWeek: 0 });
  });

  it('tg_channel_stats: числа по каналу и изменение подписчиков между днями', async () => {
    const first = await agent.call('tg_channel_stats', { chat: '@stonksnws' });
    expect(first.isError, first.text).toBe(false);
    expect(first.text).toContain('Statistics of @stonksnws [channel] for the last 30 days: 7 posts');
    expect(first.text).toContain('subscribers: 1k (1000) | change: no earlier snapshot yet');
    expect(first.text).toContain('posts: 7 (1.8 per week) | reposts from elsewhere: 14%');
    expect(first.text).not.toContain('ads');
    expect(first.text).toContain('views per post: avg 225 | median 200 | spread 44%');
    expect(first.text).toContain('reach: an average post is seen by 22.5% of subscribers');
    expect(first.text).toContain('engagement (ERR): 1.48% of views leave a reaction');
    expect(first.text).toContain('per post: 3 reactions, 1.5 comments, 1 shares');
    expect(first.text).toContain('reactions used: 👍 71%, 🔥 19%, ❤ 10% (3 kinds)');
    expect(first.text).toContain('trend: views per post +100% in the newer half of the period against the older half');
    expect(first.text).toContain('View numbers use 6 posts older than 24 hours');
    expect(first.text).toContain('#60 | 2026-09-29 12:00 | views 400 | comments 4 | https://t.me/stonksnws/60');
    expect(first.text).toMatch(/By week \(Monday, UTC\):\n2026-09-28 \| 2 posts \| avg views 225/);
    // текст постов в статистику не попадает
    expect(first.text).not.toContain('Купите курс');

    // через три дня подписчиков стало больше: виден рост от первого снимка
    clock += 3 * DAY * 1000;
    members = 1100;
    const later = await agent.call('tg_channel_stats', { chat: '@stonksnws', days: 14 });
    expect(later.text).toContain('subscribers: 1.1k (1100) | on 2026-10-01: 1000 (+100, +10%)');
  });

  it('tg_channel_stats: предел постов, пустой период, человек вместо канала', async () => {
    const all = Array.from({ length: 250 }, (_, i) => post(1000 - i, i * 0.1 + 2, 100));
    gw.tg.on('messages.GetHistory', (req: { offsetId: number; limit: number }) => {
      const start = req.offsetId === 0 ? 0 : all.findIndex(m => m.id === req.offsetId) + 1;
      return { messages: all.slice(start, start + req.limit), chats: [chan()], users: [] };
    });
    const capped = await agent.call('tg_channel_stats', { chat: '@stonksnws', max_posts: 100 });
    expect(capped.text).toContain('Only the newest 100 posts were read (max_posts)');
    expect(gw.tg.callsOf('messages.GetHistory')).toHaveLength(1);

    gw.tg.on('messages.GetHistory', () => ({ messages: [], chats: [chan()], users: [] }));
    expect((await agent.call('tg_channel_stats', { chat: '@stonksnws' })).text).toContain('No posts in this period.');

    gw.tg.on('contacts.ResolveUsername', () => ({ peer: { className: 'PeerUser', userId: 42n }, chats: [], users: [rawUser(42, { username: 'seller' })] }));
    gw.storage.scopes.put({ userId: 'nick', accountId: 'agent', target: 'seller', effect: 'allow' });
    expect((await agent.call('tg_channel_stats', { chat: '@seller' })).text).toContain('not for people');
    expect((await nick.tools()).map(t => t.name)).not.toContain('tg_channel_stats');
  });
});

describe('набор index: локальный индекс и поиск по нему', () => {
  const INDEX = ['core', 'index'];
  const FLEA = 700;
  let agent: TestClient;
  /** Лента чата, от новых к старым. */
  let feed: Array<Record<string, unknown>>;
  const flea = () => rawChannel(FLEA, { username: 'baraholka', title: 'Барахолка', broadcast: false, megagroup: true });
  const at = (daysAgo: number) => NOW_SEC - Math.round(daysAgo * DAY);
  const msg = (id: number, daysAgo: number, text: string, extra: Record<string, unknown> = {}) =>
    rawMessage(FLEA, id, { date: at(daysAgo), message: text, fromId: { className: 'PeerUser', userId: 42n }, ...extra });
  const historyCalls = () => gw.tg.callsOf('messages.GetHistory').length;

  beforeEach(async () => {
    agent = await gw.client('nick', INDEX);
    feed = [
      msg(110, 1, 'Продам велосипеды Stels, два штуки, по 12 000 руб'),
      msg(109, 2, 'Куплю iPhone 15 Pro, бу'),
      msg(108, 5, 'ВЕЛОСИПЕД детский отдам даром'),
      { className: 'MessageService', id: 107, peerId: { className: 'PeerChannel', channelId: BigInt(FLEA) }, date: at(6), action: { className: 'MessageActionChatAddUser' } },
      msg(106, 10, 'Сдам квартиру в Лимассоле, 1200 евро'),
      msg(105, 20, 'Продам самокат и шлем'),
      msg(104, 45, 'Старое объявление: велосипедный насос'),
      msg(103, 80, 'Совсем старое: продам лыжи'),
    ];
    gw.tg.on('contacts.ResolveUsername', (req: { username: string }) => {
      if (req.username.toLowerCase() === 'stonksnws') return { peer: { className: 'PeerChannel', channelId: 500n }, chats: [rawChannel(500, { username: 'stonksnws', title: 'Stonks' })], users: [] };
      return { peer: { className: 'PeerChannel', channelId: BigInt(FLEA) }, chats: [flea()], users: [] };
    });
    gw.tg.on('messages.GetHistory', (req: { offsetId: number; limit: number }) => {
      const start = req.offsetId === 0 ? 0 : feed.findIndex(m => (m.id as number) < req.offsetId);
      const slice = start === -1 ? [] : feed.slice(start, start + req.limit);
      return { messages: slice, chats: [flea()], users: [rawUser(42, { username: 'seller', firstName: 'Иван' })] };
    });
  });

  afterEach(async () => {
    await agent.close();
  });

  it('индексация и поиск: формы слова, регистр, все слова запроса, без обращений к Telegram', async () => {
    const indexed = await agent.call('tg_index', { chat: '@baraholka', since: '30d' });
    expect(indexed.isError, indexed.text).toBe(false);
    // за 30 дней пять сообщений, служебное в индекс не идёт
    expect(indexed.text).toContain('Indexed @baraholka: 5 messages in the local index (5 new,');
    expect(indexed.text).toContain('The index covers this chat since 2026-09-01 12:00 UTC');
    expect(gw.tg.last('messages.GetHistory').options).toMatchObject({ priority: 'background' });

    const before = gw.tg.calls.length;
    const bikes = await agent.call('tg_local_search', { query: 'велосипед' });
    expect(bikes.text).toContain('Local search "велосипед": 2 of 2 matches in 1 indexed chat(s)');
    expect(bikes.text).toContain('#110');
    expect(bikes.text).toContain('#108');
    expect(bikes.text).toContain('https://t.me/baraholka/110');
    expect(bikes.text).toMatch(/> Продам велосипеды Stels/);
    expect(bikes.text).toContain('Index last synced: 2026-10-01 12:00 UTC');
    // сообщение старше периода в индекс не попало
    expect(bikes.text).not.toContain('насос');

    expect((await agent.call('tg_local_search', { query: 'ПРОДАМ самокат' })).text).toContain('1 of 1 matches');
    expect((await agent.call('tg_local_search', { query: 'продам квартиру' })).text).toContain('0 of 0 matches');
    expect((await agent.call('tg_local_search', { query: 'продам', since: '3d' })).text).toContain('1 of 1 matches');
    expect((await agent.call('tg_local_search', { query: 'велосипед', mode: 'full' })).text).toContain('<<<TG:');
    // ни одного запроса к Telegram за все поиски
    expect(gw.tg.calls.length).toBe(before);
  });

  it('короткие слова и знаки запроса не ломают поиск', async () => {
    await agent.call('tg_index', { chat: '@baraholka' });
    const short = await agent.call('tg_local_search', { query: 'iphone бу' });
    expect(short.isError, short.text).toBe(false);
    expect(short.text).toContain('#109');
    expect(short.text).toContain('shorter than 3 characters');
    expect((await agent.call('tg_local_search', { query: 'iphone 15' })).text).toContain('#109');
    expect((await agent.call('tg_local_search', { query: 'бу' })).text).toContain('at least one query word of 3 or more characters');
    // операторы FTS остаются текстом
    const odd = await agent.call('tg_local_search', { query: '"велосипед" OR NEAR( * продам' });
    expect(odd.isError, odd.text).toBe(false);
    expect(buildMatch('a"b  велосипед')).toEqual({ match: '"a""b" "велосипед"', short: [] });
  });

  it('повторный запуск дочитывает новое, обновляет изменённое и почти не ходит в Telegram', async () => {
    await agent.call('tg_index', { chat: '@baraholka', since: '30d' });
    const callsAfterFirst = historyCalls();

    // новое объявление, а у вчерашнего автор поправил текст
    feed.unshift(msg(111, 0.1, 'Продам гитару Yamaha'));
    feed[1] = msg(110, 1, 'ПРОДАНО. Велики ушли');
    clock += 3600 * 1000;
    const again = await agent.call('tg_index', { chat: '@baraholka', since: '30d' });
    expect(again.text).toContain('6 messages in the local index (1 new,');
    expect(historyCalls() - callsAfterFirst).toBe(1);

    expect((await agent.call('tg_local_search', { query: 'гитару' })).text).toContain('#111');
    expect((await agent.call('tg_local_search', { query: 'Stels' })).text).toContain('0 of 0 matches');
    expect((await agent.call('tg_local_search', { query: 'продано' })).text).toContain('#110');
  });

  it('период можно продлить назад: дочитывается только хвост', async () => {
    await agent.call('tg_index', { chat: '@baraholka', since: '30d' });
    expect((await agent.call('tg_local_search', { query: 'насос' })).text).toContain('0 of 0 matches');
    const wider = await agent.call('tg_index', { chat: '@baraholka', since: '60d' });
    expect(wider.text).toContain('6 messages in the local index (1 new,');
    expect(wider.text).toContain('covers this chat since 2026-08-02');
    expect((await agent.call('tg_local_search', { query: 'насос' })).text).toContain('#104');
    expect((await agent.call('tg_local_search', { query: 'лыжи' })).text).toContain('0 of 0 matches');

    const list = await agent.call('tg_index', { action: 'list' });
    expect(list.text).toContain('Indexed chats: 1');
    expect(list.text).toContain('@baraholka | account agent | 6 messages | since 2026-08-02 | synced 2026-10-01 12:00');
    // период можно задать и годами: предел три года
    expect((await agent.call('tg_index', { chat: '@baraholka', since: '1y' })).text).toContain('covers this chat since 2025-10-01');
    expect((await agent.call('tg_index', { chat: '@baraholka', since: '9y' })).text).toContain('covers this chat since 2023-10-02');
    expect((await agent.call('tg_index', { chat: '@baraholka', since: 'давно' })).text).toContain('Use a relative period (30d, 12h, 2w, 6mo, 1y)');
  });

  it('страницы выдачи и поиск в одном чате', async () => {
    feed = Array.from({ length: 25 }, (_, i) => msg(300 - i, 1 + i * 0.1, `Продам стул номер ${i}`));
    await agent.call('tg_index', { chat: '@baraholka' });
    const first = await agent.call('tg_local_search', { query: 'стул', limit: 10 });
    expect(first.text).toContain('10 of 25 matches');
    const cursor = first.text.match(/next_cursor: (\S+)/)![1]!;
    const second = await agent.call('tg_local_search', { query: 'стул', limit: 10, cursor });
    expect(second.text).toContain('#290');
    expect(second.text).not.toContain('#291 ');
    expect((await agent.call('tg_local_search', { query: 'стол', cursor })).text).toContain('cursor belongs to another query');

    expect((await agent.call('tg_local_search', { query: 'стул', chat: '@baraholka', limit: 50 })).text).toContain('25 of 25 matches');
    const notIndexed = await agent.call('tg_local_search', { query: 'стул', chat: '@stonksnws' });
    expect(notIndexed.isError).toBe(true);
    expect(notIndexed.text).toContain('@stonksnws is not indexed');
  });

  it('доступ: общий аккаунт делит индекс, закрытый чат не ищется, удалить может только создатель', async () => {
    await agent.call('tg_index', { chat: '@baraholka' });
    const partner = await gw.client('partner', INDEX);
    // общий аккаунт agent: второй пользователь ищет по тому же индексу
    expect((await partner.call('tg_local_search', { query: 'велосипед', account: 'agent' })).text).toContain('3 of 3 matches');
    const denied = await partner.call('tg_index', { action: 'remove', chat: '@baraholka', account: 'agent' });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('was created by nick');

    // владелец закрыл чат первому пользователю: индекс для него пропадает из поиска и списка
    gw.storage.scopes.put({ userId: 'nick', accountId: 'agent', target: '-1000000000700', effect: 'deny' });
    expect((await agent.call('tg_local_search', { query: 'велосипед' })).text).toContain('Nothing is indexed yet');
    expect((await agent.call('tg_index', { action: 'list' })).text).toContain('Indexed chats: 0');
    expect((await partner.call('tg_local_search', { query: 'велосипед', account: 'agent' })).text).toContain('3 of 3 matches');
    await partner.close();
    expect((await nick.tools()).map(t => t.name)).not.toContain('tg_local_search');
  });

  it('удаление индекса и удаление аккаунта убирают текст из базы', async () => {
    await agent.call('tg_index', { chat: '@baraholka' });
    const count = (table: string) => Number((gw.storage.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    // по умолчанию 90 дней: семь сообщений, служебное не в счёт
    expect(count('indexed_messages')).toBe(7);
    expect(count('indexed_fts')).toBe(7);

    const removed = await agent.call('tg_index', { action: 'remove', chat: '@baraholka' });
    expect(removed.text).toContain('7 messages deleted from the gateway');
    expect(count('indexed_messages')).toBe(0);
    expect(count('indexed_fts')).toBe(0);
    expect((await agent.call('tg_index', { action: 'remove', chat: '@baraholka' })).text).toContain('is not indexed');

    await agent.call('tg_index', { chat: '@baraholka' });
    expect(count('indexed_fts')).toBe(7);
    removeAccount(gw.storage, 'agent');
    expect(count('indexed_messages')).toBe(0);
    expect(count('indexed_fts')).toBe(0);
    expect(count('indexed_chats')).toBe(0);
  });

  it('долгая индексация возвращает job_id; вторая задача на тот же чат не запускается', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const page = { messages: [msg(1, 1, 'Продам стол')], chats: [flea()], users: [] };
    gw.tg.on('messages.GetHistory', async () => {
      await gate;
      return page;
    });
    await agent.call('tg_resolve', { ref: '@baraholka' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = agent.call('tg_index', { chat: '@baraholka' });
      await vi.advanceTimersByTimeAsync(21_000);
      const started = await pending;
      expect(started.text).toContain('Indexing of @baraholka is running');
      const jobId = started.text.match(/job_id: (job_[0-9a-f]+)/)![1]!;

      const second = agent.call('tg_index', { chat: '@baraholka' });
      await vi.advanceTimersByTimeAsync(6_000);
      expect((await second).text).toContain(jobId);
      expect(gw.storage.jobs.list({ limit: 10 }).filter(j => j.kind === 'index')).toHaveLength(1);

      release();
      await vi.advanceTimersByTimeAsync(10);
      expect((await agent.call('tg_index', { job_id: jobId })).text).toContain('Indexed @baraholka: 1 messages');
    } finally {
      vi.useRealTimers();
    }
  });

  it('предел за запуск: большой чат индексируется за несколько запусков без дыр', async () => {
    feed = Array.from({ length: 450 }, (_, i) => msg(1000 - i, 1 + i * 0.05, `Объявление номер ${1000 - i}`));
    await agent.call('tg_resolve', { ref: '@baraholka' });
    const store = new IndexStore(gw.storage, () => clock);
    const service = new LocalIndexService({ storage: gw.storage, store, history: new HistoryService(gw.tg), now: () => clock, maxPerRun: 200 });
    const jobs = new JobManager({ storage: gw.storage, log: createLogger('test', { level: 'silent' }) });
    jobs.register('index', ctx => service.run(ctx));
    const run = async () => {
      const job = jobs.start({ userId: 'nick', accountId: 'agent', kind: 'index', params: { accountId: 'agent', chatKey: '-1000000000700', sinceTs: at(60) } });
      return (await jobs.waitFor(job.id, 'nick', 5_000)).result as { partial: boolean; messages: number; sinceTs: number };
    };

    const first = await run();
    expect(first).toMatchObject({ partial: true, messages: 200 });
    // покрытие честное: только до самого старого прочитанного сообщения
    expect(first.sinceTs).toBe(at(1 + 199 * 0.05));
    // следующие запуски сначала перечитывают свежую голову, потом идут дальше вглубь
    const second = await run();
    expect(second).toMatchObject({ partial: true, messages: 300 });
    let last = second;
    let runs = 2;
    while (last.partial && runs < 8) {
      last = await run();
      runs++;
    }
    expect(runs).toBe(4);
    expect(last).toMatchObject({ partial: false, messages: 450, sinceTs: at(60) });
    expect(store.get('agent', '-1000000000700')).toMatchObject({ newestId: 1000, oldestId: 551, messages: 450 });
    jobs.stop();
  });
});

describe('контракт всех наборов', () => {
  it('у каждого инструмента плоская схема, короткое описание и верная пометка чтения', async () => {
    const everything = await gw.client('nick', ['core', 'discover', 'analytics', 'index', 'write']);
    const tools = await everything.tools();
    await everything.close();
    expect(tools.map(t => t.name).sort()).toEqual([
      'tg_channel_stats',
      'tg_confirm',
      'tg_export',
      'tg_find_channels',
      'tg_forward_sources',
      'tg_get_comments',
      'tg_get_media',
      'tg_get_message',
      'tg_index',
      'tg_join',
      'tg_list_dialogs',
      'tg_list_topics',
      'tg_local_search',
      'tg_react',
      'tg_read_history',
      'tg_reply',
      'tg_resolve',
      'tg_search_chat',
      'tg_search_messages',
      'tg_send',
      'tg_similar_channels',
      'tg_status',
    ]);
    const writes = new Set(['tg_confirm', 'tg_join', 'tg_react', 'tg_reply', 'tg_send']);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(!writes.has(tool.name));
      const schema = JSON.stringify(tool.inputSchema);
      expect(schema, tool.name).not.toMatch(/anyOf|oneOf|allOf/);
      const props = (tool.inputSchema.properties ?? {}) as Record<string, { type?: string; items?: { type?: string } }>;
      for (const [name, prop] of Object.entries(props)) {
        expect(['string', 'number', 'integer', 'boolean', 'array'], `${tool.name}.${name}`).toContain(prop.type);
        if (prop.type === 'array') expect(['string', 'number', 'integer'], `${tool.name}.${name}`).toContain(prop.items?.type);
      }
      expect((tool.description ?? '').length, tool.name).toBeLessThan(520);
    }
    // шлюз только инструмент: ничего, что запускает агентов, следит за чатами или ведёт поручения
    expect(tools.map(t => t.name).filter(n => /watch|inbox|rule|task|runner/.test(n))).toEqual([]);
    expect(tools).toHaveLength(22);
  });
});
