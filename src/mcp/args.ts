/**
 * Разбор аргументов инструментов. Схемы плоские (строки, числа, enum), поэтому
 * даты приходят строкой, а здесь превращаются в unix-секунды.
 */
import { GatewayError } from '../core/errors.js';

const RELATIVE_RE = /^(\d{1,4})\s*(m|min|h|d|w)$/i;
const UNIT_SECONDS: Record<string, number> = { m: 60, min: 60, h: 3600, d: 86_400, w: 604_800 };

/**
 * Момент времени: `30d`, `12h`, `2w` (столько назад от сейчас), дата
 * `2026-09-01`, дата и время ISO или unix-секунды. Возвращает unix-секунды.
 */
export function parseWhen(value: string, nowMs: number, argName: string): number {
  const text = value.trim();
  const fail = (): never => {
    throw new GatewayError(
      'INVALID_ARGUMENT',
      `Invalid "${argName}": "${text.slice(0, 40)}". Use a relative period (30d, 12h, 2w), a date (2026-09-01) or an ISO date-time (2026-09-01T12:00:00Z).`,
    );
  };

  const relative = text.match(RELATIVE_RE);
  if (relative) {
    return Math.floor(nowMs / 1000) - Number(relative[1]) * UNIT_SECONDS[relative[2]!.toLowerCase()]!;
  }
  if (/^\d{9,11}$/.test(text)) return Number(text);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const ms = Date.parse(`${text}T00:00:00Z`);
    return Number.isNaN(ms) ? fail() : Math.floor(ms / 1000);
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text)) {
    // Без часового пояса считаем время как UTC: так же, как шлюз его печатает.
    const iso = text.replace(' ', 'T');
    const ms = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`);
    return Number.isNaN(ms) ? fail() : Math.floor(ms / 1000);
  }
  return fail();
}

export interface DateWindow {
  minDate?: number;
  maxDate?: number;
}

export function parseWindow(since: string | undefined, until: string | undefined, nowMs: number): DateWindow {
  const minDate = since ? parseWhen(since, nowMs, 'since') : undefined;
  const maxDate = until ? parseWhen(until, nowMs, 'until') : undefined;
  if (minDate !== undefined && maxDate !== undefined && minDate >= maxDate) {
    throw new GatewayError('INVALID_ARGUMENT', '"since" must be earlier than "until".');
  }
  return { minDate, maxDate };
}

export function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(1, Math.trunc(value)), max);
}

/** Окно дат словами для заголовка ответа. */
export function describeWindow(window: DateWindow): string {
  const fmt = (s: number): string => new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ');
  if (window.minDate && window.maxDate) return ` from ${fmt(window.minDate)} to ${fmt(window.maxDate)}`;
  if (window.minDate) return ` since ${fmt(window.minDate)}`;
  if (window.maxDate) return ` until ${fmt(window.maxDate)}`;
  return '';
}

/** Длительность вида `3d`, `24h`, `30m`, `2w` в миллисекундах. */
export function parseDuration(value: string, argName: string, maxMs: number): number {
  const m = value.trim().match(RELATIVE_RE);
  const ms = m ? Number(m[1]) * UNIT_SECONDS[m[2]!.toLowerCase()]! * 1000 : NaN;
  if (!Number.isFinite(ms) || ms <= 0 || ms > maxMs) {
    throw new GatewayError('INVALID_ARGUMENT', `Invalid "${argName}": use a duration like 3d, 24h or 30m, up to ${Math.round(maxMs / 86_400_000)} days.`);
  }
  return ms;
}

/** Число от 0 до max: для «сколько сообщений добавить», где ноль это осмысленное значение. */
export function clampCount(value: number | undefined, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, Math.trunc(value)), max);
}
