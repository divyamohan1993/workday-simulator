import { describe, it, expect } from 'vitest';
import type { EventKind, EventMixWeights } from '../types/index.js';
import { EVENT_CATEGORY } from '../types/index.js';
import { createPrng } from './prng.js';
import { mergeBiases, pickKind, resolveMix } from './mix.js';

const evenMix: EventMixWeights = {
  byCategory: { AUTH: 1, JML: 1, ACCESS: 1, TXN: 1, COMPLIANCE: 1 },
};

describe('resolveMix', () => {
  it('includes every kind when all categories are weighted', () => {
    const resolved = resolveMix(evenMix);
    expect(resolved.kinds.length).toBe(46);
    expect(resolved.total).toBeGreaterThan(0);
    // cumulative is strictly increasing and ends at total.
    expect(resolved.cumulative[resolved.cumulative.length - 1]).toBeCloseTo(resolved.total, 6);
  });

  it('excludes kinds whose category is weighted zero', () => {
    const onlyAuth: EventMixWeights = {
      byCategory: { AUTH: 1, JML: 0, ACCESS: 0, TXN: 0, COMPLIANCE: 0 },
    };
    const resolved = resolveMix(onlyAuth);
    for (const kind of resolved.kinds) {
      expect(EVENT_CATEGORY[kind]).toBe('AUTH');
    }
  });

  it('applies per-kind overrides', () => {
    const withOverride: EventMixWeights = {
      byCategory: { AUTH: 1, JML: 0, ACCESS: 0, TXN: 0, COMPLIANCE: 0 },
      byKind: { 'login.success': 100 },
    };
    const resolved = resolveMix(withOverride);
    const prng = createPrng('override');
    const counts = new Map<EventKind, number>();
    for (let i = 0; i < 5000; i += 1) {
      const kind = pickKind(prng, resolved);
      if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    // login.success carries 100x weight so it must dominate the AUTH category.
    expect((counts.get('login.success') ?? 0) / 5000).toBeGreaterThan(0.8);
  });
});

describe('pickKind with chaos bias', () => {
  it('shifts the distribution toward biased kinds', () => {
    const bias = new Map<EventKind, number>([['login.failure', 50]]);
    const biasedMix = resolveMix(evenMix, bias);
    const prng = createPrng('bias');
    let failures = 0;
    const n = 10_000;
    for (let i = 0; i < n; i += 1) {
      if (pickKind(prng, biasedMix) === 'login.failure') failures += 1;
    }
    const unbiased = resolveMix(evenMix);
    let baselineFailures = 0;
    const prng2 = createPrng('bias');
    for (let i = 0; i < n; i += 1) {
      if (pickKind(prng2, unbiased) === 'login.failure') baselineFailures += 1;
    }
    expect(failures).toBeGreaterThan(baselineFailures * 5);
  });

  it('returns null for an empty mix', () => {
    const empty: EventMixWeights = {
      byCategory: { AUTH: 0, JML: 0, ACCESS: 0, TXN: 0, COMPLIANCE: 0 },
    };
    expect(pickKind(createPrng('x'), resolveMix(empty))).toBeNull();
  });
});

describe('mergeBiases', () => {
  it('multiplies overlapping factors across injectors', () => {
    const merged = mergeBiases([
      new Map([['login.failure', 2]]),
      new Map([
        ['login.failure', 3],
        ['account.lockout', 4],
      ]),
    ]);
    expect(merged.get('login.failure')).toBe(6);
    expect(merged.get('account.lockout')).toBe(4);
  });
});
