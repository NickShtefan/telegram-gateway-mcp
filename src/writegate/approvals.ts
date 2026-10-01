/**
 * Подтверждение записи. Любое действие, которое что-то меняет в Telegram,
 * идёт в два шага (решения 4 и 23): инструмент записи создаёт запрос и
 * возвращает предпросмотр, а выполняет действие шлюз после вызова `tg_confirm`.
 *
 * Запрос живёт недолго: он нужен на время разговора агента с владельцем
 * («вот что я отправлю» и «да»). Очереди черновиков шлюз не ведёт.
 */
import { randomBytes } from 'node:crypto';
import { GatewayError, isGatewayError } from '../core/errors.js';
import { createLogger, type Logger } from '../core/log.js';
import { sanitizeOutgoing } from '../policy/envelope.js';
import { MESSAGE_MAX_CHARS } from '../services/write.js';
import type { ApprovalRecord, WriteStore } from './store.js';

export interface ApprovalRequest {
  userId: string;
  accountId: string | null;
  kind: string;
  /** Аргументы действия. Поле `text` это черновик, который владелец может заменить. */
  payload: Record<string, unknown>;
  /** Что и где будет сделано: пишет шлюз, чужого текста здесь нет. */
  title: string;
}

/** Исполнитель действия после подтверждения. Возвращает итог одной строкой для агента. */
export type ApprovalExecutor = (approval: ApprovalRecord) => Promise<{ summary: string; data?: Record<string, unknown> }>;

interface ExecutorEntry {
  run: ApprovalExecutor;
  /** Можно ли заменить текст черновика при подтверждении. */
  editable: boolean;
}

export interface ApprovalsOptions {
  store: WriteStore;
  log?: Logger;
  now?: () => number;
  ttlMs?: number;
}

/** Сколько живёт запрос: время на то, чтобы показать предпросмотр и получить ответ. */
export const APPROVAL_TTL_MS = 30 * 60 * 1000;
/** Сколько хранятся решённые запросы. */
const KEEP_DECIDED_MS = 7 * 24 * 60 * 60 * 1000;

/** Текст действия в том виде, в каком он уйдёт в Telegram и показан в предпросмотре. */
function cleanDraft(text: string): string {
  const clean = sanitizeOutgoing(text).trim();
  if (!clean) throw new GatewayError('INVALID_ARGUMENT', 'Message text is empty.');
  if (clean.length > MESSAGE_MAX_CHARS) {
    throw new GatewayError('INVALID_ARGUMENT', `Message text is ${clean.length} characters, the Telegram limit is ${MESSAGE_MAX_CHARS}.`);
  }
  return clean;
}

export class Approvals {
  private readonly store: WriteStore;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly executors = new Map<string, ExecutorEntry>();

  constructor(options: ApprovalsOptions) {
    this.store = options.store;
    this.log = options.log ?? createLogger('approvals');
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? APPROVAL_TTL_MS;
  }

  register(kind: string, run: ApprovalExecutor, options: { editable?: boolean } = {}): void {
    this.executors.set(kind, { run, editable: options.editable ?? false });
  }

  /** Создаёт запрос на действие. В Telegram при этом ничего не происходит. */
  request(request: ApprovalRequest): ApprovalRecord {
    if (!this.executors.has(request.kind)) throw new GatewayError('INVALID_ARGUMENT', `Unknown action kind "${request.kind}".`);
    // Подтверждается ровно то, что уйдёт: текст чистится до показа, а не после.
    const payload = typeof request.payload.text === 'string' ? { ...request.payload, text: cleanDraft(request.payload.text) } : request.payload;
    return this.store.createApproval({
      id: `ap_${randomBytes(5).toString('hex')}`,
      userId: request.userId,
      accountId: request.accountId,
      kind: request.kind,
      payload,
      preview: request.title,
      expiresAt: this.now() + this.ttlMs,
    });
  }

  /** Запрос того же вида, который ещё ждёт решения: второй такой же не создаётся. */
  findPending(userId: string, kind: string, match: (payload: Record<string, unknown>) => boolean): ApprovalRecord | null {
    return this.store.listApprovals(userId, ['pending', 'executing']).find(a => a.kind === kind && a.expiresAt > this.now() && match(a.payload)) ?? null;
  }

  /** Запрос пользователя. Чужой запрос неотличим от несуществующего. */
  status(id: string, userId: string): ApprovalRecord {
    const approval = this.store.getApproval(id);
    if (!approval || approval.userId !== userId) throw new GatewayError('NOT_FOUND', `Approval "${id}" not found.`);
    return approval;
  }

  /**
   * Подтверждает и выполняет действие. `text` заменяет черновик словами
   * владельца. Повторный вызов действие второй раз не выполнит: вернётся
   * запись с уже известным исходом.
   */
  async confirm(id: string, userId: string, text?: string): Promise<ApprovalRecord> {
    const approval = this.status(id, userId);
    if (approval.state !== 'pending') return approval;
    if (approval.expiresAt <= this.now()) {
      this.store.transitionApproval(id, ['pending'], 'expired');
      throw new GatewayError('LIMIT_REACHED', `Approval ${id} has expired. Nothing was done: prepare the action again if it is still needed.`);
    }
    if (text !== undefined) {
      if (this.executors.get(approval.kind)?.editable !== true) throw new GatewayError('INVALID_ARGUMENT', 'This request has no text to replace.');
      this.store.updateApproval(id, { payload: { ...approval.payload, text: cleanDraft(text), editedByOwner: true } });
    }
    await this.execute(id);
    return this.store.getApproval(id)!;
  }

  /** Отменяет запрос без действия. */
  reject(id: string, userId: string): ApprovalRecord {
    this.status(id, userId);
    this.store.transitionApproval(id, ['pending'], 'rejected');
    return this.store.getApproval(id)!;
  }

  /** Выполняет подтверждённое действие. Два одновременных подтверждения не выполнят его дважды. */
  private async execute(id: string): Promise<void> {
    if (!this.store.transitionApproval(id, ['pending'], 'executing')) return;
    const approval = this.store.getApproval(id)!;
    const entry = this.executors.get(approval.kind);
    try {
      if (!entry) throw new GatewayError('INVALID_ARGUMENT', `No executor for "${approval.kind}".`);
      const outcome = await entry.run(approval);
      this.store.updateApproval(id, { state: 'executed', result: { summary: outcome.summary, ...(outcome.data ?? {}) } });
    } catch (err) {
      const message = isGatewayError(err) ? `${err.code}: ${err.message}` : (err as Error).message;
      this.log.warn('confirmed action failed', { approval: id, kind: approval.kind, error: message });
      // Код ошибки хранится отдельно: агент, подтвердивший действие, получает её в обычном виде.
      const detail = isGatewayError(err) ? { code: err.code, message: err.message, retry_after: err.retryAfter, outcome_unknown: err.outcomeUnknown === true } : {};
      this.store.updateApproval(id, { state: 'failed', result: { error: message, ...detail } });
    }
  }

  /**
   * После рестарта: действия, которые выполнялись в момент остановки. Дошло ли
   * сообщение до Telegram, неизвестно, поэтому повторять его шлюз не станет.
   */
  recover(): number {
    const stuck = this.store.approvalsInState('executing');
    for (const approval of stuck) {
      this.store.updateApproval(approval.id, {
        state: 'failed',
        result: { error: 'The gateway restarted while this action was being executed. The outcome is unknown: check in Telegram before repeating it.' },
      });
    }
    return stuck.length;
  }

  /** Уборка: просроченные запросы закрываются, старые решённые удаляются. */
  sweep(): number {
    const expired = this.store.expireApprovals();
    this.store.pruneApprovals(this.now() - KEEP_DECIDED_MS);
    return expired;
  }
}
