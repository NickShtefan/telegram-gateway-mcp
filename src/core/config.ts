/**
 * Конфигурация шлюза. Всё состояние лежит в домашней папке шлюза
 * (`TG_MCP_HOME`, по умолчанию `~/.tg-mcp`): база, ключ шифрования сессий
 * и `.env`. На лабораторной машине это домашняя папка отдельного пользователя
 * macOS, агентам она недоступна (решение 17).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomToken } from './crypto.js';
import { GatewayError } from './errors.js';

export interface GatewayConfig {
  home: string;
  dbPath: string;
  /** Папка для выгрузок и картинок: её читают агенты. */
  filesDir: string;
  host: string;
  port: number;
  toolsets: string[];
  apiId: number | null;
  apiHash: string | null;
}

export const DEFAULT_PORT = 7777;
export const DEFAULT_HOST = '127.0.0.1';
export const KNOWN_TOOLSETS = ['core', 'discover', 'analytics', 'index', 'write'] as const;
/** Наборы, которых больше нет. В старом .env они не должны ронять демон: просто пропускаются. */
export const RETIRED_TOOLSETS: readonly string[] = ['automate'];

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(expandHome(env.TG_MCP_HOME?.trim() || '~/.tg-mcp'));
}

/** Подхватывает `<home>/.env`, не затирая то, что уже есть в окружении. */
export function loadEnvFile(home: string, env: NodeJS.ProcessEnv = process.env): void {
  const path = join(home, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
}

export function parseToolsets(raw: string | undefined): string[] {
  const requested = (raw ?? 'core')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
    .filter(s => !RETIRED_TOOLSETS.includes(s));
  const unknown = requested.filter(t => !(KNOWN_TOOLSETS as readonly string[]).includes(t));
  if (unknown.length > 0) {
    // Опечатка в списке не должна молча сузить набор инструментов.
    throw new GatewayError(
      'INVALID_ARGUMENT',
      `Unknown toolset(s): ${unknown.join(', ')}. Known: ${KNOWN_TOOLSETS.join(', ')}.`,
    );
  }
  return [...new Set(requested.length > 0 ? requested : ['core'])];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const home = resolveHome(env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  loadEnvFile(home, env);

  const apiIdRaw = (env.TG_API_ID ?? env.API_ID ?? '').trim();
  const apiId = /^\d+$/.test(apiIdRaw) ? Number(apiIdRaw) : null;
  const apiHash = (env.TG_API_HASH ?? env.API_HASH ?? '').trim() || null;

  const portRaw = (env.TG_MCP_PORT ?? '').trim();
  const port = /^\d+$/.test(portRaw) && Number(portRaw) > 0 && Number(portRaw) < 65536 ? Number(portRaw) : DEFAULT_PORT;

  return {
    home,
    dbPath: resolve(expandHome(env.TG_MCP_DB?.trim() || join(home, 'gateway.sqlite'))),
    filesDir: resolve(expandHome(env.TG_MCP_FILES_DIR?.trim() || join(home, 'files'))),
    host: env.TG_MCP_HOST?.trim() || DEFAULT_HOST,
    port,
    toolsets: parseToolsets(env.TG_MCP_TOOLSETS),
    apiId,
    apiHash,
  };
}

export function requireApiCredentials(config: GatewayConfig): { apiId: number; apiHash: string } {
  if (config.apiId === null || config.apiHash === null) {
    throw new GatewayError(
      'INVALID_ARGUMENT',
      `Telegram API credentials are missing. Put TG_API_ID and TG_API_HASH (from my.telegram.org) into ${join(config.home, '.env')}.`,
    );
  }
  return { apiId: config.apiId, apiHash: config.apiHash };
}

/**
 * Секрет, которым шифруются сессии. Берётся из `TG_MCP_SESSION_KEY`, иначе из
 * файла `<home>/session.key`; при первом запуске файл создаётся с правами 0600.
 */
export function loadSessionSecret(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.TG_MCP_SESSION_KEY?.trim();
  if (fromEnv) return fromEnv;

  const path = join(home, 'session.key');
  if (existsSync(path)) {
    const value = readFileSync(path, 'utf8').trim();
    if (!value) throw new GatewayError('INVALID_ARGUMENT', `Session key file ${path} is empty.`);
    return value;
  }
  const secret = randomToken(32);
  try {
    // wx: если ключ успел создать другой процесс, берём его, а не перезаписываем.
    writeFileSync(path, secret + '\n', { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return readFileSync(path, 'utf8').trim();
  }
  chmodSync(path, 0o600);
  return secret;
}
