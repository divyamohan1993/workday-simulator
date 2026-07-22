import type {
  DeliveryTarget,
  Paginated,
  RunState,
  RunSummary,
  ScenarioConfig,
} from '../types/index.js';

/**
 * Persistence for runs and their end-of-run summaries. Backed by the simulator's
 * own better-sqlite3 database via Drizzle. All writes are parameterized; ids are
 * caller-supplied (generated with nanoid) so inserts are idempotent on replay.
 */
export interface RunStore {
  /** Insert a new run row. */
  create(run: RunState): void;
  /** Patch mutable fields of an existing run (status, counters, timings). */
  update(id: string, patch: Partial<RunState>): void;
  get(id: string): RunState | undefined;
  /** Newest-first page of runs. */
  list(limit: number, offset: number): Paginated<RunState>;
  /** Persist the immutable summary produced when a run ends. */
  saveSummary(summary: RunSummary): void;
  getSummary(runId: string): RunSummary | undefined;
}

/**
 * CRUD for reusable scenario profiles. `remove` is a soft delete (sets a deletion
 * timestamp) so historical runs keep a resolvable scenario reference.
 */
export interface ScenarioStore {
  create(scenario: ScenarioConfig): ScenarioConfig;
  update(id: string, patch: Partial<ScenarioConfig>): ScenarioConfig | undefined;
  get(id: string): ScenarioConfig | undefined;
  list(limit: number, offset: number): Paginated<ScenarioConfig>;
  /** Soft delete. Returns false if the id was unknown. */
  remove(id: string): boolean;
}

/**
 * CRUD for delivery targets. The built-in receiver target is created at startup and
 * is protected from deletion (`remove` returns false for it).
 */
export interface TargetStore {
  create(target: DeliveryTarget): DeliveryTarget;
  update(id: string, patch: Partial<DeliveryTarget>): DeliveryTarget | undefined;
  get(id: string): DeliveryTarget | undefined;
  list(limit: number, offset: number): Paginated<DeliveryTarget>;
  /** Soft delete. Returns false if unknown or if the target is protected. */
  remove(id: string): boolean;
}
