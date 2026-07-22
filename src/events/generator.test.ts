import { describe, expect, it } from 'vitest';
import type { EventKind, WorkdayEvent } from '../types/index.js';
import { ALL_EVENT_KINDS, EVENT_CATEGORY } from '../types/index.js';
import { createEventGenerator } from './index.js';
import { parseEvent } from './schema.js';
import { fixedClock, makeCtx, seededPool, silentLogger } from './__tests__/support.js';

function newGenerator(seed = 'gen-seed') {
  return createEventGenerator({ seed, logger: silentLogger() });
}

describe('generate: payload validity', () => {
  it('produces a schema-valid, correctly-categorized event for every kind', () => {
    const generator = newGenerator();
    const pool = seededPool();
    const ctx = makeCtx(pool);

    for (const kind of ALL_EVENT_KINDS) {
      // Generate several times so branch-heavy payloads exercise multiple paths.
      for (let i = 0; i < 5; i += 1) {
        let event: WorkdayEvent;
        try {
          event = generator.generate(kind, ctx);
        } catch (err) {
          // A missing eligible actor is a legal skip, not a failure.
          expect((err as Error).name).toBe('NoEligibleActorError');
          continue;
        }
        expect(event.kind).toBe(kind);
        expect(event.category).toBe(EVENT_CATEGORY[kind]);
        expect(() => parseEvent(event)).not.toThrow();

        for (const follow of generator.saga(event, ctx)) {
          expect(() => parseEvent(follow)).not.toThrow();
        }
      }
    }
  });

  it('sets a monotonic sequence number and non-empty ids', () => {
    const generator = newGenerator();
    const ctx = makeCtx(seededPool());
    const first = generator.generate('login.success', ctx);
    const second = generator.generate('payment.sepa', ctx);
    expect(first.seq).toBeGreaterThan(0);
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(first.id).not.toBe(second.id);
    expect(first.correlationId).not.toBe(second.correlationId);
  });
});

describe('generate: actor and subject semantics', () => {
  it('marks a human login actor as an employee with no distinct subject', () => {
    const event = newGenerator().generate('login.success', makeCtx(seededPool()));
    expect(event.actor.kind).toBe('employee');
    expect(event.subject).toBeUndefined();
  });

  it('uses a service actor for NHI activity', () => {
    const event = newGenerator().generate('nhi.activity', makeCtx(seededPool()));
    expect(event.actor.kind).toBe('service');
  });

  it('raises detector events from a system actor against a subject', () => {
    const ctx = makeCtx(seededPool());
    const sod = newGenerator().generate('sod.violation', ctx);
    expect(sod.actor.kind).toBe('system');
    expect(sod.subject).toBeDefined();
    // System-actor events still carry a valid location/division sourced from the subject.
    expect(sod.location).toBe(sod.subject?.location);
    expect(sod.division).toBe(sod.subject?.division);
  });

  it('locks an account via a system actor targeting the human subject', () => {
    const event = newGenerator().generate('account.lockout', makeCtx(seededPool()));
    expect(event.actor.kind).toBe('system');
    expect(event.subject).toBeDefined();
  });
});

describe('generate: JML mutates the identity pool', () => {
  it('joiner.hire inserts a new active identity', () => {
    const pool = seededPool();
    const before = pool.size();
    const event = newGenerator().generate('joiner.hire', makeCtx(pool));
    expect(pool.size()).toBe(before + 1);
    expect(event.subject).toBeDefined();
    const hired = pool.get(event.subject!.id);
    expect(hired?.status).toBe('active');
    if (event.kind === 'joiner.hire') {
      expect(event.payload.birthrightEntitlements.length).toBeGreaterThan(0);
    }
  });

  it('leaver.termination deprovisions and the saga revokes each grant', () => {
    const pool = seededPool();
    const generator = newGenerator();
    const ctx = makeCtx(pool);
    // Find a target with entitlements so the revoke delta is non-empty.
    let event = generator.generate('leaver.termination', ctx);
    for (let i = 0; i < 40 && (event.subject === undefined); i += 1) {
      event = generator.generate('leaver.termination', ctx);
    }
    const subject = pool.get(event.subject!.id);
    expect(subject?.status === 'terminated' || subject?.status === 'disabled').toBe(true);
    expect(subject?.entitlements.length).toBe(0);

    const followOns = generator.saga(event, ctx);
    for (const follow of followOns) {
      expect(follow.kind).toBe('access.revoke');
      expect(follow.correlationId).toBe(event.correlationId);
      expect(follow.causationId).toBe(event.id);
    }
  });
});

describe('generate: determinism under a fixed seed', () => {
  it('two fresh generators with the same seed and pool emit identical events', () => {
    const kinds: EventKind[] = [
      'login.success', 'joiner.hire', 'access.request', 'payment.swift', 'nhi.activity',
      'mover.transfer', 'leaver.termination', 'trade.book', 'sod.violation', 'gdpr.request',
      'audit.pull', 'card.txn', 'firefighter.grant', 'rehire', 'recertification',
    ];

    const run = (): unknown[] => {
      const generator = createEventGenerator({ seed: 'determinism', logger: silentLogger() });
      const pool = seededPool(2000, 'determinism-pool');
      const ctx = makeCtx(pool, fixedClock());
      const out: unknown[] = [];
      for (const kind of kinds) {
        try {
          const event = generator.generate(kind, ctx);
          out.push(event);
          out.push(...generator.saga(event, ctx));
        } catch {
          out.push(`skip:${kind}`);
        }
      }
      return out;
    };

    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});
