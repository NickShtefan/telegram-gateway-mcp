/**
 * Хранилище поручений. Поручение помнит цель, рамки и переписку, пока дело не
 * закончится: агент между запусками ничего не помнит (решение 10).
 */
import type { SqliteStorage } from '../storage/sqlite.js';

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));

/**
 * waiting_reply: ждём ответ собеседника; agent_turn: агент думает;
 * question: вопрос владельцу; done: готово; closed: остановлено или истекло.
 */
export type TaskState = 'waiting_reply' | 'agent_turn' | 'question' | 'done' | 'closed';
export type TaskVia = 'account' | 'business';
export type TaskRole = 'peer' | 'agent' | 'owner' | 'system';

export const ASK_ME_BEFORE = ['over_limits', 'money_transfer', 'address', 'personal_data', 'meeting_time'] as const;
export type AskMeBefore = (typeof ASK_ME_BEFORE)[number];

export interface TaskRecord {
  id: string;
  userId: string;
  accountId: string | null;
  via: TaskVia;
  peerKey: string;
  peerLabel: string;
  goal: string;
  limits: string;
  askMeBefore: string[];
  state: TaskState;
  deadlineAt: number;
  maxMessages: number;
  reminderAfterMs: number | null;
  reminderSent: boolean;
  messagesSent: number;
  lastSeenId: number;
  nextPollAt: number;
  lastActivityAt: number;
  question: string | null;
  questionMessageId: number | null;
  summary: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TaskMessage {
  id: number;
  taskId: string;
  ts: number;
  role: TaskRole;
  text: string;
  tgMessageId: number | null;
}

export type NewTask = Pick<
  TaskRecord,
  'id' | 'userId' | 'accountId' | 'via' | 'peerKey' | 'peerLabel' | 'goal' | 'limits' | 'askMeBefore' | 'deadlineAt' | 'maxMessages' | 'reminderAfterMs'
>;

export type TaskPatch = Partial<
  Pick<TaskRecord, 'state' | 'reminderSent' | 'messagesSent' | 'lastSeenId' | 'nextPollAt' | 'lastActivityAt' | 'question' | 'questionMessageId' | 'summary'>
>;

const ACTIVE: TaskState[] = ['waiting_reply', 'agent_turn', 'question'];

export class TaskStore {
  constructor(
    private readonly db: SqliteStorage,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private map(r: Row): TaskRecord {
    let ask: string[] = [];
    try {
      ask = JSON.parse(str(r.ask_me_before)) as string[];
    } catch {
      ask = [];
    }
    return {
      id: str(r.id),
      userId: str(r.user_id),
      accountId: strOrNull(r.account_id),
      via: str(r.via) as TaskVia,
      peerKey: str(r.peer_key),
      peerLabel: str(r.peer_label),
      goal: str(r.goal),
      limits: str(r.limits),
      askMeBefore: ask,
      state: str(r.state) as TaskState,
      deadlineAt: num(r.deadline_at),
      maxMessages: num(r.max_messages),
      reminderAfterMs: numOrNull(r.reminder_after_ms),
      reminderSent: num(r.reminder_sent) === 1,
      messagesSent: num(r.messages_sent),
      lastSeenId: num(r.last_seen_id),
      nextPollAt: num(r.next_poll_at),
      lastActivityAt: num(r.last_activity_at),
      question: strOrNull(r.question),
      questionMessageId: numOrNull(r.question_message_id),
      summary: strOrNull(r.summary),
      createdAt: num(r.created_at),
      updatedAt: num(r.updated_at),
    };
  }

  create(task: NewTask): TaskRecord {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO tasks (id, user_id, account_id, via, peer_key, peer_label, goal, limits, ask_me_before, state, deadline_at, max_messages,
           reminder_after_ms, last_activity_at, next_poll_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting_reply', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.userId,
        task.accountId,
        task.via,
        task.peerKey,
        task.peerLabel,
        task.goal,
        task.limits,
        JSON.stringify(task.askMeBefore),
        task.deadlineAt,
        task.maxMessages,
        task.reminderAfterMs,
        now,
        now,
        now,
        now,
      );
    return this.get(task.id)!;
  }

  get(id: string): TaskRecord | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return row ? this.map(row) : null;
  }

  update(id: string, patch: TaskPatch): void {
    const current = this.get(id);
    if (!current) return;
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE tasks SET state = ?, reminder_sent = ?, messages_sent = ?, last_seen_id = ?, next_poll_at = ?, last_activity_at = ?,
           question = ?, question_message_id = ?, summary = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.state,
        next.reminderSent ? 1 : 0,
        next.messagesSent,
        next.lastSeenId,
        next.nextPollAt,
        next.lastActivityAt,
        next.question,
        next.questionMessageId,
        next.summary,
        this.now(),
        id,
      );
  }

  /** Поручения, видимые пользователю: свои и чужие на общих аккаунтах (решение 18). */
  visibleTo(userId: string, limit = 50): TaskRecord[] {
    return (
      this.db
        .prepare(
          `SELECT t.* FROM tasks t WHERE t.user_id = ?
           UNION
           SELECT t.* FROM tasks t JOIN account_access x ON x.account_id = t.account_id WHERE x.user_id = ?
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(userId, userId, limit) as Row[]
    ).map(r => this.map(r));
  }

  active(): TaskRecord[] {
    const marks = ACTIVE.map(() => '?').join(', ');
    return (this.db.prepare(`SELECT * FROM tasks WHERE state IN (${marks}) ORDER BY created_at`).all(...ACTIVE) as Row[]).map(r => this.map(r));
  }

  /** Активное поручение пользователя с этим собеседником. */
  activeWithPeer(userId: string, peerKey: string, via?: TaskVia): TaskRecord | null {
    return this.active().find(t => t.userId === userId && t.peerKey === peerKey && (via === undefined || t.via === via)) ?? null;
  }

  /** Поручения с открытым вопросом владельцу. */
  openQuestions(userId: string): TaskRecord[] {
    return this.active().filter(t => t.userId === userId && t.state === 'question');
  }

  addMessage(taskId: string, role: TaskRole, text: string, tgMessageId: number | null = null, ts?: number): number {
    const result = this.db
      .prepare('INSERT INTO task_messages (task_id, ts, role, text, tg_message_id) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, ts ?? this.now(), role, text, tgMessageId);
    return num(result.lastInsertRowid);
  }

  messages(taskId: string, limit = 200): TaskMessage[] {
    return (
      this.db.prepare('SELECT * FROM (SELECT * FROM task_messages WHERE task_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id').all(taskId, limit) as Row[]
    ).map(r => ({ id: num(r.id), taskId: str(r.task_id), ts: num(r.ts), role: str(r.role) as TaskRole, text: str(r.text), tgMessageId: numOrNull(r.tg_message_id) }));
  }

  hasMessage(taskId: string, tgMessageId: number): boolean {
    return this.db.prepare('SELECT 1 AS ok FROM task_messages WHERE task_id = ? AND tg_message_id = ?').get(taskId, tgMessageId) !== undefined;
  }
}
