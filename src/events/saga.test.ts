import { describe, expect, it } from 'vitest';
import type { WorkdayEvent } from '../types/index.js';
import { createEventGenerator } from './index.js';
import { parseEvent } from './schema.js';
import { makeCtx, seededPool, silentLogger } from './__tests__/support.js';

function newGenerator(seed = 'saga-seed') {
  return createEventGenerator({ seed, logger: silentLogger() });
}

/** Generate `kind` until its saga satisfies a predicate, returning both. */
function findSaga(
  kind: WorkdayEvent['kind'],
  predicate: (follow: WorkdayEvent[]) => boolean,
  attempts = 200,
): { primary: WorkdayEvent; follow: WorkdayEvent[] } {
  const generator = newGenerator();
  const ctx = makeCtx(seededPool());
  for (let i = 0; i < attempts; i += 1) {
    const primary = generator.generate(kind, ctx);
    const follow = generator.saga(primary, ctx);
    if (predicate(follow)) {
      return { primary, follow };
    }
  }
  throw new Error(`no ${kind} saga matched the predicate within ${attempts} attempts`);
}

describe('saga correlation integrity', () => {
  it('login.success chains mfa and session, sharing correlation and chaining causation', () => {
    const { primary, follow } = findSaga('login.success', (f) => f.length >= 2 && f[0]?.kind === 'mfa.challenge');
    expect(follow.every((e) => e.correlationId === primary.correlationId)).toBe(true);
    // Sequential chain: each event's causation is the previous event's id.
    let prevId = primary.id;
    for (const event of follow) {
      expect(event.causationId).toBe(prevId);
      prevId = event.id;
    }
    // Sequence numbers strictly increase across the whole saga.
    let prevSeq = primary.seq;
    for (const event of follow) {
      expect(event.seq).toBeGreaterThan(prevSeq);
      prevSeq = event.seq;
    }
  });

  it('access.request runs a four-eyes decision then provisions on approval', () => {
    const { primary, follow } = findSaga('access.request', (f) => f.length === 2 && f[1]?.kind === 'access.provision');
    expect(follow[0]?.kind).toBe('access.approve');
    expect(follow[1]?.kind).toBe('access.provision');
    expect(follow.every((e) => e.correlationId === primary.correlationId)).toBe(true);
    // approve is caused by the request; provision by the approve (sequential flow).
    expect(follow[0]?.causationId).toBe(primary.id);
    expect(follow[1]?.causationId).toBe(follow[0]?.id);
    // The provisioned entitlement matches the requested one.
    if (primary.kind === 'access.request' && follow[1]?.kind === 'access.provision') {
      expect(follow[1].payload.entitlement.id).toBe(primary.payload.entitlement.id);
    }
  });

  it('a denied request emits only a deny and no provision', () => {
    const { primary, follow } = findSaga('access.request', (f) => f.length === 1 && f[0]?.kind === 'access.deny');
    expect(follow).toHaveLength(1);
    expect(follow[0]?.correlationId).toBe(primary.correlationId);
    expect(follow[0]?.causationId).toBe(primary.id);
  });

  it('joiner.hire fans out birthright provisions as siblings caused by the hire', () => {
    const { primary, follow } = findSaga('joiner.hire', (f) => f.length > 0);
    expect(follow.every((e) => e.kind === 'access.provision')).toBe(true);
    expect(follow.every((e) => e.correlationId === primary.correlationId)).toBe(true);
    // Provisions are siblings of the hire (all directly caused by it), not a chain.
    expect(follow.every((e) => e.causationId === primary.id)).toBe(true);
    // Fan-out is bounded.
    expect(follow.length).toBeLessThanOrEqual(8);
    for (const event of follow) {
      expect(() => parseEvent(event)).not.toThrow();
    }
  });

  it('a login-failure streak escalates to an account lockout', () => {
    // A high attempt count guarantees the lockout branch fires.
    const { primary, follow } = findSaga('login.failure', (f) => f.length === 1);
    expect(primary.kind).toBe('login.failure');
    expect(follow[0]?.kind).toBe('account.lockout');
    expect(follow[0]?.correlationId).toBe(primary.correlationId);
    expect(follow[0]?.causationId).toBe(primary.id);
  });

  it('standalone events yield no follow-ons', () => {
    const generator = newGenerator();
    const ctx = makeCtx(seededPool());
    const event = generator.generate('session.start', ctx);
    expect(generator.saga(event, ctx)).toEqual([]);
  });
});
