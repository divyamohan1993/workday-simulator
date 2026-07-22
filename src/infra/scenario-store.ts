/**
 * `ScenarioStore` over SQLite/Drizzle.
 *
 * Soft-delete semantics per the contract: `remove` sets `deleted_at`; `list` hides
 * soft-deleted rows; `get` still resolves them so a historical run can render the
 * scenario it referenced. All access is through Drizzle's parameterized builders,
 * never string interpolation.
 */

import { and, count, desc, eq, isNull } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Paginated, ScenarioConfig } from '../types/index.js';
import type { ScenarioStore } from '../contracts/stores.js';
import type { AppDatabase } from './db.js';
import { scenarios } from './schema.js';
import { clampLimit, clampOffset, isoToMs, toPaginated } from './store-helpers.js';

/** Construction dependencies. `now` is injectable so tests are deterministic. */
export interface ScenarioStoreDeps {
  db: AppDatabase;
  logger: Logger;
  /** Wall-clock source for audit timestamps; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Build the scenario store.
 *
 * @param deps Drizzle handle, logger, and optional clock.
 * @returns A `ScenarioStore` implementation.
 */
export function createScenarioStore(deps: ScenarioStoreDeps): ScenarioStore {
  const { db, logger } = deps;
  const now = deps.now ?? Date.now;

  return {
    create(scenario: ScenarioConfig): ScenarioConfig {
      const createdAt = isoToMs(scenario.createdAt) ?? now();
      const updatedAt = isoToMs(scenario.updatedAt) ?? createdAt;
      try {
        db.insert(scenarios)
          .values({
            id: scenario.id,
            name: scenario.name,
            data: scenario,
            createdAt,
            updatedAt,
            deletedAt: null,
          })
          .run();
      } catch (err) {
        logger.error({ err, scenarioId: scenario.id }, 'scenario insert failed');
        throw new Error(`could not create scenario ${scenario.id}`);
      }
      return scenario;
    },

    update(id: string, patch: Partial<ScenarioConfig>): ScenarioConfig | undefined {
      const updatedAtMs = now();
      return db.transaction((tx) => {
        const existing = tx
          .select()
          .from(scenarios)
          .where(and(eq(scenarios.id, id), isNull(scenarios.deletedAt)))
          .get();
        if (!existing) return undefined;

        // Merge shallowly, then re-assert the immutable identity/creation fields so a
        // malformed patch cannot rewrite the primary key or forge the creation time.
        const merged: ScenarioConfig = {
          ...existing.data,
          ...patch,
          id: existing.data.id,
          createdAt: existing.data.createdAt,
          updatedAt: new Date(updatedAtMs).toISOString(),
        };

        tx.update(scenarios)
          .set({ data: merged, name: merged.name, updatedAt: updatedAtMs })
          .where(eq(scenarios.id, id))
          .run();
        return merged;
      });
    },

    get(id: string): ScenarioConfig | undefined {
      // No deleted-at filter: soft-deleted scenarios remain resolvable by id.
      const row = db.select().from(scenarios).where(eq(scenarios.id, id)).get();
      return row?.data;
    },

    list(limit: number, offset: number): Paginated<ScenarioConfig> {
      const safeLimit = clampLimit(limit);
      const safeOffset = clampOffset(offset);
      const rows = db
        .select()
        .from(scenarios)
        .where(isNull(scenarios.deletedAt))
        .orderBy(desc(scenarios.seq))
        .limit(safeLimit)
        .offset(safeOffset)
        .all();
      const totalRow = db
        .select({ value: count() })
        .from(scenarios)
        .where(isNull(scenarios.deletedAt))
        .get();
      const total = Number(totalRow?.value ?? 0);
      return toPaginated(
        rows.map((row) => row.data),
        total,
        safeLimit,
        safeOffset,
      );
    },

    remove(id: string): boolean {
      const ts = now();
      const result = db
        .update(scenarios)
        .set({ deletedAt: ts, updatedAt: ts })
        .where(and(eq(scenarios.id, id), isNull(scenarios.deletedAt)))
        .run();
      return result.changes > 0;
    },
  };
}
