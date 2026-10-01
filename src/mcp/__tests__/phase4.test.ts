import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestGateway, type TestClient, type TestGateway } from '../../__tests__/helpers/gateway.js';
import { rawChannel, rawUser } from '../../__tests__/helpers/fakeTg.js';

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
