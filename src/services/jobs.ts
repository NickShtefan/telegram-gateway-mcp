/**
 * Задачи: всё, что дольше обычного вызова (выгрузка истории за месяцы,
 * скачивание сотен превью). Инструмент сразу возвращает `job_id`, прогресс
 * читается отдельным вызовом.
 *
 * В channel-scope архиватор хранил один прогресс на процесс (`archiveService.ts:15`).
 * Здесь состояние у каждой задачи своё и лежит в базе, а после рестарта задачи
 * возвращаются в очередь (идея из tgcli).
 */
import { randomBytes } from 'node:crypto';
import { GatewayError, isGatewayError } from '../core/errors.js';
import { createLogger, type Logger } from '../core/log.js';
import type { JobRecord, Storage } from '../storage/port.js';

export interface JobContext {
  job: JobRecord;
  /** Сохраняет прогресс: его видит агент. */
  progress(update: Record<string, unknown>): void;
  /** true, если задачу отменили: исполнитель должен остановиться. */
  cancelled(): boolean;
}

export type JobRunner = (context: JobContext) => Promise<Record<string, unknown>>;

export interface JobManagerOptions {
  storage: Storage;
  /** Сколько задач выполняется одновременно. */
  concurrency?: number;
  log?: Logger;
}

export class JobManager {
  private readonly storage: Storage;
  private readonly concurrency: number;
  private readonly log: Logger;
  private readonly runners = new Map<string, JobRunner>();
  private readonly cancelledIds = new Set<string>();
  private readonly waiters = new Map<string, Array<() => void>>();
  private active = 0;
  private stopped = false;

  constructor(options: JobManagerOptions) {
    this.storage = options.storage;
    this.concurrency = options.concurrency ?? 2;
    this.log = options.log ?? createLogger('jobs');
  }

  /** Регистрирует исполнителя вида задач. Параметры задачи лежат в базе, поэтому её можно продолжить после рестарта. */
  register(kind: string, runner: JobRunner): void {
    this.runners.set(kind, runner);
  }

  start(input: { userId: string; accountId?: string | null; kind: string; params: Record<string, unknown> }): JobRecord {
    if (!this.runners.has(input.kind)) {
      throw new GatewayError('INVALID_ARGUMENT', `Unknown job kind "${input.kind}".`);
    }
    const job = this.storage.jobs.create({ id: `job_${randomBytes(6).toString('hex')}`, ...input });
    this.pump();
    return job;
  }

  /** Задача пользователя. Чужая задача неотличима от несуществующей. */
  get(id: string, userId: string): JobRecord {
    const job = this.storage.jobs.get(id);
    if (!job || job.userId !== userId) {
      throw new GatewayError('NOT_FOUND', `Job "${id}" not found.`);
    }
    return job;
  }

  cancel(id: string, userId: string): JobRecord {
    const job = this.get(id, userId);
    if (job.state === 'queued') {
      this.storage.jobs.update(id, { state: 'cancelled' });
      this.notify(id);
    } else if (job.state === 'running') {
      this.cancelledIds.add(id);
    }
    return this.get(id, userId);
  }

  /** Ждёт завершения задачи не дольше `ms` и возвращает её текущее состояние. */
  async waitFor(id: string, userId: string, ms: number): Promise<JobRecord> {
    const done = (j: JobRecord): boolean => j.state === 'done' || j.state === 'failed' || j.state === 'cancelled';
    const current = this.get(id, userId);
    if (done(current) || ms <= 0) return current;
    await new Promise<void>(resolve => {
      const timer = setTimeout(finish, ms);
      const list = this.waiters.get(id) ?? [];
      function finish(): void {
        clearTimeout(timer);
        resolve();
      }
      list.push(finish);
      this.waiters.set(id, list);
    });
    return this.get(id, userId);
  }

  /** После рестарта: прерванные задачи возвращаются в очередь и запускаются снова. */
  resume(): number {
    const requeued = this.storage.jobs.requeueRunning();
    this.pump();
    return requeued;
  }

  stop(): void {
    this.stopped = true;
    for (const id of this.waiters.keys()) this.notify(id);
  }

  private pump(): void {
    if (this.stopped) return;
    while (this.active < this.concurrency) {
      const next = this.storage.jobs
        .list({ state: 'queued', limit: 50 })
        .reverse()
        .find(j => this.runners.has(j.kind));
      if (!next) return;
      this.active++;
      this.storage.jobs.update(next.id, { state: 'running' });
      void this.run(next.id).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private async run(id: string): Promise<void> {
    const job = this.storage.jobs.get(id);
    if (!job) return;
    const runner = this.runners.get(job.kind)!;
    let progress = { ...job.progress };
    try {
      const result = await runner({
        job,
        progress: update => {
          progress = { ...progress, ...update };
          this.storage.jobs.update(id, { progress });
        },
        cancelled: () => this.cancelledIds.has(id) || this.stopped,
      });
      if (this.stopped) {
        // Процесс останавливается: задача остаётся «выполняемой» и вернётся в очередь при старте.
        return;
      }
      this.storage.jobs.update(id, this.cancelledIds.has(id) ? { state: 'cancelled', result } : { state: 'done', result });
    } catch (err) {
      if (this.stopped) return;
      const message = isGatewayError(err) ? `${err.code}: ${err.message}` : (err as Error).message;
      this.log.warn('job failed', { job: id, kind: job.kind, error: message });
      this.storage.jobs.update(id, { state: 'failed', error: message });
    } finally {
      this.cancelledIds.delete(id);
      this.notify(id);
    }
  }

  private notify(id: string): void {
    const list = this.waiters.get(id);
    if (!list) return;
    this.waiters.delete(id);
    for (const wake of list) wake();
  }
}
