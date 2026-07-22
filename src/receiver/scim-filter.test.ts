import { describe, expect, it } from 'vitest';
import { SCIM_SCHEMA, type ScimUser } from '../domain/scim.js';
import { compileUserFilter } from './scim-filter.js';
import { ScimError } from './scim-resources.js';

function user(overrides: Partial<ScimUser> = {}): ScimUser {
  return {
    schemas: [SCIM_SCHEMA.USER],
    id: 'usr_1',
    externalId: 'DB00100000',
    userName: 'grace.hopper',
    name: { formatted: 'Grace Hopper', givenName: 'Grace', familyName: 'Hopper' },
    displayName: 'Grace Hopper',
    userType: 'FTE',
    active: true,
    emails: [{ value: 'grace.hopper@db.com', type: 'work', primary: true }],
    groups: [],
    meta: { resourceType: 'User', created: '', lastModified: '', location: '/scim/v2/Users/usr_1' },
    ...overrides,
  };
}

describe('compileUserFilter', () => {
  it('matches everything for an empty filter', () => {
    const predicate = compileUserFilter(undefined);
    expect(predicate(user())).toBe(true);
  });

  it('matches userName eq case-insensitively', () => {
    const predicate = compileUserFilter('userName eq "grace.hopper"');
    expect(predicate(user())).toBe(true);
    expect(predicate(user({ userName: 'GRACE.HOPPER' }))).toBe(true);
    expect(predicate(user({ userName: 'someone.else' }))).toBe(false);
  });

  it('matches externalId and id equality', () => {
    expect(compileUserFilter('externalId eq "DB00100000"')(user())).toBe(true);
    expect(compileUserFilter('id eq "usr_1"')(user())).toBe(true);
    expect(compileUserFilter('id eq "nope"')(user())).toBe(false);
  });

  it('matches a boolean active filter', () => {
    expect(compileUserFilter('active eq true')(user({ active: true }))).toBe(true);
    expect(compileUserFilter('active eq true')(user({ active: false }))).toBe(false);
    expect(compileUserFilter('active eq false')(user({ active: false }))).toBe(true);
  });

  it('supports the presence operator', () => {
    expect(compileUserFilter('userName pr')(user())).toBe(true);
    expect(compileUserFilter('externalId pr')(user({ externalId: '' }))).toBe(false);
  });

  it('rejects an unsupported attribute or expression with invalidFilter', () => {
    expect(() => compileUserFilter('unknownAttr eq "x"')).toThrow(ScimError);
    expect(() => compileUserFilter('userName sw "x"')).toThrow(ScimError);
    try {
      compileUserFilter('userName co "x"');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ScimError).status).toBe(400);
      expect((error as ScimError).scimType).toBe('invalidFilter');
    }
  });
});
