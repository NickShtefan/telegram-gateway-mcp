import { request } from 'node:http';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestGateway, type TestGateway } from '../../__tests__/helpers/gateway.js';
import { runServe } from '../../cli/serve.js';
import { isLockHeld } from '../../core/lock.js';
import { createLogger } from '../../core/log.js';
import { SqliteStorage } from '../../storage/sqlite.js';
import { allowedHosts, bearerToken, startHttpServer, type RunningHttpServer } from '../http.js';
import { parseResponseBody, runStdioProxy } from '../stdio.js';

const silent = createLogger('test', { level: 'silent' });
let gw: TestGateway;
let http: RunningHttpServer;
let url: string;

beforeEach(async () => {
  gw = makeTestGateway();
  http = await startHttpServer({ services: gw.services, host: '127.0.0.1', port: 0, toolsets: ['core'], version: 'test', log: silent });
  url = `http://127.0.0.1:${http.port}/mcp`;
});

afterEach(async () => {
  await http.close();
  gw.cleanup();
});

/** Запрос с произвольными заголовками: fetch не даёт подменить Host. */
function raw(method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: http.port, method, path, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } };

describe('HTTP: вход демона', () => {
  it('healthz отвечает без токена и ничего не раскрывает', async () => {
    const res = await fetch(`http://127.0.0.1:${http.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('без токена и с чужим токеном 401', async () => {
    const variants: Array<Record<string, string>> = [{}, { Authorization: 'Bearer ' + 'x'.repeat(43) }, { Authorization: 'Basic abc' }];
    for (const headers of variants) {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(initialize) });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('Bearer');
    }
  });

  it('чужой Host и запрос из браузера отклоняются', async () => {
    const auth = { Authorization: `Bearer ${gw.tokens.nick}`, 'Content-Type': 'application/json' };
    const rebinding = await raw('POST', '/mcp', { ...auth, Host: 'evil.example.com' }, JSON.stringify(initialize));
    expect(rebinding.status).toBe(403);
    const browser = await raw('POST', '/mcp', { ...auth, Host: `127.0.0.1:${http.port}`, Origin: 'https://evil.example.com' }, JSON.stringify(initialize));
    expect(browser.status).toBe(403);
    const localhost = await raw('POST', '/mcp', { ...auth, Host: `localhost:${http.port}`, Accept: 'application/json, text/event-stream' }, JSON.stringify(initialize));
    expect(localhost.status).toBe(200);
  });

  it('GET не поддерживается, мусор в теле и неизвестный путь дают понятные коды', async () => {
    const auth = { Authorization: `Bearer ${gw.tokens.nick}` };
    const get = await fetch(url, { headers: auth });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    const bad = await fetch(url, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{not json' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: number } }).error.code).toBe(-32700);
    expect((await fetch(`http://127.0.0.1:${http.port}/other`, { headers: auth })).status).toBe(404);
  });

  it('клиент MCP по HTTP: токен определяет пользователя', async () => {
    const connect = async (token: string) => {
      const client = new Client({ name: 'agent', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      return client;
    };
    const nick = await connect(gw.tokens.nick);
    const partner = await connect(gw.tokens.partner);
    expect((await nick.listTools()).tools).toHaveLength(10);
    const text = async (c: Client) => ((await c.callTool({ name: 'tg_status', arguments: {} })) as { content: Array<{ text: string }> }).content[0]!.text;
    expect(await text(nick)).toContain('Gateway user: nick');
    expect(await text(partner)).toContain('Gateway user: partner');
    expect(nick.getInstructions()).toContain('Telegram gateway');
    await nick.close();
    await partner.close();
  });

  it('разбор заголовков', () => {
    expect(bearerToken({ headers: { authorization: 'Bearer abc' } } as never)).toBe('abc');
    expect(bearerToken({ headers: { authorization: 'bearer   abc  ' } } as never)).toBe('abc');
    expect(bearerToken({ headers: {} } as never)).toBeNull();
    expect([...allowedHosts('127.0.0.1', 7777)].sort()).toEqual(['127.0.0.1:7777', '[::1]:7777', 'localhost:7777']);
    expect(allowedHosts('10.0.0.5', 7777).has('10.0.0.5:7777')).toBe(true);
    expect(allowedHosts('0.0.0.0', 7777).has('0.0.0.0:7777')).toBe(false);
  });
});

describe('stdio-прокладка', () => {
  async function run(lines: string[], options: { token?: string; target?: string } = {}): Promise<Array<Record<string, unknown>>> {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', c => chunks.push(c as Buffer));
    const done = runStdioProxy({ url: options.target ?? url, token: options.token ?? gw.tokens.nick, input, output, log: silent, timeoutMs: 5_000 });
    for (const line of lines) input.write(line + '\n');
    input.end();
    await done;
    return Buffer.concat(chunks)
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as Record<string, unknown>);
  }

  it('проксирует запросы в демон и пишет в stdout только JSON-RPC', async () => {
    const replies = await run([
      JSON.stringify(initialize),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      '',
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tg_status', arguments: {} } }),
    ]);
    expect(replies).toHaveLength(3);
    const byId = new Map(replies.map(r => [r.id, r]));
    expect((byId.get(1)!.result as { serverInfo: { name: string } }).serverInfo.name).toBe('telegram-gateway');
    expect((byId.get(2)!.result as { tools: unknown[] }).tools).toHaveLength(10);
    expect(JSON.stringify(byId.get(3))).toContain('Gateway user: nick');
  });

  it('демон недоступен: запрос получает ошибку, уведомление молчит', async () => {
    const replies = await run([JSON.stringify(initialize), JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })], { target: 'http://127.0.0.1:9/mcp' });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ id: 1, error: { code: -32000 } });
    expect(JSON.stringify(replies[0])).toContain('daemon is not reachable');
  });

  it('неверный токен и мусор на входе', async () => {
    const denied = await run([JSON.stringify(initialize)], { token: 'wrong-token-wrong-token' });
    expect(JSON.stringify(denied[0])).toContain('rejected the token');
    const garbage = await run(['{not json']);
    expect(garbage[0]).toMatchObject({ id: null, error: { code: -32700 } });
  });

  it('разбирает ответ потоком событий', () => {
    expect(parseResponseBody('text/event-stream', 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n')).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
    expect(parseResponseBody('application/json', '[{"id":1},{"id":2}]')).toHaveLength(2);
    expect(parseResponseBody('application/json', '')).toEqual([]);
  });
});

describe('serve', () => {
  it('не слушает наружу без явного разрешения владельца', async () => {
    const io = { out: () => undefined, err: () => undefined, prompt: async () => '' };
    delete process.env.TG_MCP_ALLOW_REMOTE;
    await expect(runServe({ config: { ...gw.config, host: '0.0.0.0', port: 0 }, io, version: 'test', overrides: { storage: new SqliteStorage({ path: ':memory:' }) }, log: silent })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('plain HTTP'),
    });
    expect(await isLockHeld(gw.config.home)).toBe(false);
  });

  it('поднимает демон под блокировкой и освобождает её при остановке', async () => {
    const storage = new SqliteStorage({ path: ':memory:' });
    const controller = new AbortController();
    const err: string[] = [];
    let port = 0;
    const ready = new Promise<void>(resolve => {
      void runServe({
        config: { ...gw.config, port: 0 },
        io: { out: () => undefined, err: l => err.push(l), prompt: async () => '' },
        version: 'test',
        signal: controller.signal,
        overrides: { storage },
        log: silent,
        onReady: info => {
          port = info.port;
          resolve();
        },
      }).then(code => {
        expect(code).toBe(0);
        resolve();
      });
    });
    await ready;
    expect(port).toBeGreaterThan(0);
    expect(err.join('\n')).toContain(`listening on http://127.0.0.1:${port}/mcp`);
    expect(await isLockHeld(gw.config.home)).toBe(true);
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);

    // второй демон на тех же сессиях не стартует
    await expect(
      runServe({ config: { ...gw.config, port: 0 }, io: { out: () => undefined, err: () => undefined, prompt: async () => '' }, version: 'test', overrides: { storage: new SqliteStorage({ path: ':memory:' }) }, log: silent }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });

    controller.abort();
    await new Promise(r => setTimeout(r, 100));
    expect(await isLockHeld(gw.config.home)).toBe(false);
  });
});
