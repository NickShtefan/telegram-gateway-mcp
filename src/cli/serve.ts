/**
 * `tg-mcp serve`: демон, который владеет сессиями Telegram и отдаёт
 * инструменты агентам по HTTP. Берёт блокировку: второй процесс на тех же
 * сессиях не стартует.
 */
import { parseToolsets, type GatewayConfig } from '../core/config.js';
import { GatewayError } from '../core/errors.js';
import { acquireLock } from '../core/lock.js';
import { createLogger, type Logger } from '../core/log.js';
import { createRuntime, type RuntimeOverrides } from '../runtime.js';
import { buildServices } from '../services/index.js';
import { startHttpServer } from '../transport/http.js';
import type { CliIo } from './io.js';

export interface ServeOptions {
  config: GatewayConfig;
  io: CliIo;
  version: string;
  host?: string;
  port?: number;
  toolsets?: string;
  filesDir?: string;
  allowedOrigins?: string[];
  /** Для тестов: остановка без сигнала процесса и подмена зависимостей. */
  signal?: AbortSignal;
  overrides?: RuntimeOverrides;
  onReady?: (info: { host: string; port: number }) => void;
  log?: Logger;
}

/** Как долго хранятся записи аудита. */
const AUDIT_KEEP_MS = 90 * 86_400_000;
const PRUNE_EVERY_MS = 6 * 3_600_000;

/** Известный шум teleproto: цикл обновлений бросает TIMEOUT мимо всех обработчиков. */
function isGramUpdateNoise(reason: unknown): boolean {
  const text = reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason);
  return /TIMEOUT/.test(text) && /updates\.js|_updateLoop/.test(text);
}

export async function runServe(options: ServeOptions): Promise<number> {
  const log = options.log ?? createLogger('serve');
  const config: GatewayConfig = {
    ...options.config,
    host: options.host ?? options.config.host,
    port: options.port ?? options.config.port,
    toolsets: options.toolsets ? parseToolsets(options.toolsets) : options.config.toolsets,
    filesDir: options.filesDir ?? options.config.filesDir,
  };

  // Токен идёт открытым текстом по HTTP: вне localhost его можно перехватить.
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(config.host);
  if (!loopback && process.env.TG_MCP_ALLOW_REMOTE !== '1') {
    throw new GatewayError(
      'INVALID_ARGUMENT',
      `Refusing to listen on ${config.host}: the gateway token would travel over plain HTTP. Use 127.0.0.1, or set TG_MCP_ALLOW_REMOTE=1 if the network is private and you accept the risk.`,
    );
  }

  const lock = await acquireLock(config.home);
  const runtime = createRuntime(config, { log: log.child('gateway'), ...options.overrides });
  const services = buildServices(runtime);

  const onRejection = (reason: unknown): void => {
    if (isGramUpdateNoise(reason)) {
      log.debug('ignored teleproto update loop timeout');
      return;
    }
    log.error('unhandled rejection', { error: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason) });
  };
  process.on('unhandledRejection', onRejection);

  let http;
  try {
    const resumed = services.jobs.resume();
    if (resumed > 0) log.info('resumed interrupted jobs', { count: resumed });
    // Действия, которые выполнялись в момент падения: исход неизвестен, повторять их шлюз не станет.
    const interrupted = services.writeGate.approvals.recover();
    if (interrupted > 0) log.warn('write actions interrupted by a restart, their outcome is unknown', { count: interrupted });
    http = await startHttpServer({
      services,
      host: config.host,
      port: config.port,
      toolsets: config.toolsets,
      version: options.version,
      log: log.child('http'),
      allowedOrigins: options.allowedOrigins,
    });
  } catch (err) {
    process.removeListener('unhandledRejection', onRejection);
    await runtime.close();
    await lock.release();
    throw err;
  }

  // Сам по себе демон в Telegram не ходит. Раз в минуту только уборка в своей базе.
  let lastPrune = 0;
  const sweeper = setInterval(() => {
    try {
      services.writeGate.approvals.sweep();
      if (Date.now() - lastPrune >= PRUNE_EVERY_MS) {
        lastPrune = Date.now();
        const audit = runtime.storage.audit.prune(Date.now() - AUDIT_KEEP_MS);
        if (audit > 0) log.info('pruned old audit records', { audit });
      }
    } catch (err) {
      log.warn('sweep failed', { error: (err as Error).message });
    }
  }, 60_000);
  sweeper.unref();

  options.io.err(`tg-mcp is listening on http://${http.host}:${http.port}/mcp (toolsets: ${config.toolsets.join(', ')})`);
  options.onReady?.({ host: http.host, port: http.port });

  await new Promise<void>(resolve => {
    const stop = (): void => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) resolve();
  });

  log.info('shutting down');
  clearInterval(sweeper);
  services.jobs.stop();
  await http.close();
  await runtime.close();
  await lock.release();
  process.removeListener('unhandledRejection', onRejection);
  return 0;
}
