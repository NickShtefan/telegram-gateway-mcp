/**
 * `tg-mcp serve`: демон, который владеет сессиями Telegram и отдаёт
 * инструменты агентам по HTTP. Берёт блокировку: второй процесс на тех же
 * сессиях не стартует.
 */
import { parseToolsets, type GatewayConfig } from '../core/config.js';
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

/** Известный шум GramJS: цикл обновлений бросает TIMEOUT мимо всех обработчиков. */
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

  const lock = await acquireLock(config.home);
  const runtime = createRuntime(config, { log: log.child('gateway'), ...options.overrides });
  const services = buildServices(runtime);

  const onRejection = (reason: unknown): void => {
    if (isGramUpdateNoise(reason)) {
      log.debug('ignored GramJS update loop timeout');
      return;
    }
    log.error('unhandled rejection', { error: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason) });
  };
  process.on('unhandledRejection', onRejection);

  let http;
  try {
    const resumed = services.jobs.resume();
    if (resumed > 0) log.info('resumed interrupted jobs', { count: resumed });
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

  // Фоновая работа: бот согласований, наблюдатель, уборка.
  const background = new AbortController();
  const { approvals, watcher, runner } = services.automation;
  const loops: Array<Promise<void>> = [watcher.run(background.signal)];
  if (approvals.enabled) loops.push(approvals.poll(background.signal));
  else log.warn('approval bot is not configured (TG_MCP_APPROVAL_BOT_TOKEN): write tools and rules will answer UNAVAILABLE');
  const sweeper = setInterval(() => {
    void approvals.sweep().catch(err => log.warn('approval sweep failed', { error: (err as Error).message }));
    try {
      runner.sweep();
    } catch (err) {
      log.warn('runner sweep failed', { error: (err as Error).message });
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
  background.abort();
  clearInterval(sweeper);
  services.jobs.stop();
  await http.close();
  await runtime.close();
  await lock.release();
  process.removeListener('unhandledRejection', onRejection);
  return 0;
}
