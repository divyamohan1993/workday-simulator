/**
 * The event generator: the frozen `EventGenerator` implementation.
 *
 * WHY this file is thin: all the realism lives in the five category builders; this is
 * the composition and dispatch layer. It owns exactly two pieces of state, the single
 * seeded Faker instance (so every draw is replayable) and a `WeakMap` from each
 * just-generated JML event to the entitlement delta its pool mutation produced. The
 * WeakMap is the mechanism that lets a saga emit the right provision/revoke follow-ons
 * even though the frozen JML payloads do not carry entitlement ids and the pool has
 * already been mutated by generation time. A WeakMap (not a keyed Map) is deliberate:
 * chaos injectors call `generate` for JML kinds without ever calling `saga`, and a
 * WeakMap lets those entries be collected instead of leaking.
 *
 * Determinism: constructed once with `options.seed`; the runtime does not reseed it
 * (a documented boundary), so per-run determinism is anchored by the pool and arrival
 * seeds plus this generator's construction seed.
 */

import { base, en, Faker } from '@faker-js/faker';
import type { EventGeneratorOptions } from '../contracts/factories.js';
import type { EventGenerator, GenerationContext } from '../contracts/index.js';
import type { JmlOutcome } from '../domain/index.js';
import type { EventKind, EventOfKind, WorkdayEvent } from '../types/index.js';
import { EVENT_CATEGORY, EVENT_KINDS_BY_CATEGORY } from '../types/index.js';
import { accessSaga, generateAccess } from './builders/access.js';
import { authSaga, generateAuth } from './builders/auth.js';
import { complianceSaga, generateCompliance } from './builders/compliance.js';
import { generateJml, jmlSaga } from './builders/jml.js';
import { generateTxn, txnSaga } from './builders/txn.js';
import { createForge } from './internal.js';

type AuthKind = (typeof EVENT_KINDS_BY_CATEGORY.AUTH)[number];
type JmlKind = (typeof EVENT_KINDS_BY_CATEGORY.JML)[number];
type AccessKind = (typeof EVENT_KINDS_BY_CATEGORY.ACCESS)[number];
type TxnKind = (typeof EVENT_KINDS_BY_CATEGORY.TXN)[number];
type ComplianceKind = (typeof EVENT_KINDS_BY_CATEGORY.COMPLIANCE)[number];

/** Deterministic 32-bit FNV-1a hash so a seed STRING can seed Faker's numeric RNG. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Construct the event generator. Shape matches the frozen `EventGeneratorFactory` so
 * the server can wire it directly.
 *
 * @param options.seed Deterministic seed for the payload RNG.
 * @param options.logger Structured logger.
 * @returns An `EventGenerator`.
 */
export function createEventGenerator(options: EventGeneratorOptions): EventGenerator {
  const logger = options.logger.child({ module: 'event-generator' });
  const faker = new Faker({ locale: [en, base] });
  faker.seed(hashSeed(options.seed));
  const forge = createForge(faker);

  // Maps a generated JML event to the entitlement delta its mutation produced, so the
  // saga can emit provision/revoke follow-ons. WeakMap so chaos-injected JML events
  // (generated but never sagaed) are collected rather than retained forever.
  const jmlOutcomes = new WeakMap<WorkdayEvent, JmlOutcome>();

  const generate = <K extends EventKind>(kind: K, ctx: GenerationContext): EventOfKind<K> => {
    const k: EventKind = kind;
    let event: WorkdayEvent;
    switch (EVENT_CATEGORY[k]) {
      case 'AUTH':
        event = generateAuth(k as AuthKind, ctx, forge);
        break;
      case 'JML': {
        const result = generateJml(k as JmlKind, ctx, forge);
        if (result.outcome) {
          jmlOutcomes.set(result.event, result.outcome);
        }
        event = result.event;
        break;
      }
      case 'ACCESS':
        event = generateAccess(k as AccessKind, ctx, forge);
        break;
      case 'TXN':
        event = generateTxn(k as TxnKind, ctx, forge);
        break;
      case 'COMPLIANCE':
        event = generateCompliance(k as ComplianceKind, ctx, forge);
        break;
      default:
        throw new Error(`unknown event category for kind ${String(k)}`);
    }
    return event as EventOfKind<K>;
  };

  const saga = (primary: WorkdayEvent, ctx: GenerationContext): WorkdayEvent[] => {
    switch (primary.category) {
      case 'AUTH':
        return authSaga(primary, ctx, forge);
      case 'JML':
        return jmlSaga(primary, jmlOutcomes.get(primary), ctx, forge);
      case 'ACCESS':
        return accessSaga(primary, ctx, forge);
      case 'TXN':
        return txnSaga(primary, ctx, forge);
      case 'COMPLIANCE':
        return complianceSaga(primary, ctx, forge);
      default:
        return [];
    }
  };

  logger.debug({ seed: options.seed }, 'event generator constructed');
  return { generate, saga };
}
