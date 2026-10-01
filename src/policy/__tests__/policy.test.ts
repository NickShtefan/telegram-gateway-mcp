import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addUser } from '../../cli/admin.js';
import { GatewayError } from '../../core/errors.js';
import { SqliteStorage } from '../../storage/sqlite.js';
import { AccessPolicy } from '../access.js';
import { Audit } from '../audit.js';
import { ScopePolicy } from '../scopes.js';

let storage: SqliteStorage;
let access: AccessPolicy;
let scopes: ScopePolicy;
let nickToken: string;
let partnerToken: string;

beforeEach(() => {
  storage = new SqliteStorage({ path: ':memory:' });
  nickToken = addUser(storage, { id: 'nick', telegramId: '111', accounts: ['nick', 'agent'] }).token;
  partnerToken = addUser(storage, { id: 'partner', accounts: ['partner', 'agent'] }).token;
  access = new AccessPolicy(storage);
  scopes = new ScopePolicy(storage);
});

afterEach(() => storage.close());

describe('AccessPolicy', () => {
  it('токен определяет пользователя и его аккаунты', () => {
    expect(access.authenticate(nickToken)).toEqual({ userId: 'nick', telegramId: '111', defaultAccount: 'nick', accounts: ['agent', 'nick'] });
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
