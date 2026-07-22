import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './db.js';
import type { OpenedDatabase } from './db.js';
import { createScenarioStore } from './scenario-store.js';
import type { ScenarioStore } from '../contracts/stores.js';
import { makeScenario, silentLogger } from './__tests__/fixtures.js';

describe('createScenarioStore', () => {
  let opened: OpenedDatabase;
  let store: ScenarioStore;

  beforeEach(() => {
    opened = openDatabase(':memory:', silentLogger());
    store = createScenarioStore({ db: opened.db, logger: silentLogger() });
  });

  afterEach(() => {
    opened.sqlite.close();
  });

  it('round-trips a scenario through create and get', () => {
    const scenario = makeScenario({ id: 'scn-1', name: 'Alpha' });
    const created = store.create(scenario);
    expect(created).toEqual(scenario);

    const fetched = store.get('scn-1');
    expect(fetched).toEqual(scenario);
    expect(fetched?.eventMix.byCategory.AUTH).toBe(5);
  });

  it('returns undefined for an unknown id', () => {
    expect(store.get('missing')).toBeUndefined();
  });

  it('lists newest-first with correct pagination totals', () => {
    store.create(makeScenario({ id: 'scn-1' }));
    store.create(makeScenario({ id: 'scn-2' }));
    store.create(makeScenario({ id: 'scn-3' }));

    const firstPage = store.list(2, 0);
    expect(firstPage.total).toBe(3);
    expect(firstPage.limit).toBe(2);
    expect(firstPage.offset).toBe(0);
    expect(firstPage.items.map((s) => s.id)).toEqual(['scn-3', 'scn-2']);

    const secondPage = store.list(2, 2);
    expect(secondPage.total).toBe(3);
    expect(secondPage.items.map((s) => s.id)).toEqual(['scn-1']);
  });

  it('merges a patch on update and returns the merged scenario', () => {
    store.create(makeScenario({ id: 'scn-1', name: 'Alpha', baselineRps: 50 }));
    const updated = store.update('scn-1', { name: 'Beta', baselineRps: 99 });

    expect(updated?.name).toBe('Beta');
    expect(updated?.baselineRps).toBe(99);
    expect(updated?.id).toBe('scn-1');
    expect(store.get('scn-1')?.name).toBe('Beta');
  });

  it('cannot rewrite id or createdAt via a malicious patch', () => {
    const scenario = makeScenario({ id: 'scn-1', createdAt: '2020-01-01T00:00:00.000Z' });
    store.create(scenario);
    const updated = store.update('scn-1', {
      id: 'hijacked',
      createdAt: '1999-01-01T00:00:00.000Z',
    } as Partial<typeof scenario>);

    expect(updated?.id).toBe('scn-1');
    expect(updated?.createdAt).toBe('2020-01-01T00:00:00.000Z');
    expect(store.get('hijacked')).toBeUndefined();
  });

  it('returns undefined when updating an unknown id', () => {
    expect(store.update('missing', { name: 'X' })).toBeUndefined();
  });

  it('soft-deletes: remove hides from list but get still resolves', () => {
    store.create(makeScenario({ id: 'scn-1' }));
    store.create(makeScenario({ id: 'scn-2' }));

    expect(store.remove('scn-1')).toBe(true);

    const listed = store.list(50, 0);
    expect(listed.total).toBe(1);
    expect(listed.items.map((s) => s.id)).toEqual(['scn-2']);

    // Historical resolvability: a soft-deleted scenario remains fetchable by id.
    expect(store.get('scn-1')?.id).toBe('scn-1');
  });

  it('remove returns false for an unknown or already-deleted id', () => {
    store.create(makeScenario({ id: 'scn-1' }));
    expect(store.remove('scn-1')).toBe(true);
    expect(store.remove('scn-1')).toBe(false);
    expect(store.remove('never')).toBe(false);
  });
});
