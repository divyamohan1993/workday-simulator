import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './db.js';
import type { OpenedDatabase } from './db.js';
import { createTargetStore } from './target-store.js';
import type { TargetStore } from '../contracts/stores.js';
import { makeTarget, silentLogger } from './__tests__/fixtures.js';

describe('createTargetStore', () => {
  let opened: OpenedDatabase;
  let store: TargetStore;

  beforeEach(() => {
    opened = openDatabase(':memory:', silentLogger());
    store = createTargetStore({ db: opened.db, logger: silentLogger() });
  });

  afterEach(() => {
    opened.sqlite.close();
  });

  it('round-trips a target, storing auth secrets verbatim for the delivery layer', () => {
    const target = makeTarget({ id: 'tgt-1' });
    store.create(target);
    const fetched = store.get('tgt-1');
    expect(fetched).toEqual(target);
    // The store does not redact; redaction is applied at the API response boundary.
    expect(fetched?.auth).toEqual({ kind: 'bearer', token: 'super-secret-token' }); // pragma: allowlist secret (deterministic test fixture, not a real credential)
  });

  it('lists newest-first with correct totals', () => {
    store.create(makeTarget({ id: 'tgt-1' }));
    store.create(makeTarget({ id: 'tgt-2' }));
    const page = store.list(50, 0);
    expect(page.total).toBe(2);
    expect(page.items.map((t) => t.id)).toEqual(['tgt-2', 'tgt-1']);
  });

  it('merges an update but never flips the built-in flag or the id', () => {
    store.create(makeTarget({ id: 'tgt-1', name: 'Old', builtIn: false }));
    const updated = store.update('tgt-1', {
      name: 'New',
      builtIn: true,
      id: 'other',
    } as Partial<ReturnType<typeof makeTarget>>);

    expect(updated?.name).toBe('New');
    expect(updated?.builtIn).toBe(false);
    expect(updated?.id).toBe('tgt-1');
  });

  it('soft-deletes a normal target but protects the built-in target', () => {
    store.create(makeTarget({ id: 'tgt-user', builtIn: false }));
    store.create(makeTarget({ id: 'tgt-builtin', builtIn: true }));

    expect(store.remove('tgt-builtin')).toBe(false);
    expect(store.get('tgt-builtin')?.id).toBe('tgt-builtin');

    expect(store.remove('tgt-user')).toBe(true);
    expect(store.list(50, 0).items.map((t) => t.id)).toEqual(['tgt-builtin']);
    // Still resolvable by id after soft delete.
    expect(store.get('tgt-user')?.id).toBe('tgt-user');
  });

  it('remove returns false for unknown ids', () => {
    expect(store.remove('nope')).toBe(false);
  });
});
