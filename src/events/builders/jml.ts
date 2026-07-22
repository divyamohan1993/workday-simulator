/**
 * JML (Joiner/Mover/Leaver) event builders.
 *
 * These are the only builders that MUTATE the identity pool: a hire inserts an
 * identity, a leaver flips status and deprovisions, a mover recomputes the baseline.
 * Each mutation runs through the domain's delta-returning lifecycle helpers
 * (`applyHire`, `applyTransfer`, ...), which return the entitlement delta the change
 * produced. That delta is returned alongside the event so the generator can stash it
 * and the saga can emit an `access.provision` per granted grant and an `access.revoke`
 * per revoked grant, which is the single most important flow for testing an identity
 * manager's JML automation.
 *
 * All JML events are raised by the platform HR feed (a system actor); the affected
 * identity is the event subject, and the event's location/division come from it.
 */

import type { GenerationContext } from '../../contracts/index.js';
import type {
  ContractExpiryPayload,
  Division,
  EmployeeType,
  Grade,
  LeaverTerminationPayload,
  LocationCode,
  WorkdayEvent,
} from '../../types/index.js';
import { ALL_DIVISIONS, ALL_LOCATIONS, EVENT_KINDS_BY_CATEGORY, GRADE_SENIORITY } from '../../types/index.js';
import {
  applyConversion,
  applyHire,
  applyLoa,
  applyPromotion,
  applyRehire,
  applyTermination,
  applyTransfer,
  type JmlOutcome,
} from '../../domain/index.js';
import { isActiveLike, jmlStateMachine } from '../../engine/index.js';
import {
  assembleEvent,
  assertNever,
  chaosActive,
  type Forge,
  primaryCorrelationId,
  requireMatch,
  systemActor,
  toEntitlementRef,
  toIdentityRef,
} from '../internal.js';
import { assembleProvision, assembleRevoke } from './access.js';

/** The JML event kinds, derived from the frozen category map. */
type JmlKind = (typeof EVENT_KINDS_BY_CATEGORY.JML)[number];

/** The result of a JML generation: the event plus its entitlement delta (for the saga). */
export interface JmlResult {
  event: WorkdayEvent;
  /** Set only for kinds that produce a provision/revoke delta the saga should emit. */
  outcome?: JmlOutcome;
}

const HR_FEED = 'workday-hr-feed';
/** Maximum provision/revoke follow-ons a single JML event fans out into. */
const MAX_FANOUT = 8;

/** Grades ordered by seniority, for computing the next promotion step. */
const GRADES_BY_SENIORITY: Grade[] = (Object.entries(GRADE_SENIORITY) as [Grade, number][])
  .sort((a, b) => a[1] - b[1])
  .map(([grade]) => grade);

function nextGrade(grade: Grade): Grade {
  const index = GRADES_BY_SENIORITY.indexOf(grade);
  return GRADES_BY_SENIORITY[Math.min(index + 1, GRADES_BY_SENIORITY.length - 1)] ?? grade;
}

/** Date-only (YYYY-MM-DD) rendering of the current simulated instant. */
function simDate(gctx: GenerationContext, dayOffset = 0): string {
  return new Date(gctx.clock.now() + dayOffset * 86_400_000).toISOString().slice(0, 10);
}

function otherDivision(forge: Forge, current: Division): Division {
  return forge.pick(ALL_DIVISIONS.filter((d) => d !== current));
}

const CONTRACT_TYPE_BY_EMPLOYEE: Record<EmployeeType, 'permanent' | 'fixed_term' | 'agency' | 'internship'> = {
  FTE: 'permanent',
  External: 'fixed_term',
  Contractor: 'agency',
  Intern: 'internship',
  Service: 'permanent',
};

/**
 * Build a primary JML event, applying the corresponding pool mutation and returning
 * the entitlement delta for the saga. Throws `NoEligibleActorError` (via `requireMatch`)
 * when no identity is eligible for the transition, which the runtime treats as a skip.
 *
 * @param kind The JML kind to build.
 * @param gctx The generation context (its pool is mutated).
 * @param forge The seeded RNG facade.
 * @returns The event and, for provisioning kinds, its delta.
 */
export function generateJml(kind: JmlKind, gctx: GenerationContext, forge: Forge): JmlResult {
  const correlationId = primaryCorrelationId(gctx, forge);
  const causationId = gctx.causationId;
  const actor = systemActor(HR_FEED);
  const pool = gctx.pool;

  switch (kind) {
    case 'joiner.hire': {
      const type = forge.weighted<EmployeeType>([
        { weight: 70, value: 'FTE' }, { weight: 14, value: 'Contractor' }, { weight: 6, value: 'Intern' },
        { weight: 7, value: 'External' }, { weight: 3, value: 'Service' },
      ]);
      const outcome = applyHire(pool, { type, status: 'active', startDate: new Date(gctx.clock.now()).toISOString() });
      const emp = outcome.employee;
      const event = assembleEvent(gctx, forge, {
        kind, actor, subject: toIdentityRef(emp), location: emp.location, division: emp.division, correlationId, causationId,
        payload: {
          effectiveDate: simDate(gctx),
          employeeType: emp.type,
          division: emp.division,
          grade: emp.grade,
          managerId: emp.managerId,
          location: emp.location,
          contractType: CONTRACT_TYPE_BY_EMPLOYEE[emp.type],
          positionId: `POS-${forge.int(100_000, 999_999)}`,
          birthrightEntitlements: outcome.granted.map((e) => e.id),
        },
      });
      return { event, outcome };
    }
    case 'mover.transfer': {
      const target = requireMatch(gctx, kind, (e) => !e.isNonHuman && jmlStateMachine.isEligible('mover.transfer', e.status), 'no identity eligible to transfer');
      const from = { division: target.division, location: target.location, costCenter: target.costCenter };
      const toDivision = otherDivision(forge, target.division);
      const toLocation = forge.chance(0.5) ? forge.pick(ALL_LOCATIONS.filter((l) => l !== target.location)) : target.location;
      const outcome = applyTransfer(pool, target.id, { division: toDivision, location: toLocation });
      if (!outcome) {
        throw new Error('transfer produced no outcome');
      }
      const after = outcome.employee;
      const event = assembleEvent(gctx, forge, {
        kind, actor, subject: toIdentityRef(after), location: after.location, division: after.division, correlationId, causationId,
        payload: {
          fromDivision: from.division, toDivision, fromLocation: from.location, toLocation: after.location,
          fromCostCenter: from.costCenter, toCostCenter: after.costCenter, effectiveDate: simDate(gctx),
          retainedEntitlements: outcome.retained.map((e) => e.id),
          revokedEntitlements: outcome.revoked.map((e) => e.id),
        },
      });
      return { event, outcome };
    }
    case 'mover.promotion': {
      const target = requireMatch(gctx, kind, (e) => !e.isNonHuman && isActiveLike(e.status) && GRADE_SENIORITY[e.grade] >= GRADE_SENIORITY.Analyst && GRADE_SENIORITY[e.grade] < GRADE_SENIORITY.MD, 'no identity eligible to promote');
      const fromGrade = target.grade;
      const toGrade = nextGrade(fromGrade);
      const outcome = applyPromotion(pool, target.id, toGrade);
      if (!outcome) {
        throw new Error('promotion produced no outcome');
      }
      const after = outcome.employee;
      const event = assembleEvent(gctx, forge, {
        kind, actor, subject: toIdentityRef(after), location: after.location, division: after.division, correlationId, causationId,
        payload: { fromGrade, toGrade, effectiveDate: simDate(gctx), newTitle: `${toGrade}, ${after.jobFamily}` },
      });
      return { event, outcome };
    }
    case 'mover.manager_change': {
      const target = requireMatch(gctx, kind, (e) => !e.isNonHuman && isActiveLike(e.status) && GRADE_SENIORITY[e.grade] < GRADE_SENIORITY.MD, 'no identity eligible for a manager change');
      const newManager = requireMatch(gctx, kind, (e) => !e.isNonHuman && e.status === 'active' && GRADE_SENIORITY[e.grade] > GRADE_SENIORITY[target.grade] && e.id !== target.id, 'no senior manager available');
      const fromManagerId = target.managerId;
      const after = pool.changeManager(target.id, newManager.id) ?? target;
      const event = assembleEvent(gctx, forge, {
        kind, actor, subject: toIdentityRef(after), location: after.location, division: after.division, correlationId, causationId,
        payload: { fromManagerId, toManagerId: newManager.id, effectiveDate: simDate(gctx), partOfReorg: chaosActive(gctx, 'mass_termination_reorg') || forge.chance(0.2) },
      });
      return { event };
    }
    case 'leaver.termination': {
      const target = requireMatch(gctx, kind, (e) => !e.isNonHuman && jmlStateMachine.isEligible('leaver.termination', e.status), 'no identity eligible to terminate');
      const reason: LeaverTerminationPayload['reason'] = chaosActive(gctx, 'mass_termination_reorg')
        ? 'redundancy'
        : forge.weighted([
            { weight: 40, value: 'redundancy' }, { weight: 25, value: 'performance' }, { weight: 20, value: 'misconduct' }, { weight: 15, value: 'gross_misconduct' },
          ]);
      const immediate = reason === 'gross_misconduct' || forge.chance(0.2);
      const outcome = applyTermination(pool, target.id, { immediate });
      if (!outcome) {
        throw new Error('termination produced no outcome');
      }
      const emp = outcome.employee;
      const event = assembleEvent(gctx, forge, {
        kind, actor, subject: toIdentityRef(emp), location: emp.location, division: emp.division, correlationId, causationId,
        payload: {
          reason, immediate, lastWorkingDay: simDate(gctx),
          revokeImmediately: immediate || forge.chance(0.7),
          escortRequired: reason === 'gross_misconduct' || (reason === 'misconduct' && forge.chance(0.5)),
        },
      });
      return { event, outcome };
    }
    case 'leaver.resignation': {
      const target = requireMatch(gctx, kind, (e) => !e.isNonHuman && jmlStateMachine.isEligible('leaver.resignation', e.status), 'no identity eligible to resign');
      const noticePeriodDays = forge.weighted([{ weight: 40, value: 30 }, { weight: 35, value: 60 }, { weight: 25, value: 90 }]);
      const event = assembleEvent(gctx, forge, {
        kind, actor, subject: toIdentityRef(target), location: target.location, division: target.division, correlationId, causationId,
        payload: { noticePeriodDays, lastWorkingDay: simDate(gctx, noticePeriodDays), rehireEligible: forge.chance(0.85) },
      });
      return { event };
    }
    case 'leaver.loa': {
      const target = requireMatch(gctx, kind, (e) => !e.isNonHuman && e.status === 'active', 'no active identity to place on leave');
      const loaType = forge.weighted<'maternity' | 'paternity' | 'medical' | 'sabbatical' | 'garden_leave'>([
        { weight: 25, value: 'medical' }, { weight: 25, value: 'maternity' }, { weight: 20, value: 'paternity' }, { weight: 15, value: 'sabbatical' }, { weight: 15, value: 'garden_leave' },
      ]);
      const outcome = applyLoa(pool, target.id);
      if (!outcome) {
        throw new Error('leave of absence produced no outcome');
      }
      const emp = outcome.employee;
      const event = assembleEvent(gctx, forge, {
        kind, actor, subject: toIdentityRef(emp), location: emp.location, division: emp.division, correlationId, causationId,
        payload: {
          loaType, startDate: simDate(gctx),
          ...(loaType === 'sabbatical' || loaType === 'garden_leave' ? {} : { expectedReturn: simDate(gctx, forge.int(30, 365)) }),
          suspendAccess: loaType === 'garden_leave' || forge.chance(0.6),
        },
      });
      return { event };
    }
    case 'rehire': {
      const target = requireMatch(gctx, kind, (e) => e.status === 'terminated', 'no terminated identity to rehire');
      const outcome = applyRehire(pool, target.id);
      if (!outcome) {
        throw new Error('rehire produced no outcome');
      }
      const emp = outcome.employee;
      const event = assembleEvent(gctx, forge, {
        kind, actor, subject: toIdentityRef(emp), location: emp.location, division: emp.division, correlationId, causationId,
        payload: { previousEmployeeId: emp.employeeId, gapDays: forge.int(30, 900), restoredEntitlements: outcome.granted.map((e) => e.id) },
      });
      return { event, outcome };
    }
    case 'contractor.convert': {
      const target = requireMatch(gctx, kind, (e) => (e.type === 'Contractor' || e.type === 'External') && !e.isNonHuman && isActiveLike(e.status), 'no contractor to convert');
      const fromType = target.type;
      const outcome = applyConversion(pool, target.id, 'FTE');
      if (!outcome) {
        throw new Error('conversion produced no outcome');
      }
      const emp = outcome.employee;
      const event = assembleEvent(gctx, forge, {
        kind, actor, subject: toIdentityRef(emp), location: emp.location, division: emp.division, correlationId, causationId,
        payload: { fromType, toType: 'FTE', effectiveDate: simDate(gctx), newEmployeeId: emp.employeeId },
      });
      // Only the NEW identity's provisions are emitted; the old grants are implicitly
      // deprovisioned by the conversion. Present the granted set as the saga delta.
      return { event, outcome: { employee: emp, granted: outcome.granted, revoked: [], retained: [] } };
    }
    case 'contract.expiry': {
      const target = requireMatch(gctx, kind, (e) => (e.type === 'Contractor' || e.type === 'Intern' || e.type === 'External' || e.isNonHuman) && jmlStateMachine.isEligible('contract.expiry', e.status), 'no contract eligible to expire');
      const autoRevoke = forge.chance(0.8);
      const contractEndDate = typeof target.attributes.contractEndDate === 'string' ? target.attributes.contractEndDate.slice(0, 10) : simDate(gctx);
      const payload: ContractExpiryPayload = { contractEndDate, autoRevoke, extensionGranted: !autoRevoke };
      if (autoRevoke) {
        const outcome = applyTermination(pool, target.id, { immediate: true });
        if (!outcome) {
          throw new Error('contract expiry produced no outcome');
        }
        const emp = outcome.employee;
        const event = assembleEvent(gctx, forge, {
          kind, actor: systemActor('contract-monitor'), subject: toIdentityRef(emp), location: emp.location, division: emp.division, correlationId, causationId, payload,
        });
        return { event, outcome };
      }
      const event = assembleEvent(gctx, forge, {
        kind, actor: systemActor('contract-monitor'), subject: toIdentityRef(target), location: target.location, division: target.division, correlationId, causationId, payload,
      });
      return { event };
    }
    default:
      return assertNever(kind);
  }
}

/** Revoke reason implied by the JML kind that produced the delta. */
function revokeReasonFor(kind: WorkdayEvent['kind']): 'leaver' | 'mover' | 'expiry' | 'manual' {
  switch (kind) {
    case 'leaver.termination':
    case 'leaver.resignation':
      return 'leaver';
    case 'contract.expiry':
      return 'expiry';
    case 'mover.transfer':
    case 'mover.promotion':
      return 'mover';
    default:
      return 'manual';
  }
}

/**
 * Follow-on events for a JML primary: an `access.revoke` per revoked grant and an
 * `access.provision` per granted grant, capped so a single lifecycle change cannot
 * fan out unboundedly. All follow-ons are directly caused by the JML event (siblings),
 * so each carries the primary's id as its causation.
 *
 * @param primary The just-generated JML event.
 * @param outcome The entitlement delta the mutation produced, if any.
 * @param gctx The generation context.
 * @param forge The seeded RNG facade.
 * @returns Ordered follow-on events (revokes then provisions).
 */
export function jmlSaga(primary: WorkdayEvent, outcome: JmlOutcome | undefined, gctx: GenerationContext, forge: Forge): WorkdayEvent[] {
  if (!outcome || !primary.subject) {
    return [];
  }
  const subject = primary.subject;
  const correlationId = primary.correlationId;
  const reason = revokeReasonFor(primary.kind);
  const followOns: WorkdayEvent[] = [];

  for (const ent of outcome.revoked.slice(0, MAX_FANOUT)) {
    followOns.push(assembleRevoke(gctx, forge, { subject, entitlement: toEntitlementRef(ent), reason, correlationId, causationId: primary.id }));
  }
  const remaining = MAX_FANOUT - followOns.length;
  for (const ent of outcome.granted.slice(0, Math.max(0, remaining))) {
    followOns.push(assembleProvision(gctx, forge, { subject, entitlement: toEntitlementRef(ent), correlationId, causationId: primary.id }));
  }
  return followOns;
}
