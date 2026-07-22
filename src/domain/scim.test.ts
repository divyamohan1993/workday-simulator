import { describe, expect, it } from 'vitest';
import type { Employee, Entitlement } from '../types/index.js';
import { SCIM_SCHEMA, scimActiveFor, toScimGroup, toScimUser } from './scim.js';

function ent(id: string, name: string, type: Entitlement['type']): Entitlement {
  return {
    id,
    system: 'ActiveDirectory',
    name,
    type,
    risk: 'low',
    sensitive: false,
    grantedAt: new Date(0).toISOString(),
    sodTags: [],
  };
}

function employee(overrides: Partial<Employee> = {}): Employee {
  return {
    id: 'emp_1',
    employeeId: 'DB00100000',
    firstName: 'Grace',
    lastName: 'Hopper',
    displayName: 'Grace Hopper',
    email: 'grace.hopper@db.com',
    username: 'ghopper',
    managerId: 'emp_boss',
    division: 'Technology, Data & Innovation',
    jobFamily: 'Software Engineering',
    grade: 'VP',
    type: 'FTE',
    status: 'active',
    location: 'NYC',
    legalEntity: 'Deutsche Bank Trust Company Americas',
    costCenter: 'CC-TDI-1234',
    entitlements: [
      ent('g1', 'All Staff', 'group'),
      ent('r1', 'Cloud Developer', 'role'),
      ent('a1', 'Corporate Mailbox', 'account'),
    ],
    startDate: '2020-01-01',
    attributes: { title: 'VP, Software Engineering' },
    isNonHuman: false,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('scimActiveFor', () => {
  it('maps only enabled states to active', () => {
    expect(scimActiveFor('active')).toBe(true);
    expect(scimActiveFor('onboarding')).toBe(true);
    expect(scimActiveFor('on_leave')).toBe(false);
    expect(scimActiveFor('suspended')).toBe(false);
    expect(scimActiveFor('terminated')).toBe(false);
    expect(scimActiveFor('disabled')).toBe(false);
    expect(scimActiveFor('dormant')).toBe(false);
  });
});

describe('toScimUser', () => {
  it('maps core and enterprise attributes', () => {
    const user = toScimUser(employee());
    expect(user.schemas).toContain(SCIM_SCHEMA.USER);
    expect(user.schemas).toContain(SCIM_SCHEMA.ENTERPRISE_USER);
    expect(user.id).toBe('emp_1');
    expect(user.externalId).toBe('DB00100000');
    expect(user.userName).toBe('ghopper');
    expect(user.name).toMatchObject({ givenName: 'Grace', familyName: 'Hopper' });
    expect(user.emails[0]).toMatchObject({ value: 'grace.hopper@db.com', primary: true });
    expect(user.active).toBe(true);
    expect(user.title).toBe('VP, Software Engineering');
    const enterprise = user[SCIM_SCHEMA.ENTERPRISE_USER];
    expect(enterprise?.employeeNumber).toBe('DB00100000');
    expect(enterprise?.costCenter).toBe('CC-TDI-1234');
    expect(enterprise?.manager?.value).toBe('emp_boss');
    expect(user.meta.resourceType).toBe('User');
  });

  it('maps only group-like entitlements to SCIM groups', () => {
    const user = toScimUser(employee());
    const values = user.groups.map((g) => g.value);
    expect(values).toContain('g1'); // group
    expect(values).toContain('r1'); // role
    expect(values).not.toContain('a1'); // account is not a group membership
  });

  it('reflects a disabled account and omits an absent manager', () => {
    const user = toScimUser(employee({ status: 'terminated', managerId: null }));
    expect(user.active).toBe(false);
    expect(user[SCIM_SCHEMA.ENTERPRISE_USER]?.manager).toBeUndefined();
  });
});

describe('toScimGroup', () => {
  it('builds a group resource with members and metadata', () => {
    const group = toScimGroup(
      'AD-ALL-STAFF',
      'All Staff',
      [{ value: 'emp_1', display: 'Grace Hopper' }],
      { created: '2020-01-01T00:00:00.000Z', lastModified: '2026-01-01T00:00:00.000Z' },
    );
    expect(group.schemas).toContain(SCIM_SCHEMA.GROUP);
    expect(group.displayName).toBe('All Staff');
    expect(group.members).toHaveLength(1);
    expect(group.meta.resourceType).toBe('Group');
    expect(group.meta.location).toBe('/scim/v2/Groups/AD-ALL-STAFF');
  });
});
