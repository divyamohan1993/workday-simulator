import { describe, expect, it } from 'vitest';
import { SCIM_SCHEMA } from '../domain/scim.js';
import { detectDormant, detectOrphans } from './detectors.js';
import { ScimStore } from './scim-store.js';

const NOW = 1_700_000_000_000;
const patchActive = (active: boolean): unknown => ({
  schemas: [SCIM_SCHEMA.PATCH_OP],
  Operations: [{ op: 'replace', path: 'active', value: active }],
});

describe('detectOrphans', () => {
  it('flags a group membership that references a non-existent account', () => {
    const store = new ScimStore();
    store.createUser({ id: 'usr_live', userName: 'live', active: true }, NOW, 1000);
    store.createGroup(
      { externalId: 'g1', displayName: 'G', members: [{ value: 'usr_live' }, { value: 'ghost' }] },
      NOW,
    );
    const orphans = detectOrphans(store, NOW);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.accountId).toBe('ghost');
  });

  it('flags memberships left dangling after the owner is deprovisioned', () => {
    const store = new ScimStore();
    store.createUser({ id: 'usr_1', userName: 'a', active: true }, NOW, 1000);
    store.createGroup({ externalId: 'g1', displayName: 'G', members: [{ value: 'usr_1' }] }, NOW);
    expect(detectOrphans(store, NOW)).toHaveLength(0);
    store.deleteUser('usr_1', NOW);
    expect(detectOrphans(store, NOW)).toHaveLength(1);
  });
});

describe('detectDormant', () => {
  it('flags an enabled account idle beyond the window, in simulated time', () => {
    const store = new ScimStore();
    store.createUser({ id: 'u1', userName: 'a', active: true }, NOW, 1000);
    const threshold = 100_000;
    expect(detectDormant(store, 1000, threshold, NOW)).toHaveLength(0);
    expect(detectDormant(store, 1000 + threshold + 1, threshold, NOW)).toHaveLength(1);
  });

  it('excludes disabled accounts from dormancy', () => {
    const store = new ScimStore();
    store.createUser({ id: 'u1', userName: 'a', active: true }, NOW, 1000);
    store.patchUser('u1', patchActive(false), NOW, 1000);
    expect(detectDormant(store, 1_000_000_000, 100_000, NOW)).toHaveLength(0);
  });
});
