import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    // запросы собраны настоящими классами GramJS и сериализуются
    for (const call of gw.tg.callsOf('messages.GetDialogs')) expect(() => call.request.getBytes()).not.toThrow();
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
    gw.storage.scopes.put({ userId: 'nick', accountId: 'agent', target: '-1000000000700', effect: 'deny', source: 'owner' });
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
    gw.storage.scopes.put({ userId: 'nick', accountId: 'agent', target: 'crypto_news', effect: 'deny', source: 'owner' });
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
