import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TelegramClient } from 'teleproto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loginAccount, normalizePhone } from '../auth.js';
import { ClientPool, type ClientFactory } from '../clientPool.js';
import { loadConfig, loadSessionSecret, parseToolsets, requireApiCredentials } from '../config.js';
import { seal } from '../crypto.js';
import { AccountLimiter } from '../limiter.js';
import { createLogger } from '../log.js';
import { TgGateway } from '../tg.js';
import { SqliteStorage } from '../../storage/sqlite.js';

const silent = createLogger('test', { level: 'silent' });
const SECRET = 'test-secret';

interface FakeClient {
  connect: ReturnType<typeof vi.fn>;
  getMe: ReturnType<typeof vi.fn>;
  invoke: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  session: { save: () => string };
  sessionGiven: string;
}

function makeFactory(setup: (client: FakeClient) => void = () => undefined) {
  const created: FakeClient[] = [];
  const factory: ClientFactory = ({ session }) => {
    const client: FakeClient = {
      connect: vi.fn(async () => true),
      getMe: vi.fn(async () => ({ id: 1001n, username: 'agent_acc', firstName: 'Agent', lastName: null })),
      invoke: vi.fn(async () => ({ ok: true })),
      destroy: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      session: { save: () => 'SAVED_SESSION' },
      sessionGiven: session,
    };
    setup(client);
    created.push(client);
    return client as unknown as TelegramClient;
  };
  return { factory, created };
}

let storage: SqliteStorage;

beforeEach(() => {
  storage = new SqliteStorage({ path: ':memory:' });
  storage.accounts.upsert({ id: 'agent' });
  storage.sessions.put('agent', seal('PLAIN_SESSION', SECRET));
});

afterEach(() => {
  storage.close();
  vi.useRealTimers();
});

function makePool(factory: ClientFactory, onFatal = vi.fn()) {
  return {
    pool: new ClientPool({ storage, credentials: () => ({ sessionSecret: SECRET, apiId: 1, apiHash: 'h' }), factory, onFatal, log: silent, connectTimeoutMs: 30_000 }),
    onFatal,
  };
}

describe('ClientPool', () => {
  it('подключает аккаунт один раз, даже при параллельных запросах', async () => {
    const { factory, created } = makeFactory();
    const { pool } = makePool(factory);
    const [a, b, c] = await Promise.all([pool.getClient('agent'), pool.getClient('agent'), pool.getClient('agent')]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(created).toHaveLength(1);
    expect(created[0]!.sessionGiven).toBe('PLAIN_SESSION');
    expect(pool.identity('agent')).toEqual({ tgUserId: '1001', username: 'agent_acc', displayName: 'Agent' });
    expect(storage.accounts.get('agent')).toMatchObject({ status: 'active', tgUserId: '1001', username: 'agent_acc' });
  });

  it('аккаунт без сессии просит владельца войти', async () => {
    storage.accounts.upsert({ id: 'fresh' });
    const { pool } = makePool(makeFactory().factory);
    await expect(pool.getClient('fresh')).rejects.toMatchObject({ code: 'ACCOUNT_UNAUTHORIZED', message: expect.stringContaining('tg-mcp login --account fresh') });
    await expect(pool.getClient('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('неверный ключ шифрования не даёт клиента', async () => {
    const { factory, created } = makeFactory();
    const pool = new ClientPool({ storage, credentials: () => ({ sessionSecret: 'other', apiId: 1, apiHash: 'h' }), factory, onFatal: vi.fn(), log: silent });
    await expect(pool.getClient('agent')).rejects.toMatchObject({ code: 'ACCOUNT_UNAUTHORIZED' });
    expect(created).toHaveLength(0);
  });

  it('неавторизованная сессия помечает аккаунт и закрывает клиента', async () => {
    const { factory, created } = makeFactory(c => c.getMe.mockResolvedValue(null));
    const { pool } = makePool(factory);
    await expect(pool.getClient('agent')).rejects.toMatchObject({ code: 'ACCOUNT_UNAUTHORIZED' });
    expect(storage.accounts.get('agent')?.status).toBe('unauthorized');
    expect(created[0]!.destroy).toHaveBeenCalled();
    expect(pool.isConnected('agent')).toBe(false);
  });

  it('зависшее подключение требует перезапуска процесса', async () => {
    vi.useFakeTimers();
    const { factory } = makeFactory(c => c.connect.mockReturnValue(new Promise(() => undefined)));
    const { pool, onFatal } = makePool(factory);
    const p = pool.getClient('agent');
    const assertion = expect(p).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(40_000);
    await assertion;
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it('destroyAll закрывает клиентов через destroy', async () => {
    const { factory, created } = makeFactory();
    const { pool } = makePool(factory);
    await pool.getClient('agent');
    await pool.destroyAll();
    expect(created[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(pool.isConnected('agent')).toBe(false);
  });
});

describe('TgGateway', () => {
  function makeTg(setup?: (client: FakeClient) => void) {
    const { factory, created } = makeFactory(setup);
    const { pool } = makePool(factory);
    const limiter = new AccountLimiter({ onFatal: vi.fn(), log: silent, minIntervalMs: 0 });
    return { tg: new TgGateway({ pool, limiter, entities: storage.entities, log: silent }), created, pool };
  }

  it('вызов идёт через клиента аккаунта, сущности из ответа попадают в кэш', async () => {
    const { tg, created } = makeTg(c =>
      c.invoke.mockResolvedValue({
        messages: [],
        chats: [{ className: 'Channel', id: 5n, accessHash: 77n, title: 'News', username: 'news', broadcast: true }],
        users: [{ className: 'User', id: 42n, accessHash: 9n, firstName: 'Ivan' }],
      }),
    );
    const request = { className: 'messages.GetHistory' };
    const result = await tg.invoke('agent', request as never);
    expect(created[0]!.invoke).toHaveBeenCalledWith(request);
    expect(result).toHaveProperty('chats');
    expect(storage.entities.getByUsername('agent', 'news')).toMatchObject({ peerKey: '-1000000000005', accessHash: '77' });
    expect(storage.entities.get('agent', '42')?.accessHash).toBe('9');
    expect(tg.laneStatus('agent').callsInWindow).toBe(1);
  });

  it('ошибка авторизации помечает аккаунт и закрывает клиента', async () => {
    const { tg, created, pool } = makeTg(c => c.invoke.mockRejectedValue(new Error('AUTH_KEY_UNREGISTERED')));
    await expect(tg.invoke('agent', { className: 'users.GetUsers' } as never)).rejects.toMatchObject({ code: 'ACCOUNT_UNAUTHORIZED' });
    expect(storage.accounts.get('agent')?.status).toBe('unauthorized');
    expect(created[0]!.destroy).toHaveBeenCalled();
    expect(pool.isConnected('agent')).toBe(false);
  });

  it('withClient выполняет операцию с клиентом в полосе', async () => {
    const { tg } = makeTg();
    await expect(tg.withClient('agent', 'download', async client => typeof client.invoke)).resolves.toBe('function');
    await expect(tg.whoami('agent')).resolves.toMatchObject({ username: 'agent_acc' });
  });
});

describe('библиотека MTProto (teleproto)', () => {
  it('настоящий клиент создаётся с параметрами шлюза и ничего не пишет в stdout', async () => {
    const { defaultClientFactory } = await import('../clientPool.js');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const client = defaultClientFactory({ session: '', apiId: 12345, apiHash: 'a'.repeat(32), log: silent });
      expect(client.floodSleepThreshold).toBe(0);
      // сообщение библиотеки уходит в логгер шлюза (stderr), а не в stdout
      (client as unknown as { _log: { warn(message: string): void } })._log.warn('test warning');
      expect(stdout).not.toHaveBeenCalled();
      expect(consoleLog).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      consoleLog.mockRestore();
    }
  });

  it('читает сессию, сохранённую GramJS: повторный вход после смены библиотеки не нужен', async () => {
    const { StringSession } = await import('teleproto/sessions');
    // формат GramJS: версия, номер дата-центра, длина адреса, адрес, порт, ключ 256 байт
    const key = Buffer.alloc(256, 7);
    const address = Buffer.from('149.154.167.91');
    const length = Buffer.alloc(2);
    length.writeInt16BE(address.length, 0);
    const port = Buffer.alloc(2);
    port.writeInt16BE(443, 0);
    const legacy = '1' + Buffer.concat([Buffer.from([2]), length, address, port, key]).toString('base64');

    const session = new StringSession(legacy);
    await session.load();
    expect(session.dcId).toBe(2);
    expect(session.serverAddress).toBe('149.154.167.91');
    expect(session.port).toBe(443);
    expect(session.authKey?.getKey()?.equals(key)).toBe(true);
    // и сохраняет в том же виде
    expect(session.save()).toBe(legacy);
  });
});

describe('loginAccount', () => {
  it('проводит вход и возвращает сессию с данными аккаунта', async () => {
    const { factory, created } = makeFactory(c =>
      c.start.mockImplementation(async (params: { phoneCode: () => Promise<string>; password: (h?: string) => Promise<string> }) => {
        expect(await params.phoneCode()).toBe('12345');
        expect(await params.password('hint')).toBe('pw');
      }),
    );
    const result = await loginAccount({
      factory,
      apiId: 1,
      apiHash: 'h',
      phone: '+7 (999) 123-45-67',
      prompts: { code: async () => '12345', password: async () => 'pw' },
      log: silent,
    });
    expect(result).toEqual({ session: 'SAVED_SESSION', identity: { tgUserId: '1001', username: 'agent_acc', displayName: 'Agent' } });
    expect(created[0]!.sessionGiven).toBe('');
    expect(created[0]!.connect).not.toHaveBeenCalled();
    expect(created[0]!.start.mock.calls[0]![0].phoneNumber).toBe('+79991234567');
    expect(created[0]!.destroy).toHaveBeenCalled();
  });

  it('после трёх неверных кодов прерывает вход', async () => {
    const { factory } = makeFactory(c => {
      c.start.mockImplementation(async (params: { onError: (e: Error) => Promise<boolean> }) => {
        expect(await params.onError(new Error('PHONE_CODE_INVALID'))).toBe(false);
        expect(await params.onError(new Error('PHONE_CODE_INVALID'))).toBe(false);
        expect(await params.onError(new Error('PHONE_CODE_INVALID'))).toBe(true);
        throw new Error('AUTH_USER_CANCEL');
      });
    });
    await expect(
      loginAccount({ factory, apiId: 1, apiHash: 'h', phone: '+79991234567', prompts: { code: async () => '0', password: async () => '' }, log: silent }),
    ).rejects.toMatchObject({ telegramCode: 'PHONE_CODE_INVALID' });
  });

  it('незарегистрированный номер: вход прерывается, новый аккаунт не создаётся', async () => {
    const { factory, created } = makeFactory(c => {
      c.start.mockImplementation(async (params: { firstAndLastNames: () => Promise<[string, string]>; onError: (e: Error) => Promise<boolean> }) => {
        const refused = (await params.firstAndLastNames().catch((e: unknown) => e)) as Error;
        expect(refused).toBeInstanceOf(Error);
        // GramJS спрашивает, прекращать ли: с первой же ошибки да
        expect(await params.onError(refused)).toBe(true);
        throw new Error('AUTH_USER_CANCEL');
      });
    });
    await expect(
      loginAccount({ factory, apiId: 1, apiHash: 'h', phone: '+79991234567', prompts: { code: async () => '1', password: async () => '' }, log: silent }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('does not register new accounts') });
    expect(created[0]!.destroy).toHaveBeenCalled();
  });

  it('прерванный ввод кода останавливает вход, а не спрашивает код заново', async () => {
    const code = vi.fn(async () => {
      throw new Error('Cancelled.');
    });
    const { factory } = makeFactory(c => {
      c.start.mockImplementation(async (params: { phoneCode: () => Promise<string>; onError: (e: Error) => Promise<boolean> }) => {
        const failed = (await params.phoneCode().catch((e: unknown) => e)) as Error;
        expect(await params.onError(failed)).toBe(true);
        throw new Error('AUTH_USER_CANCEL');
      });
    });
    await expect(
      loginAccount({ factory, apiId: 1, apiHash: 'h', phone: '+79991234567', prompts: { code, password: async () => '' }, log: silent }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'Login cancelled: Cancelled.' });
    expect(code).toHaveBeenCalledTimes(1);
  });

  it('проверяет формат телефона', () => {
    expect(normalizePhone('79991234567')).toBe('+79991234567');
    expect(() => normalizePhone('abc')).toThrow(/international format/);
  });
});

describe('config', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tgmcp-config-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('читает .env из домашней папки, окружение имеет приоритет', () => {
    writeFileSync(join(home, '.env'), 'TG_API_ID=12345\nTG_API_HASH="abcdef"\nTG_MCP_PORT=8123\n# comment\n');
    const env: NodeJS.ProcessEnv = { TG_MCP_HOME: home, TG_MCP_PORT: '9000' };
    const config = loadConfig(env);
    expect(config).toMatchObject({ home, apiId: 12345, apiHash: 'abcdef', port: 9000, host: '127.0.0.1', toolsets: ['core'] });
    expect(config.dbPath).toBe(join(home, 'gateway.sqlite'));
    expect(requireApiCredentials(config)).toEqual({ apiId: 12345, apiHash: 'abcdef' });
  });

  it('без учётных данных API объясняет, куда их положить', () => {
    const config = loadConfig({ TG_MCP_HOME: home });
    expect(() => requireApiCredentials(config)).toThrow(/TG_API_ID/);
  });

  it('опечатка в наборе инструментов роняет старт, снятый набор automate просто пропускается', () => {
    expect(parseToolsets('core, Write ,index')).toEqual(['core', 'write', 'index']);
    // старый .env с набором, которого больше нет, не должен ронять демон
    expect(parseToolsets('core, automate, write')).toEqual(['core', 'write']);
    expect(parseToolsets('automate')).toEqual(['core']);
    expect(parseToolsets(undefined)).toEqual(['core']);
    expect(() => parseToolsets('core,wirte')).toThrow(/Unknown toolset/);
  });

  it('ключ сессий, созданный другим процессом, не перезаписывается', () => {
    const first = loadSessionSecret(home);
    expect(loadSessionSecret(home)).toBe(first);
    expect(readFileSync(join(home, 'session.key'), 'utf8').trim()).toBe(first);
  });

  it('ключ сессий создаётся один раз с правами 0600', () => {
    const first = loadSessionSecret(home, {});
    const second = loadSessionSecret(home, {});
    expect(first).toBe(second);
    expect(readFileSync(join(home, 'session.key'), 'utf8').trim()).toBe(first);
    expect(statSync(join(home, 'session.key')).mode & 0o777).toBe(0o600);
    expect(loadSessionSecret(home, { TG_MCP_SESSION_KEY: 'from-env' })).toBe('from-env');
  });
});
