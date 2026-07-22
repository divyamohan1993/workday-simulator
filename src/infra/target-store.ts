/**
 * `TargetStore` over SQLite/Drizzle.
 *
 * Same soft-delete semantics as the scenario store, plus protection for the built-in
 * receiver target: `remove` refuses to delete any row flagged `built_in`. That guard
 * lives in the WHERE clause of a single UPDATE, so the refusal is atomic and there is
 * no read-then-write race.
 *
 * SECURITY NOTE: a `DeliveryTarget` carries auth secrets (`auth.token`,
 * `auth.password`, `auth.clientSecret`, `auth.secret`). They are stored as-is here
 * because the delivery adapter must read them back in plaintext to authenticate to
 * the target; redaction is applied at the API response boundary (server), never in
 * storage. Protect the database file at the deployment layer.
 */

import { and, count, desc, eq, isNull } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { DeliveryTarget, Paginated } from '../types/index.js';
import type { TargetStore } from '../contracts/stores.js';
import type { AppDatabase } from './db.js';
import { targets } from './schema.js';
import { clampLimit, clampOffset, isoToMs, toPaginated } from './store-helpers.js';

/** Construction dependencies. `now` is injectable so tests are deterministic. */
export interface TargetStoreDeps {
  db: AppDatabase;
  logger: Logger;
  /** Wall-clock source for audit timestamps; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Build the target store.
 *
 * @param deps Drizzle handle, logger, and optional clock.
 * @returns A `TargetStore` implementation.
 */
export function createTargetStore(deps: TargetStoreDeps): TargetStore {
  const { db, logger } = deps;
  const now = deps.now ?? Date.now;

  return {
    create(target: DeliveryTarget): DeliveryTarget {
      const createdAt = isoToMs(target.createdAt) ?? now();
      const updatedAt = isoToMs(target.updatedAt) ?? createdAt;
      try {
        db.insert(targets)
          .values({
            id: target.id,
            name: target.name,
            kind: target.kind,
            builtIn: target.builtIn,
            data: target,
            createdAt,
            updatedAt,
            deletedAt: null,
          })
          .run();
      } catch (err) {
        logger.error({ err, targetId: target.id }, 'target insert failed');
        throw new Error(`could not create target ${target.id}`);
      }
      return target;
    },

    update(id: string, patch: Partial<DeliveryTarget>): DeliveryTarget | undefined {
      const updatedAtMs = now();
      return db.transaction((tx) => {
        const existing = tx
          .select()
          .from(targets)
          .where(and(eq(targets.id, id), isNull(targets.deletedAt)))
          .get();
        if (!existing) return undefined;

        // Re-assert identity, creation time, and the built-in flag: a target cannot
        // change its id, forge its creation time, or promote/demote itself to
        // built-in via an update payload.
        const merged: DeliveryTarget = {
          ...existing.data,
          ...patch,
          id: existing.data.id,
          builtIn: existing.data.builtIn,
          createdAt: existing.data.createdAt,
          updatedAt: new Date(updatedAtMs).toISOString(),
        };

        tx.update(targets)
          .set({
            data: merged,
            name: merged.name,
            kind: merged.kind,
            updatedAt: updatedAtMs,
          })
          .where(eq(targets.id, id))
          .run();
        return merged;
      });
    },

    get(id: string): DeliveryTarget | undefined {
      const row = db.select().from(targets).where(eq(targets.id, id)).get();
      return row?.data;
    },

    list(limit: number, offset: number): Paginated<DeliveryTarget> {
      const safeLimit = clampLimit(limit);
      const safeOffset = clampOffset(offset);
      const rows = db
        .select()
        .from(targets)
        .where(isNull(targets.deletedAt))
        .orderBy(desc(targets.seq))
        .limit(safeLimit)
        .offset(safeOffset)
        .all();
      const totalRow = db
        .select({ value: count() })
        .from(targets)
        .where(isNull(targets.deletedAt))
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
      // The `built_in = 0` guard makes deleting a protected target impossible and the
      // refusal atomic: a built-in row simply does not match, so `changes` is 0.
      const result = db
        .update(targets)
        .set({ deletedAt: ts, updatedAt: ts })
        .where(and(eq(targets.id, id), isNull(targets.deletedAt), eq(targets.builtIn, false)))
        .run();
      return result.changes > 0;
    },
  };
}
