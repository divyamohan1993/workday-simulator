/**
 * TXN event builders: the banking activity stream (SEPA and SWIFT payments, trade
 * booking, card transactions, four-eyes wire approvals, limit breaches and high-value
 * screening alerts).
 *
 * These are the behaviour signals an identity manager correlates against access (a
 * trader booking trades should hold Murex execution; a payment operator initiating
 * SWIFT should not also approve it). Identifiers are structurally real (mod-97 IBANs,
 * ISO 9362 BICs, UUID UETRs) via the `banking` helpers, and amounts follow
 * per-instrument magnitude bands. The saga models the real screening/approval chain:
 * a large wire triggers a high-value alert and a dual-control approval.
 */

import type { GenerationContext } from '../../contracts/index.js';
import type { Employee, EventKind, HighValueAlertPayload, WorkdayEvent } from '../../types/index.js';
import { EVENT_KINDS_BY_CATEGORY, GRADE_SENIORITY } from '../../types/index.js';
import {
  buildSepaPayload,
  buildSwiftPayload,
  logUniformAmount,
  pickMerchant,
  SWIFT_CURRENCIES,
} from '../banking.js';
import { geoForLocation, REMOTE_GEOS } from '../geo.js';
import {
  assembleEvent,
  assertNever,
  type Forge,
  primaryCorrelationId,
  refFromActor,
  requireActiveHuman,
  systemActor,
  toIdentityRef,
} from '../internal.js';
import { EVENT_RATES } from '../rates.js';

/** The TXN event kinds, derived from the frozen category map. */
type TxnKind = (typeof EVENT_KINDS_BY_CATEGORY.TXN)[number];

/** SEPA amount above which a high-value screening alert may fire. */
const SEPA_ALERT_THRESHOLD = 100_000;
/** SWIFT amount above which a wire is treated as large (alert + dual control). */
const SWIFT_LARGE_THRESHOLD = 1_000_000;

const COUNTERPARTIES = [
  'JPMorgan Chase', 'HSBC Holdings', 'BNP Paribas', 'Citigroup', 'Barclays', 'UBS Group',
  'Goldman Sachs', 'Morgan Stanley', 'Societe Generale', 'Commerzbank',
] as const;

const INSTRUMENTS: Record<'Rates' | 'Credit' | 'FX' | 'Equities' | 'Commodities', readonly string[]> = {
  Rates: ['10Y Bund Future', 'EUR IRS 5Y', 'Euribor 3M Future', 'US 10Y Treasury'],
  Credit: ['iTraxx Europe Main', 'CDX IG', 'DB 2030 Senior', 'Bund-BTP Spread'],
  FX: ['EUR/USD Spot', 'GBP/USD Forward', 'USD/JPY Swap', 'EUR/CHF Option'],
  Equities: ['DAX Future', 'SAP SE', 'Siemens AG', 'EuroStoxx 50 Future'],
  Commodities: ['Brent Crude Future', 'XAU/USD Gold', 'TTF Natural Gas', 'LME Copper'],
};

/** Pick a human, preferring one matching a predicate, else any active human. */
function preferHuman(gctx: GenerationContext, kind: EventKind, predicate: (e: Employee) => boolean): Employee {
  return gctx.pool.pick((e) => !e.isNonHuman && e.status === 'active' && predicate(e)) ?? requireActiveHuman(gctx, kind);
}

function buildHighValueAlert(
  forge: Forge,
  txnId: string,
  amount: number,
  currency: string,
  flaggedBy: HighValueAlertPayload['flaggedBy'],
): HighValueAlertPayload {
  const threshold = amount >= SWIFT_LARGE_THRESHOLD ? 1_000_000 : forge.pick([10_000, 50_000, 100_000]);
  const screeningStatus = forge.chance(EVENT_RATES.highValueBlocked)
    ? 'blocked'
    : forge.chance(EVENT_RATES.highValuePending / (1 - EVENT_RATES.highValueBlocked))
      ? 'pending'
      : 'cleared';
  return { txnId, amount, currency, threshold, flaggedBy, screeningStatus };
}

/**
 * Build a primary TXN event. Payments and trades are raised by human operators in the
 * relevant divisions; limit breaches and high-value alerts are raised by risk/AML
 * engines against a human subject from whom location and division are taken.
 *
 * @param kind The TXN kind to build.
 * @param gctx The generation context.
 * @param forge The seeded RNG facade.
 * @returns The assembled event.
 */
export function generateTxn(kind: TxnKind, gctx: GenerationContext, forge: Forge): WorkdayEvent {
  const correlationId = primaryCorrelationId(gctx, forge);
  const causationId = gctx.causationId;

  switch (kind) {
    case 'payment.sepa': {
      const operator = preferHuman(gctx, kind, (e) => e.division === 'Corporate Bank' || e.division === 'Operations' || e.division === 'Finance');
      return assembleEvent(gctx, forge, {
        kind, actor: { kind: 'employee', ...toIdentityRef(operator) }, location: operator.location, division: operator.division, correlationId, causationId,
        payload: buildSepaPayload(forge.faker, forge.id('sepa')),
      });
    }
    case 'payment.swift': {
      const operator = preferHuman(gctx, kind, (e) => e.division === 'Corporate Bank' || e.division === 'Operations' || e.division === 'Investment Bank');
      return assembleEvent(gctx, forge, {
        kind, actor: { kind: 'employee', ...toIdentityRef(operator) }, location: operator.location, division: operator.division, correlationId, causationId,
        payload: buildSwiftPayload(forge.faker, forge.id('swift')),
      });
    }
    case 'trade.book': {
      const trader = preferHuman(gctx, kind, (e) => e.division === 'Investment Bank' || e.division === 'Asset Management');
      const assetClass = forge.weighted<'Rates' | 'Credit' | 'FX' | 'Equities' | 'Commodities'>([
        { weight: 30, value: 'Rates' }, { weight: 20, value: 'FX' }, { weight: 20, value: 'Equities' }, { weight: 18, value: 'Credit' }, { weight: 12, value: 'Commodities' },
      ]);
      return assembleEvent(gctx, forge, {
        kind, actor: { kind: 'employee', ...toIdentityRef(trader) }, location: trader.location, division: trader.division, correlationId, causationId,
        payload: {
          tradeId: forge.id('trd'),
          assetClass,
          instrument: forge.pick(INSTRUMENTS[assetClass]),
          notional: logUniformAmount(forge.faker, 100_000, 500_000_000),
          currency: forge.weighted(SWIFT_CURRENCIES),
          book: `${trader.location}-${assetClass.toUpperCase().slice(0, 4)}-${forge.int(1, 40)}`,
          counterparty: forge.pick(COUNTERPARTIES),
          direction: forge.chance(0.5) ? 'buy' : 'sell',
        },
      });
    }
    case 'card.txn': {
      const holder = requireActiveHuman(gctx, kind);
      const merchant = pickMerchant(forge.faker);
      const fraud = forge.chance(EVENT_RATES.cardFraud);
      const geo = fraud && forge.chance(0.7) ? forge.pick(REMOTE_GEOS) : geoForLocation(holder.location);
      return assembleEvent(gctx, forge, {
        kind, actor: { kind: 'employee', ...toIdentityRef(holder) }, location: holder.location, division: holder.division, correlationId, causationId,
        payload: {
          txnId: forge.id('card'),
          panLast4: forge.faker.string.numeric(4),
          amount: merchant.channel === 'atm' ? logUniformAmount(forge.faker, 20, 1000) : logUniformAmount(forge.faker, 1, 2000),
          currency: 'EUR',
          merchant: merchant.merchant,
          mcc: merchant.mcc,
          channel: merchant.channel,
          country: geo.country,
          fraudScore: fraud ? forge.int(81, 100) : forge.int(0, 45),
        },
      });
    }
    case 'wire.approval': {
      const approver = preferHuman(gctx, kind, (e) => GRADE_SENIORITY[e.grade] >= GRADE_SENIORITY.VP);
      const amount = logUniformAmount(forge.faker, 10_000, 50_000_000);
      const approvalTier = amount >= 5_000_000 ? 3 : amount >= 100_000 ? 2 : 1;
      return assembleEvent(gctx, forge, {
        kind, actor: { kind: 'employee', ...toIdentityRef(approver) }, location: approver.location, division: approver.division, correlationId, causationId,
        payload: {
          txnId: forge.id('wire'),
          amount,
          currency: forge.weighted(SWIFT_CURRENCIES),
          approvalTier,
          approverId: approver.id,
          dualControl: approvalTier >= 2,
        },
      });
    }
    case 'limit.breach': {
      const trader = preferHuman(gctx, kind, (e) => e.division === 'Investment Bank' || e.division === 'Risk');
      const limit = logUniformAmount(forge.faker, 1_000_000, 500_000_000);
      const exposure = Math.round(limit * (1 + forge.float(0.01, 0.5)) * 100) / 100;
      return assembleEvent(gctx, forge, {
        kind, actor: systemActor('risk-engine'), subject: toIdentityRef(trader), location: trader.location, division: trader.division, correlationId, causationId,
        payload: {
          limitType: forge.weighted([
            { weight: 35, value: 'intraday' }, { weight: 25, value: 'position' }, { weight: 20, value: 'credit' }, { weight: 20, value: 'settlement' },
          ]),
          limit,
          exposure,
          currency: forge.weighted(SWIFT_CURRENCIES),
          book: `${trader.location}-RISK-${forge.int(1, 40)}`,
          breachPct: Math.round(((exposure - limit) / limit) * 100 * 100) / 100,
        },
      });
    }
    case 'highvalue.alert': {
      const party = preferHuman(gctx, kind, (e) => e.division === 'Corporate Bank' || e.division === 'Operations');
      const currency = forge.weighted(SWIFT_CURRENCIES);
      const amount = logUniformAmount(forge.faker, 50_000, 100_000_000);
      return assembleEvent(gctx, forge, {
        kind, actor: systemActor('aml-engine'), subject: toIdentityRef(party), location: party.location, division: party.division, correlationId, causationId,
        payload: buildHighValueAlert(forge, forge.id('htx'), amount, currency, forge.weighted([
          { weight: 50, value: 'aml' }, { weight: 30, value: 'fraud' }, { weight: 20, value: 'sanctions' },
        ])),
      });
    }
    default:
      return assertNever(kind);
  }
}

/**
 * Follow-on events for a TXN primary: a large SWIFT wire triggers a high-value alert
 * and, under dual control, a wire approval; a large SEPA payment or a suspected-fraud
 * card transaction triggers a high-value alert.
 *
 * @param primary The just-generated TXN event.
 * @param gctx The generation context.
 * @param forge The seeded RNG facade.
 * @returns Ordered follow-on events (possibly empty).
 */
export function txnSaga(primary: WorkdayEvent, gctx: GenerationContext, forge: Forge): WorkdayEvent[] {
  const followOns: WorkdayEvent[] = [];
  const correlationId = primary.correlationId;
  const loc = { location: primary.location, division: primary.division };

  if (primary.kind === 'payment.swift' && primary.payload.amount >= SWIFT_LARGE_THRESHOLD) {
    const subject = refFromActor(primary.actor);
    const alert = assembleEvent(gctx, forge, {
      kind: 'highvalue.alert', actor: systemActor('aml-engine'), subject, ...loc, correlationId, causationId: primary.id,
      payload: buildHighValueAlert(forge, primary.payload.txnId, primary.payload.amount, primary.payload.currency, 'aml'),
    });
    followOns.push(alert);
    if (forge.chance(EVENT_RATES.wireApprovalRequired)) {
      const approver = gctx.pool.pick((e) => !e.isNonHuman && e.status === 'active' && GRADE_SENIORITY[e.grade] >= GRADE_SENIORITY.VP);
      if (approver) {
        followOns.push(
          assembleEvent(gctx, forge, {
            kind: 'wire.approval', actor: { kind: 'employee', ...toIdentityRef(approver) }, location: approver.location, division: approver.division, correlationId, causationId: alert.id,
            payload: { txnId: primary.payload.txnId, amount: primary.payload.amount, currency: primary.payload.currency, approvalTier: 3, approverId: approver.id, dualControl: true },
          }),
        );
      }
    }
    return followOns;
  }

  if (primary.kind === 'payment.sepa' && primary.payload.amount >= SEPA_ALERT_THRESHOLD && forge.chance(0.5)) {
    followOns.push(
      assembleEvent(gctx, forge, {
        kind: 'highvalue.alert', actor: systemActor('aml-engine'), subject: refFromActor(primary.actor), ...loc, correlationId, causationId: primary.id,
        payload: buildHighValueAlert(forge, primary.payload.txnId, primary.payload.amount, primary.payload.currency, 'aml'),
      }),
    );
    return followOns;
  }

  if (primary.kind === 'card.txn' && primary.payload.fraudScore > 80) {
    followOns.push(
      assembleEvent(gctx, forge, {
        kind: 'highvalue.alert', actor: systemActor('fraud-engine'), subject: refFromActor(primary.actor), ...loc, correlationId, causationId: primary.id,
        payload: buildHighValueAlert(forge, primary.payload.txnId, primary.payload.amount, primary.payload.currency, 'fraud'),
      }),
    );
  }

  return followOns;
}
