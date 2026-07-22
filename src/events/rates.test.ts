import { describe, expect, it } from 'vitest';
import { createEventGenerator } from './index.js';
import { DEFAULT_EVENT_MIX } from './event-mix.js';
import { EVENT_RATES } from './rates.js';
import { makeCtx, seededPool, silentLogger } from './__tests__/support.js';

function newGenerator(seed = 'rates-seed') {
  return createEventGenerator({ seed, logger: silentLogger() });
}

/** A modest pool keeps the O(n) predicate picks in the deny saga fast under the timeout. */
const POOL_SIZE = 1200;

describe('cross-kind failure share via the default event mix', () => {
  it('keeps the login-failure share within the realistic 3-8% band', () => {
    const success = DEFAULT_EVENT_MIX.byKind?.['login.success'] ?? 0;
    const failure = DEFAULT_EVENT_MIX.byKind?.['login.failure'] ?? 0;
    const share = failure / (success + failure);
    expect(share).toBeGreaterThanOrEqual(0.03);
    expect(share).toBeLessThanOrEqual(0.08);
  });
});

describe('within-kind outcome rates are within band', () => {
  const N = 2500;

  it('step-up is satisfied around the configured rate', () => {
    const generator = newGenerator();
    const ctx = makeCtx(seededPool(POOL_SIZE));
    let satisfied = 0;
    for (let i = 0; i < N; i += 1) {
      const event = generator.generate('stepup', ctx);
      if (event.kind === 'stepup' && event.payload.satisfied) {
        satisfied += 1;
      }
    }
    const rate = satisfied / N;
    expect(rate).toBeGreaterThan(EVENT_RATES.stepUpSatisfied - 0.05);
    expect(rate).toBeLessThan(EVENT_RATES.stepUpSatisfied + 0.05);
  });

  it('card fraud is flagged around the configured rate', () => {
    const generator = newGenerator();
    const ctx = makeCtx(seededPool(POOL_SIZE));
    let fraud = 0;
    for (let i = 0; i < N; i += 1) {
      const event = generator.generate('card.txn', ctx);
      if (event.kind === 'card.txn' && event.payload.fraudScore > 80) {
        fraud += 1;
      }
    }
    const rate = fraud / N;
    expect(rate).toBeGreaterThan(0.01);
    expect(rate).toBeLessThan(0.06);
  });

  it('high-value alerts are blocked around the configured rate', () => {
    const generator = newGenerator();
    const ctx = makeCtx(seededPool(POOL_SIZE));
    let blocked = 0;
    for (let i = 0; i < N; i += 1) {
      const event = generator.generate('highvalue.alert', ctx);
      if (event.kind === 'highvalue.alert' && event.payload.screeningStatus === 'blocked') {
        blocked += 1;
      }
    }
    const rate = blocked / N;
    expect(rate).toBeGreaterThan(EVENT_RATES.highValueBlocked - 0.06);
    expect(rate).toBeLessThan(EVENT_RATES.highValueBlocked + 0.06);
  });

  it('access requests with a clear pre-check are denied around the configured rate', () => {
    const generator = newGenerator();
    const ctx = makeCtx(seededPool(POOL_SIZE));
    let clear = 0;
    let denied = 0;
    for (let i = 0; i < N; i += 1) {
      const request = generator.generate('access.request', ctx);
      if (request.kind !== 'access.request' || request.payload.sodPreCheck !== 'clear') {
        continue;
      }
      const follow = generator.saga(request, ctx);
      if (follow.length === 0) {
        continue;
      }
      clear += 1;
      if (follow[0]?.kind === 'access.deny') {
        denied += 1;
      }
    }
    expect(clear).toBeGreaterThan(500);
    const rate = denied / clear;
    expect(rate).toBeGreaterThan(EVENT_RATES.accessDeny - 0.07);
    expect(rate).toBeLessThan(EVENT_RATES.accessDeny + 0.07);
  });
});
