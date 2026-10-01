/**
 * Страж зависаний. Зависший вызов GramJS нельзя безопасно отменить, а второй
 * клиент на той же сессии даёт AUTH_KEY_DUPLICATED. Поэтому процесс выходит
 * с кодом 1, и супервизор (launchd) поднимает его с чистого листа.
 * Перенесено из helper `gramFatalRecovery.ts` и `statsRefresher.ts` (watchdog).
 */
import { createLogger, type Logger } from './log.js';

export type ExitProcess = (code: number) => void;

export interface FatalHandlerOptions {
  exit?: ExitProcess;
  log?: Logger;
  /** Выполняется перед выходом, например закрытие базы. Ошибки игнорируются. */
  beforeExit?: () => void;
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
      options.beforeExit?.();
    } catch {
      // выход важнее аккуратного закрытия
    }
    exit(1);
  };
}

export interface WatchdogOptions {
  /** Сколько пропущенных тиков подряд считаются зависанием. */
  maxMissedTicks: number;
  onStuck: (missed: number) => void;
  log?: Logger;
  name: string;
}

/**
 * Сторож периодического воркера: тик не должен начинаться, пока идёт прошлый.
 * Считает пропуски подряд и поднимает тревогу, когда их слишком много.
 */
export class TickWatchdog {
  private busy = false;
  private missed = 0;
  private readonly log: Logger;

  constructor(private readonly options: WatchdogOptions) {
    this.log = options.log ?? createLogger('watchdog');
  }

  /** true, если тик можно начинать. */
  begin(): boolean {
    if (this.busy) {
      this.missed++;
      this.log.warn(`${this.options.name}: previous tick still running`, { missed: this.missed });
      if (this.missed >= this.options.maxMissedTicks) {
        this.options.onStuck(this.missed);
      }
      return false;
    }
    this.busy = true;
    this.missed = 0;
    return true;
  }

  end(): void {
    this.busy = false;
  }

  get missedTicks(): number {
    return this.missed;
  }
}
