/**
 * Миграции схемы. Индекс в массиве плюс один это версия (PRAGMA user_version).
 * Опубликованные миграции не меняются: новое добавляется следующей записью.
 */
export const MIGRATIONS: string[] = [
  // 1: пользователи, аккаунты, сессии, кэш сущностей, аудит, задачи
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    token_sha256 TEXT NOT NULL UNIQUE,
    telegram_id TEXT,
    default_account TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    tg_user_id TEXT,
    username TEXT,
    display_name TEXT,
    status TEXT NOT NULL DEFAULT 'needs_login',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE account_access (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (account_id, user_id)
  );

  CREATE TABLE sessions (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    iv TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE entities (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    peer_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    access_hash TEXT,
    username TEXT,
    title TEXT,
    meta TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, peer_key)
  );
  CREATE INDEX entities_username ON entities(account_id, username);

  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    user_id TEXT,
    account_id TEXT,
    tool TEXT NOT NULL,
    args TEXT NOT NULL DEFAULT '{}',
    peer_key TEXT,
    result_count INTEGER,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    flood_wait_seconds INTEGER
  );
  CREATE INDEX audit_ts ON audit(ts);

  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    account_id TEXT,
    kind TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT 'queued',
    progress TEXT NOT NULL DEFAULT '{}',
    result TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX jobs_state ON jobs(state);

  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];
