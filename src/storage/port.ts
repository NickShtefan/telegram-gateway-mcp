/**
 * Порт хранилища. Ядро и сервисы знают только эти интерфейсы; реализация
 * по умолчанию на SQLite (`sqlite.ts`). Методы синхронные: SQLite в одном
 * процессе отвечает сразу, а запись получается атомарной без блокировок.
 *
 * Все id чатов здесь это ключи из `core/chatId.ts` (помеченный id строкой).
 */
import type { Sealed } from '../core/crypto.js';
import type { PeerKind } from '../core/chatId.js';

// ---------- пользователи и аккаунты (решение 16) ----------

export interface UserRecord {
  id: string;
  /** SHA-256 от bearer-токена. Сам токен шлюз не хранит. */
  tokenSha256: string;
  /** Telegram id человека: кому бот согласований шлёт запросы. */
  telegramId: string | null;
  defaultAccount: string | null;
  createdAt: number;
}

export type AccountStatus = 'needs_login' | 'active' | 'unauthorized' | 'frozen';

export interface AccountRecord {
  id: string;
  /** Telegram id самого аккаунта, известен после входа. */
  tgUserId: string | null;
  username: string | null;
  displayName: string | null;
  status: AccountStatus;
  createdAt: number;
  updatedAt: number;
}

export interface UsersRepo {
  create(user: { id: string; tokenSha256: string; telegramId?: string | null; defaultAccount?: string | null }): UserRecord;
  get(id: string): UserRecord | null;
  findByTokenHash(tokenSha256: string): UserRecord | null;
  list(): UserRecord[];
  update(id: string, patch: { tokenSha256?: string; telegramId?: string | null; defaultAccount?: string | null }): void;
  remove(id: string): void;
}

export interface AccountsRepo {
  upsert(account: { id: string; tgUserId?: string | null; username?: string | null; displayName?: string | null; status?: AccountStatus }): AccountRecord;
  get(id: string): AccountRecord | null;
  list(): AccountRecord[];
  setStatus(id: string, status: AccountStatus): void;
  remove(id: string): void;
  grant(accountId: string, userId: string): void;
  revoke(accountId: string, userId: string): void;
  hasAccess(userId: string, accountId: string): boolean;
  accountsOf(userId: string): AccountRecord[];
  usersOf(accountId: string): string[];
}

export interface SessionsRepo {
  put(accountId: string, sealed: Sealed): void;
  get(accountId: string): Sealed | null;
  remove(accountId: string): void;
}

// ---------- кэш сущностей: accessHash привязан к аккаунту ----------

export interface EntityRecord {
  accountId: string;
  peerKey: string;
  kind: PeerKind;
  /** accessHash строкой; у обычных групп его нет. */
  accessHash: string | null;
  username: string | null;
  title: string | null;
  /** Форум, канал или супергруппа, группа обсуждений и прочее. */
  meta: Record<string, unknown>;
  updatedAt: number;
}

export interface EntitiesRepo {
  put(entity: Omit<EntityRecord, 'updatedAt'>): void;
  putMany(entities: Array<Omit<EntityRecord, 'updatedAt'>>): void;
  get(accountId: string, peerKey: string): EntityRecord | null;
  getByUsername(accountId: string, username: string): EntityRecord | null;
  remove(accountId: string, peerKey: string): void;
  count(accountId: string): number;
}

// ---------- аудит ----------

export interface AuditEntry {
  id: number;
  ts: number;
  userId: string | null;
  accountId: string | null;
  tool: string;
  /** Аргументы вызова без секретов. */
  args: Record<string, unknown>;
  peerKey: string | null;
  resultCount: number | null;
  durationMs: number;
  /** Код GatewayError или null при успехе. */
  errorCode: string | null;
  floodWaitSeconds: number | null;
}

export interface AuditRepo {
  add(entry: Omit<AuditEntry, 'id'>): number;
  recent(filter?: { userId?: string; accountId?: string; tool?: string; limit?: number }): AuditEntry[];
  prune(olderThanTs: number): number;
}

// ---------- задачи (долгие операции) ----------

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobRecord {
  id: string;
  userId: string;
  accountId: string | null;
  kind: string;
  params: Record<string, unknown>;
  state: JobState;
  progress: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface JobsRepo {
  create(job: { id: string; userId: string; accountId?: string | null; kind: string; params: Record<string, unknown> }): JobRecord;
  get(id: string): JobRecord | null;
  update(id: string, patch: { state?: JobState; progress?: Record<string, unknown>; result?: Record<string, unknown> | null; error?: string | null }): void;
  list(filter?: { userId?: string; state?: JobState; limit?: number }): JobRecord[];
  /** После рестарта: всё, что «выполнялось», возвращается в очередь. */
  requeueRunning(): number;
}

// ---------- скоупы доступа ----------

export type ScopeEffect = 'allow' | 'deny';

export interface ScopeRule {
  userId: string;
  accountId: string;
  /** Ключ чата или username в нижнем регистре без @. */
  target: string;
  effect: ScopeEffect;
  /** `owner` или `task:<id>`: поручение открывает ровно один диалог и закрывает его за собой. */
  source: string;
  createdAt: number;
}

export interface ScopesRepo {
  put(rule: Omit<ScopeRule, 'createdAt'>): void;
  list(userId: string, accountId: string): ScopeRule[];
  remove(userId: string, accountId: string, target: string, source?: string): number;
  removeBySource(source: string): number;
}

// ---------- ключ-значение для мелкого состояния ----------

export interface KvRepo {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface Storage {
  users: UsersRepo;
  accounts: AccountsRepo;
  sessions: SessionsRepo;
  entities: EntitiesRepo;
  audit: AuditRepo;
  jobs: JobsRepo;
  scopes: ScopesRepo;
  kv: KvRepo;
  /** Выполняет fn в одной транзакции; при ошибке откатывает. */
  transaction<T>(fn: () => T): T;
  close(): void;
}
