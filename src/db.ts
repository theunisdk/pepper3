import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type JobMode = 'main' | 'isolated';
export type RunStatus = 'running' | 'ok' | 'error' | 'timeout' | 'skipped';

export interface Job {
  id: number;
  name: string;
  /** Cron expression, or an ISO timestamp for a one-shot. */
  schedule: string;
  kind: 'cron' | 'at';
  tz: string;
  prompt: string;
  mode: JobMode;
  enabled: number;
  /** Epoch ms of the next occurrence, or null if there is none (fired one-shot). */
  next_run: number | null;
  created_at: number;
}

export interface Run {
  id: number;
  job_id: number;
  /** Epoch ms of the *nominal* occurrence — the scheduler's idempotency key. */
  scheduled_for: number;
  started_at: number;
  finished_at: number | null;
  status: RunStatus;
  late: number;
  summary: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One Codex thread per chat. Survives restarts: this is what makes a daemon
-- restart invisible to the conversation.
CREATE TABLE IF NOT EXISTS threads (
  chat_key   TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  schedule   TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('cron','at')),
  tz         TEXT NOT NULL,
  prompt     TEXT NOT NULL,
  mode       TEXT NOT NULL CHECK (mode IN ('main','isolated')),
  enabled    INTEGER NOT NULL DEFAULT 1,
  next_run   INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  scheduled_for INTEGER NOT NULL,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  status        TEXT NOT NULL CHECK (status IN ('running','ok','error','timeout','skipped')),
  late          INTEGER NOT NULL DEFAULT 0,
  summary       TEXT
);

-- The heart of "no silent skips, no double fires": an occurrence can be claimed
-- exactly once. Both the live ticker and restart catch-up insert through this
-- constraint, so they can never both run the same occurrence.
CREATE UNIQUE INDEX IF NOT EXISTS runs_occurrence ON runs(job_id, scheduled_for);
CREATE INDEX IF NOT EXISTS runs_by_job ON runs(job_id, scheduled_for DESC);
`;

export function openDb(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

// --- threads -----------------------------------------------------------------

export function getThreadId(db: Database.Database, chatKey: string): string | undefined {
  const row = db.prepare('SELECT thread_id FROM threads WHERE chat_key = ?').get(chatKey) as
    | { thread_id: string }
    | undefined;
  return row?.thread_id;
}

export function setThreadId(db: Database.Database, chatKey: string, threadId: string): void {
  db.prepare(
    `INSERT INTO threads (chat_key, thread_id, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(chat_key) DO UPDATE SET thread_id = excluded.thread_id, updated_at = excluded.updated_at`,
  ).run(chatKey, threadId, Date.now());
}

export function clearThread(db: Database.Database, chatKey: string): void {
  db.prepare('DELETE FROM threads WHERE chat_key = ?').run(chatKey);
}

// --- meta (main chat id, etc.) ----------------------------------------------

export function getMeta(db: Database.Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
