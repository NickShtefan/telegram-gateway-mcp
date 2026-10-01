import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock dependencies before importing the subject under test.
// ---------------------------------------------------------------------------

vi.mock('../db/models/Client.js', () => ({
  default: {
    find: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
  },
}));

vi.mock('../services/clientManager.js', () => {
  const { EventEmitter } = require('events');
  const emitter = new EventEmitter();
  return {
    clientManager: Object.assign(emitter, {
      getClient: vi.fn(),
      getFirstActiveClient: vi.fn(),
    }),
  };
});

import { TelegramRateLimiter } from '../services/rateLimiter.js';
import type { TelegramClient } from 'telegram';
import type { Api } from 'telegram';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockClient(opts: {
  delayMs?: number;
  error?: Error;
  counter?: { n: number };
}): TelegramClient {
  const delayMs = opts.delayMs ?? 10;
  return {
    invoke: vi.fn(async () => {
      if (opts.counter) opts.counter.n++;
      await new Promise((r) => setTimeout(r, delayMs));
      if (opts.error) throw opts.error;
      return { ok: true } as unknown;
    }),
  } as unknown as TelegramClient;
}

// Dummy request — content doesn't matter, workers pass it through verbatim.
const fakeRequest = {} as Api.AnyRequest;

// The rate limiter enforces a 2-second minimum gap per client. For fast tests
// we build a fresh instance and bypass slot-waiting by monkey-patching the
// module-private state (requestsPerMinute is high enough; MIN_INTERVAL_MS is
// the blocker). We work around it by simply waiting one iteration at a time —
// but a cleaner approach is to set lastRequestAt in the past by pre-running
// one request, then measuring the SECOND. Since that's awkward, we instead
// accept the 2s floor for some tests and verify timing accordingly. For
// parallelism, what matters is that two workers serve two items in one
// floor-period, not two floor-periods.

describe('TelegramRateLimiter — parallel per-client workers', () => {
  let limiter: TelegramRateLimiter;

  beforeEach(() => {
    limiter = new TelegramRateLimiter(1000); // high RPM so not a bottleneck
  });

  afterEach(async () => {
    await limiter._shutdown();
  });

  it('dispatches null-clientId items across workers in parallel', async () => {
    const counterA = { n: 0 };
    const counterB = { n: 0 };
    const clientA = makeMockClient({ delayMs: 100, counter: counterA });
    const clientB = makeMockClient({ delayMs: 100, counter: counterB });

    limiter._setActiveIdsLoader(async () => ['A', 'B']);
    limiter._setClientResolver(async (id) => (id === 'A' ? clientA : clientB));

    await limiter._syncWorkersNow();
    expect(limiter.workerCount).toBe(2);

    const start = Date.now();
    const results = await Promise.all([
      limiter.invoke(fakeRequest),
      limiter.invoke(fakeRequest),
    ]);
    const elapsed = Date.now() - start;

    expect(results).toHaveLength(2);
    // Both workers received exactly one invoke each (parallel fan-out).
    expect(counterA.n).toBe(1);
    expect(counterB.n).toBe(1);
    // Parallel: ~100ms. Serial would be ~200ms. Allow 180ms headroom.
    expect(elapsed).toBeLessThan(180);
  }, 10_000);

  it('routes explicit-clientId items only to the matching worker', async () => {
    const counterA = { n: 0 };
    const counterB = { n: 0 };
    const clientA = makeMockClient({ delayMs: 10, counter: counterA });
    const clientB = makeMockClient({ delayMs: 10, counter: counterB });

    limiter._setActiveIdsLoader(async () => ['A', 'B']);
    limiter._setClientResolver(async (id) => (id === 'A' ? clientA : clientB));
    await limiter._syncWorkersNow();

    // 3 items all targeting A — B should stay idle.
    await Promise.all([
      limiter.invoke(fakeRequest, 'A'),
      limiter.invoke(fakeRequest, 'A'),
      limiter.invoke(fakeRequest, 'A'),
    ]);

    expect(counterA.n).toBe(3);
    expect(counterB.n).toBe(0);
  }, 10_000);

  it('FLOOD_WAIT on one client does not block others', async () => {
    const counterA = { n: 0 };
    const counterB = { n: 0 };
    // Use a big wait (60s) to make "A is stuck" observable, but we'll never
    // await A's promise — we verify B served null-items anyway and tear the
    // limiter down in afterEach.
    const floodErr = Object.assign(new Error('FLOOD_WAIT_60'), {
      errorMessage: 'FLOOD_WAIT_60',
      seconds: 60,
    });
    const clientA = makeMockClient({ delayMs: 5, error: floodErr, counter: counterA });
    const clientB = makeMockClient({ delayMs: 5, counter: counterB });

    limiter._setActiveIdsLoader(async () => ['A', 'B']);
    limiter._setClientResolver(async (id) => (id === 'A' ? clientA : clientB));
    await limiter._syncWorkersNow();

    // Kick A into flood by sending it one explicit item first.
    const aPromise = limiter.invoke(fakeRequest, 'A').catch(() => 'rejected');
    // Let A's worker pick up, hit flood, and enter its 60s cooldown.
    await new Promise((r) => setTimeout(r, 50));

    // Now send 2 null-clientId items; B should serve them both even though
    // A is parked in flood-wait.
    const start = Date.now();
    const results = await Promise.all([
      limiter.invoke(fakeRequest),
      limiter.invoke(fakeRequest),
    ]);
    const elapsed = Date.now() - start;

    expect(results).toHaveLength(2);
    expect(counterB.n).toBeGreaterThanOrEqual(2);
    // Neither of the two null-items should have been forced to wait for A's
    // 60-second flood. If A had blocked, elapsed would exceed a second easily.
    expect(elapsed).toBeLessThan(5_000);

    // A's promise is parked in 60s flood-wait — don't await it here. The
    // `catch(() => 'rejected')` above ensures no unhandled-rejection warning.
    void aPromise;
  }, 15_000);

  it('stops workers for clients that transition out of active', async () => {
    const clientA = makeMockClient({ delayMs: 5 });
    const clientB = makeMockClient({ delayMs: 5 });

    let active: string[] = ['A', 'B'];
    limiter._setActiveIdsLoader(async () => active);
    limiter._setClientResolver(async (id) => (id === 'A' ? clientA : clientB));

    await limiter._syncWorkersNow();
    expect(limiter.workerCount).toBe(2);

    active = ['A']; // B deactivated
    await limiter._syncWorkersNow();

    // Give the stopped worker a moment to exit its loop.
    await new Promise((r) => setTimeout(r, 50));
    expect(limiter.workerCount).toBe(1);
  }, 10_000);

  it('starts workers for clients that newly become active', async () => {
    const clientA = makeMockClient({ delayMs: 5 });
    let active: string[] = [];
    limiter._setActiveIdsLoader(async () => active);
    limiter._setClientResolver(async () => clientA);

    await limiter._syncWorkersNow();
    expect(limiter.workerCount).toBe(0);

    active = ['A'];
    await limiter._syncWorkersNow();
    expect(limiter.workerCount).toBe(1);
  });
});
