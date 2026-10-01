import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seal, sha256Hex, unseal } from '../../core/crypto.js';
import { MIGRATIONS } from '../migrations.js';
import { SqliteStorage } from '../sqlite.js';

let clock = 1_000;
let storage: SqliteStorage;

beforeEach(() => {
  clock = 1_000;
  storage = new SqliteStorage({ path: ':memory:', now: () => clock });
});

afterEach(() => {
  storage.close();
});

describe('SqliteStorage: схема', () => {
  it('применяет все миграции', () => {
    expect(storage.schemaVersion()).toBe(MIGRATIONS.length);
  });

  it('FTS5 доступен в node:sqlite', () => {
    storage.db.exec('CREATE VIRTUAL TABLE fts_probe USING fts5(body)');
    storage.db.prepare('INSERT INTO fts_probe (body) VALUES (?)').run('продам велосипед недорого');
    const rows = storage.db.prepare("SELECT body FROM fts_probe WHERE fts_probe MATCH 'велосипед'").all();
    expect(rows).toHaveLength(1);
  });
});

describe('SqliteStorage: пользователи и аккаунты', () => {
  it('находит пользователя по хэшу токена, сам токен не хранит', () => {
    const token = 'user-token';
    storage.users.create({ id: 'nick', tokenSha256: sha256Hex(token), telegramId: '111' });
    expect(storage.users.findByTokenHash(sha256Hex(token))?.id).toBe('nick');
    expect(storage.users.findByTokenHash(sha256Hex('other'))).toBeNull();
    expect(JSON.stringify(storage.users.list())).not.toContain(token);
  });

  it('два пользователя с одним токеном невозможны', () => {
    storage.users.create({ id: 'a', tokenSha256: 'h' });
    expect(() => storage.users.create({ id: 'b', tokenSha256: 'h' })).toThrow();
  });

  it('доступ: свой аккаунт, чужой и общий', () => {
    storage.users.create({ id: 'nick', tokenSha256: 'h1' });
    storage.users.create({ id: 'partner', tokenSha256: 'h2' });
    for (const id of ['nick', 'partner', 'agent']) storage.accounts.upsert({ id });
    storage.accounts.grant('nick', 'nick');
    storage.accounts.grant('partner', 'partner');
    storage.accounts.grant('agent', 'nick');
    storage.accounts.grant('agent', 'partner');
    storage.accounts.grant('agent', 'partner'); // повтор не ломает

    expect(storage.accounts.hasAccess('nick', 'nick')).toBe(true);
    expect(storage.accounts.hasAccess('nick', 'partner')).toBe(false);
    expect(storage.accounts.hasAccess('partner', 'agent')).toBe(true);
    expect(storage.accounts.accountsOf('partner').map(a => a.id)).toEqual(['agent', 'partner']);
    expect(storage.accounts.usersOf('agent')).toEqual(['nick', 'partner']);

    storage.accounts.revoke('agent', 'partner');
    expect(storage.accounts.hasAccess('partner', 'agent')).toBe(false);
  });

  it('upsert аккаунта обновляет только переданные поля', () => {
    storage.accounts.upsert({ id: 'agent', username: 'agent_bot_like', status: 'active' });
    clock = 2_000;
    const updated = storage.accounts.upsert({ id: 'agent', tgUserId: '42' });
    expect(updated).toMatchObject({ username: 'agent_bot_like', tgUserId: '42', status: 'active', createdAt: 1_000, updatedAt: 2_000 });
  });

  it('удаление аккаунта убирает сессию, доступ и кэш сущностей', () => {
    storage.users.create({ id: 'nick', tokenSha256: 'h1' });
    storage.accounts.upsert({ id: 'agent' });
    storage.accounts.grant('agent', 'nick');
    storage.sessions.put('agent', seal('session', 'k'));
    storage.entities.put({ accountId: 'agent', peerKey: '-1001', kind: 'channel', accessHash: '9', username: 'chan', title: 'Chan', meta: {} });
    storage.accounts.remove('agent');
    expect(storage.sessions.get('agent')).toBeNull();
    expect(storage.entities.count('agent')).toBe(0);
    expect(storage.accounts.accountsOf('nick')).toEqual([]);
  });
});

describe('SqliteStorage: сессии', () => {
  it('хранит сессию только в зашифрованном виде', () => {
    storage.accounts.upsert({ id: 'agent' });
    storage.sessions.put('agent', seal('1BQA-plain-session', 'key'));
    const raw = JSON.stringify(storage.db.prepare('SELECT * FROM sessions').all());
    expect(raw).not.toContain('1BQA-plain-session');
    expect(unseal(storage.sessions.get('agent')!, 'key')).toBe('1BQA-plain-session');
    storage.sessions.put('agent', seal('second', 'key'));
    expect(unseal(storage.sessions.get('agent')!, 'key')).toBe('second');
  });
});

describe('SqliteStorage: кэш сущностей', () => {
  beforeEach(() => {
    storage.accounts.upsert({ id: 'a1' });
    storage.accounts.upsert({ id: 'a2' });
  });

  it('accessHash хранится отдельно для каждого аккаунта', () => {
    storage.entities.put({ accountId: 'a1', peerKey: '-1005', kind: 'channel', accessHash: '111', username: 'News', title: 'News', meta: {} });
    storage.entities.put({ accountId: 'a2', peerKey: '-1005', kind: 'channel', accessHash: '222', username: 'News', title: 'News', meta: {} });
    expect(storage.entities.get('a1', '-1005')?.accessHash).toBe('111');
    expect(storage.entities.get('a2', '-1005')?.accessHash).toBe('222');
    expect(storage.entities.getByUsername('a1', '@NEWS')?.peerKey).toBe('-1005');
  });

  it('неполный объект не затирает accessHash и meta', () => {
    storage.entities.put({ accountId: 'a1', peerKey: '77', kind: 'user', accessHash: '555', username: 'seller', title: 'Seller', meta: { bot: false } });
    storage.entities.put({ accountId: 'a1', peerKey: '77', kind: 'user', accessHash: null, username: null, title: 'Seller New', meta: {} });
    expect(storage.entities.get('a1', '77')).toMatchObject({ accessHash: '555', username: 'seller', title: 'Seller New', meta: { bot: false } });
  });

  it('username, перешедший к другому чату, у прежнего убирается', () => {
    storage.entities.put({ accountId: 'a1', peerKey: '-1005', kind: 'channel', accessHash: '1', username: 'shop', title: 'Old shop', meta: { broadcast: true } });
    storage.entities.put({ accountId: 'a2', peerKey: '-1005', kind: 'channel', accessHash: '2', username: 'shop', title: 'Old shop', meta: { broadcast: true } });
    storage.entities.put({ accountId: 'a1', peerKey: '-1009', kind: 'channel', accessHash: '3', username: 'Shop', title: 'New shop', meta: { broadcast: true } });
    expect(storage.entities.getByUsername('a1', 'shop')?.peerKey).toBe('-1009');
    expect(storage.entities.get('a1', '-1005')?.username).toBeNull();
    // кэш другого аккаунта не трогаем: он узнает о смене сам
    expect(storage.entities.get('a2', '-1005')?.username).toBe('shop');
  });

  it('полный объект без username снимает имя, неполный его не трогает', () => {
    storage.entities.put({ accountId: 'a1', peerKey: '-1005', kind: 'channel', accessHash: '1', username: 'shop', title: 'Shop', meta: { broadcast: true } });
    storage.entities.put({ accountId: 'a1', peerKey: '-1005', kind: 'channel', accessHash: null, username: null, title: 'Shop', meta: {} });
    expect(storage.entities.get('a1', '-1005')?.username).toBe('shop');
    storage.entities.put({ accountId: 'a1', peerKey: '-1005', kind: 'channel', accessHash: '1', username: null, title: 'Shop', meta: { broadcast: true } });
    expect(storage.entities.get('a1', '-1005')?.username).toBeNull();
    expect(storage.entities.getByUsername('a1', 'shop')).toBeNull();
  });

  it('putMany пишет пачкой', () => {
    storage.entities.putMany(
      Array.from({ length: 50 }, (_, i) => ({ accountId: 'a1', peerKey: String(i + 1), kind: 'user' as const, accessHash: String(i), username: null, title: null, meta: {} })),
    );
    expect(storage.entities.count('a1')).toBe(50);
  });
});

describe('SqliteStorage: аудит, задачи, kv, транзакции', () => {
  it('аудит фильтруется по пользователю и чистится по времени', () => {
    const base = { accountId: 'agent', args: { chat: '@x' }, peerKey: '-1001', resultCount: 3, durationMs: 12, errorCode: null, floodWaitSeconds: null };
    storage.audit.add({ ...base, ts: 100, userId: 'nick', tool: 'tg_read_history' });
    storage.audit.add({ ...base, ts: 200, userId: 'partner', tool: 'tg_resolve', errorCode: 'FLOOD_WAIT', floodWaitSeconds: 30 });
    expect(storage.audit.recent({ userId: 'nick' }).map(e => e.tool)).toEqual(['tg_read_history']);
    expect(storage.audit.recent()[0]).toMatchObject({ tool: 'tg_resolve', errorCode: 'FLOOD_WAIT', floodWaitSeconds: 30, args: { chat: '@x' } });
    expect(storage.audit.prune(150)).toBe(1);
    expect(storage.audit.recent()).toHaveLength(1);
  });

  it('задача проходит состояния и возвращается в очередь после рестарта', () => {
    storage.jobs.create({ id: 'j1', userId: 'nick', accountId: 'agent', kind: 'export', params: { chat: '-1001' } });
    storage.jobs.update('j1', { state: 'running', progress: { done: 100, total: 400 } });
    expect(storage.jobs.get('j1')).toMatchObject({ state: 'running', progress: { done: 100, total: 400 }, result: null });
    expect(storage.jobs.requeueRunning()).toBe(1);
    expect(storage.jobs.get('j1')?.state).toBe('queued');
    storage.jobs.update('j1', { state: 'done', result: { path: '/tmp/x.jsonl', rows: 400 } });
    expect(storage.jobs.list({ userId: 'nick', state: 'done' })).toHaveLength(1);
    expect(storage.jobs.list({ userId: 'partner' })).toHaveLength(0);
  });

  it('очередь задач читается от старых к новым', () => {
    for (let i = 1; i <= 60; i++) {
      clock += 10;
      storage.jobs.create({ id: `job_${i}`, userId: 'nick', kind: 'export', params: {} });
    }
    expect(storage.jobs.list({ state: 'queued', limit: 1, oldestFirst: true })[0]!.id).toBe('job_1');
    expect(storage.jobs.list({ state: 'queued', limit: 1 })[0]!.id).toBe('job_60');
  });

  it('повторный close не падает', () => {
    const other = new SqliteStorage({ path: ':memory:' });
    other.close();
    expect(() => other.close()).not.toThrow();
  });

  it('kv хранит и перезаписывает значения', () => {
    expect(storage.kv.get('k')).toBeNull();
    storage.kv.set('k', '1');
    storage.kv.set('k', '2');
    expect(storage.kv.get('k')).toBe('2');
    storage.kv.remove('k');
    expect(storage.kv.get('k')).toBeNull();
  });

  it('транзакция откатывается при ошибке', () => {
    expect(() =>
      storage.transaction(() => {
        storage.kv.set('tx', 'value');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(storage.kv.get('tx')).toBeNull();
    storage.transaction(() => storage.transaction(() => storage.kv.set('nested', 'ok')));
    expect(storage.kv.get('nested')).toBe('ok');
  });
});
