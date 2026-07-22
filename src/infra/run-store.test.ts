import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './db.js';
import type { OpenedDatabase } from './db.js';
import { createRunStore } from './run-store.js';
import type { RunStore } from '../contracts/stores.js';
import { makeRunState, makeRunSummary, silentLogger } from './__tests__/fixtures.js';

/** Read the persisted history samples for a run, newest first. */
function readSamples(
  opened: OpenedDatabase,
  runId: string,
): Array<{ currentRps: number; generated: number; status: string }> {
  return opened.sqlite
    .prepare(
      'SELECT current_rps AS currentRps, generated, status FROM run_samples WHERE run_id = ? ORDER BY seq DESC',
    )
    .all(runId) as Array<{ currentRps: number; generated: number; status: string }>;
}

describe('createRunStore', () => {
  let opened: OpenedDatabase;
  let nowMs: number;
  let store: RunStore;

  beforeEach(() => {
    opened = openDatabase(':memory:', silentLogger());
    nowMs = 1000;
    store = createRunStore({
      db: opened.db,
      sqlite: opened.sqlite,
      logger: silentLogger(),
      now: () => nowMs,
      sampleMinIntervalMs: 500,
    });
  });

  afterEach(() => {
    opened.sqlite.close();
  });

  it('round-trips a run through create and get', () => {
    const run = makeRunState({ id: 'run-1' });
    store.create(run);
    expect(store.get('run-1')).toEqual(run);
  });

  it('create is idempotent on a replayed id', () => {
    const run = makeRunState({ id: 'run-1' });
    store.create(run);
    expect(() => store.create(run)).not.toThrow();
    expect(store.list(50, 0).total).toBe(1);
  });

  it('lists newest-first with correct totals', () => {
    store.create(makeRunState({ id: 'run-1' }));
    store.create(makeRunState({ id: 'run-2' }));
    const page = store.list(50, 0);
    expect(page.total).toBe(2);
    expect(page.items.map((r) => r.id)).toEqual(['run-2', 'run-1']);
  });

  it('merges update patches into the persisted run state', () => {
    store.create(makeRunState({ id: 'run-1', currentRps: 0 }));
    store.update('run-1', {
      status: 'running',
      currentRps: 42,
      counters: { generated: 10, delivered: 8, failed: 1, dropped: 1, byCategory: { AUTH: 10, JML: 0, ACCESS: 0, TXN: 0, COMPLIANCE: 0 } },
    });
    const fetched = store.get('run-1');
    expect(fetched?.currentRps).toBe(42);
    expect(fetched?.counters.generated).toBe(10);
    // Immutable fields survive the merge.
    expect(fetched?.id).toBe('run-1');
    expect(fetched?.seed).toBe('seed-abc');
  });

  it('ignores an update for an unknown run without throwing', () => {
    expect(() => store.update('ghost', { status: 'running' })).not.toThrow();
  });

  it('appends throttled run-history samples, always recording a terminal one', () => {
    store.create(makeRunState({ id: 'run-1' }));

    nowMs = 1000;
    store.update('run-1', { currentRps: 5, counters: { generated: 5, delivered: 5, failed: 0, dropped: 0, byCategory: { AUTH: 5, JML: 0, ACCESS: 0, TXN: 0, COMPLIANCE: 0 } } });

    nowMs = 1100; // within the 500 ms throttle: suppressed
    store.update('run-1', { currentRps: 6 });

    nowMs = 1600; // past the throttle: recorded
    store.update('run-1', { currentRps: 7, counters: { generated: 12, delivered: 11, failed: 1, dropped: 0, byCategory: { AUTH: 12, JML: 0, ACCESS: 0, TXN: 0, COMPLIANCE: 0 } } });

    nowMs = 1650; // within throttle, but terminal status is always recorded
    store.update('run-1', { status: 'completed', currentRps: 0 });

    const samples = readSamples(opened, 'run-1');
    expect(samples).toHaveLength(3);
    // Newest first: the terminal sample, then the 1600 sample, then the 1000 sample.
    expect(samples[0]?.status).toBe('completed');
    expect(samples[1]?.currentRps).toBe(7);
    expect(samples[1]?.generated).toBe(12);
    expect(samples[2]?.currentRps).toBe(5);
  });

  it('prunes run-history samples beyond the retention cap, keeping the newest', () => {
    const bounded = createRunStore({
      db: opened.db,
      sqlite: opened.sqlite,
      logger: silentLogger(),
      now: () => nowMs,
      sampleMinIntervalMs: 500,
      maxSamplesPerRun: 3,
      pruneEvery: 1,
    });
    bounded.create(makeRunState({ id: 'run-cap' }));

    // Six checkpoints, each past the throttle, so six sample writes occur.
    for (let i = 0; i < 6; i += 1) {
      nowMs = 1000 + i * 600;
      bounded.update('run-cap', { currentRps: i });
    }

    const samples = readSamples(opened, 'run-cap');
    expect(samples).toHaveLength(3);
    // Newest three retained: currentRps 5, 4, 3 (newest first).
    expect(samples.map((s) => s.currentRps)).toEqual([5, 4, 3]);
  });

  it('persists and upserts a run summary', () => {
    store.create(makeRunState({ id: 'run-1' }));
    store.saveSummary(makeRunSummary({ runId: 'run-1', errorRate: 0.03 }));
    expect(store.getSummary('run-1')?.errorRate).toBe(0.03);

    // Re-saving overwrites rather than conflicting.
    store.saveSummary(makeRunSummary({ runId: 'run-1', errorRate: 0.09 }));
    expect(store.getSummary('run-1')?.errorRate).toBe(0.09);
  });

  it('returns undefined for a missing summary', () => {
    expect(store.getSummary('run-1')).toBeUndefined();
  });
});
