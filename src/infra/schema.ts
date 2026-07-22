/**
 * Drizzle schema for the simulator's own better-sqlite3 database.
 *
 * WHY a JSON payload column plus a few flat audit/index columns, rather than a
 * fully normalized column-per-field mapping: the domain objects persisted here
 * (ScenarioConfig, DeliveryTarget, RunState, RunSummary) are deeply nested and the
 * REST contract never queries their internals in SQL. Every read is either a
 * get-by-id or a newest-first page; nothing filters on a nested field. Storing the
 * canonical object in a single JSON `data` column keeps reconstruction lossless and
 * avoids brittle, ever-drifting column maps, while the flat `created_at` /
 * `updated_at` / `deleted_at` columns drive sorting and soft-delete without parsing
 * JSON. If a future feature needs to filter on an inner field, add a generated
 * column then (YAGNI until then).
 *
 * WHY a synthetic monotonic `seq` INTEGER PRIMARY KEY AUTOINCREMENT in addition to
 * the logical `id`: ordering "newest first" by a millisecond `created_at` alone is
 * non-deterministic because rapid inserts collide within the same millisecond.
 * `seq` is strictly increasing and persistent, giving every list a stable, total
 * ordering (`ORDER BY seq DESC`). The logical `id` (a nanoid, or the run id for
 * summaries) stays the external primary key via a UNIQUE constraint.
 *
 * Timestamps are stored as epoch-milliseconds INTEGERs (not ISO text) so ordering
 * and range scans are pure integer comparisons. The domain objects keep their own
 * ISO `createdAt` / `updatedAt` strings inside the JSON payload; the columns mirror
 * them for the database's own bookkeeping.
 *
 * The tables are created at runtime by the idempotent bootstrap in `db.ts`
 * (`CREATE TABLE IF NOT EXISTS`), so a blank database boots with zero external
 * steps. This schema is ALSO the source of truth for `drizzle-kit generate`; it is
 * referenced by `drizzle.config.ts` (see integration notes about its path).
 */

import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  DeliveryTarget,
  RunState,
  RunSummary,
  ScenarioConfig,
} from '../types/index.js';

/**
 * Reusable simulation profiles. `remove` is a soft delete (sets `deleted_at`) so a
 * historical run can still resolve the scenario it referenced.
 */
export const scenarios = sqliteTable('scenarios', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  name: text('name').notNull(),
  data: text('data', { mode: 'json' }).$type<ScenarioConfig>().notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
});

/**
 * Delivery destinations for the event stream. The built-in receiver target is
 * marked `built_in` and is protected from deletion by the store.
 */
export const targets = sqliteTable('targets', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  builtIn: integer('built_in', { mode: 'boolean' }).notNull(),
  data: text('data', { mode: 'json' }).$type<DeliveryTarget>().notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
});

/**
 * Live run state. The runtime overwrites this row (~1 Hz) with the latest RunState;
 * the immutable end-of-run report lives in `run_summaries`, and the per-tick history
 * time series lives in `run_samples`.
 */
export const runs = sqliteTable('runs', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  scenarioId: text('scenario_id').notNull(),
  targetId: text('target_id').notNull(),
  status: text('status').notNull(),
  data: text('data', { mode: 'json' }).$type<RunState>().notNull(),
  startedAt: integer('started_at'),
  endedAt: integer('ended_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
});

/**
 * Immutable end-of-run summaries. The logical `id` column holds the run id, so a
 * summary is one-to-one with its run and `saveSummary` upserts on it.
 */
export const runSummaries = sqliteTable('run_summaries', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  scenarioId: text('scenario_id').notNull(),
  targetId: text('target_id').notNull(),
  status: text('status').notNull(),
  data: text('data', { mode: 'json' }).$type<RunSummary>().notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
});

/**
 * Compact per-tick run-history samples. Appended as a side effect of
 * `RunStore.update` (the only place, under the frozen contracts, that is invoked on
 * the right ~1 Hz cadence with the run's live counters). Each row is a throughput +
 * cumulative-counter snapshot; the full latency/error-rate picture is captured once
 * per run in `run_summaries`. See `run-store.ts` for the rationale.
 */
export const runSamples = sqliteTable('run_samples', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  runId: text('run_id').notNull(),
  ts: integer('ts').notNull(),
  status: text('status').notNull(),
  elapsedSec: real('elapsed_sec').notNull(),
  currentRps: real('current_rps').notNull(),
  targetRps: real('target_rps').notNull(),
  generated: integer('generated').notNull(),
  delivered: integer('delivered').notNull(),
  failed: integer('failed').notNull(),
  dropped: integer('dropped').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
});

/** All tables, for bootstrap iteration and drizzle-kit discovery. */
export const schema = { scenarios, targets, runs, runSummaries, runSamples };

export type ScenarioRow = typeof scenarios.$inferSelect;
export type TargetRow = typeof targets.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type RunSummaryRow = typeof runSummaries.$inferSelect;
export type RunSampleRow = typeof runSamples.$inferSelect;
