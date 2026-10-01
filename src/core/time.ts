/**
 * Дедлайны и паузы. Перенесено из helper `refreshShared.ts` (withTimeout,
 * StageTimeoutError): промис teleproto при сбое сети может не завершиться никогда,
 * поэтому каждый внешний await ограничен по времени.
 */

export class DeadlineError extends Error {
  readonly label: string;
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'DeadlineError';
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

/** Больше 2^31-1 Node молча урезает setTimeout до 1 мс. */
export const MAX_TIMER_MS = 2_147_483_647;

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const ms = Math.min(Math.max(0, timeoutMs), MAX_TIMER_MS);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(label, timeoutMs)), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.min(Math.max(0, ms), MAX_TIMER_MS)));
}

/** Число из env с проверкой диапазона; при мусоре возвращает значение по умолчанию. */
export function envNumber(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}
