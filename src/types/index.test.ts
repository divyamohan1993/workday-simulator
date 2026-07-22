import { describe, expect, it } from 'vitest';
import {
  ALL_EVENT_CATEGORIES,
  ALL_EVENT_KINDS,
  EVENT_CATEGORY,
  EVENT_KINDS_BY_CATEGORY,
  eventCategoryOf,
  GRADE_SENIORITY,
} from './index.js';

/**
 * Guards the runtime taxonomy maps that four modules depend on. Also serves as the
 * canonical example of the colocated-test pattern: import the module under test via
 * its ".js" specifier and { describe, it, expect } from "vitest".
 */
describe('event taxonomy', () => {
  it('maps every kind to exactly one category', () => {
    expect(Object.keys(EVENT_CATEGORY)).toHaveLength(ALL_EVENT_KINDS.length);
    for (const kind of ALL_EVENT_KINDS) {
      expect(EVENT_CATEGORY[kind]).toBeDefined();
    }
  });

  it('keeps eventCategoryOf consistent with the grouping', () => {
    for (const category of ALL_EVENT_CATEGORIES) {
      for (const kind of EVENT_KINDS_BY_CATEGORY[category]) {
        expect(eventCategoryOf(kind)).toBe(category);
      }
    }
  });

  it('enumerates the full 46-kind surface', () => {
    expect(ALL_EVENT_KINDS).toHaveLength(46);
    expect(new Set(ALL_EVENT_KINDS).size).toBe(46);
  });
});

describe('grade seniority', () => {
  it('orders MD above every other grade', () => {
    const ranks = Object.values(GRADE_SENIORITY);
    expect(GRADE_SENIORITY.MD).toBe(Math.max(...ranks));
    expect(GRADE_SENIORITY.Intern).toBe(Math.min(...ranks));
  });
});
