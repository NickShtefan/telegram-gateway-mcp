import { describe, it, expect, beforeEach } from 'vitest';
import { runExclusive, __resetGateForTests } from '../gramGate.js';
import { withTimeout, StageTimeoutError } from '../../workers/refreshShared.js';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('gramGate.runExclusive', () => {
  beforeEach(() => {
    __resetGateForTests();
  });

  it('сериализует конкурентные операции', async () => {
    const order: string[] = [];
    const first = deferred<void>();

    const p1 = runExclusive('op1', async () => {
      order.push('op1:start');
      await first.promise;
      order.push('op1:end');
    });
    const p2 = runExclusive('op2', async () => {
      order.push('op2:start');
    });

    // op2 не стартует, пока op1 держит полосу
    await new Promise(r => setTimeout(r, 10));
    expect(order).toEqual(['op1:start']);

    first.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['op1:start', 'op1:end', 'op2:start']);
  });

  it('отказ операции не отравляет цепочку', async () => {
    await expect(runExclusive('bad', async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    await expect(runExclusive('good', async () => 42)).resolves.toBe(42);
  });

  it('зависшая операция с таймаутом ВНУТРИ гейта освобождает полосу (#81)', async () => {
    const neverSettles = new Promise<never>(() => {});

    const p1 = runExclusive('stuck', () => withTimeout(neverSettles, 30, 'stuck-stage'));
    const p2 = runExclusive('next', async () => 'alive');

    await expect(p1).rejects.toBeInstanceOf(StageTimeoutError);
    await expect(p2).resolves.toBe('alive');
  });
});
