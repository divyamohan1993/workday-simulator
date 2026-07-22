/**
 * `createStores` composition root: opens the database and wires the three stores
 * behind the frozen `StoresFactory` signature. This is the only persistence entry
 * point the server constructs; it hands the resulting bundle to the runtime.
 */

import type { StoresBundle, StoresFactory, StoresOptions } from '../contracts/factories.js';
import { openDatabase } from './db.js';
import { createRunStore } from './run-store.js';
import { createScenarioStore } from './scenario-store.js';
import { createTargetStore } from './target-store.js';

/**
 * Default retention for per-run history samples. At the runtime's ~1 Hz persistence
 * cadence this is ~13.9 hours of samples, so realistic runs are never pruned, while a
 * pathological open-ended run cannot grow the table without bound.
 */
const DEFAULT_MAX_SAMPLES_PER_RUN = 50_000;

/**
 * Open the simulator database and build the runs / scenarios / targets stores.
 *
 * @param options `dbPath` (a file path or `:memory:`) and a `logger`.
 * @returns The stores bundle plus a `close()` that releases the database handle.
 */
export const createStores: StoresFactory = (options: StoresOptions): StoresBundle => {
  const { dbPath, logger } = options;
  const { sqlite, db } = openDatabase(dbPath, logger);

  const scenarios = createScenarioStore({ db, logger });
  const targets = createTargetStore({ db, logger });
  const runs = createRunStore({
    db,
    sqlite,
    logger,
    maxSamplesPerRun: DEFAULT_MAX_SAMPLES_PER_RUN,
  });

  return {
    runs,
    scenarios,
    targets,
    close(): void {
      try {
        sqlite.close();
      } catch (err) {
        logger.warn({ err }, 'error while closing the database handle');
      }
    },
  };
};

// Compile-time conformance guard: the exported factory must satisfy the frozen alias
// exactly, so any drift fails the build here rather than in the integrator's session.
const _conformance: StoresFactory = createStores;
void _conformance;
