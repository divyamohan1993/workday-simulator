import { describe, expect, it } from 'vitest';
import { SCIM_SCHEMA } from '../domain/scim.js';
import { ScimStore } from './scim-store.js';
import { ScimError } from './scim-resources.js';

const NOW = 1_700_000_000_000;

function userBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemas: [SCIM_SCHEMA.USER],
    id: 'usr_1',
    externalId: 'DB00100000',
    userName: 'grace.hopper',
    displayName: 'Grace Hopper',
    name: { formatted: 'Grace Hopper', givenName: 'Grace', familyName: 'Hopper' },
    userType: 'FTE',
    active: true,
    emails: [{ value: 'grace.hopper@db.com', type: 'work', primary: true }],
    ...overrides,
  };
}

const patch = (ops: unknown[]): unknown => ({ schemas: [SCIM_SCHEMA.PATCH_OP], Operations: ops });

describe('ScimStore users', () => {
  it('round-trips a create then get, honoring the client id and stamping server meta', () => {
    const store = new ScimStore();
    const { resource, created } = store.createUser(userBody(), NOW, 0);
    expect(created).toBe(true);
    expect(resource.id).toBe('usr_1');
    expect(resource.meta.location).toBe('/scim/v2/Users/usr_1');
    expect(resource.meta.version).toBe('W/"1"');

    const fetched = store.getUser('usr_1');
    expect(fetched.userName).toBe('grace.hopper');
    expect(fetched.emails[0]?.value).toBe('grace.hopper@db.com');
  });

  it('treats a repeat create of the same id as an idempotent no-op', () => {
    const store = new ScimStore();
    store.createUser(userBody(), NOW, 0);
    const second = store.createUser(userBody({ displayName: 'Changed' }), NOW, 0);
    expect(second.created).toBe(false);
    expect(store.getUser('usr_1').displayName).toBe('Grace Hopper'); // unchanged
  });

  it('rejects a create without userName', () => {
    const store = new ScimStore();
    expect(() => store.createUser({ id: 'x' }, NOW, 0)).toThrow(ScimError);
  });

  it('flips active on a deactivate PATCH', () => {
    const store = new ScimStore();
    store.createUser(userBody(), NOW, 0);
    const { activeChanged, active } = store.patchUser('usr_1', patch([{ op: 'replace', path: 'active', value: false }]), NOW, 0);
    expect(activeChanged).toBe(true);
    expect(active).toBe(false);
    expect(store.getUser('usr_1').active).toBe(false);
    expect(store.userEtag('usr_1')).toBe('W/"2"'); // version bumped
  });

  it('soft-deletes so get 404s but the id stays reserved', () => {
    const store = new ScimStore();
    store.createUser(userBody(), NOW, 0);
    store.deleteUser('usr_1', NOW);
    expect(() => store.getUser('usr_1')).toThrow(ScimError);
    expect(store.hasLiveUser('usr_1')).toBe(false);
    // Deleting again is idempotent, not a 404.
    expect(() => store.deleteUser('usr_1', NOW)).not.toThrow();
  });

  it('replaces mutable attributes via PUT', () => {
    const store = new ScimStore();
    store.createUser(userBody(), NOW, 0);
    const replaced = store.replaceUser('usr_1', userBody({ displayName: 'G. Hopper', active: false }), NOW, 0);
    expect(replaced.displayName).toBe('G. Hopper');
    expect(replaced.active).toBe(false);
  });

  it('lists with a predicate and paginates', () => {
    const store = new ScimStore();
    for (let i = 0; i < 5; i += 1) {
      store.createUser(userBody({ id: `usr_${i}`, userName: `user${i}`, active: i % 2 === 0 }), NOW, 0);
    }
    const activeOnly = store.listUsers((u) => u.active, 1, 100);
    expect(activeOnly.total).toBe(3);
    const page = store.listUsers(() => true, 2, 2);
    expect(page.total).toBe(5);
    expect(page.resources).toHaveLength(2);
    expect(page.resources[0]?.id).toBe('usr_1');
  });
});

describe('ScimStore groups', () => {
  it('creates a group keyed by externalId and adds members via PATCH', () => {
    const store = new ScimStore();
    const { resource } = store.createGroup({ externalId: 'ent-murex-42', displayName: 'Murex Trader' }, NOW);
    expect(resource.id).toBe('ent-murex-42');

    const result = store.patchGroup(
      'ent-murex-42',
      patch([{ op: 'add', path: 'members', value: [{ value: 'usr_1', display: 'Grace' }] }]),
      NOW,
    );
    expect(result.addedUserIds).toEqual(['usr_1']);
    expect(store.getGroup('ent-murex-42').members).toHaveLength(1);
  });

  it('auto-creates a group when a membership PATCH arrives before the group create', () => {
    const store = new ScimStore();
    const result = store.patchGroup(
      'ent-unknown',
      patch([{ op: 'add', path: 'members', value: [{ value: 'usr_9' }] }]),
      NOW,
    );
    expect(result.addedUserIds).toEqual(['usr_9']);
    expect(store.getGroup('ent-unknown').members[0]?.value).toBe('usr_9');
  });
});
