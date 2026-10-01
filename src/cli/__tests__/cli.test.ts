import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TelegramClient } from 'teleproto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientFactory } from '../../core/clientPool.js';
import { loadConfig, type GatewayConfig } from '../../core/config.js';
import { sha256Hex, unseal } from '../../core/crypto.js';
import { acquireLock, isLockHeld, lockPath } from '../../core/lock.js';
import { SqliteStorage } from '../../storage/sqlite.js';
import { addUser, describeAccounts, grantAccount, removeAccount, revokeAccount, rotateToken } from '../admin.js';
import { collectChecks } from '../doctor.js';
import type { CliIo } from '../io.js';
import { runLogin } from '../login.js';
import { main } from '../main.js';

let home: string;
let config: GatewayConfig;
let storage: SqliteStorage;
let out: string[];
let err: string[];
let io: CliIo;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tgmcp-'));
  config = loadConfig({ TG_MCP_HOME: home, TG_API_ID: '1', TG_API_HASH: 'hash' });
  storage = new SqliteStorage({ path: ':memory:' });
  out = [];
  err = [];
  io = { out: l => out.push(l), err: l => err.push(l), prompt: vi.fn(async () => '') };
});

afterEach(() => {
  storage.close();
  rmSync(home, { recursive: true, force: true });
});

function fakeFactory(overrides: Record<string, unknown> = {}): ClientFactory {
  return () =>
    ({
      connect: vi.fn(async () => true),
      start: vi.fn(async () => undefined),
      getMe: vi.fn(async () => ({ id: 555n, username: 'agent_acc', firstName: 'Agent' })),
      destroy: vi.fn(async () => undefined),
      session: { save: () => 'SESSION_FROM_LOGIN' },
      ...overrides,
    }) as unknown as TelegramClient;
}

describe('admin', () => {
  it('создаёт пользователя с токеном, в базе только хэш', () => {
    const { user, token } = addUser(storage, { id: 'nick', accounts: ['nick', 'agent'] });
    expect(user.defaultAccount).toBe('nick');
    expect(storage.users.findByTokenHash(sha256Hex(token))?.id).toBe('nick');
    expect(storage.accounts.hasAccess('nick', 'agent')).toBe(true);
    expect(() => addUser(storage, { id: 'nick' })).toThrow(/already exists/);
    expect(() => addUser(storage, { id: 'Bad Id' })).toThrow(/Invalid user id/);
  });

  it('новый токен отменяет старый', () => {
    const { token } = addUser(storage, { id: 'nick' });
    const next = rotateToken(storage, 'nick');
    expect(storage.users.findByTokenHash(sha256Hex(token))).toBeNull();
    expect(storage.users.findByTokenHash(sha256Hex(next))?.id).toBe('nick');
  });

  it('общий аккаунт виден как shared, отзыв доступа меняет аккаунт по умолчанию', () => {
    addUser(storage, { id: 'nick', accounts: ['agent'] });
    addUser(storage, { id: 'partner', accounts: ['partner'] });
    grantAccount(storage, 'agent', 'partner');
    expect(describeAccounts(storage).find(a => a.id === 'agent')).toMatchObject({ shared: true, users: ['nick', 'partner'] });
    revokeAccount(storage, 'agent', 'nick');
    expect(storage.users.get('nick')?.defaultAccount).toBeNull();
    removeAccount(storage, 'partner');
    expect(storage.users.get('partner')?.defaultAccount).toBe('agent');
  });
});

describe('login', () => {
  it('сохраняет зашифрованную сессию и данные аккаунта', async () => {
    io.prompt = vi.fn(async (q: string) => (q.startsWith('Phone') ? '+79991234567' : '12345'));
    await runLogin({ config, storage, io, account: 'agent', factory: fakeFactory(), sessionSecret: 'secret' });
    expect(storage.accounts.get('agent')).toMatchObject({ status: 'active', username: 'agent_acc', tgUserId: '555' });
    const sealed = storage.sessions.get('agent')!;
    expect(sealed.data).not.toContain('SESSION_FROM_LOGIN');
    expect(unseal(sealed, 'secret')).toBe('SESSION_FROM_LOGIN');
    expect(out.join('\n')).toContain('logged in as @agent_acc');
    expect(out.join('\n')).not.toContain('SESSION_FROM_LOGIN');
    expect(out.join('\n')).toContain('tg-mcp account grant agent <user>');
  });

  it('без учётных данных API не начинает вход', async () => {
    const bare = loadConfig({ TG_MCP_HOME: home });
    await expect(runLogin({ config: bare, storage, io, account: 'agent', factory: fakeFactory() })).rejects.toThrow(/TG_API_ID/);
  });
});

describe('doctor', () => {
  it('пустая установка: предупреждения без ошибок', async () => {
    const checks = await collectChecks({ config, storage, io, nodeVersion: 'v22.22.0' });
    expect(checks.filter(c => c.level === 'fail')).toEqual([]);
    expect(checks.map(c => c.message).join('\n')).toContain('no gateway users');
  });

  it('снятый набор automate в настройках: предупреждение, а не падение', async () => {
    const before = process.env.TG_MCP_TOOLSETS;
    process.env.TG_MCP_TOOLSETS = 'core,automate,write';
    try {
      const checks = await collectChecks({ config, storage, io });
      expect(checks.some(c => c.level === 'warn' && c.message.includes('"automate" no longer exists'))).toBe(true);
    } finally {
      if (before === undefined) delete process.env.TG_MCP_TOOLSETS;
      else process.env.TG_MCP_TOOLSETS = before;
    }
  });

  it('старый Node и аккаунт без сессии это ошибки', async () => {
    storage.accounts.upsert({ id: 'agent' });
    const checks = await collectChecks({ config, storage, io, nodeVersion: 'v20.11.0' });
    const failed = checks.filter(c => c.level === 'fail').map(c => c.message);
    expect(failed.some(m => m.startsWith('Node.js v20.11.0'))).toBe(true);
    expect(failed.some(m => m.includes('account agent: no session'))).toBe(true);
  });

  it('--connect подключает аккаунты, когда демон не запущен', async () => {
    io.prompt = vi.fn(async () => '1');
    await runLogin({ config, storage, io, account: 'agent', phone: '+79991234567', factory: fakeFactory() });
    addUser(storage, { id: 'nick', accounts: ['agent'] });
    const checks = await collectChecks({ config, storage, io, connect: true, factory: fakeFactory() });
    expect(checks.some(c => c.level === 'ok' && c.message.startsWith('account agent connects: @agent_acc'))).toBe(true);
  });

  it('--connect не открывает сессии, пока демон держит блокировку', async () => {
    const lock = await acquireLock(home);
    try {
      const factory = vi.fn(fakeFactory());
      const checks = await collectChecks({ config, storage, io, connect: true, factory });
      expect(checks.some(c => c.level === 'warn' && c.message.includes('skipping --connect'))).toBe(true);
      expect(factory).not.toHaveBeenCalled();
    } finally {
      await lock.release();
    }
  });
});

describe('lock', () => {
  it('второй процесс не получает блокировку, после release она свободна', async () => {
    expect(await isLockHeld(home)).toBe(false);
    const lock = await acquireLock(home);
    expect(await isLockHeld(home)).toBe(true);
    await expect(acquireLock(home)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await lock.release();
    expect(await isLockHeld(home)).toBe(false);
    const again = await acquireLock(home);
    await again.release();
  });
});

describe('lock: гонки и мусор', () => {
  it('из двух одновременных стартов блокировку получает один', async () => {
    const results = await Promise.allSettled([acquireLock(home), acquireLock(home), acquireLock(home)]);
    const won = results.filter(r => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    for (const lost of results.filter(r => r.status === 'rejected')) {
      expect((lost as PromiseRejectedResult).reason).toMatchObject({ code: 'UNAVAILABLE' });
    }
    await (won[0] as PromiseFulfilledResult<{ release(): Promise<void> }>).value.release();
  });

  it('сокет умершего процесса занимается заново', async () => {
    // сервер закрыт без удаления файла: так выглядит сокет после kill -9
    const dead = createServer();
    await new Promise<void>(resolve => dead.listen(lockPath(home), resolve));
    const handle = (dead as unknown as { _handle: { close(): void } })._handle;
    handle.close();
    expect(await isLockHeld(home)).toBe(false);
    const lock = await acquireLock(home);
    expect(await isLockHeld(home)).toBe(true);
    await lock.release();
  });

  it('слишком длинный путь к папке шлюза даёт понятную ошибку, а не EINVAL', async () => {
    const deep = join(home, 'a'.repeat(60), 'b'.repeat(60));
    expect(await isLockHeld(deep)).toBe(false);
    await expect(acquireLock(deep)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('Set TG_MCP_HOME to a shorter path') });
  });

  it('обычный файл на месте сокета не считается живым процессом', async () => {
    writeFileSync(lockPath(home), 'stale');
    const lock = await acquireLock(home);
    await lock.release();
  });

  it('doctor --connect держит блокировку, пока открыты сессии', async () => {
    io.prompt = vi.fn(async () => '1');
    await runLogin({ config, storage, io, account: 'agent', phone: '+79991234567', factory: fakeFactory() });
    let heldDuringConnect = false;
    const base = fakeFactory();
    const factory: ClientFactory = options => {
      const client = base(options);
      const connect = client.connect.bind(client);
      client.connect = (async () => {
        heldDuringConnect = await isLockHeld(home);
        return connect();
      }) as typeof client.connect;
      return client;
    };
    await collectChecks({ config, storage, io, connect: true, factory });
    expect(heldDuringConnect).toBe(true);
    expect(await isLockHeld(home)).toBe(false);
  });
});

describe('main', () => {
  it('команды runner больше нет: шлюз агентов не запускает', async () => {
    expect(await main(['runner', '--agent', 'claude -p {prompt}'], { io, config, storage })).not.toBe(0);
    expect(await main(['help'], { io, config, storage })).toBe(0);
    expect(out.join('\n')).not.toContain('runner');
  });

  it('help и неизвестная команда', async () => {
    expect(await main(['help'], { io, config, storage })).toBe(0);
    expect(out.join('\n')).toContain('tg-mcp login --account');
    expect(await main(['frobnicate'], { io, config, storage })).toBe(1);
    expect(err.join('\n')).toContain('Unknown command');
  });

  it('user add печатает токен один раз, user list его не показывает', async () => {
    expect(await main(['user', 'add', 'nick', '--account', 'agent'], { io, config, storage })).toBe(0);
    const token = out[out.length - 1]!;
    expect(storage.users.findByTokenHash(sha256Hex(token))?.id).toBe('nick');
    out.length = 0;
    expect(await main(['user', 'list'], { io, config, storage })).toBe(0);
    expect(out.join('\n')).toContain('nick  accounts: [agent]');
    expect(out.join('\n')).not.toContain(token);
  });

  it('account grant и list', async () => {
    await main(['user', 'add', 'nick'], { io, config, storage });
    await main(['user', 'add', 'partner'], { io, config, storage });
    expect(await main(['account', 'grant', 'agent', 'nick'], { io, config, storage })).toBe(0);
    expect(await main(['account', 'grant', 'agent', 'partner'], { io, config, storage })).toBe(0);
    out.length = 0;
    await main(['account', 'list'], { io, config, storage });
    expect(out.join('\n')).toContain('agent  no session  -  users: [nick, partner]  shared');
    expect(await main(['account', 'grant', 'agent', 'ghost'], { io, config, storage })).toBe(1);
  });

  it('scope: владелец открывает личный чат и закрывает канал', async () => {
    await main(['user', 'add', 'nick', '--account', 'agent'], { io, config, storage });
    out.length = 0;
    expect(await main(['scope', 'allow', 'nick', 'agent', '@Seller'], { io, config, storage })).toBe(0);
    expect(await main(['scope', 'deny', 'nick', 'agent', '-1001782171896'], { io, config, storage })).toBe(0);
    expect(await main(['scope', 'list', 'nick', 'agent'], { io, config, storage })).toBe(0);
    expect(out.join('\n')).toContain('allow  @seller  (owner)');
    expect(out.join('\n')).toContain('deny  -1001782171896  (owner)');
    expect(await main(['scope', 'remove', 'nick', 'agent', 't.me/seller'], { io, config, storage })).toBe(0);
    expect(storage.scopes.list('nick', 'agent')).toHaveLength(1);
    // чужой аккаунт и инвайт не принимаются
    expect(await main(['scope', 'allow', 'nick', 'other', '@x_user'], { io, config, storage })).toBe(1);
    expect(await main(['scope', 'allow', 'nick', 'agent', 't.me/+AbCdEf'], { io, config, storage })).toBe(1);
  });
});
