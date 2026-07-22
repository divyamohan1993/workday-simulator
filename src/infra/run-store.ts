/**
 * `RunStore` over SQLite/Drizzle, plus the run-history sampler.
 *
 * WHY the sampler lives here, on `update`: the task calls for "periodically persist
 * compact samples to SQLite for run history", but under the frozen contracts the
 * `MetricsRegistry` has no database handle (its `MetricsOptions` is only
 * `{ recentEventsSize }`) and the already-built runtime never calls a sample-persist
 * method. The one seam that fires on the right ~1 Hz cadence with the run's live
 * counters is `RunStore.update`: the runtime invokes it every `PERSIST_INTERVAL_MS`
 * with `{ status, elapsedSec, currentRps, targetRps, counters, ... }`. So each run
 * checkpoint also appends a compact `run_samples` row. This needs no cooperation from
 * the (unbuilt) server and leaks nothing past the frozen interfaces. The full
 * latency / error-rate picture is captured once per run in `run_summaries`; the
 * samples are a throughput + cumulative-counter time series for charting.
 *
 * The sample write is best-effort and isolated: it runs AFTER the run-state update
 * has committed and is wrapped so a sampling failure can never abort the run update
 * the runtime depends on. Rapid duplicate checkpoints (the runtime persists several
 * times within a few milliseconds at finalize) are de-duplicated by a per-run
 * minimum interval, while a terminal-status checkpoint is always recorded so the
 * final counters land in history.
 */

import { count, desc, eq, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { Paginated, RunState, RunSummary, RunStatus } from '../types/index.js';
import type { RunStore } from '../contracts/stores.js';
import type { AppDatabase } from './db.js';
import { runSamples, runSummaries, runs } from './schema.js';
import { clampLimit, clampOffset, isoToMs, toPaginated } from './store-helpers.js';

/** Per-run sampler bookkeeping, kept in memory and freed when a run finalizes. */
interface SampleState {
  lastMs: number;
  count: number;
}

/** Construction dependencies for the run store. */
export interface RunStoreDeps {
  db: AppDatabase;
  /** Raw handle, used only for the parameterized sample-prune statement. */
  sqlite: Database.Database;
  logger: Logger;
  /** Wall-clock source; defaults to `Date.now`. Injectable for deterministic tests. */
  now?: () => number;
  /** Minimum gap between two history samples for the same run. Default 500 ms. */
  sampleMinIntervalMs?: number;
  /** Cap on retained samples per run (0 = unbounded). Oldest are pruned beyond it. */
  maxSamplesPerRun?: number;
  /** Amortize prune cost: only prune every Nth sample. Default 512. */
  pruneEvery?: number;
}

/** Terminal run states after which no further history samples are expected. */
function isTerminal(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed';
}

/**
 * Build the run store.
 *
 * @param deps Drizzle handle, raw handle, logger, and sampler tuning.
 * @returns A `RunStore` implementation that also maintains run-history samples.
 */
export function createRunStore(deps: RunStoreDeps): RunStore {
  const { db, sqlite, logger } = deps;
  const now = deps.now ?? Date.now;
  const sampleMinIntervalMs = deps.sampleMinIntervalMs ?? 500;
  const maxSamplesPerRun = deps.maxSamplesPerRun ?? 0;
  const pruneEvery = Math.max(1, deps.pruneEvery ?? 512);

  const sampleState = new Map<string, SampleState>();

  // Prepared once; parameterized so a run id can never be interpolated into SQL.
  // Keeps only the newest `?` samples for a run, deleting anything older by seq.
  const pruneStmt = sqlite.prepare(
    `DELETE FROM run_samples
       WHERE run_id = ?
         AND seq NOT IN (
           SELECT seq FROM run_samples WHERE run_id = ? ORDER BY seq DESC LIMIT ?
         )`,
  );

  /** Append one compact history sample for `run`, throttled and best-effort. */
  function appendSample(run: RunState, ms: number): void {
    const terminal = isTerminal(run.status);
    const prior = sampleState.get(run.id);
    if (!terminal && prior !== undefined && ms - prior.lastMs < sampleMinIntervalMs) {
      return; // Too soon after the previous sample: de-duplicate.
    }
    const nextCount = (prior?.count ?? 0) + 1;
    try {
      db.insert(runSamples)
        .values({
          id: nanoid(),
          runId: run.id,
          ts: ms,
          status: run.status,
          elapsedSec: run.elapsedSec,
          currentRps: run.currentRps,
          targetRps: run.targetRps,
          generated: run.counters.generated,
          delivered: run.counters.delivered,
          failed: run.counters.failed,
          dropped: run.counters.dropped,
          createdAt: ms,
          updatedAt: ms,
          deletedAt: null,
        })
        .run();
      if (maxSamplesPerRun > 0 && nextCount % pruneEvery === 0) {
        pruneStmt.run(run.id, run.id, maxSamplesPerRun);
      }
    } catch (err) {
      // History is auxiliary; never let it break the authoritative run-state write.
      logger.debug({ err, runId: run.id }, 'run-history sample append failed; ignored');
    }

    if (terminal) {
      sampleState.delete(run.id); // Bound memory: free bookkeeping once the run ends.
    } else {
      sampleState.set(run.id, { lastMs: ms, count: nextCount });
    }
  }

  return {
    create(run: RunState): void {
      const ts = now();
      // Ids are caller-supplied (nanoid), so a replayed create is idempotent rather
      // than an error: ignore a conflict on the unique id instead of throwing.
      db.insert(runs)
        .values({
          id: run.id,
          scenarioId: run.scenarioId,
          targetId: run.targetId,
          status: run.status,
          data: run,
          startedAt: isoToMs(run.startedAt),
          endedAt: isoToMs(run.endedAt),
          createdAt: ts,
          updatedAt: ts,
          deletedAt: null,
        })
        .onConflictDoNothing({ target: runs.id })
        .run();
    },

    update(id: string, patch: Partial<RunState>): void {
      const ms = now();
      const merged = db.transaction((tx): RunState | undefined => {
        const existing = tx.select().from(runs).where(eq(runs.id, id)).get();
        if (!existing) return undefined;
        // Preserve identity fields; the runtime never patches them, but a defensive
        // merge keeps the primary key and seed immutable regardless of the patch.
        const next: RunState = {
          ...existing.data,
          ...patch,
          id: existing.data.id,
          scenarioId: existing.data.scenarioId,
          targetId: existing.data.targetId,
          seed: existing.data.seed,
        };
        tx.update(runs)
          .set({
            status: next.status,
            data: next,
            startedAt: isoToMs(next.startedAt),
            endedAt: isoToMs(next.endedAt),
            updatedAt: ms,
          })
          .where(eq(runs.id, id))
          .run();
        return next;
      });

      if (merged === undefined) {
        // The runtime always creates a run before updating it; an unknown id means an
        // upstream ordering bug. Warn but do not throw, so the sim stays resilient.
        logger.warn({ runId: id }, 'update for unknown run ignored');
        return;
      }
      appendSample(merged, ms);
    },

    get(id: string): RunState | undefined {
      const row = db.select().from(runs).where(eq(runs.id, id)).get();
      return row?.data;
    },

    list(limit: number, offset: number): Paginated<RunState> {
      const safeLimit = clampLimit(limit);
      const safeOffset = clampOffset(offset);
      const rows = db
        .select()
        .from(runs)
        .where(isNull(runs.deletedAt))
        .orderBy(desc(runs.seq))
        .limit(safeLimit)
        .offset(safeOffset)
        .all();
      const totalRow = db
        .select({ value: count() })
        .from(runs)
        .where(isNull(runs.deletedAt))
        .get();
      const total = Number(totalRow?.value ?? 0);
      return toPaginated(
        rows.map((row) => row.data),
        total,
        safeLimit,
        safeOffset,
      );
    },

    saveSummary(summary: RunSummary): void {
      const ts = now();
      // A run finalizes once, but `stop` can be re-invoked; upsert on the run id so a
      // repeated save overwrites rather than conflicts.
      db.insert(runSummaries)
        .values({
          id: summary.runId,
          scenarioId: summary.scenarioId,
          targetId: summary.targetId,
          status: summary.status,
          data: summary,
          createdAt: ts,
          updatedAt: ts,
          deletedAt: null,
        })
        .onConflictDoUpdate({
          target: runSummaries.id,
          set: { status: summary.status, data: summary, updatedAt: ts },
        })
        .run();
    },

    getSummary(runId: string): RunSummary | undefined {
      const row = db.select().from(runSummaries).where(eq(runSummaries.id, runId)).get();
      return row?.data;
    },
  };
}
