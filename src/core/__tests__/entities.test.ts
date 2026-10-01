import { describe, expect, it } from 'vitest';
import { entityFromApi, harvestEntities, peerKeyOfPeer, toInputChannel, toInputPeer, toInputUser } from '../entities.js';

describe('entityFromApi', () => {
  it('канал: ключ в форме -100, флаги и активный username', () => {
    const info = entityFromApi({
      className: 'Channel',
      id: 1782171896n,
      accessHash: 555n,
      title: 'Stonks',
      usernames: [{ username: 'old', active: false }, { username: 'stonksnws', active: true }],
      broadcast: true,
      forum: false,
      left: true,
    });
    expect(info).toMatchObject({
      peerKey: '-1001782171896',
      kind: 'channel',
      accessHash: '555',
      username: 'stonksnws',
      title: 'Stonks',
      meta: { broadcast: true, megagroup: false, forum: false, member: false },
    });
  });

  it('min-объект не отдаёт accessHash в кэш', () => {
    expect(entityFromApi({ className: 'User', id: 7, accessHash: 99n, min: true, firstName: 'A' })).toMatchObject({
      accessHash: null,
      meta: {},
    });
  });

  it('пользователь и обычная группа', () => {
    expect(entityFromApi({ className: 'User', id: 42, accessHash: '9', username: 'seller', firstName: 'Ivan', lastName: 'P', bot: false })).toMatchObject({
      peerKey: '42',
      kind: 'user',
      accessHash: '9',
      username: 'seller',
      title: 'Ivan P',
    });
    expect(entityFromApi({ className: 'Chat', id: 4321, title: 'Flat' })).toMatchObject({ peerKey: '-4321', kind: 'chat', accessHash: null });
  });

  it('чужие объекты игнорируются', () => {
    expect(entityFromApi({ className: 'Message', id: 1 })).toBeNull();
    expect(entityFromApi(null)).toBeNull();
    expect(entityFromApi({ className: 'User', id: 0 })).toBeNull();
  });
});

describe('harvestEntities и peerKeyOfPeer', () => {
  it('собирает users и chats из ответа', () => {
    const found = harvestEntities({
      messages: [{ className: 'Message', id: 1 }],
      users: [{ className: 'User', id: 1, accessHash: 1n }, { className: 'UserEmpty', id: 2 }],
      chats: [{ className: 'Channel', id: 5, accessHash: 2n, title: 'c' }],
    });
    expect(found.map(e => e.peerKey)).toEqual(['1', '-1000000000005']);
    expect(harvestEntities(undefined)).toEqual([]);
  });

  it('peer сообщения превращается в ключ', () => {
    expect(peerKeyOfPeer({ className: 'PeerChannel', channelId: 5n })).toBe('-1000000000005');
    expect(peerKeyOfPeer({ className: 'PeerUser', userId: 42 })).toBe('42');
    expect(peerKeyOfPeer({ className: 'PeerChat', chatId: 9 })).toBe('-9');
    expect(peerKeyOfPeer(null)).toBeNull();
  });
});

describe('InputPeer из кэша', () => {
  it('строит InputPeer по типу чата', () => {
    const channel = toInputPeer({ peerKey: '-1000000000005', accessHash: '77' });
    expect(channel.className).toBe('InputPeerChannel');
    expect(String((channel as { channelId: unknown }).channelId)).toBe('5');
    expect(String((channel as { accessHash: unknown }).accessHash)).toBe('77');
    expect(toInputPeer({ peerKey: '-9', accessHash: null }).className).toBe('InputPeerChat');
    expect(toInputPeer({ peerKey: '42', accessHash: '1' }).className).toBe('InputPeerUser');
    expect(toInputChannel({ peerKey: '-1000000000005', accessHash: '77' }).className).toBe('InputChannel');
    expect(toInputUser({ peerKey: '42', accessHash: '1' }).className).toBe('InputUser');
  });

  it('без accessHash объясняет, что чат надо сначала найти', () => {
    expect(() => toInputPeer({ peerKey: '-1000000000005', accessHash: null })).toThrow(/tg_resolve/);
    expect(() => toInputChannel({ peerKey: '42', accessHash: '1' })).toThrow(/not a channel/);
  });
});
