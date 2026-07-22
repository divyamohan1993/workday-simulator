import { describe, expect, it } from 'vitest';
import type { EventKind } from '../types/index.js';
import { ALL_EVENT_KINDS } from '../types/index.js';
import { createPrng, pickKind, resolveMix } from '../engine/index.js';
import { DEFAULT_EVENT_MIX, defaultEventMix } from './event-mix.js';

describe('DEFAULT_EVENT_MIX', () => {
  it('resolves to every kind under the engine sampler', () => {
    const resolved = resolveMix(DEFAULT_EVENT_MIX);
    expect(resolved.kinds.length).toBe(ALL_EVENT_KINDS.length);
    expect(resolved.total).toBeGreaterThan(0);
  });

  it('weights successful logins far above failed ones', () => {
    const success = DEFAULT_EVENT_MIX.byKind?.['login.success'] ?? 0;
    const failure = DEFAULT_EVENT_MIX.byKind?.['login.failure'] ?? 0;
    expect(success).toBeGreaterThan(failure * 10);
  });

  it('samples successful logins much more often than failures', () => {
    const resolved = resolveMix(DEFAULT_EVENT_MIX);
    const prng = createPrng('mix-sample');
    const counts = new Map<EventKind, number>();
    for (let i = 0; i < 20_000; i += 1) {
      const kind = pickKind(prng, resolved);
      if (kind) {
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
      }
    }
    const success = counts.get('login.success') ?? 0;
    const failure = counts.get('login.failure') ?? 0;
    expect(success).toBeGreaterThan(failure * 5);
    // Rare privileged events stay rare relative to bulk auth traffic.
    expect(counts.get('breakglass') ?? 0).toBeLessThan(success);
  });

  it('defaultEventMix returns an independent mutable copy', () => {
    const copy = defaultEventMix();
    copy.byCategory.AUTH = 999;
    if (copy.byKind) {
      copy.byKind['login.success'] = 1;
    }
    expect(DEFAULT_EVENT_MIX.byCategory.AUTH).not.toBe(999);
    expect(DEFAULT_EVENT_MIX.byKind?.['login.success']).not.toBe(1);
  });
});
