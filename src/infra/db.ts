/**
 * better-sqlite3 connection setup and idempotent schema bootstrap.
 *
 * WHY self-bootstrap with `CREATE TABLE IF NOT EXISTS` instead of relying on
 * `drizzle-kit migrate`: the simulator must boot on a blank database with zero
 * external steps (the house "zero-intervention autoconfig" rule). Requiring a
 * separate `pnpm db:migrate` before first run would break a fresh Docker deploy and
 * every unit test. The Drizzle schema in `schema.ts` remains the source of truth for
 * query typing and for `drizzle-kit generate`; this bootstrap creates the exact same
 * tables at runtime so the two paths converge whether or not migrations were run.
 *
 * WHY WAL: the simulator writes run state and history samples continuously while the
 * dashboard reads. WAL lets readers and a writer proceed concurrently without
 * blocking, which keeps the ~1 Hz persistence off the hot path. `synchronous=NORMAL`
 * is the correct durability/throughput trade under WAL (safe across app crashes,
 * only a power loss can lose the last commit, which for a load-generator's own
 * bookkeeping is acceptable). `busy_timeout` avoids spurious SQLITE_BUSY under the
 * brief reader/writer overlaps.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { Logger } from 'pino';
import { schema } from './schema.js';

/** The Drizzle handle, typed with the simulator schema for relational access. */
export type AppDatabase = BetterSQLite3Database<typeof schema>;

/** An opened database: the raw better-sqlite3 handle plus the Drizzle wrapper. */
export interface OpenedDatabase {
  /** Raw handle, owned for pragmas, bootstrap DDL and `close()`. */
  sqlite: Database.Database;
  /** Drizzle query layer used by the stores. */
  db: AppDatabase;
}

/**
 * DDL that mirrors `schema.ts` exactly. Executed once at open time. Idempotent:
 * every statement is `IF NOT EXISTS`, so re-opening an existing database is a no-op
 * and opening one that `drizzle-kit migrate` already created only adds any missing
 * indexes.
 */
const BOOTSTRAP_DDL = `
CREATE TABLE IF NOT EXISTS scenarios (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_scenarios_active ON scenarios (deleted_at, seq);

CREATE TABLE IF NOT EXISTS targets (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  built_in INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_targets_active ON targets (deleted_at, seq);

CREATE TABLE IF NOT EXISTS runs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  scenario_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_active ON runs (deleted_at, seq);

CREATE TABLE IF NOT EXISTS run_summaries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  scenario_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS run_samples (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  status TEXT NOT NULL,
  elapsed_sec REAL NOT NULL,
  current_rps REAL NOT NULL,
  target_rps REAL NOT NULL,
  generated INTEGER NOT NULL,
  delivered INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  dropped INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_run_samples_run ON run_samples (run_id, seq);
`;

/** Whether a path refers to a transient in-memory database that has no parent dir. */
function isInMemory(dbPath: string): boolean {
  return dbPath === ':memory:' || dbPath.startsWith('file::memory:') || dbPath === '';
}

/**
 * Open the simulator database, apply pragmas, and ensure the schema exists.
 *
 * @param dbPath Filesystem path (or `:memory:`) for the SQLite file. The parent
 *   directory is created if missing so a blank deploy works without manual setup.
 * @param logger Structured logger for one-line open diagnostics.
 * @returns The raw handle and the Drizzle wrapper.
 * @throws If the database cannot be opened (surfaced to the caller to fail fast).
 */
export function openDatabase(dbPath: string, logger: Logger): OpenedDatabase {
  if (!isInMemory(dbPath)) {
    // Create the containing directory so a first-boot on a clean host succeeds.
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
    } catch (err) {
      logger.warn({ err, dbPath }, 'could not ensure database directory; continuing');
    }
  }

  const sqlite = new Database(dbPath);

  // Durability and concurrency pragmas. WAL is a no-op on :memory: (reports
  // "memory"); we log whatever mode we actually got rather than assume.
  const journalMode = sqlite.pragma('journal_mode = WAL', { simple: true });
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  // Create tables and indexes before any query runs on this connection.
  sqlite.exec(BOOTSTRAP_DDL);

  const db = drizzle(sqlite, { schema });

  logger.info({ dbPath: isInMemory(dbPath) ? ':memory:' : dbPath, journalMode }, 'database ready');
  return { sqlite, db };
}
