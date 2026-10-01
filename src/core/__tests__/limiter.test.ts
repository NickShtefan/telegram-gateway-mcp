import { RPCMessageToError } from 'teleproto/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayError } from '../errors.js';
import { AccountLimiter } from '../limiter.js';
import { createLogger } from '../log.js';
import { createFatalHandler, TickWatchdog } from '../recovery.js';

const silent = createLogger('test', { level: 'silent' });

function makeLimiter(overrides: Partial<ConstructorParameters<typeof AccountLimiter>[0]> = {}) {
  const onFatal = vi.fn();
  const limiter = new AccountLimiter({ onFatal, log: silent, ...overrides });
  return { limiter, onFatal };
}

function floodError(seconds: number): Error {
  return Object.assign(new Error(`A wait of ${seconds} seconds is required`), {
    seconds,
    errorMessage: `FLOOD_WAIT_${seconds}`,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AccountLimiter: полоса и паузы', () => {
  it('выполняет вызовы одного аккаунта строго по одному и с паузой между ними', async () => {
    const { limiter } = makeLimiter({ minIntervalMs: 500 });
    const starts: number[] = [];
    let active = 0;
    let maxActive = 0;
    const op = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      starts.push(Date.now());
      await new Promise(r => setTimeout(r, 100));
      active--;
      return starts.length;
    };

    const all = Promise.all([1, 2, 3].map(() => limiter.run('a', op, { label: 'op' })));
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(all).resolves.toEqual([1, 2, 3]);
    expect(maxActive).toBe(1);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(500);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(500);
  });

  it('аккаунты не блокируют друг друга', async () => {
    const { limiter } = makeLimiter();
    const order: string[] = [];
    const slow = limiter.run('a', async () => {
      await new Promise(r => setTimeout(r, 5_000));
      order.push('a');
    }, { label: 'slow' });
    const fast = limiter.run('b', async () => {
      order.push('b');
    }, { label: 'fast' });
    await vi.advanceTimersByTimeAsync(10);
    await fast;
    expect(order).toEqual(['b']);
    await vi.advanceTimersByTimeAsync(5_000);
    await slow;
    expect(order).toEqual(['b', 'a']);
  });

  it('вызов агента обгоняет фоновые в очереди', async () => {
    const { limiter } = makeLimiter({ minIntervalMs: 0 });
    const order: string[] = [];
    const mk = (name: string) => async () => {
      order.push(name);
      await new Promise(r => setTimeout(r, 10));
    };
    const p = [
      limiter.run('a', mk('bg1'), { label: 'bg1', priority: 'background' }),
      limiter.run('a', mk('bg2'), { label: 'bg2', priority: 'background' }),
      limiter.run('a', mk('bg3'), { label: 'bg3', priority: 'background' }),
      limiter.run('a', mk('agent1'), { label: 'agent1' }),
      limiter.run('a', mk('agent2'), { label: 'agent2' }),
    ];
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all(p);
    // bg1 уже выполнялся, остальные перестроились: сначала агент, потом фон.
    expect(order).toEqual(['bg1', 'agent1', 'agent2', 'bg2', 'bg3']);
  });

  it('держит лимит вызовов в минуту', async () => {
    const { limiter } = makeLimiter({ minIntervalMs: 0, perMinute: 3, interactiveWaitBudgetMs: 120_000 });
    const times: number[] = [];
    const p = Promise.all(
      [1, 2, 3, 4].map(() => limiter.run('a', async () => void times.push(Date.now()), { label: 'op' })),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(times).toHaveLength(3);
    expect(limiter.status('a').callsInWindow).toBe(3);
    await vi.advanceTimersByTimeAsync(60_000);
    await p;
    expect(times).toHaveLength(4);
    expect(times[3]! - times[0]!).toBeGreaterThanOrEqual(60_000);
  });
});

describe('AccountLimiter: FLOOD_WAIT', () => {
  it('короткую паузу пережидает и повторяет вызов', async () => {
    const { limiter } = makeLimiter();
    let calls = 0;
    const p = limiter.run('a', async () => {
      calls++;
      if (calls === 1) throw floodError(5);
      return 'ok';
    }, { label: 'messages.Search' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(1);
    expect(limiter.status('a').floodWaitSeconds).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(p).resolves.toBe('ok');
    expect(calls).toBe(2);
  });

  it('паузу длиннее бюджета возвращает ошибкой с retry_after и не ждёт', async () => {
    const { limiter } = makeLimiter({ interactiveWaitBudgetMs: 15_000 });
    const p = limiter.run('a', async () => {
      throw floodError(120);
    }, { label: 'contacts.ResolveUsername' });
    const assertion = expect(p).rejects.toMatchObject({ code: 'FLOOD_WAIT', retryAfter: 120 });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });

  it('пока аккаунт на паузе, следующий вызов агента отклоняется сразу', async () => {
    const { limiter } = makeLimiter();
    const first = limiter.run('a', async () => {
      throw floodError(200);
    }, { label: 'first' });
    first.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);

    const op = vi.fn(async () => 'never');
    await expect(limiter.run('a', op, { label: 'second' })).rejects.toMatchObject({ code: 'FLOOD_WAIT' });
    expect(op).not.toHaveBeenCalled();
    const err = (await limiter.run('a', op, { label: 'third' }).catch((e: unknown) => e)) as GatewayError;
    expect(err.retryAfter).toBeGreaterThan(190);
    expect(err.retryAfter).toBeLessThanOrEqual(200);
  });

  it('фоновый вызов ждёт паузу до предела, дольше предела пропускает', async () => {
    const { limiter } = makeLimiter({ floodCapSeconds: 300 });
    let calls = 0;
    const waited = limiter.run('a', async () => {
      calls++;
      if (calls === 1) throw floodError(120);
      return 'done';
    }, { label: 'bg', priority: 'background' });
    await vi.advanceTimersByTimeAsync(121_000);
    await expect(waited).resolves.toBe('done');

    const skipped = limiter.run('b', async () => {
      throw floodError(301);
    }, { label: 'bg-long', priority: 'background' });
    const assertion = expect(skipped).rejects.toMatchObject({ code: 'FLOOD_WAIT', retryAfter: 301 });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });

  it('FLOOD_WAIT без числа ставит паузу по умолчанию', async () => {
    const { limiter } = makeLimiter({ unknownFloodSeconds: 30, interactiveWaitBudgetMs: 1_000 });
    const p = limiter.run('a', async () => {
      throw new Error('FLOOD_WAIT');
    }, { label: 'op' });
    const assertion = expect(p).rejects.toMatchObject({ code: 'FLOOD_WAIT', retryAfter: 30 });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });

  it('пауза одного аккаунта не трогает другой', async () => {
    const { limiter } = makeLimiter();
    limiter.pause('a', 100);
    await expect(limiter.run('b', async () => 'ok', { label: 'op' })).resolves.toBe('ok');
    expect(limiter.pickLeastLoaded(['a', 'b'])).toBe('b');
    expect(limiter.pickLeastLoaded(['a'])).toBe('a');
    expect(limiter.pickLeastLoaded([])).toBeNull();
  });
});

describe('AccountLimiter: настоящие ошибки GramJS', () => {
  const real = (message: string, method: string): Error =>
    RPCMessageToError({ errorCode: 420, errorMessage: message } as never, { className: method } as never) as Error;

  it('короткий FLOOD_WAIT от GramJS пережидается и вызов повторяется', async () => {
    const { limiter } = makeLimiter();
    let calls = 0;
    const p = limiter.run('a', async () => {
      calls++;
      if (calls === 1) throw real('FLOOD_WAIT_5', 'messages.GetHistory');
      return 'ok';
    }, { label: 'messages.GetHistory' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(limiter.status('a').floodWaitSeconds).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(p).resolves.toBe('ok');
    expect(calls).toBe(2);
  });

  it('долгая пауза закрывает только тот метод, который её получил', async () => {
    const { limiter } = makeLimiter({ floodCapSeconds: 300 });
    const first = limiter.run('a', async () => {
      throw real('FLOOD_WAIT_3600', 'contacts.ResolveUsername');
    }, { label: 'contacts.ResolveUsername' });
    const rejected = expect(first).rejects.toMatchObject({ code: 'FLOOD_WAIT', retryAfter: 3600 });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;

    const op = vi.fn(async () => 'never');
    const again = (await limiter.run('a', op, { label: 'contacts.ResolveUsername' }).catch((e: unknown) => e)) as GatewayError;
    expect(again.code).toBe('FLOOD_WAIT');
    expect(again.message).toContain('Other kinds of requests still work');
    expect(op).not.toHaveBeenCalled();

    const other = limiter.run('a', async () => 'history', { label: 'messages.GetHistory' });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(other).resolves.toBe('history');

    const status = limiter.status('a');
    expect(status.floodWaitSeconds).toBe(0);
    expect(status.pausedMethods).toHaveLength(1);
    expect(status.pausedMethods[0]).toMatchObject({ label: 'contacts.ResolveUsername' });

    await vi.advanceTimersByTimeAsync(3_600_000);
    await expect(limiter.run('a', async () => 'resolved', { label: 'contacts.ResolveUsername' })).resolves.toBe('resolved');
    expect(limiter.status('a').pausedMethods).toEqual([]);
  });

  it('медленный режим чата не ставит аккаунт на паузу и не повторяется', async () => {
    const { limiter } = makeLimiter();
    const op = vi.fn(async () => {
      throw real('SLOWMODE_WAIT_30', 'messages.SendMessage');
    });
    const p = limiter.run('a', op, { label: 'messages.SendMessage', write: true });
    const rejected = expect(p).rejects.toMatchObject({ code: 'FLOOD_WAIT', retryAfter: 30 });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(op).toHaveBeenCalledTimes(1);
    expect(limiter.status('a').floodWaitSeconds).toBe(0);
    const other = limiter.run('a', async () => 'ok', { label: 'messages.GetHistory' });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(other).resolves.toBe('ok');
  });
});

describe('AccountLimiter: дедлайны и зависания', () => {
  it('зависший вызов отдаёт TIMEOUT, требует перезапуск и освобождает полосу', async () => {
    const { limiter, onFatal } = makeLimiter({ defaultDeadlineMs: 20_000 });
    const hung = limiter.run('a', () => new Promise<never>(() => undefined), { label: 'messages.GetHistory' });
    const hungAssertion = expect(hung).rejects.toMatchObject({ code: 'TIMEOUT', outcomeUnknown: false });
    const next = limiter.run('a', async () => 'after', { label: 'next', waitBudgetMs: 60_000 });
    await vi.advanceTimersByTimeAsync(20_001);
    await hungAssertion;
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0]![0]).toContain('messages.GetHistory');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(next).resolves.toBe('after');
  });

  it('таймаут записи сообщает, что исход неизвестен', async () => {
    const { limiter } = makeLimiter();
    const p = limiter.run('a', () => new Promise<never>(() => undefined), { label: 'messages.SendMessage', write: true, deadlineMs: 1_000 });
    const assertion = expect(p).rejects.toMatchObject({ code: 'TIMEOUT', outcomeUnknown: true });
    await vi.advanceTimersByTimeAsync(1_001);
    await assertion;
  });

  it('onHang=error не роняет процесс', async () => {
    const { limiter, onFatal } = makeLimiter();
    const p = limiter.run('a', () => new Promise<never>(() => undefined), { label: 'download', deadlineMs: 1_000, onHang: 'error' });
    const assertion = expect(p).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(1_001);
    await assertion;
    expect(onFatal).not.toHaveBeenCalled();
  });

  it('вызов, не дождавшийся очереди за бюджет, получает ошибку сам', async () => {
    const { limiter } = makeLimiter({ interactiveWaitBudgetMs: 2_000 });
    const long = limiter.run('a', () => new Promise(r => setTimeout(() => r('long'), 10_000)), { label: 'long' });
    const op = vi.fn(async () => 'queued');
    const queued = limiter.run('a', op, { label: 'queued' });
    const assertion = expect(queued).rejects.toMatchObject({ code: 'FLOOD_WAIT' });
    await vi.advanceTimersByTimeAsync(2_100);
    await assertion;
    expect(op).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(long).resolves.toBe('long');
  });

  it('ошибки Telegram приходят классифицированными', async () => {
    const { limiter } = makeLimiter();
    await expect(
      limiter.run('a', async () => {
        throw new Error('CHANNEL_PRIVATE');
      }, { label: 'op' }),
    ).rejects.toMatchObject({ code: 'CHAT_PRIVATE' });
  });

  it('после shutdown очередь отклоняется, новые вызовы не принимаются', async () => {
    const { limiter } = makeLimiter();
    const running = limiter.run('a', () => new Promise(r => setTimeout(() => r('x'), 1_000)), { label: 'running' });
    const queued = limiter.run('a', async () => 'y', { label: 'queued' });
    const assertion = expect(queued).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    limiter.shutdown();
    await assertion;
    await expect(limiter.run('a', async () => 'z', { label: 'late' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(running).resolves.toBe('x');
  });
});

describe('recovery', () => {
  it('fatal handler выходит с кодом 1 один раз', () => {
    const exit = vi.fn();
    const beforeExit = vi.fn();
    const fatal = createFatalHandler({ exit, beforeExit, log: silent });
    fatal('hung call');
    fatal('second');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(beforeExit).toHaveBeenCalledTimes(1);
  });

  it('перед выходом ждущие вызовы получают ошибку и успевают её записать', async () => {
    const exit = vi.fn();
    const order: string[] = [];
    const fatal = createFatalHandler({ exit, log: silent, graceMs: 300, prepare: () => order.push('prepare'), beforeExit: () => order.push('beforeExit') });
    fatal('hung call');
    expect(order).toEqual(['prepare']);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(order).toEqual(['prepare', 'beforeExit']);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('watchdog считает пропущенные тики и поднимает тревогу', () => {
    const onStuck = vi.fn();
    const dog = new TickWatchdog({ name: 'watcher', maxMissedTicks: 3, onStuck, log: silent });
    expect(dog.begin()).toBe(true);
    expect(dog.begin()).toBe(false);
    expect(dog.begin()).toBe(false);
    expect(onStuck).not.toHaveBeenCalled();
    expect(dog.begin()).toBe(false);
    expect(onStuck).toHaveBeenCalledWith(3);
    dog.end();
    expect(dog.begin()).toBe(true);
    expect(dog.missedTicks).toBe(0);
  });
});
