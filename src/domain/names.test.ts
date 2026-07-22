import { describe, expect, it } from 'vitest';
import { Faker, base, en } from '@faker-js/faker';
import { generateName, NameAllocator, slugForEmail } from './names.js';

function rng(seed = 1) {
  const f = new Faker({ locale: [en, base] });
  f.seed(seed);
  return f;
}

describe('slugForEmail', () => {
  it('strips diacritics and non-alphanumerics', () => {
    expect(slugForEmail('José Müller-Zoë')).toBe('josemullerzoe');
    expect(slugForEmail("O'Brien")).toBe('obrien');
  });

  it('returns empty for scripts with no ASCII transliteration', () => {
    expect(slugForEmail('李明')).toBe('');
  });
});

describe('generateName', () => {
  it('produces a mononym with an empty surname', () => {
    const name = generateName(rng(), 'mononym');
    expect(name.lastName).toBe('');
    expect(name.displayName).toBe(name.firstName);
  });

  it('produces a genuinely long surname', () => {
    const name = generateName(rng(), 'long');
    expect(name.lastName.length).toBeGreaterThanOrEqual(60);
  });

  it('produces non-ASCII CJK names', () => {
    const name = generateName(rng(), 'cjk');
    expect(/[一-鿿぀-ヿ가-힯]/.test(name.displayName)).toBe(true);
  });

  it('is deterministic under a fixed seed', () => {
    expect(generateName(rng(42), 'unicode')).toEqual(generateName(rng(42), 'unicode'));
  });
});

describe('NameAllocator', () => {
  it('derives first.last@db.com when there is no collision', () => {
    const allocator = new NameAllocator(rng());
    const result = allocator.allocate({
      ownerId: 'u1',
      firstName: 'Grace',
      lastName: 'Hopper',
      location: 'NYC',
    });
    expect(result.email).toBe('grace.hopper@db.com');
    expect(result.collisions).toHaveLength(0);
  });

  it('resolves a duplicate name to a unique, disambiguated address', () => {
    const allocator = new NameAllocator(rng(5));
    const first = allocator.allocate({ ownerId: 'u1', firstName: 'John', lastName: 'Smith', location: 'LDN' });
    const second = allocator.allocate({ ownerId: 'u2', firstName: 'John', lastName: 'Smith', location: 'LDN' });
    expect(first.email).toBe('john.smith@db.com');
    expect(second.email).not.toBe(first.email);
    expect(second.collisions.some((c) => c.attribute === 'email')).toBe(true);
    const emailCollision = second.collisions.find((c) => c.attribute === 'email');
    expect(emailCollision?.collidingWith).toContain('u1');
    expect(['numeric_suffix', 'middle_initial', 'location_suffix']).toContain(emailCollision?.strategy);
  });

  it('keeps every allocated email unique across many collisions', () => {
    const allocator = new NameAllocator(rng(9));
    const emails = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const r = allocator.allocate({ ownerId: `u${i}`, firstName: 'Alex', lastName: 'Doe', location: 'FFT' });
      emails.add(r.email);
    }
    expect(emails.size).toBe(200);
  });

  it('handles a CJK name by falling back to a valid local part', () => {
    const allocator = new NameAllocator(rng());
    const result = allocator.allocate({ ownerId: 'u1', firstName: '明', lastName: '李', location: 'HKG' });
    expect(result.email.endsWith('@db.com')).toBe(true);
    expect(result.email.length).toBeGreaterThan('@db.com'.length + 1);
  });
});
