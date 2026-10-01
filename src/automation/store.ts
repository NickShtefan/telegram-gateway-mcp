/**
 * Хранилище автоматизации: наблюдаемые чаты, входящие, согласования, правила,
 * журнал записи, очередь запусков агента и токены с ограниченными правами.
 * Состояние хранит шлюз: агент между запусками ничего не помнит (решение 10).
 */
import type { SqliteStorage } from '../storage/sqlite.js';

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
function json<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || v === '') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

// ---------- наблюдение ----------

export interface WatchRecord {
  id: number;
  userId: string;
  accountId: string;
  chatKey: string;
  createdAt: number;
}

export interface WatchState {
  accountId: string;
  chatKey: string;
  lastSeenId: number;
  /** Первый опрос только запоминает последний id и событий не создаёт. */
  baselineDone: boolean;
  nextPollAt: number;
  intervalMs: number;
  lastPollAt: number | null;
  lastError: string | null;
}

// ---------- входящие ----------

export interface InboxEvent {
  id: number;
  userId: string;
  ts: number;
  kind: string;
  accountId: string | null;
  chatKey: string | null;
  messageId: number | null;
  payload: Record<string, unknown>;
}

// ---------- согласования ----------

export type ApprovalState = 'pending' | 'awaiting_edit' | 'executing' | 'executed' | 'rejected' | 'expired' | 'failed';

export interface ApprovalRecord {
  id: string;
  /** Кто решает: пользователь, чьё это действие (решение 18). */
  userId: string;
  accountId: string | null;
  kind: string;
  source: string;
  payload: Record<string, unknown>;
  preview: string;
  state: ApprovalState;
  result: Record<string, unknown> | null;
  botChatId: string | null;
  botMessageId: number | null;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
}

// ---------- правила ----------

export interface RuleConfig {
  /** Что агент должен сделать с новым постом. */
  prompt: string;
  /** Срабатывать только на посты с одним из этих слов; пусто: на все. */
  keywords: string[];
  skipAds: boolean;
  perDay: number;
  /** Тихие часы `HH:MM-HH:MM` по UTC; null: без них. */
  quietHours: string | null;
  /** Случайная пауза перед запуском агента, секунды. */
  delaySec: [number, number];
  sendAs: 'account' | 'channel';
}

export interface RuleRecord {
  id: string;
  userId: string;
  accountId: string;
  chatKey: string;
  config: RuleConfig;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

// ---------- запись ----------

export interface WriteRecord {
  ts: number;
  userId: string;
  accountId: string;
  kind: 'reply' | 'send' | 'join' | 'react';
  chatKey: string;
  postId: number | null;
  sentMessageId: number | null;
  source: string;
}

// ---------- запуск агента ----------

export type RunnerJobState = 'pending' | 'claimed' | 'done' | 'failed';

export interface RunnerJob {
  id: string;
  userId: string;
  kind: string;
  payload: Record<string, unknown>;
  state: RunnerJobState;
  runAfter: number;
  createdAt: number;
  claimedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
  output: string | null;
}

/** Что разрешено агенту, запущенному по правилу или поручению. */
export interface ScopedGrant {
  accountId: string;
  /** Чаты, которые можно читать (пост и его обсуждение, один диалог). */
  chatKeys: string[];
  tools: string[];
  /** Единственное разрешённое действие записи. */
  reply?: { chatKey: string; postId: number; sendAs?: 'account' | 'channel' };
  /** Сообщения старше этого id в чате недоступны: поручение не открывает прежнюю переписку. */
  minMessageId?: number;
  send?: { chatKey: string };
  ruleId?: string;
  taskId?: string;
  jobId?: string;
}

export class AutomationStore {
  constructor(
    private readonly db: SqliteStorage,
    private readonly now: () => number = () => Date.now(),
  ) {}

  // ---------- watches ----------

  addWatch(userId: string, accountId: string, chatKey: string): boolean {
    const result = this.db
      .prepare('INSERT OR IGNORE INTO watches (user_id, account_id, chat_key, created_at) VALUES (?, ?, ?, ?)')
      .run(userId, accountId, chatKey, this.now());
    this.db
      .prepare('INSERT OR IGNORE INTO watch_state (account_id, chat_key, next_poll_at) VALUES (?, ?, ?)')
      .run(accountId, chatKey, this.now());
    return num(result.changes) > 0;
  }

  removeWatch(userId: string, accountId: string, chatKey: string): boolean {
    const result = this.db.prepare('DELETE FROM watches WHERE user_id = ? AND account_id = ? AND chat_key = ?').run(userId, accountId, chatKey);
    // Состояние опроса живёт, пока чат наблюдает хоть кто-то.
    this.db
      .prepare(
        `DELETE FROM watch_state WHERE account_id = ? AND chat_key = ?
         AND NOT EXISTS (SELECT 1 FROM watches w WHERE w.account_id = watch_state.account_id AND w.chat_key = watch_state.chat_key)`,
      )
      .run(accountId, chatKey);
    return num(result.changes) > 0;
  }

  listWatches(userId: string, accountId?: string): WatchRecord[] {
    const rows = accountId
      ? this.db.prepare('SELECT * FROM watches WHERE user_id = ? AND account_id = ? ORDER BY id').all(userId, accountId)
      : this.db.prepare('SELECT * FROM watches WHERE user_id = ? ORDER BY id').all(userId);
    return (rows as Row[]).map(r => ({ id: num(r.id), userId: str(r.user_id), accountId: str(r.account_id), chatKey: str(r.chat_key), createdAt: num(r.created_at) }));
  }

  /** Сколько разных чатов наблюдается через аккаунт. */
  watchedChatCount(accountId: string): number {
    return num((this.db.prepare('SELECT COUNT(*) AS n FROM watch_state WHERE account_id = ?').get(accountId) as Row).n);
  }

  watchersOf(accountId: string, chatKey: string): string[] {
    return (this.db.prepare('SELECT user_id FROM watches WHERE account_id = ? AND chat_key = ? ORDER BY user_id').all(accountId, chatKey) as Row[]).map(r => str(r.user_id));
  }

  private mapState(r: Row): WatchState {
    return {
      accountId: str(r.account_id),
      chatKey: str(r.chat_key),
      lastSeenId: num(r.last_seen_id),
      baselineDone: num(r.baseline_done) === 1,
      nextPollAt: num(r.next_poll_at),
      intervalMs: num(r.interval_ms),
      lastPollAt: numOrNull(r.last_poll_at),
      lastError: strOrNull(r.last_error),
    };
  }

  watchState(accountId: string, chatKey: string): WatchState | null {
    const row = this.db.prepare('SELECT * FROM watch_state WHERE account_id = ? AND chat_key = ?').get(accountId, chatKey) as Row | undefined;
    return row ? this.mapState(row) : null;
  }

  dueWatchStates(limit: number): WatchState[] {
    return (this.db.prepare('SELECT * FROM watch_state WHERE next_poll_at <= ? ORDER BY next_poll_at LIMIT ?').all(this.now(), limit) as Row[]).map(r => this.mapState(r));
  }

  updateWatchState(accountId: string, chatKey: string, patch: Partial<Pick<WatchState, 'lastSeenId' | 'baselineDone' | 'nextPollAt' | 'intervalMs' | 'lastError'>>): void {
    const current = this.watchState(accountId, chatKey);
    if (!current) return;
    this.db
      .prepare(
        'UPDATE watch_state SET last_seen_id = ?, baseline_done = ?, next_poll_at = ?, interval_ms = ?, last_error = ?, last_poll_at = ? WHERE account_id = ? AND chat_key = ?',
      )
      .run(
        patch.lastSeenId ?? current.lastSeenId,
        (patch.baselineDone ?? current.baselineDone) ? 1 : 0,
        patch.nextPollAt ?? current.nextPollAt,
        patch.intervalMs ?? current.intervalMs,
        patch.lastError === undefined ? current.lastError : patch.lastError,
        this.now(),
        accountId,
        chatKey,
      );
  }

  // ---------- inbox ----------

  addInbox(event: Omit<InboxEvent, 'id' | 'ts'> & { ts?: number }): number {
    const result = this.db
      .prepare('INSERT INTO inbox (user_id, ts, kind, account_id, chat_key, message_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(event.userId, event.ts ?? this.now(), event.kind, event.accountId, event.chatKey, event.messageId, JSON.stringify(event.payload ?? {}));
    return num(result.lastInsertRowid);
  }

  inboxAfter(userId: string, afterId: number, limit: number): InboxEvent[] {
    return (this.db.prepare('SELECT * FROM inbox WHERE user_id = ? AND id > ? ORDER BY id LIMIT ?').all(userId, afterId, limit) as Row[]).map(r => ({
      id: num(r.id),
      userId: str(r.user_id),
      ts: num(r.ts),
      kind: str(r.kind),
      accountId: strOrNull(r.account_id),
      chatKey: strOrNull(r.chat_key),
      messageId: numOrNull(r.message_id),
      payload: json<Record<string, unknown>>(r.payload, {}),
    }));
  }

  latestInboxId(userId: string): number {
    return num((this.db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM inbox WHERE user_id = ?').get(userId) as Row).n);
  }

  pruneInbox(olderThanTs: number): number {
    return num(this.db.prepare('DELETE FROM inbox WHERE ts < ?').run(olderThanTs).changes);
  }

  // ---------- approvals ----------

  private mapApproval(r: Row): ApprovalRecord {
    return {
      id: str(r.id),
      userId: str(r.user_id),
      accountId: strOrNull(r.account_id),
      kind: str(r.kind),
      source: str(r.source),
      payload: json<Record<string, unknown>>(r.payload, {}),
      preview: str(r.preview),
      state: str(r.state) as ApprovalState,
      result: json<Record<string, unknown> | null>(r.result, null),
      botChatId: strOrNull(r.bot_chat_id),
      botMessageId: numOrNull(r.bot_message_id),
      createdAt: num(r.created_at),
      expiresAt: num(r.expires_at),
      decidedAt: numOrNull(r.decided_at),
    };
  }

  createApproval(a: Pick<ApprovalRecord, 'id' | 'userId' | 'accountId' | 'kind' | 'source' | 'payload' | 'preview' | 'expiresAt'>): ApprovalRecord {
    this.db
      .prepare(
        `INSERT INTO approvals (id, user_id, account_id, kind, source, payload, preview, state, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(a.id, a.userId, a.accountId, a.kind, a.source, JSON.stringify(a.payload), a.preview, this.now(), a.expiresAt);
    return this.getApproval(a.id)!;
  }

  getApproval(id: string): ApprovalRecord | null {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapApproval(row) : null;
  }

  updateApproval(
    id: string,
    patch: Partial<Pick<ApprovalRecord, 'state' | 'payload' | 'preview' | 'result' | 'botChatId' | 'botMessageId'>> & { decided?: boolean },
  ): void {
    const current = this.getApproval(id);
    if (!current) return;
    this.db
      .prepare('UPDATE approvals SET state = ?, payload = ?, preview = ?, result = ?, bot_chat_id = ?, bot_message_id = ?, decided_at = ? WHERE id = ?')
      .run(
        patch.state ?? current.state,
        JSON.stringify(patch.payload ?? current.payload),
        patch.preview ?? current.preview,
        patch.result === undefined ? (current.result === null ? null : JSON.stringify(current.result)) : patch.result === null ? null : JSON.stringify(patch.result),
        patch.botChatId === undefined ? current.botChatId : patch.botChatId,
        patch.botMessageId === undefined ? current.botMessageId : patch.botMessageId,
        patch.decided ? this.now() : current.decidedAt,
        id,
      );
  }

  /**
   * Атомарный переход состояния: возвращает true, только если запись была в
   * одном из ожидаемых состояний. Защищает от двойного нажатия кнопки.
   */
  transitionApproval(id: string, from: ApprovalState[], to: ApprovalState): boolean {
    const marks = from.map(() => '?').join(', ');
    const result = this.db.prepare(`UPDATE approvals SET state = ?, decided_at = ? WHERE id = ? AND state IN (${marks})`).run(to, this.now(), id, ...from);
    return num(result.changes) > 0;
  }

  /** Согласование, которое ждёт новый текст от этого человека в этом чате бота. */
  approvalAwaitingEdit(botChatId: string): ApprovalRecord | null {
    const row = this.db
      .prepare("SELECT * FROM approvals WHERE state = 'awaiting_edit' AND bot_chat_id = ? ORDER BY decided_at DESC LIMIT 1")
      .get(botChatId) as Row | undefined;
    return row ? this.mapApproval(row) : null;
  }

  listApprovals(userId: string, states: ApprovalState[], limit = 20): ApprovalRecord[] {
    const marks = states.map(() => '?').join(', ');
    return (this.db.prepare(`SELECT * FROM approvals WHERE user_id = ? AND state IN (${marks}) ORDER BY created_at DESC LIMIT ?`).all(userId, ...states, limit) as Row[]).map(r =>
      this.mapApproval(r),
    );
  }

  approvalsInState(state: ApprovalState): ApprovalRecord[] {
    return (this.db.prepare('SELECT * FROM approvals WHERE state = ? ORDER BY created_at').all(state) as Row[]).map(r => this.mapApproval(r));
  }

  /** Просроченные согласования: переводятся в `expired` и возвращаются для уведомления. */
  expireApprovals(): ApprovalRecord[] {
    const rows = this.db.prepare("SELECT * FROM approvals WHERE state IN ('pending', 'awaiting_edit') AND expires_at <= ?").all(this.now()) as Row[];
    const expired: ApprovalRecord[] = [];
    for (const row of rows) {
      const id = str(row.id);
      if (this.transitionApproval(id, ['pending', 'awaiting_edit'], 'expired')) expired.push(this.getApproval(id)!);
    }
    return expired;
  }

  // ---------- rules ----------

  private mapRule(r: Row): RuleRecord {
    return {
      id: str(r.id),
      userId: str(r.user_id),
      accountId: str(r.account_id),
      chatKey: str(r.chat_key),
      config: json<RuleConfig>(r.config, { prompt: '', keywords: [], skipAds: true, perDay: 5, quietHours: null, delaySec: [60, 300], sendAs: 'account' }),
      enabled: num(r.enabled) === 1,
      createdAt: num(r.created_at),
      updatedAt: num(r.updated_at),
    };
  }

  putRule(rule: Pick<RuleRecord, 'id' | 'userId' | 'accountId' | 'chatKey' | 'config' | 'enabled'>): RuleRecord {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO rules (id, user_id, account_id, chat_key, config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, chat_key = excluded.chat_key, config = excluded.config,
           enabled = excluded.enabled, updated_at = excluded.updated_at`,
      )
      .run(rule.id, rule.userId, rule.accountId, rule.chatKey, JSON.stringify(rule.config), rule.enabled ? 1 : 0, now, now);
    return this.getRule(rule.id)!;
  }

  getRule(id: string): RuleRecord | null {
    const row = this.db.prepare('SELECT * FROM rules WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapRule(row) : null;
  }

  setRuleEnabled(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE rules SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, this.now(), id);
  }

  removeRule(id: string): void {
    this.db.prepare('DELETE FROM rules WHERE id = ?').run(id);
  }

  /** Правила, видимые пользователю: свои и чужие на аккаунтах, к которым у него есть доступ (решение 18). */
  rulesVisibleTo(userId: string): RuleRecord[] {
    return (
      this.db
        .prepare(
          `SELECT r.* FROM rules r WHERE r.user_id = ?
           UNION
           SELECT r.* FROM rules r JOIN account_access x ON x.account_id = r.account_id WHERE x.user_id = ?
           ORDER BY created_at`,
        )
        .all(userId, userId) as Row[]
    ).map(r => this.mapRule(r));
  }

  enabledRulesFor(accountId: string, chatKey: string): RuleRecord[] {
    return (this.db.prepare('SELECT * FROM rules WHERE account_id = ? AND chat_key = ? AND enabled = 1 ORDER BY created_at').all(accountId, chatKey) as Row[]).map(r =>
      this.mapRule(r),
    );
  }

  /** false, если правило уже срабатывало на этот пост. */
  recordFire(ruleId: string, chatKey: string, messageId: number, outcome: string): boolean {
    const result = this.db
      .prepare('INSERT OR IGNORE INTO rule_fires (rule_id, chat_key, message_id, ts, outcome) VALUES (?, ?, ?, ?, ?)')
      .run(ruleId, chatKey, messageId, this.now(), outcome);
    return num(result.changes) > 0;
  }

  setFireOutcome(ruleId: string, chatKey: string, messageId: number, outcome: string): void {
    this.db.prepare('UPDATE rule_fires SET outcome = ? WHERE rule_id = ? AND chat_key = ? AND message_id = ?').run(outcome, ruleId, chatKey, messageId);
  }

  /** Сколько раз правило запускало агента с указанного момента. */
  firesSince(ruleId: string, sinceTs: number): number {
    return num(
      (this.db.prepare("SELECT COUNT(*) AS n FROM rule_fires WHERE rule_id = ? AND ts >= ? AND outcome NOT LIKE 'skipped%'").get(ruleId, sinceTs) as Row).n,
    );
  }

  lastFires(ruleId: string, limit = 5): Array<{ chatKey: string; messageId: number; ts: number; outcome: string }> {
    return (this.db.prepare('SELECT * FROM rule_fires WHERE rule_id = ? ORDER BY id DESC LIMIT ?').all(ruleId, limit) as Row[]).map(r => ({
      chatKey: str(r.chat_key),
      messageId: num(r.message_id),
      ts: num(r.ts),
      outcome: str(r.outcome),
    }));
  }

  // ---------- writes ----------

  hasReply(accountId: string, chatKey: string, postId: number): boolean {
    return this.db.prepare("SELECT 1 AS ok FROM writes WHERE account_id = ? AND chat_key = ? AND post_id = ? AND kind = 'reply'").get(accountId, chatKey, postId) !== undefined;
  }

  /** Записывает действие. Для второго ответа на тот же пост с того же аккаунта бросает ошибку SQLite (уникальный индекс). */
  recordWrite(write: WriteRecord): number {
    const result = this.db
      .prepare('INSERT INTO writes (ts, user_id, account_id, kind, chat_key, post_id, sent_message_id, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(write.ts, write.userId, write.accountId, write.kind, write.chatKey, write.postId, write.sentMessageId, write.source);
    return num(result.lastInsertRowid);
  }

  writesSince(accountId: string, kind: WriteRecord['kind'], sinceTs: number): number {
    return num((this.db.prepare('SELECT COUNT(*) AS n FROM writes WHERE account_id = ? AND kind = ? AND ts >= ?').get(accountId, kind, sinceTs) as Row).n);
  }

  /** Был ли уже диалог с этим человеком с этого аккаунта: для лимита новых диалогов. */
  hasWrittenTo(accountId: string, chatKey: string): boolean {
    return this.db.prepare("SELECT 1 AS ok FROM writes WHERE account_id = ? AND chat_key = ? AND kind = 'send' LIMIT 1").get(accountId, chatKey) !== undefined;
  }

  newDialogsSince(accountId: string, sinceTs: number): number {
    return num(
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM (
               SELECT chat_key, MIN(ts) AS first_ts FROM writes WHERE account_id = ? AND kind = 'send' AND chat_key NOT LIKE '-%' GROUP BY chat_key
             ) WHERE first_ts >= ?`,
          )
          .get(accountId, sinceTs) as Row
      ).n,
    );
  }

  // ---------- runner ----------

  private mapJob(r: Row): RunnerJob {
    return {
      id: str(r.id),
      userId: str(r.user_id),
      kind: str(r.kind),
      payload: json<Record<string, unknown>>(r.payload, {}),
      state: str(r.state) as RunnerJobState,
      runAfter: num(r.run_after),
      createdAt: num(r.created_at),
      claimedAt: numOrNull(r.claimed_at),
      finishedAt: numOrNull(r.finished_at),
      exitCode: numOrNull(r.exit_code),
      output: strOrNull(r.output),
    };
  }

  enqueueRunnerJob(job: Pick<RunnerJob, 'id' | 'userId' | 'kind' | 'payload' | 'runAfter'>): RunnerJob {
    this.db
      .prepare("INSERT INTO runner_jobs (id, user_id, kind, payload, state, run_after, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
      .run(job.id, job.userId, job.kind, JSON.stringify(job.payload), job.runAfter, this.now());
    return this.getRunnerJob(job.id)!;
  }

  getRunnerJob(id: string): RunnerJob | null {
    const row = this.db.prepare('SELECT * FROM runner_jobs WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapJob(row) : null;
  }

  /** Забирает следующее готовое задание пользователя. Двум запускам одно задание не достанется. */
  claimRunnerJob(userId: string): RunnerJob | null {
    return this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT id FROM runner_jobs WHERE user_id = ? AND state = 'pending' AND run_after <= ? ORDER BY created_at LIMIT 1")
        .get(userId, this.now()) as Row | undefined;
      if (!row) return null;
      const id = str(row.id);
      this.db.prepare("UPDATE runner_jobs SET state = 'claimed', claimed_at = ? WHERE id = ? AND state = 'pending'").run(this.now(), id);
      return this.getRunnerJob(id);
    });
  }

  finishRunnerJob(id: string, userId: string, exitCode: number, output: string): boolean {
    const result = this.db
      .prepare("UPDATE runner_jobs SET state = ?, finished_at = ?, exit_code = ?, output = ? WHERE id = ? AND user_id = ? AND state = 'claimed'")
      .run(exitCode === 0 ? 'done' : 'failed', this.now(), exitCode, output.slice(-4000), id, userId);
    return num(result.changes) > 0;
  }

  /**
   * Задания, которые никто не забрал за отведённое время: runner не работал.
   * Запускать агента на пост вчерашней давности уже незачем.
   */
  expirePendingRunnerJobs(maxAgeMs: number): RunnerJob[] {
    const rows = this.db.prepare("SELECT * FROM runner_jobs WHERE state = 'pending' AND run_after <= ?").all(this.now() - maxAgeMs) as Row[];
    for (const row of rows) {
      this.db
        .prepare("UPDATE runner_jobs SET state = 'failed', finished_at = ?, exit_code = -3, output = 'expired: the runner was not running' WHERE id = ? AND state = 'pending'")
        .run(this.now(), str(row.id));
    }
    return rows.map(r => this.mapJob(r));
  }

  /** Задания, которые забрали и не закрыли (runner упал): помечаются неудачными. */
  failStaleRunnerJobs(staleMs: number): RunnerJob[] {
    const rows = this.db.prepare("SELECT * FROM runner_jobs WHERE state = 'claimed' AND claimed_at <= ?").all(this.now() - staleMs) as Row[];
    for (const row of rows) {
      this.db
        .prepare("UPDATE runner_jobs SET state = 'failed', finished_at = ?, exit_code = -1, output = 'runner did not report back' WHERE id = ?")
        .run(this.now(), str(row.id));
    }
    return rows.map(r => this.mapJob(r));
  }

  /** Отменяет ещё не начатые задания с таким значением в payload: правило выключили или поручение остановили. */
  cancelPendingRunnerJobs(kind: string, field: string, value: string): number {
    const rows = this.db.prepare("SELECT id, payload FROM runner_jobs WHERE kind = ? AND state = 'pending'").all(kind) as Row[];
    let cancelled = 0;
    for (const row of rows) {
      if (json<Record<string, unknown>>(row.payload, {})[field] !== value) continue;
      this.db.prepare("UPDATE runner_jobs SET state = 'failed', finished_at = ?, exit_code = -2, output = 'cancelled' WHERE id = ? AND state = 'pending'").run(this.now(), str(row.id));
      cancelled++;
    }
    return cancelled;
  }

  /** Есть ли незавершённое задание этого вида с таким значением в payload (например, для поручения). */
  hasOpenRunnerJob(kind: string, field: string, value: string): boolean {
    const rows = this.db.prepare("SELECT payload FROM runner_jobs WHERE kind = ? AND state IN ('pending', 'claimed')").all(kind) as Row[];
    return rows.some(r => json<Record<string, unknown>>(r.payload, {})[field] === value);
  }

  pendingRunnerJobs(userId: string): number {
    return num((this.db.prepare("SELECT COUNT(*) AS n FROM runner_jobs WHERE user_id = ? AND state = 'pending'").get(userId) as Row).n);
  }

  // ---------- scoped tokens ----------

  putScopedToken(tokenSha256: string, userId: string, scope: ScopedGrant, expiresAt: number): void {
    this.db.prepare('INSERT INTO scoped_tokens (token_sha256, user_id, scope, expires_at) VALUES (?, ?, ?, ?)').run(tokenSha256, userId, JSON.stringify(scope), expiresAt);
  }

  getScopedToken(tokenSha256: string): { userId: string; scope: ScopedGrant } | null {
    const row = this.db.prepare('SELECT * FROM scoped_tokens WHERE token_sha256 = ? AND expires_at > ?').get(tokenSha256, this.now()) as Row | undefined;
    return row ? { userId: str(row.user_id), scope: json<ScopedGrant>(row.scope, { accountId: '', chatKeys: [], tools: [] }) } : null;
  }

  revokeScopedTokensForJob(jobId: string): number {
    const rows = this.db.prepare('SELECT token_sha256, scope FROM scoped_tokens').all() as Row[];
    let removed = 0;
    for (const row of rows) {
      if (json<ScopedGrant>(row.scope, { accountId: '', chatKeys: [], tools: [] }).jobId === jobId) {
        this.db.prepare('DELETE FROM scoped_tokens WHERE token_sha256 = ?').run(str(row.token_sha256));
        removed++;
      }
    }
    return removed;
  }

  pruneScopedTokens(): number {
    return num(this.db.prepare('DELETE FROM scoped_tokens WHERE expires_at <= ?').run(this.now()).changes);
  }
}
