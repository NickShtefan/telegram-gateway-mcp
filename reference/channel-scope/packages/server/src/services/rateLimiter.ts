import { EventEmitter } from 'events';
import type { TelegramClient } from 'telegram';
import { Api } from 'telegram';
import Client from '../db/models/Client.js';
import { clientManager } from './clientManager.js';

interface QueueItem {
  request: Api.AnyRequest;
  clientId: string | null; // null = any available client
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  retries: number;
}

interface ClientState {
  lastRequestAt: number;
  requestCount: number;
  windowStart: number;
  floodWaitUntil: number;
}

interface Worker {
  running: boolean;   // worker loop is currently alive
  stop: boolean;      // request to stop
  wake: () => void;   // resolves the pending idle-sleep promise, if any
}

const DEFAULT_REQUESTS_PER_MINUTE = 60;
const MAX_RETRIES = 3;
const MIN_INTERVAL_MS = 500; // minimum 500ms between requests per client (Telegram handles ~2/s sustained)
const SYNC_POLL_MS = 30_000;  // fallback poll interval for active-clients sync

/**
 * Parallel per-client rate limiter.
 *
 * Each active client runs its own worker loop. A shared FIFO queue holds items;
 * items with `clientId === null` can be picked by any worker (the first to have
 * a free slot wins), items with an explicit clientId are picked only by the
 * matching worker. FLOOD_WAIT on one client does not block others.
 *
 * The public API (`invoke<T>(request, clientId?)`) is unchanged.
 */
class TelegramRateLimiter extends EventEmitter {
  private queue: QueueItem[] = [];
  private clientStates: Map<string, ClientState> = new Map();
  private workers: Map<string, Worker> = new Map();
  private requestsPerMinute: number;
  private syncTimer: NodeJS.Timeout | null = null;
  private initialized = false;

  // Optional DI for tests — swap the client resolver without mocking modules.
  private clientResolver: (id: string) => Promise<TelegramClient> = (id) =>
    clientManager.getClient(id);
  private activeIdsLoader: () => Promise<string[]> = async () => {
    const docs = await Client.find({ status: 'active' }).lean();
    return docs.map((d) => d._id.toString());
  };

  constructor(requestsPerMinute = DEFAULT_REQUESTS_PER_MINUTE) {
    super();
    this.requestsPerMinute = requestsPerMinute;
  }

  /**
   * Execute a Telegram API request through the rate-limited queue.
   * If clientId is null, any worker whose client is free may pick it up.
   */
  async invoke<T>(request: Api.AnyRequest, clientId: string | null = null): Promise<T> {
    // Lazy init — start workers + subscribe to clientManager events on first use.
    if (!this.initialized) {
      this.initialized = true;
      // Fire-and-forget; workers that appear later will still drain the queue.
      void this.syncWorkers();
      this.subscribeToClientStatus();
      this.startSyncPoll();
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        request,
        clientId,
        resolve: resolve as (result: unknown) => void,
        reject,
        retries: 0,
      });
      this.wakeAll();
    });
  }

  /** Pending items in the shared queue. */
  get pendingCount(): number {
    return this.queue.length;
  }

  /**
   * Pick the least-loaded active client ID for a multi-step, session-bound
   * sequence (e.g. GetChannels → GetFullChannel → downloadProfilePhoto where
   * access_hash must stay on one client). Returns null if no client is active.
   *
   * This is the pool-aware replacement for `clientManager.getFirstActiveClient()`
   * in call-sites that previously hard-coded the first active client and
   * thereby funneled all work through account A.
   */
  async pickActiveClientId(): Promise<string | null> {
    if (!this.initialized) {
      this.initialized = true;
      void this.syncWorkers();
      this.subscribeToClientStatus();
      this.startSyncPoll();
    }
    let ids: string[];
    try {
      ids = await this.activeIdsLoader();
    } catch {
      return null;
    }
    if (ids.length === 0) return null;

    const now = Date.now();
    let bestId: string | null = null;
    let bestScore = Infinity;
    for (const id of ids) {
      const state = this.getClientState(id);
      if (state.floodWaitUntil > now) continue;
      const windowRequests = this.getWindowRequests(state, now);
      if (windowRequests < bestScore) { bestScore = windowRequests; bestId = id; }
    }
    // All clients in flood wait — return the one freeing up soonest.
    if (!bestId) {
      let soonest = Infinity;
      for (const id of ids) {
        const state = this.getClientState(id);
        if (state.floodWaitUntil < soonest) { soonest = state.floodWaitUntil; bestId = id; }
      }
    }
    return bestId;
  }

  /** Number of currently-running worker loops (visible for tests). */
  get workerCount(): number {
    let n = 0;
    for (const w of this.workers.values()) if (w.running) n++;
    return n;
  }

  // -----------------------------------------------------------------------
  // Testing hooks — not part of the public surface used by app code.
  // -----------------------------------------------------------------------
  _setClientResolver(fn: (id: string) => Promise<TelegramClient>): void {
    this.clientResolver = fn;
  }
  _setActiveIdsLoader(fn: () => Promise<string[]>): void {
    this.activeIdsLoader = fn;
  }
  async _syncWorkersNow(): Promise<void> {
    await this.syncWorkers();
  }
  async _shutdown(): Promise<void> {
    if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = null; }
    for (const w of this.workers.values()) { w.stop = true; w.wake(); }
    // Let workers drain.
    const timeout = Date.now() + 2000;
    while (this.workerCount > 0 && Date.now() < timeout) {
      await this.sleep(10);
    }
    this.workers.clear();
  }

  // -----------------------------------------------------------------------
  // Worker lifecycle
  // -----------------------------------------------------------------------

  private subscribeToClientStatus(): void {
    clientManager.on('status', () => { void this.syncWorkers(); });
  }

  private startSyncPoll(): void {
    if (this.syncTimer) return;
    this.syncTimer = setInterval(() => { void this.syncWorkers(); }, SYNC_POLL_MS);
    // Don't keep the process alive just for polling.
    if (typeof this.syncTimer.unref === 'function') this.syncTimer.unref();
  }

  private async syncWorkers(): Promise<void> {
    let activeIds: string[];
    try {
      activeIds = await this.activeIdsLoader();
    } catch (err) {
      console.warn('[RateLimiter] syncWorkers: failed to load active clients:', (err as Error).message);
      return;
    }
    const activeSet = new Set(activeIds);

    // Start workers for newly-active clients.
    for (const id of activeIds) {
      if (!this.workers.has(id) || !this.workers.get(id)!.running) {
        this.startWorker(id);
      }
    }

    // Stop workers for clients that are no longer active.
    for (const [id, worker] of this.workers) {
      if (!activeSet.has(id) && worker.running) {
        worker.stop = true;
        worker.wake();
      }
    }
  }

  private startWorker(clientId: string): void {
    const existing = this.workers.get(clientId);
    if (existing && existing.running) return;

    const worker: Worker = {
      running: true,
      stop: false,
      wake: () => { /* replaced during loop */ },
    };
    this.workers.set(clientId, worker);
    void this.workerLoop(clientId, worker).catch((err) => {
      console.error(`[RateLimiter] Worker ${clientId} crashed:`, err);
    }).finally(() => {
      worker.running = false;
    });
  }

  private wakeAll(): void {
    for (const w of this.workers.values()) w.wake();
  }

  /**
   * Main per-client worker loop.
   *
   * Pulls eligible items from the shared queue. An item is eligible for this
   * worker if (a) `item.clientId === null` (any worker can take it) or
   * (b) `item.clientId === clientId`. If no eligible item is available, the
   * loop waits on a wake-up promise (resolved by `invoke` or by syncWorkers).
   */
  private async workerLoop(clientId: string, worker: Worker): Promise<void> {
    while (!worker.stop) {
      const item = this.takeEligible(clientId);
      if (!item) {
        // Idle — wait until someone wakes us or a short timeout (safety).
        await new Promise<void>((resolve) => {
          worker.wake = resolve;
          // Safety timer so we never hang forever if a wake() call races the
          // assignment above (we reassign wake each iteration).
          const t = setTimeout(resolve, 1000);
          if (typeof t.unref === 'function') t.unref();
        });
        continue;
      }

      try {
        await this.waitForSlot(clientId, worker);
        if (worker.stop) {
          // Re-queue the item so another worker (or the next activation of
          // this client) can handle it.
          this.queue.unshift(item);
          this.wakeAll();
          break;
        }

        const client = await this.clientResolver(clientId);
        this.recordRequest(clientId);
        await this.executeRequest(client, item, clientId);
      } catch (err) {
        item.reject(err as Error);
      }
    }
  }

  /**
   * Scan the queue for the first item eligible for this worker and remove it.
   * Items targeting a different client are skipped (left for their worker).
   */
  private takeEligible(clientId: string): QueueItem | null {
    for (let i = 0; i < this.queue.length; i++) {
      const it = this.queue[i];
      if (it.clientId === null || it.clientId === clientId) {
        this.queue.splice(i, 1);
        return it;
      }
    }
    return null;
  }

  private async executeRequest(
    client: TelegramClient,
    item: QueueItem,
    clientId: string,
  ): Promise<void> {
    try {
      const result = await client.invoke(item.request);
      item.resolve(result);
    } catch (err) {
      const error = err as Error & { seconds?: number; errorMessage?: string };

      if (error.errorMessage?.includes('FLOOD_WAIT') || error.message?.includes('FLOOD_WAIT')) {
        const waitSeconds = error.seconds || this.parseFloodWait(error.message) || 30;
        console.warn(`[RateLimiter] FLOOD_WAIT ${waitSeconds}s for client ${clientId}`);

        const state = this.getClientState(clientId);
        state.floodWaitUntil = Date.now() + waitSeconds * 1000;

        if (item.retries < MAX_RETRIES) {
          item.retries++;
          // Null-clientId items can be picked up by any free worker (good —
          // another active client can serve while we sleep off the flood).
          // Explicit-clientId items stay pinned to this client and will wait.
          this.queue.push(item);
          this.wakeAll();
          return;
        }
      }

      item.reject(error);
    }
  }

  /**
   * Wait until this client has an available request slot.
   *
   * Unlike the serial implementation, this only gates the current worker —
   * other workers run in parallel. `worker` is passed so the sleep can be
   * interrupted on shutdown.
   */
  private async waitForSlot(clientId: string, worker: Worker): Promise<void> {
    const state = this.getClientState(clientId);
    const now = Date.now();

    if (state.floodWaitUntil > now) {
      const waitMs = state.floodWaitUntil - now;
      console.log(`[RateLimiter] Waiting ${Math.ceil(waitMs / 1000)}s for flood wait (client ${clientId})`);
      await this.interruptibleSleep(waitMs, worker);
      if (worker.stop) return;
    }

    const timeSinceLast = Date.now() - state.lastRequestAt;
    if (timeSinceLast < MIN_INTERVAL_MS) {
      await this.interruptibleSleep(MIN_INTERVAL_MS - timeSinceLast, worker);
      if (worker.stop) return;
    }

    let windowRequests = this.getWindowRequests(state, Date.now());
    while (windowRequests >= this.requestsPerMinute && !worker.stop) {
      const waitMs = state.windowStart + 60_000 - Date.now();
      if (waitMs > 0) {
        console.log(`[RateLimiter] Rate limit reached, waiting ${Math.ceil(waitMs / 1000)}s (client ${clientId})`);
        await this.interruptibleSleep(waitMs, worker);
      }
      windowRequests = this.getWindowRequests(state, Date.now());
    }
  }

  private getClientState(clientId: string): ClientState {
    let state = this.clientStates.get(clientId);
    if (!state) {
      state = { lastRequestAt: 0, requestCount: 0, windowStart: Date.now(), floodWaitUntil: 0 };
      this.clientStates.set(clientId, state);
    }
    return state;
  }

  private getWindowRequests(state: ClientState, now: number): number {
    if (now - state.windowStart >= 60_000) {
      state.windowStart = now;
      state.requestCount = 0;
    }
    return state.requestCount;
  }

  private recordRequest(clientId: string): void {
    const state = this.getClientState(clientId);
    const now = Date.now();
    if (now - state.windowStart >= 60_000) {
      state.windowStart = now;
      state.requestCount = 0;
    }
    state.requestCount++;
    state.lastRequestAt = now;
  }

  private parseFloodWait(message: string): number | null {
    const match = message.match(/FLOOD_WAIT_(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private interruptibleSleep(ms: number, worker: Worker): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      const prevWake = worker.wake;
      worker.wake = () => { clearTimeout(timer); worker.wake = prevWake; resolve(); };
    });
  }
}

export const rateLimiter = new TelegramRateLimiter();
export { TelegramRateLimiter };
