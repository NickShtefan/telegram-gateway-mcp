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
  it('resolves the user and account grants from the token', () => {
    expect(access.authenticate(nickToken)).toEqual({ userId: 'nick', defaultAccount: 'nick', accounts: ['agent', 'nick'] });
    expect(access.authenticate(partnerToken).userId).toBe('partner');
  });

  it('returns the same error for empty, short, and invalid tokens', () => {
    for (const bad of [undefined, null, '', 'short', 'x'.repeat(43)]) {
      expect(() => access.authenticate(bad)).toThrow('Missing or invalid gateway token.');
    }
  });

  it('handles default, requested, shared, and inaccessible accounts', () => {
    const nick = access.authenticate(nickToken);
    expect(access.resolveAccount(nick)).toBe('nick');
    expect(access.resolveAccount(nick, 'agent')).toBe('agent');
    expect(() => access.resolveAccount(nick, 'partner')).toThrow(/not available to you/);
    // Inaccessible and nonexistent accounts are indistinguishable.
    expect(() => access.resolveAccount(nick, 'ghost')).toThrow(/not available to you/);
    expect(access.isShared('agent')).toBe(true);
    expect(access.isShared('nick')).toBe(false);
  });

  it('asks for account when no default is configured', () => {
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

  it('opens channels/groups and closes private chats by default', () => {
    expect(scopes.isAllowed('nick', 'agent', channel)).toBe(true);
    expect(scopes.isAllowed('nick', 'agent', { peerKey: '-4321', kind: 'chat' })).toBe(true);
    const decision = scopes.decide('nick', 'agent', seller);
    expect(decision.allowed).toBe(false);
    expect(() => scopes.assertAllowed('nick', 'agent', seller)).toThrow(GatewayError);
  });

  it('always closes service chats, even with an allow rule', () => {
    storage.scopes.put({ userId: 'nick', accountId: 'agent', target: '777000', effect: 'allow' });
    expect(scopes.isAllowed('nick', 'agent', { peerKey: '777000', kind: 'user' })).toBe(false);
    expect(scopes.isAllowed('nick', 'agent', { peerKey: '999', kind: 'user', username: 'BotFather' })).toBe(false);
  });

  it('allow opens one dialog for one user/account', () => {
    storage.scopes.put({ userId: 'nick', accountId: 'agent', target: '@Seller', effect: 'allow' });
    expect(scopes.isAllowed('nick', 'agent', seller)).toBe(true);
    expect(scopes.isAllowed('partner', 'agent', seller)).toBe(false);
    expect(scopes.isAllowed('nick', 'nick', seller)).toBe(false);
    expect(storage.scopes.remove('nick', 'agent', 'seller')).toBe(1);
    expect(scopes.isAllowed('nick', 'agent', seller)).toBe(false);
  });

  it('deny overrides allow', () => {
    storage.scopes.put({ userId: 'nick', accountId: 'agent', target: channel.peerKey, effect: 'deny' });
    // ID and username rules refer to the same chat.
    storage.scopes.put({ userId: 'nick', accountId: 'agent', target: 'news', effect: 'allow' });
    expect(scopes.isAllowed('nick', 'agent', channel)).toBe(false);
    expect(storage.scopes.remove('nick', 'agent', channel.peerKey)).toBe(1);
    expect(scopes.isAllowed('nick', 'agent', channel)).toBe(true);
  });
});

describe('private-chat modes', () => {
  const seller = { peerKey: '42', kind: 'user' as const, username: 'seller' };
  const stranger = { peerKey: '77', kind: 'user' as const, username: null };
  const channel = { peerKey: '-1000000000500', kind: 'channel' as const, username: 'News' };

  it('send: allows sending to anyone without reading', () => {
    expect(scopes.privateMode('nick', 'agent')).toBe('closed');
    expect(scopes.isAllowed('nick', 'agent', stranger, 'write')).toBe(false);

    writePrivateMode(storage, 'nick', 'agent', 'send');
    expect(scopes.privateMode('nick', 'agent')).toBe('send');
    expect(scopes.isAllowed('nick', 'agent', stranger, 'write')).toBe(true);
    expect(scopes.isAllowed('nick', 'agent', stranger)).toBe(false);
    const decision = scopes.decide('nick', 'agent', stranger);
    expect(decision).toMatchObject({ allowed: false, code: 'private' });
    expect(decision.allowed === false && decision.reason).toContain('open for sending only');

    // Individually allowed chats remain readable in send mode.
    storage.scopes.put({ userId: 'nick', accountId: 'agent', target: 'seller', effect: 'allow' });
    expect(scopes.isAllowed('nick', 'agent', seller)).toBe(true);
    // Channel access is unaffected.
    expect(scopes.isAllowed('nick', 'agent', channel)).toBe(true);
  });

  it('open: allows reading and writing any private chat', () => {
    writePrivateMode(storage, 'nick', 'agent', 'open');
    expect(scopes.isAllowed('nick', 'agent', stranger)).toBe(true);
    expect(scopes.isAllowed('nick', 'agent', stranger, 'write')).toBe(true);
  });

  it('service chats and owner denial override the mode', () => {
    writePrivateMode(storage, 'nick', 'agent', 'open');
    storage.scopes.put({ userId: 'nick', accountId: 'agent', target: '42', effect: 'deny' });
    for (const action of ['read', 'write'] as const) {
      expect(scopes.isAllowed('nick', 'agent', seller, action)).toBe(false);
      expect(scopes.isAllowed('nick', 'agent', { peerKey: '777000', kind: 'user' }, action)).toBe(false);
      expect(scopes.isAllowed('nick', 'agent', { peerKey: '999', kind: 'user', username: 'SpamBot' }, action)).toBe(false);
    }
  });

  it('modes belong to each user/account pair and replace previous modes', () => {
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
  it('audits duration and error codes without secrets', () => {
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
