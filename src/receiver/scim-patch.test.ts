import { describe, expect, it } from 'vitest';
import { SCIM_SCHEMA, type ScimGroup, type ScimUser } from '../domain/scim.js';
import { applyGroupPatch, applyUserPatch } from './scim-patch.js';
import { ScimError } from './scim-resources.js';

function user(): ScimUser {
  return {
    schemas: [SCIM_SCHEMA.USER],
    id: 'usr_1',
    externalId: 'DB1',
    userName: 'a.b',
    name: { formatted: 'A B', givenName: 'A', familyName: 'B' },
    displayName: 'A B',
    userType: 'FTE',
    active: true,
    emails: [{ value: 'a.b@db.com', type: 'work', primary: true }],
    groups: [],
    meta: { resourceType: 'User', created: '', lastModified: '', location: '/scim/v2/Users/usr_1' },
  };
}

function group(): ScimGroup {
  return {
    schemas: [SCIM_SCHEMA.GROUP],
    id: 'grp_1',
    displayName: 'Murex Trader',
    members: [],
    meta: { resourceType: 'Group', created: '', lastModified: '', location: '/scim/v2/Groups/grp_1' },
  };
}

const patch = (ops: unknown[]): unknown => ({ schemas: [SCIM_SCHEMA.PATCH_OP], Operations: ops });

describe('applyUserPatch', () => {
  it('flips active via replace and reports the change', () => {
    const u = user();
    const result = applyUserPatch(u, patch([{ op: 'replace', path: 'active', value: false }]));
    expect(u.active).toBe(false);
    expect(result.activeChanged).toBe(true);
    expect(result.active).toBe(false);
  });

  it('does not report a change when active is unchanged', () => {
    const u = user();
    const result = applyUserPatch(u, patch([{ op: 'replace', path: 'active', value: true }]));
    expect(result.activeChanged).toBe(false);
  });

  it('replaces displayName, name.formatted and the work email', () => {
    const u = user();
    applyUserPatch(
      u,
      patch([
        { op: 'replace', path: 'displayName', value: 'New Name' },
        { op: 'replace', path: 'name.formatted', value: 'New Name' },
        { op: 'replace', path: 'emails[type eq "work"].value', value: 'new@db.com' },
      ]),
    );
    expect(u.displayName).toBe('New Name');
    expect(u.name.formatted).toBe('New Name');
    expect(u.emails[0]?.value).toBe('new@db.com');
  });

  it('applies a no-path value object', () => {
    const u = user();
    const result = applyUserPatch(u, patch([{ op: 'replace', value: { active: false, displayName: 'X' } }]));
    expect(u.active).toBe(false);
    expect(u.displayName).toBe('X');
    expect(result.activeChanged).toBe(true);
  });

  it('rejects a malformed PATCH', () => {
    expect(() => applyUserPatch(user(), { schemas: [] })).toThrow(ScimError);
    expect(() => applyUserPatch(user(), patch([{ op: 'bogus', path: 'active', value: true }]))).toThrow(ScimError);
  });
});

describe('applyGroupPatch', () => {
  it('adds members and reports the added ids', () => {
    const g = group();
    const result = applyGroupPatch(
      g,
      patch([{ op: 'add', path: 'members', value: [{ value: 'usr_1', display: 'A B' }] }]),
    );
    expect(g.members.map((m) => m.value)).toEqual(['usr_1']);
    expect(result.addedUserIds).toEqual(['usr_1']);
  });

  it('does not add a duplicate member', () => {
    const g = group();
    g.members.push({ value: 'usr_1', display: 'A B', type: 'User' });
    const result = applyGroupPatch(g, patch([{ op: 'add', path: 'members', value: [{ value: 'usr_1' }] }]));
    expect(g.members).toHaveLength(1);
    expect(result.addedUserIds).toEqual([]);
  });

  it('removes a targeted member by value-eq path', () => {
    const g = group();
    g.members.push({ value: 'usr_1', display: 'A B', type: 'User' });
    const result = applyGroupPatch(g, patch([{ op: 'remove', path: 'members[value eq "usr_1"]' }]));
    expect(g.members).toHaveLength(0);
    expect(result.removedUserIds).toEqual(['usr_1']);
  });
});
