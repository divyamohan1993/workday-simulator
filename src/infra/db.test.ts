import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './db.js';
import { createScenarioStore } from './scenario-store.js';
import { makeScenario, silentLogger } from './__tests__/fixtures.js';

describe('openDatabase', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'workday-db-'));
  });

  afterEach(() => {
    // Removes the main db plus its -wal / -shm sidecars.
    rmSync(dir, { recursive: true, force: true });
  });

  it('enables WAL journalling and creates every table on a fresh file', () => {
    const opened = openDatabase(join(dir, 'fresh.db'), silentLogger());
    try {
      expect(opened.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');

      const tableNames = (
        opened.sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name: string }>
      ).map((row) => row.name);

      expect(tableNames).toEqual(
        expect.arrayContaining(['scenarios', 'targets', 'runs', 'run_summaries', 'run_samples']),
      );
    } finally {
      opened.sqlite.close();
    }
  });

  it('is idempotent: reopening an existing database preserves data', () => {
    const path = join(dir, 'persist.db');

    const first = openDatabase(path, silentLogger());
    createScenarioStore({ db: first.db, logger: silentLogger() }).create(
      makeScenario({ id: 'persisted' }),
    );
    first.sqlite.close();

    // Second open re-runs the CREATE ... IF NOT EXISTS bootstrap; it must not wipe or
    // error, and the previously written row must still be readable.
    const second = openDatabase(path, silentLogger());
    try {
      const store = createScenarioStore({ db: second.db, logger: silentLogger() });
      expect(store.get('persisted')?.id).toBe('persisted');
    } finally {
      second.sqlite.close();
    }
  });
});
