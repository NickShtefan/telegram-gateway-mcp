import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addUser } from '../../cli/admin.js';
import { GatewayError } from '../../core/errors.js';
import { SqliteStorage } from '../../storage/sqlite.js';
import { AccessPolicy } from '../access.js';
import { Audit } from '../audit.js';
import { readPrivateMode, ScopePolicy, writePrivateMode } from '../scopes.js';

let storage: SqliteStorage;
let access: AccessPolicy;
let scopes: ScopePolicy;
let nickToken: string;
let partnerToken: string;

beforeEach(() => {
  storage = new SqliteStorage({ path: ':memory:' });
  nickToken = addUser(storage, { id: 'nick', accounts: ['nick', 'agent'] }).token;
  partnerToken = addUser(storage, { id: 'partner', accounts: ['partner', 'agent'] }).token;
  access = new AccessPolicy(storage);
  scopes = new ScopePolicy(storage);
});

afterEach(() => storage.close());

describe('AccessPolicy', () => {
  it('токен определяет пользователя и его аккаунты', () => {
    expect(access.authenticate(nickToken)).toEqual({ userId: 'nick', defaultAccount: 'nick', accounts: ['agent', 'nick'] });
    expect(access.authenticate(partnerToken).userId).toBe('partner');
  });

  it('пустой, короткий и чужой токен дают одну ошибку', () => {
    for (const bad of [undefined, null, '', 'short', 'x'.repeat(43)]) {
      expect(() => access.authenticate(bad)).toThrow('Missing or invalid gateway token.');
    }
  });

  it('аккаунт: по умолчанию, запрошенный свой, общий и чужой', () => {
    const nick = access.authenticate(nickToken);
    expect(access.resolveAccount(nick)).toBe('nick');
    expect(access.resolveAccount(nick, 'agent')).toBe('agent');
    expect(() => access.resolveAccount(nick, 'partner')).toThrow(/not available to you/);
    // чужой и несуществующий неотличимы
    expect(() => access.resolveAccount(nick, 'ghost')).toThrow(/not available to you/);
    expect(access.isShared('agent')).toBe(true);
    expect(access.isShared('nick')).toBe(false);
  });

  it('без аккаунта по умолчанию просит указать account', () => {
    storage.users.update('nick', { defaultAccount: null });
    const nick = access.authenticate(nickToken);
    expect(() => access.resolveAccount(nick)).toThrow(/Specify the "account" argument/);
    addUser(storage, { id: 'empty' });
    expect(() => access.resolveAccount(access.principalOf('empty'))).toThrow(/No Telegram account is connected/);
  });
});

describe('ScopePolicy', () => {
  const channel = { peerKey: '-1000000000500', kind: 'channel' as const, username: 'News' };
  const seller = { peerKey: '42', kind: 'user' as const, username: 'seller' };

  it('каналы и группы открыты, личные чаты закрыты', () => {
    expect(scopes.isAllowed('nick', 'agent', channel)).toBe(true);
    expect(scopes.isAllowed('nick', 'agent', { peerKey: '-4321', kind: 'chat' })).toBe(true);
    const decision = scopes.decide('nick', 'agent', seller);
    expect(decision.allowed).toBe(false);
    expect(() => scopes.assertAllowed('nick', 'agent', seller)).toThrow(GatewayError);
  });

  it('служебные чаты закрыты всегда, даже правилом allow', () => {
    storage.scopes.put({ userId: 'nick', accountId: 'agent', target: '777000', effect: 'allow', source: 'owner' });
    expect(scopes.isAllowed('nick', 'agent', { peerKey: '777000', kind: 'user' })).toBe(false);
    expect(scopes.isAllowed('nick', 'agent', { peerKey: '999', kind: 'user', username: 'BotFather' })).toBe(false);
  });

  it('allow открывает один диалог одному пользователю на одном аккаунте', () => {
    storage.scopes.put({ userId: 'nick', accountId: 'agent', target: '@Seller', effect: 'allow', source: 'task:t1' });
    expect(scopes.isAllowed('nick', 'agent', seller)).toBe(true);
    expect(scopes.isAllowed('partner', 'agent', seller)).toBe(false);
    expect(scopes.isAllowed('nick', 'nick', seller)).toBe(false);
    expect(storage.scopes.removeBySource('task:t1')).toBe(1);
    expect(scopes.isAllowed('nick', 'agent', seller)).toBe(false);
  });

  it('deny сильнее allow', () => {
    storage.scopes.put({ userId: 'nick', accountId: 'agent', target: channel.peerKey, effect: 'deny', source: 'owner' });
    storage.scopes.put({ userId: 'nick', accountId: 'agent', target: 'news', effect: 'allow', source: 'task:t2' });
    expect(scopes.isAllowed('nick', 'agent', channel)).toBe(false);
    expect(storage.scopes.remove('nick', 'agent', channel.peerKey)).toBe(1);
    expect(scopes.isAllowed('nick', 'agent', channel)).toBe(true);
  });
});

describe('режим личных чатов', () => {
  const seller = { peerKey: '42', kind: 'user' as const, username: 'seller' };
  const stranger = { peerKey: '77', kind: 'user' as const, username: null };
  const channel = { peerKey: '-1000000000500', kind: 'channel' as const, username: 'News' };

  it('send: писать можно любому человеку, читать нельзя', () => {
    expect(scopes.privateMode('nick', 'agent')).toBe('closed');
    expect(scopes.isAllowed('nick', 'agent', stranger, 'write')).toBe(false);

    writePrivateMode(storage, 'nick', 'agent', 'send');
    expect(scopes.privateMode('nick', 'agent')).toBe('send');
    expect(scopes.isAllowed('nick', 'agent', stranger, 'write')).toBe(true);
    expect(scopes.isAllowed('nick', 'agent', stranger)).toBe(false);
    const decision = scopes.decide('nick', 'agent', stranger);
    expect(decision).toMatchObject({ allowed: false, code: 'private' });
    expect(decision.allowed === false && decision.reason).toContain('open for sending only');

    // чат, открытый правилом, читается и в режиме send
    storage.scopes.put({ userId: 'nick', accountId: 'agent', target: 'seller', effect: 'allow', source: 'owner' });
    expect(scopes.isAllowed('nick', 'agent', seller)).toBe(true);
    // каналам режим ничего не меняет
    expect(scopes.isAllowed('nick', 'agent', channel)).toBe(true);
  });

  it('open: читать и писать можно в любой личный чат', () => {
    writePrivateMode(storage, 'nick', 'agent', 'open');
    expect(scopes.isAllowed('nick', 'agent', stranger)).toBe(true);
    expect(scopes.isAllowed('nick', 'agent', stranger, 'write')).toBe(true);
  });

  it('служебные чаты и запрет владельца сильнее режима', () => {
    writePrivateMode(storage, 'nick', 'agent', 'open');
    storage.scopes.put({ userId: 'nick', accountId: 'agent', target: '42', effect: 'deny', source: 'owner' });
    for (const action of ['read', 'write'] as const) {
      expect(scopes.isAllowed('nick', 'agent', seller, action)).toBe(false);
      expect(scopes.isAllowed('nick', 'agent', { peerKey: '777000', kind: 'user' }, action)).toBe(false);
      expect(scopes.isAllowed('nick', 'agent', { peerKey: '999', kind: 'user', username: 'SpamBot' }, action)).toBe(false);
    }
  });

  it('режим свой у каждой пары пользователь и аккаунт; новый режим заменяет старый', () => {
    writePrivateMode(storage, 'nick', 'agent', 'open');
    expect(readPrivateMode(storage, 'partner', 'agent')).toBe('closed');
    expect(readPrivateMode(storage, 'nick', 'nick')).toBe('closed');
    expect(scopes.isAllowed('partner', 'agent', stranger, 'write')).toBe(false);

    writePrivateMode(storage, 'nick', 'agent', 'send');
    expect(readPrivateMode(storage, 'nick', 'agent')).toBe('send');
    expect(storage.scopes.list('nick', 'agent')).toHaveLength(1);
    expect(scopes.isAllowed('nick', 'agent', stranger)).toBe(false);

    writePrivateMode(storage, 'nick', 'agent', 'closed');
    expect(storage.scopes.list('nick', 'agent')).toHaveLength(0);
    expect(scopes.isAllowed('nick', 'agent', stranger, 'write')).toBe(false);
  });
});

describe('Audit', () => {
  it('пишет вызов с длительностью, кодом ошибки и без секретов', () => {
    let clock = 5_000;
    const audit = new Audit(storage, () => clock);
    clock = 5_250;
    audit.record({ userId: 'nick', accountId: 'agent', tool: 'tg_read_history', args: { chat: '@news', token: 'secret', cursor: undefined, long: 'x'.repeat(500) }, peerKey: '-1000000000500', resultCount: 20, startedAt: 5_000 });
    audit.record({ userId: 'nick', accountId: 'agent', tool: 'tg_resolve', args: {}, startedAt: 5_100, error: new GatewayError('FLOOD_WAIT', 'wait', { retryAfter: 30 }) });
    audit.record({ userId: null, accountId: null, tool: 'tg_status', args: {}, startedAt: 5_200, error: new Error('boom') });
    const [internal, flood, ok] = storage.audit.recent();
    expect(ok).toMatchObject({ tool: 'tg_read_history', durationMs: 250, resultCount: 20, errorCode: null, peerKey: '-1000000000500' });
    expect(ok!.args).toMatchObject({ chat: '@news', token: '[redacted]' });
    expect(String(ok!.args.long).length).toBe(201);
    expect(flood).toMatchObject({ errorCode: 'FLOOD_WAIT', floodWaitSeconds: 30 });
    expect(internal).toMatchObject({ errorCode: 'INTERNAL', userId: null });
  });
});
