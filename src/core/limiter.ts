/**
 * Лимитер MTProto-вызовов. Каждый вызов в Telegram проходит через него.
 *
 * Собран из двух источников:
 * - channel-scope `rateLimiter.ts`: очередь на аккаунт, 60 запросов в минуту,
 *   500 мс между запросами, пауза аккаунта на FLOOD_WAIT, повторы;
 * - helper `gramGate.ts` и `refreshShared.ts`: одна полоса на сессию, дедлайн
 *   ВНУТРИ полосы (зависший вызов освобождает её по времени), предел на
 *   FLOOD_WAIT, выход процесса при зависании.
 *
 * Чего не было ни там, ни там:
 * - бюджет ожидания: если пауза длиннее, чем готов ждать вызывающий, он сразу
 *   получает ошибку с retry_after, а не висит;
 * - приоритет: вызовы агента идут раньше фоновых (наблюдатель, индекс).
 */
import { classifyError, floodInfo, GatewayError } from './errors.js';
import { createLogger, type Logger } from './log.js';
import { DeadlineError, MAX_TIMER_MS, withTimeout } from './time.js';

export type Priority = 'interactive' | 'background';

export interface LimiterOptions {
  /** Минимальная пауза между вызовами одного аккаунта. */
  minIntervalMs?: number;
  /** Вызовов в минуту на аккаунт. */
  perMinute?: number;
  /** FLOOD_WAIT дольше этого не пережидается никем, даже фоном. */
  floodCapSeconds?: number;
  maxFloodRetries?: number;
  /** Дедлайн самого вызова, если не задан в опциях вызова. */
  defaultDeadlineMs?: number;
  /** Сколько вызов агента готов ждать очередь и паузы до старта. */
  interactiveWaitBudgetMs?: number;
  /** Сколько секунд паузы ставить, если FLOOD_WAIT пришёл без числа. */
  unknownFloodSeconds?: number;
  /** Зависший вызов: процесс должен выйти (см. core/recovery.ts). */
  onFatal: (reason: string) => void;
  log?: Logger;
  now?: () => number;
}

export interface CallOptions {
  /** Имя вызова для логов и ошибок, например `messages.GetHistory`. */
  label: string;
  priority?: Priority;
  deadlineMs?: number;
  waitBudgetMs?: number;
  /** Что делать, если вызов не вернулся к дедлайну. По умолчанию перезапуск процесса. */
  onHang?: 'restart' | 'error';
  /** Вызов что-то меняет в Telegram: при таймауте исход неизвестен. */
  write?: boolean;
}

export interface LaneStatus {
  queued: number;
  running: boolean;
  callsInWindow: number;
  perMinute: number;
  lastCallAt: number | null;
  /** Секунды до конца паузы FLOOD_WAIT, 0 если паузы нет. */
  floodWaitSeconds: number;
  /** Методы на долгой паузе: Telegram считает лимиты по методам, остальные вызовы работают. */
  pausedMethods: Array<{ label: string; seconds: number }>;
}

interface Item {
  op: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  label: string;
  priority: Priority;
  deadlineMs: number;
  /** Момент, после которого вызов уже не стартует. */
  startBy: number;
  onHang: 'restart' | 'error';
  write: boolean;
  retries: number;
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

interface Lane {
  queue: Item[];
  running: boolean;
  lastCallAt: number;
  windowStart: number;
  windowCount: number;
  floodWaitUntil: number;
  /** Долгие паузы отдельных методов: имя вызова -> момент окончания. */
  methodPausedUntil: Map<string, number>;
  /** Будит спящий цикл полосы: пришёл новый вызов или пора остановиться. */
  wake: (() => void) | null;
}

const WINDOW_MS = 60_000;

export class AccountLimiter {
  private readonly lanes = new Map<string, Lane>();
  private readonly minIntervalMs: number;
  private readonly perMinute: number;
  private readonly floodCapSeconds: number;
  private readonly maxFloodRetries: number;
  private readonly defaultDeadlineMs: number;
  private readonly interactiveWaitBudgetMs: number;
  private readonly unknownFloodSeconds: number;
  private readonly onFatal: (reason: string) => void;
  private readonly log: Logger;
  private readonly now: () => number;
  private stopped = false;

  constructor(options: LimiterOptions) {
    this.minIntervalMs = options.minIntervalMs ?? 500;
    this.perMinute = options.perMinute ?? 60;
    this.floodCapSeconds = options.floodCapSeconds ?? 300;
    this.maxFloodRetries = options.maxFloodRetries ?? 3;
    this.defaultDeadlineMs = options.defaultDeadlineMs ?? 20_000;
    this.interactiveWaitBudgetMs = options.interactiveWaitBudgetMs ?? 15_000;
    this.unknownFloodSeconds = options.unknownFloodSeconds ?? 30;
    this.onFatal = options.onFatal;
    this.log = options.log ?? createLogger('limiter');
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Выполняет op в полосе аккаунта: по одному, с паузами, дедлайном и разбором
   * FLOOD_WAIT. Отклоняется только GatewayError.
   */
  run<T>(accountId: string, op: () => Promise<T>, options: CallOptions): Promise<T> {
    if (this.stopped) {
      return Promise.reject(new GatewayError('UNAVAILABLE', 'The gateway is shutting down.'));
    }
    const lane = this.lane(accountId);
    const priority = options.priority ?? 'interactive';
    const budget =
      options.waitBudgetMs ??
      (priority === 'interactive' ? this.interactiveWaitBudgetMs : this.floodCapSeconds * 1000 + WINDOW_MS);
    const now = this.now();

    return new Promise<T>((resolve, reject) => {
      const item: Item = {
        op,
        resolve: resolve as (value: unknown) => void,
        reject,
        label: options.label,
        priority,
        deadlineMs: options.deadlineMs ?? this.defaultDeadlineMs,
        startBy: now + budget,
        onHang: options.onHang ?? 'restart',
        write: options.write ?? false,
        retries: 0,
        expiryTimer: null,
      };

      // Этот метод на долгой паузе: отвечаем сразу, остальные вызовы аккаунта не страдают.
      const methodLeft = (lane.methodPausedUntil.get(options.label) ?? 0) - now;
      if (methodLeft > 0) {
        reject(this.pausedError(methodLeft, options.label));
        return;
      }

      // Пауза уже длиннее бюджета: отвечаем сразу, очередь не занимаем.
      const floodLeft = lane.floodWaitUntil - now;
      if (floodLeft > budget) {
        reject(this.pausedError(floodLeft));
        return;
      }

      this.enqueue(accountId, lane, item);
    });
  }

  status(accountId: string): LaneStatus {
    const lane = this.lanes.get(accountId);
    const now = this.now();
    if (!lane) {
      return { queued: 0, running: false, callsInWindow: 0, perMinute: this.perMinute, lastCallAt: null, floodWaitSeconds: 0, pausedMethods: [] };
    }
    const pausedMethods: Array<{ label: string; seconds: number }> = [];
    for (const [label, until] of lane.methodPausedUntil) {
      if (until > now) pausedMethods.push({ label, seconds: Math.ceil((until - now) / 1000) });
      else lane.methodPausedUntil.delete(label);
    }
    return {
      queued: lane.queue.length,
      running: lane.running,
      callsInWindow: this.windowCount(lane, now),
      perMinute: this.perMinute,
      lastCallAt: lane.lastCallAt > 0 ? lane.lastCallAt : null,
      floodWaitSeconds: Math.max(0, Math.ceil((lane.floodWaitUntil - now) / 1000)),
      pausedMethods,
    };
  }

  /**
   * Наименее загруженный аккаунт из списка: для фоновых чтений публичных
   * каналов, которым всё равно, каким аккаунтом читать. Перенесено из
   * channel-scope `pickActiveClientId`.
   */
  pickLeastLoaded(accountIds: string[]): string | null {
    if (accountIds.length === 0) return null;
    const now = this.now();
    let best: string | null = null;
    let bestScore = Infinity;
    for (const id of accountIds) {
      const lane = this.lanes.get(id);
      if (lane && lane.floodWaitUntil > now) continue;
      const score = lane ? this.windowCount(lane, now) + lane.queue.length : 0;
      if (score < bestScore) {
        bestScore = score;
        best = id;
      }
    }
    if (best) return best;
    // Все на паузе: берём тот, что освободится раньше.
    let soonest = Infinity;
    for (const id of accountIds) {
      const until = this.lanes.get(id)?.floodWaitUntil ?? 0;
      if (until < soonest) {
        soonest = until;
        best = id;
      }
    }
    return best;
  }

  /** Ставит аккаунт на паузу извне, например после FLOOD_WAIT при скачивании файла. */
  pause(accountId: string, seconds: number): void {
    const lane = this.lane(accountId);
    lane.floodWaitUntil = Math.max(lane.floodWaitUntil, this.now() + seconds * 1000);
  }

  /** Останавливает приём и отклоняет всё, что ждёт в очередях. */
  shutdown(): void {
    this.stopped = true;
    for (const lane of this.lanes.values()) {
      for (const item of lane.queue.splice(0)) {
        this.clearExpiry(item);
        item.reject(new GatewayError('UNAVAILABLE', 'The gateway is shutting down.'));
      }
      lane.wake?.();
    }
  }

  // ---------- внутреннее ----------

  private lane(accountId: string): Lane {
    let lane = this.lanes.get(accountId);
    if (!lane) {
      lane = { queue: [], running: false, lastCallAt: 0, windowStart: this.now(), windowCount: 0, floodWaitUntil: 0, methodPausedUntil: new Map(), wake: null };
      this.lanes.set(accountId, lane);
    }
    return lane;
  }

  private enqueue(accountId: string, lane: Lane, item: Item, front = false): void {
    if (front) {
      lane.queue.unshift(item);
    } else if (item.priority === 'interactive') {
      // Вызовы агента встают перед фоновыми, но после своих же.
      const firstBackground = lane.queue.findIndex(q => q.priority === 'background');
      if (firstBackground === -1) lane.queue.push(item);
      else lane.queue.splice(firstBackground, 0, item);
    } else {
      lane.queue.push(item);
    }

    this.armExpiry(lane, item);

    if (lane.running) {
      lane.wake?.();
    } else {
      void this.drain(accountId, lane);
    }
  }

  /** Вызов, который не успел стартовать за свой бюджет, получает ошибку сам, не дожидаясь очереди. */
  private armExpiry(lane: Lane, item: Item): void {
    this.clearExpiry(item);
    const ms = Math.max(0, item.startBy - this.now());
    if (ms >= MAX_TIMER_MS) return;
    item.expiryTimer = setTimeout(() => {
      const index = lane.queue.indexOf(item);
      if (index === -1) return;
      lane.queue.splice(index, 1);
      item.reject(this.waitTooLongError(lane));
    }, ms + 1);
    if (typeof item.expiryTimer.unref === 'function') item.expiryTimer.unref();
  }

  private clearExpiry(item: Item): void {
    if (item.expiryTimer) {
      clearTimeout(item.expiryTimer);
      item.expiryTimer = null;
    }
  }

  private async drain(accountId: string, lane: Lane): Promise<void> {
    lane.running = true;
    try {
      while (!this.stopped) {
        const item = lane.queue[0];
        if (!item) break;

        const now = this.now();
        const waitMs = this.requiredWait(lane, now);
        const budgetLeft = item.startBy - now;

        if (waitMs > budgetLeft) {
          lane.queue.shift();
          this.clearExpiry(item);
          item.reject(this.waitTooLongError(lane));
          continue;
        }

        if (waitMs > 0) {
          // Спим не дольше нужного; новый вызов будит цикл, и голова очереди
          // выбирается заново (вызов агента мог встать перед фоновым).
          await this.interruptibleSleep(lane, waitMs);
          continue;
        }

        lane.queue.shift();
        this.clearExpiry(item);
        await this.execute(accountId, lane, item);
      }
    } finally {
      lane.running = false;
      lane.wake = null;
    }
  }

  private requiredWait(lane: Lane, now: number): number {
    let wait = 0;
    if (lane.floodWaitUntil > now) wait = Math.max(wait, lane.floodWaitUntil - now);
    const sinceLast = now - lane.lastCallAt;
    if (lane.lastCallAt > 0 && sinceLast < this.minIntervalMs) wait = Math.max(wait, this.minIntervalMs - sinceLast);
    if (this.windowCount(lane, now) >= this.perMinute) wait = Math.max(wait, lane.windowStart + WINDOW_MS - now);
    return wait;
  }

  private windowCount(lane: Lane, now: number): number {
    if (now - lane.windowStart >= WINDOW_MS) {
      lane.windowStart = now;
      lane.windowCount = 0;
    }
    return lane.windowCount;
  }

  private interruptibleSleep(lane: Lane, ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        lane.wake = null;
        resolve();
      }, Math.min(ms, MAX_TIMER_MS));
      lane.wake = () => {
        clearTimeout(timer);
        lane.wake = null;
        resolve();
      };
    });
  }

  private async execute(accountId: string, lane: Lane, item: Item): Promise<void> {
    const startedAt = this.now();
    this.windowCount(lane, startedAt);
    lane.windowCount++;
    lane.lastCallAt = startedAt;

    try {
      // Дедлайн внутри полосы: зависший вызов освобождает её по времени.
      const result = await withTimeout(item.op(), item.deadlineMs, item.label);
      item.resolve(result);
    } catch (err) {
      if (err instanceof DeadlineError) {
        this.log.error('call timed out', { account: accountId, label: item.label, deadlineMs: item.deadlineMs });
        item.reject(classifyError(err, { write: item.write }));
        if (item.onHang === 'restart') {
          this.onFatal(`${item.label} did not return in ${item.deadlineMs}ms (account ${accountId})`);
        }
        return;
      }

      const flood = floodInfo(err);
      if (flood !== null) {
        const seconds = flood.seconds > 0 ? flood.seconds : this.unknownFloodSeconds;
        const now = this.now();
        this.log.warn('FLOOD_WAIT', { account: accountId, label: item.label, seconds, scope: flood.scope });

        // Медленный режим одного чата: аккаунт не на паузе, повторять вызов не нужно.
        if (flood.scope === 'chat') {
          item.reject(classifyError(err, { write: item.write }));
          return;
        }
        // Долгая пауза относится к методу (например, ResolveUsername на сутки): остальные
        // вызовы аккаунта продолжают работать, а этот метод отвечает ошибкой до конца паузы.
        if (seconds > this.floodCapSeconds) {
          lane.methodPausedUntil.set(item.label, now + seconds * 1000);
          item.reject(
            new GatewayError('FLOOD_WAIT', `Telegram rate limit for ${item.label}: wait ${seconds} seconds. Do NOT retry before retry_after. Other kinds of requests still work.`, {
              retryAfter: seconds,
              cause: err,
            }),
          );
          return;
        }
        lane.floodWaitUntil = Math.max(lane.floodWaitUntil, now + seconds * 1000);

        const fitsBudget = seconds * 1000 <= item.startBy - now;
        if (seconds <= this.floodCapSeconds && fitsBudget && item.retries < this.maxFloodRetries) {
          // FLOOD_WAIT значит, что запрос не выполнен: повтор безопасен и для записи.
          item.retries++;
          this.enqueue(accountId, lane, item, true);
          return;
        }
        item.reject(
          new GatewayError('FLOOD_WAIT', `Telegram rate limit: wait ${seconds} seconds. Do NOT retry before retry_after.`, {
            retryAfter: seconds,
            cause: err,
          }),
        );
        return;
      }

      item.reject(classifyError(err, { write: item.write }));
    }
  }

  private pausedError(floodLeftMs: number, label?: string): GatewayError {
    const seconds = Math.ceil(floodLeftMs / 1000);
    return new GatewayError(
      'FLOOD_WAIT',
      label
        ? `Telegram rate limit for ${label}: ${seconds} more seconds. Do NOT retry before retry_after. Other kinds of requests still work.`
        : `This account is paused by a Telegram rate limit for ${seconds} more seconds. Do NOT retry before retry_after.`,
      { retryAfter: seconds },
    );
  }

  private waitTooLongError(lane: Lane): GatewayError {
    const now = this.now();
    const floodLeft = lane.floodWaitUntil - now;
    if (floodLeft > 0) return this.pausedError(floodLeft);
    const retryAfter = Math.max(1, Math.ceil(this.requiredWait(lane, now) / 1000));
    return new GatewayError(
      'FLOOD_WAIT',
      `The gateway queue for this account is busy (own rate limit of ${this.perMinute} calls per minute). Retry after retry_after seconds.`,
      { retryAfter },
    );
  }
}
