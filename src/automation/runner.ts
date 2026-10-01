/**
 * Очередь запусков агента. Демон работает под отдельным пользователем macOS и
 * не может запустить Claude Code человека в его профиле (решение 17), поэтому
 * запуском занимается `tg-mcp runner` под пользователем человека: он забирает
 * задание отсюда, запускает агента и сообщает исход.
 *
 * Вместе с заданием runner получает токен с ограниченными правами: агент по
 * правилу видит один пост и может подготовить один ответ. Ограничивает агента
 * шлюз, а не флаги конкретного CLI: так одинаково для всех клиентов.
 */
import { randomToken, sha256Hex } from '../core/crypto.js';
import { createLogger, type Logger } from '../core/log.js';
import { ruleGrant, ruleName, rulePrompt } from './rules.js';
import type { AutomationStore, RunnerJob, ScopedGrant } from './store.js';

export interface ClaimedJob {
  id: string;
  kind: string;
  /** Промпт для агента. */
  prompt: string;
  /** Токен шлюза на время этого запуска. */
  token: string;
  timeoutSec: number;
}

export interface JobPlan {
  prompt: string;
  grant: ScopedGrant;
}

/** Как из задания получить промпт и права: по виду задания. */
export type JobPlanner = (job: RunnerJob) => JobPlan;

export interface RunnerQueueOptions {
  store: AutomationStore;
  timeoutSec?: number;
  log?: Logger;
  now?: () => number;
}

export class RunnerQueue {
  private readonly store: AutomationStore;
  private readonly timeoutSec: number;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly planners = new Map<string, JobPlanner>();
  private readonly finishers = new Map<string, (job: RunnerJob, exitCode: number) => void>();

  constructor(options: RunnerQueueOptions) {
    this.store = options.store;
    this.timeoutSec = options.timeoutSec ?? 180;
    this.log = options.log ?? createLogger('runner');
    this.now = options.now ?? (() => Date.now());

    this.register(
      'rule',
      job => {
        const p = job.payload as { ruleId: string; accountId: string; chatKey: string; chatLabel: string; postId: number; link: string | null; prompt: string; sendAs?: 'account' | 'channel' };
        return { prompt: rulePrompt(p), grant: ruleGrant(p, job.id) };
      },
      (job, exitCode) => {
        const p = job.payload as { ruleId: string; chatKey: string; postId: number };
        this.store.setFireOutcome(p.ruleId, p.chatKey, p.postId, exitCode === 0 ? 'agent_done' : 'agent_failed');
      },
    );
  }

  register(kind: string, planner: JobPlanner, onFinish?: (job: RunnerJob, exitCode: number) => void): void {
    this.planners.set(kind, planner);
    if (onFinish) this.finishers.set(kind, onFinish);
  }

  /** Следующее задание пользователя или null. */
  claim(userId: string): ClaimedJob | null {
    const job = this.store.claimRunnerJob(userId);
    if (!job) return null;
    const planner = this.planners.get(job.kind);
    if (!planner) {
      this.store.finishRunnerJob(job.id, userId, 1, `unknown job kind ${job.kind}`);
      return null;
    }
    const plan = planner(job);
    const token = randomToken(32);
    // Токен живёт чуть дольше запуска: агент может дописывать ответ на границе таймаута.
    this.store.putScopedToken(sha256Hex(token), userId, { ...plan.grant, jobId: job.id }, this.now() + (this.timeoutSec + 120) * 1000);
    this.log.info('job claimed', { job: job.id, kind: job.kind, user: userId });
    return { id: job.id, kind: job.kind, prompt: plan.prompt, token, timeoutSec: this.timeoutSec };
  }

  /** Runner сообщает исход. Токен запуска перестаёт действовать сразу. */
  finish(userId: string, jobId: string, exitCode: number, output: string): boolean {
    const ok = this.store.finishRunnerJob(jobId, userId, exitCode, output);
    if (!ok) return false;
    this.store.revokeScopedTokensForJob(jobId);
    const job = this.store.getRunnerJob(jobId)!;
    this.finishers.get(job.kind)?.(job, exitCode);
    this.store.addInbox({
      userId,
      kind: 'agent_run',
      accountId: typeof job.payload.accountId === 'string' ? job.payload.accountId : null,
      chatKey: typeof job.payload.chatKey === 'string' ? job.payload.chatKey : null,
      messageId: typeof job.payload.postId === 'number' ? job.payload.postId : null,
      payload: { job_id: jobId, job_kind: job.kind, exit_code: exitCode, rule: typeof job.payload.ruleId === 'string' ? ruleName(job.payload.ruleId) : null, task: job.payload.taskId ?? null },
    });
    return true;
  }

  /** Уборка: задания, о которых runner не отчитался, и истёкшие токены. */
  sweep(): number {
    const stale = this.store.failStaleRunnerJobs(this.timeoutSec * 3 * 1000);
    for (const job of stale) {
      this.store.revokeScopedTokensForJob(job.id);
      this.finishers.get(job.kind)?.(job, -1);
    }
    this.store.pruneScopedTokens();
    return stale.length;
  }
}
