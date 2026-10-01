/**
 * Подтверждение записи. Любое действие, которое что-то меняет в Telegram,
 * идёт в два шага (решения 4 и 23): инструмент записи создаёт запрос и
 * возвращает предпросмотр, а выполняет действие шлюз после вызова `tg_confirm`.
 *
 * Отдельного бота для согласований нет: владелец общается только со своим
 * агентом. Агент показывает ему предпросмотр и подтверждает после его «да».
 *
 * Запуск без человека (агент, которого разбудило правило или поручение)
 * подтвердить ничего не может: `tg_confirm` недоступен токену запуска. Его
 * черновики ждут во входящих, пока владелец не решит через своего агента.
 */
import { randomBytes } from 'node:crypto';
import { GatewayError, isGatewayError } from '../core/errors.js';
import { createLogger, type Logger } from '../core/log.js';
import { sanitizeOutgoing } from '../policy/envelope.js';
import { MESSAGE_MAX_CHARS } from '../services/write.js';
import type { ApprovalRecord, AutomationStore } from './store.js';

export interface ApprovalRequest {
  userId: string;
  accountId: string | null;
  kind: string;
  /** tool, rule:<id> или task:<id>. */
  source: string;
  /** Аргументы действия. Поле `text` это черновик, который владелец может заменить. */
  payload: Record<string, unknown>;
  /** Что и где будет сделано: пишет шлюз, чужого текста здесь нет. */
  title: string;
  /** Запрос создан запуском без человека: владелец узнаёт о нём из входящих. */
  background?: boolean;
  ttlMs?: number;
}

/** Исполнитель действия после подтверждения. Возвращает итог одной строкой для агента. */
export type ApprovalExecutor = (approval: ApprovalRecord) => Promise<{ summary: string; data?: Record<string, unknown> }>;

interface ExecutorEntry {
  run: ApprovalExecutor;
  /** Можно ли заменить текст черновика при подтверждении. */
  editable: boolean;
}

export interface ApprovalsOptions {
  store: AutomationStore;
  log?: Logger;
  now?: () => number;
  defaultTtlMs?: number;
}

/** Черновик из ночного запуска должен дожить до утра. */
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

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
  private readonly store: AutomationStore;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly defaultTtlMs: number;
  private readonly executors = new Map<string, ExecutorEntry>();

  constructor(options: ApprovalsOptions) {
    this.store = options.store;
    this.log = options.log ?? createLogger('approvals');
    this.now = options.now ?? (() => Date.now());
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
  }

  register(kind: string, run: ApprovalExecutor, options: { editable?: boolean } = {}): void {
    this.executors.set(kind, { run, editable: options.editable ?? false });
  }

  /** Создаёт запрос на действие. В Telegram при этом ничего не происходит. */
  request(request: ApprovalRequest): ApprovalRecord {
    if (!this.executors.has(request.kind)) throw new GatewayError('INVALID_ARGUMENT', `Unknown action kind "${request.kind}".`);

    // Подтверждается ровно то, что уйдёт: текст чистится до показа, а не после.
    const payload = typeof request.payload.text === 'string' ? { ...request.payload, text: cleanDraft(request.payload.text) } : request.payload;

    const approval = this.store.createApproval({
      id: `ap_${randomBytes(5).toString('hex')}`,
      userId: request.userId,
      accountId: request.accountId,
      kind: request.kind,
      source: request.source,
      payload: request.background ? { ...payload, background: true } : payload,
      preview: request.title,
      expiresAt: this.now() + (request.ttlMs ?? this.defaultTtlMs),
    });
    // Черновик запуска без человека никто не видел: о нём сообщает событие во входящих.
    if (request.background) this.notify(approval.id);
    return approval;
  }

  /** Можно ли заменить текст запроса при подтверждении. */
  editable(approval: ApprovalRecord): boolean {
    return this.executors.get(approval.kind)?.editable === true;
  }

  /** Запросы пользователя, которые ждут решения. */
  pending(userId: string, limit = 20): ApprovalRecord[] {
    return this.store
      .listApprovals(userId, ['pending'], limit)
      .filter(a => a.expiresAt > this.now())
      .reverse();
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
    this.assertNotExpired(approval);

    if (text !== undefined) {
      if (!this.editable(approval)) throw new GatewayError('INVALID_ARGUMENT', 'This request has no text to replace.');
      this.store.updateApproval(id, { payload: { ...approval.payload, text: cleanDraft(text), editedByOwner: true } });
    }
    await this.execute(id);
    return this.store.getApproval(id)!;
  }

  /** Отменяет запрос без действия. */
  reject(id: string, userId: string): ApprovalRecord {
    const approval = this.status(id, userId);
    if (approval.state === 'pending' && this.store.transitionApproval(id, ['pending'], 'rejected')) this.notify(id);
    return this.store.getApproval(id)!;
  }

  /** Уборка просроченных идёт раз в минуту: срок проверяется и в момент подтверждения. */
  private assertNotExpired(approval: ApprovalRecord): void {
    if (approval.expiresAt > this.now()) return;
    if (this.store.transitionApproval(approval.id, ['pending'], 'expired')) this.notify(approval.id);
    throw new GatewayError('LIMIT_REACHED', `Approval ${approval.id} has expired. Nothing was done: create the request again if it is still needed.`);
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
    this.notify(id);
  }

  /** Событие во входящие: исход запроса или черновик, который ждёт владельца. */
  private notify(id: string): void {
    const approval = this.store.getApproval(id);
    if (!approval) return;
    this.store.addInbox({
      userId: approval.userId,
      kind: 'approval',
      accountId: approval.accountId,
      chatKey: typeof approval.payload.chatKey === 'string' ? approval.payload.chatKey : null,
      messageId: typeof approval.payload.postId === 'number' ? approval.payload.postId : null,
      payload: { approval_id: approval.id, action: approval.kind, state: approval.state, source: approval.source, result: approval.result ?? {} },
    });
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
      this.notify(approval.id);
    }
    return stuck.length;
  }

  /** Закрывает просроченные запросы. */
  sweep(): number {
    const expired = this.store.expireApprovals();
    for (const approval of expired) this.notify(approval.id);
    return expired.length;
  }
}
