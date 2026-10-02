/**
 * Страж зависаний. Зависший вызов teleproto нельзя безопасно отменить, а второй
 * клиент на той же сессии даёт AUTH_KEY_DUPLICATED. Поэтому процесс выходит
 * с кодом 1, и супервизор (launchd) поднимает его с чистого листа.
 */
import { createLogger, type Logger } from './log.js';

export type ExitProcess = (code: number) => void;

export interface FatalHandlerOptions {
  exit?: ExitProcess;
  log?: Logger;
  /** Выполняется перед выходом, например закрытие базы. Ошибки игнорируются. */
  beforeExit?: () => void;
  /** Выполняется сразу: отклонить всё, что ждёт в очередях, чтобы вызывающие узнали об ошибке. */
  prepare?: () => void;
  /**
   * Сколько ждать между `prepare` и выходом. За это время обработчики ошибок
   * успевают записать исход: иначе запрос на запись остался бы «выполняется» навсегда.
   */
  graceMs?: number;
}

export type FatalHandler = (reason: string) => void;

export function createFatalHandler(options: FatalHandlerOptions = {}): FatalHandler {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const log = options.log ?? createLogger('recovery');
  let requested = false;
  return (reason: string) => {
    if (requested) return;
    requested = true;
    log.error(`fatal MTProto failure: ${reason}; exiting for supervisor restart`);
    try {
      options.prepare?.();
    } catch {
      // выход важнее аккуратной остановки
    }
    const finish = (): void => {
      try {
        options.beforeExit?.();
      } catch {
        // выход важнее аккуратного закрытия
      }
      exit(1);
    };
    if (options.graceMs && options.graceMs > 0) setTimeout(finish, options.graceMs);
    else finish();
  };
}
