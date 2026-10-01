/**
 * `tg-mcp runner`: запускает агента, когда сработало правило или ответил
 * собеседник в поручении. Работает под пользователем macOS человека, у каждого
 * пользователя шлюза свой (решение 17): демон под отдельным пользователем не
 * может запустить чужой Claude Code в его профиле.
 *
 * Агент получает токен запуска в переменной `TG_MCP_TOKEN`: по нему шлюз даёт
 * доступ только к одному посту или одному диалогу. Образец запуска агента из
 * кода: channel-scope `web/routes/research.ts:131`, без `--dangerously-skip-permissions`.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClaimedJob } from '../automation/runner.js';
import { GatewayError } from '../core/errors.js';
import type { Logger } from '../core/log.js';
import { sleep } from '../core/time.js';

/** Делит строку команды на аргументы, как оболочка: пробелы, одинарные и двойные кавычки, обратная косая черта. */
export function splitCommand(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) current += command[++i];
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (ch === '\\' && i + 1 < command.length) {
      current += command[++i];
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) {
        args.push(current);
        current = '';
        started = false;
      }
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote) throw new GatewayError('INVALID_ARGUMENT', 'Unclosed quote in the --agent command.');
  if (started) args.push(current);
  return args;
}

/**
 * Аргументы запуска агента. Промпт подставляется вместо `{prompt}` одним
 * аргументом и не проходит через оболочку: кавычки и `$()` в нём безвредны.
 */
export function buildArgv(template: string, prompt: string): string[] {
  const parts = splitCommand(template);
  if (parts.length === 0) throw new GatewayError('INVALID_ARGUMENT', 'The --agent command is empty.');
  let used = false;
  const argv = parts.map(part => {
    // Оболочки здесь нет, поэтому `~/` раскрываем сами. В промпте `~` не трогаем.
    if (!part.includes('{prompt}')) return part === '~' || part.startsWith('~/') ? join(homedir(), part.slice(1)) : part;
    used = true;
    return part.split('{prompt}').join(prompt);
  });
  if (!used) argv.push(prompt);
  return argv;
}

export interface RunnerOptions {
  /** Адрес демона без пути, например http://127.0.0.1:7777. */
  baseUrl: string;
  /** Токен пользователя шлюза (не токен запуска). */
  token: string;
  /** Команда агента, например `claude -p {prompt} --mcp-config ~/tg-mcp/agent.mcp.json`. */
  agent: string;
  pollMs?: number;
  signal?: AbortSignal;
  log: Logger;
  fetch?: typeof fetch;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  env?: NodeJS.ProcessEnv;
}

const OUTPUT_TAIL = 8_000;
const EXIT_GRACE_MS = 2_000;

/** Запускает агента для одного задания. Возвращает код выхода (124 при таймауте) и хвост вывода. */
export function runAgent(options: RunnerOptions, job: ClaimedJob): Promise<{ exitCode: number; output: string }> {
  const spawn = options.spawn ?? nodeSpawn;
  const argv = buildArgv(options.agent, job.prompt);
  return new Promise(resolve => {
    let output = '';
    let timedOut = false;
    const append = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf8')).slice(-OUTPUT_TAIL);
    };
    let child: ChildProcess;
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...(options.env ?? process.env), TG_MCP_TOKEN: job.token, TG_MCP_URL: `${options.baseUrl}/mcp` },
      });
    } catch (err) {
      resolve({ exitCode: 127, output: `could not start the agent: ${(err as Error).message}` });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, job.timeoutSec * 1000);
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ exitCode: 127, output: `could not start the agent: ${err.message}` });
    });
    const finish = (code: number | null): void => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? 124 : (code ?? 1), output: timedOut ? `${output}\n[timed out after ${job.timeoutSec}s]` : output });
    };
    child.on('close', finish);
    // Агент мог оставить фоновый процесс, который держит stdout открытым: тогда close не придёт.
    // После выхода самого агента ждём остаток вывода недолго.
    child.on('exit', code => {
      setTimeout(() => finish(code), EXIT_GRACE_MS).unref();
    });
  });
}

/** Цикл: забрать задание, запустить агента, сообщить исход. По одному заданию за раз. */
export async function runRunner(options: RunnerOptions): Promise<void> {
  const doFetch = options.fetch ?? fetch;
  const pollMs = options.pollMs ?? 5_000;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${options.token}` };
  // Проверяем команду сразу: ошибка в ней должна быть видна при старте, а не при первом посте.
  buildArgv(options.agent, 'check');

  const post = async (path: string, body: unknown): Promise<unknown> => {
    const response = await doFetch(`${options.baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    if (response.status === 401) throw new GatewayError('ACCESS_DENIED', 'The daemon rejected the token. Check TG_MCP_TOKEN.');
    if (!response.ok) throw new Error(`daemon answered HTTP ${response.status}`);
    return response.json();
  };

  let reachable = true;
  while (!options.signal?.aborted) {
    let job: ClaimedJob | null = null;
    try {
      job = ((await post('/runner/claim', {})) as { job: ClaimedJob | null }).job;
      if (!reachable) options.log.info('daemon is reachable again');
      reachable = true;
    } catch (err) {
      if (err instanceof GatewayError) throw err;
      if (reachable) options.log.warn('daemon is not reachable, will keep trying', { error: (err as Error).message });
      reachable = false;
    }

    if (!job) {
      await sleep(pollMs);
      continue;
    }

    options.log.info('starting the agent', { job: job.id, kind: job.kind });
    const result = await runAgent(options, job);
    options.log.info('agent finished', { job: job.id, exitCode: result.exitCode });
    try {
      await post('/runner/finish', { id: job.id, exit_code: result.exitCode, output: result.output });
    } catch (err) {
      options.log.error('could not report the result', { job: job.id, error: (err as Error).message });
    }
  }
}
