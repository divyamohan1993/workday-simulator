/**
 * ACCESS event builders: the access-governance lifecycle (request, approve/deny,
 * provision, revoke), recertification, firefighter (emergency) access, and the three
 * detector kinds (SoD violation, orphan and dormant accounts).
 *
 * These exercise the heart of an identity manager. The request/approve/provision saga
 * models a real four-eyes access flow; provision and revoke follow-ons are also
 * emitted by the JML builders, so the provision/revoke assemblers are exported for
 * reuse. SoD violations prefer a genuinely conflicted identity from the pool and fall
 * back to a synthesized toxic pair, so the rule and the two offending grants are
 * always real.
 */

import type { GenerationContext } from '../../contracts/index.js';
import type {
  AccessProvisionPayload,
  AccessRevokePayload,
  Employee,
  EntitlementRef,
  EventKind,
  IdentityRef,
  RiskLevel,
  WorkdayEvent,
} from '../../types/index.js';
import { EVENT_KINDS_BY_CATEGORY, GRADE_SENIORITY } from '../../types/index.js';
import {
  ALL_ENTITLEMENT_TEMPLATES,
  detectSodConflictsDetailed,
  type EntitlementProfile,
  mintEntitlement,
  SOD_RULES,
  TOXIC_PAIRS,
} from '../../domain/index.js';
import {
  assembleEvent,
  assertNever,
  type Forge,
  primaryCorrelationId,
  refFromActor,
  requireActiveHuman,
  requireMatch,
  systemActor,
  toEntitlementRef,
  toIdentityRef,
} from '../internal.js';
import { EVENT_RATES } from '../rates.js';

/** The ACCESS event kinds, derived from the frozen category map. */
type AccessKind = (typeof EVENT_KINDS_BY_CATEGORY.ACCESS)[number];

const PROVISIONING_TARGETS = [
  'ActiveDirectory', 'Murex', 'SAP', 'SWIFT-Alliance', 'Avaloq', 'Aladdin', 'CyberArk', 'GitHubEnterprise', 'Splunk',
] as const;

const JUSTIFICATIONS = [
  'Required for daily trade booking responsibilities',
  'Covering for a colleague on parental leave',
  'New project onboarding in the division',
  'Quarter-end reconciliation duties',
  'Audit remediation task assigned by manager',
  'Production support on-call rota',
  'Client onboarding workflow access',
  'Regulatory reporting deadline',
] as const;

const FIREFIGHTER_ROLES: ReadonlyArray<{ role: string; system: string }> = [
  { role: 'SAP Firefighter (Emergency Access)', system: 'SAP' },
  { role: 'UNIX Root Break-Glass', system: 'CyberArk' },
  { role: 'Domain Admin (Just-in-Time)', system: 'ActiveDirectory' },
  { role: 'SWIFT Emergency Operator', system: 'SWIFT-Alliance' },
];

/** Entitlement templates worth requesting: sensitive roles, privileged and apps. */
const REQUESTABLE = ALL_ENTITLEMENT_TEMPLATES.filter(
  (t) => t.type === 'role' || t.type === 'privileged' || t.type === 'application' || t.sensitive,
);

/** Build an EntitlementProfile from an identity, for entitlement minting/naming. */
function profileOf(employee: Employee): EntitlementProfile {
  return {
    division: employee.division,
    grade: employee.grade,
    type: employee.type,
    location: employee.location,
    jobFamily: employee.jobFamily,
    isNonHuman: employee.isNonHuman,
  };
}

/** Mint a realistic entitlement reference for a request/provision, named for the holder. */
function mintRef(forge: Forge, gctx: GenerationContext, profile: EntitlementProfile): EntitlementRef {
  const template = forge.pick(REQUESTABLE);
  return toEntitlementRef(mintEntitlement(forge.faker, template, profile, { grantedAtMs: gctx.clock.now() }));
}

/** Pick a senior human to act as an approver/reviewer, or throw if none exists. */
function requireApprover(gctx: GenerationContext, kind: EventKind): Employee {
  return requireMatch(
    gctx,
    kind,
    (e) => !e.isNonHuman && e.status === 'active' && GRADE_SENIORITY[e.grade] >= GRADE_SENIORITY.VP,
    'no senior human available to approve',
  );
}

/**
 * Assemble an `access.provision` event. Exported so the JML builders can emit a
 * provision per birthright/restored entitlement using the same shape.
 */
export function assembleProvision(
  gctx: GenerationContext,
  forge: Forge,
  args: { subject: IdentityRef; entitlement: EntitlementRef; correlationId: string; causationId?: string; requestId?: string },
): WorkdayEvent {
  const mode = forge.chance(0.9) ? 'automated' : 'manual';
  const payload: AccessProvisionPayload = {
    entitlement: args.entitlement,
    targetSystem: args.entitlement.system,
    connector: `${args.entitlement.system}-connector`,
    provisioningMode: mode,
    latencyMs: mode === 'automated' ? forge.int(200, 5000) : forge.int(30_000, 900_000),
    ...(args.requestId ? { requestId: args.requestId } : {}),
  };
  return assembleEvent(gctx, forge, {
    kind: 'access.provision',
    actor: systemActor('provisioning-engine'),
    subject: args.subject,
    location: args.subject.location,
    division: args.subject.division,
    correlationId: args.correlationId,
    causationId: args.causationId,
    entitlementId: args.entitlement.id,
    payload,
  });
}

/** Assemble an `access.revoke` event. Exported for reuse by the JML leaver/mover sagas. */
export function assembleRevoke(
  gctx: GenerationContext,
  forge: Forge,
  args: { subject: IdentityRef; entitlement: EntitlementRef; reason: AccessRevokePayload['reason']; correlationId: string; causationId?: string },
): WorkdayEvent {
  const payload: AccessRevokePayload = {
    entitlement: args.entitlement,
    reason: args.reason,
    targetSystem: args.entitlement.system,
    connector: `${args.entitlement.system}-connector`,
  };
  return assembleEvent(gctx, forge, {
    kind: 'access.revoke',
    actor: systemActor('provisioning-engine'),
    subject: args.subject,
    location: args.subject.location,
    division: args.subject.division,
    correlationId: args.correlationId,
    causationId: args.causationId,
    entitlementId: args.entitlement.id,
    payload,
  });
}

/**
 * Build a primary ACCESS event of the given kind.
 *
 * @param kind The ACCESS kind to build.
 * @param gctx The generation context.
 * @param forge The seeded RNG facade.
 * @returns The assembled event.
 */
export function generateAccess(kind: AccessKind, gctx: GenerationContext, forge: Forge): WorkdayEvent {
  const correlationId = primaryCorrelationId(gctx, forge);
  const causationId = gctx.causationId;

  switch (kind) {
    case 'access.request': {
      const channel = forge.weighted([
        { weight: 60, value: 'self_service' as const },
        { weight: 25, value: 'manager' as const },
        { weight: 10, value: 'birthright' as const },
        { weight: 5, value: 'role_mining' as const },
      ]);
      const beneficiary = requireActiveHuman(gctx, kind);
      const entitlement = mintRef(forge, gctx, profileOf(beneficiary));
      const requester =
        channel === 'manager'
          ? requireMatch(gctx, kind, (e) => !e.isNonHuman && e.status === 'active' && GRADE_SENIORITY[e.grade] >= GRADE_SENIORITY.AVP && e.id !== beneficiary.id, 'no manager to raise request')
          : null;
      const actor =
        channel === 'birthright'
          ? systemActor('birthright-engine')
          : channel === 'role_mining'
            ? systemActor('role-mining')
            : requester
              ? { kind: 'employee' as const, ...toIdentityRef(requester) }
              : { kind: 'employee' as const, ...toIdentityRef(beneficiary) };
      const selfService = channel === 'self_service';
      return assembleEvent(gctx, forge, {
        kind, actor, subject: selfService ? undefined : toIdentityRef(beneficiary),
        location: beneficiary.location, division: beneficiary.division, correlationId, causationId,
        entitlementId: entitlement.id,
        payload: {
          requestId: forge.id('req'),
          entitlement,
          businessJustification: forge.pick(JUSTIFICATIONS),
          forSubjectId: beneficiary.id,
          riskLevel: entitlement.risk,
          sodPreCheck: forge.chance(EVENT_RATES.accessSodPreCheckConflict) ? 'conflict' : 'clear',
          channel,
        },
      });
    }
    case 'access.approve': {
      const approver = requireApprover(gctx, kind);
      const beneficiary = requireActiveHuman(gctx, kind);
      return assembleEvent(gctx, forge, {
        kind, actor: { kind: 'employee', ...toIdentityRef(approver) }, subject: toIdentityRef(beneficiary),
        location: approver.location, division: approver.division, correlationId, causationId,
        payload: {
          requestId: forge.id('req'),
          approverId: approver.id,
          approvalLevel: forge.int(1, 3),
          slaMs: forge.int(60_000, 172_800_000),
          ...(forge.chance(0.4) ? { comment: 'Approved per role requirements' } : {}),
        },
      });
    }
    case 'access.deny': {
      const approver = requireApprover(gctx, kind);
      const beneficiary = requireActiveHuman(gctx, kind);
      return assembleEvent(gctx, forge, {
        kind, actor: { kind: 'employee', ...toIdentityRef(approver) }, subject: toIdentityRef(beneficiary),
        location: approver.location, division: approver.division, correlationId, causationId,
        payload: {
          requestId: forge.id('req'),
          approverId: approver.id,
          reason: forge.weighted([
            { weight: 40, value: 'sod_conflict' },
            { weight: 30, value: 'insufficient_justification' },
            { weight: 20, value: 'policy' },
            { weight: 10, value: 'risk' },
          ]),
        },
      });
    }
    case 'access.provision': {
      const subject = requireActiveHuman(gctx, kind);
      return assembleProvision(gctx, forge, { subject: toIdentityRef(subject), entitlement: mintRef(forge, gctx, profileOf(subject)), correlationId, causationId });
    }
    case 'access.revoke': {
      const subject = requireActiveHuman(gctx, kind);
      const held = subject.entitlements.length > 0 ? forge.pick(subject.entitlements) : null;
      const entitlement = held ? toEntitlementRef(held) : mintRef(forge, gctx, profileOf(subject));
      return assembleRevoke(gctx, forge, {
        subject: toIdentityRef(subject), entitlement, correlationId, causationId,
        reason: forge.weighted([
          { weight: 30, value: 'manual' }, { weight: 25, value: 'recert_fail' }, { weight: 20, value: 'sod' },
          { weight: 15, value: 'mover' }, { weight: 10, value: 'expiry' },
        ]),
      });
    }
    case 'recertification': {
      const reviewer = requireApprover(gctx, kind);
      const reviewed = requireActiveHuman(gctx, kind);
      const held = reviewed.entitlements.length > 0 ? forge.pick(reviewed.entitlements) : null;
      return assembleEvent(gctx, forge, {
        kind, actor: systemActor('recert-campaign'), subject: toIdentityRef(reviewed),
        location: reviewed.location, division: reviewed.division, correlationId, causationId,
        payload: {
          campaignId: `RECERT-${forge.int(2026, 2027)}-Q${forge.int(1, 4)}`,
          decision: forge.chance(EVENT_RATES.recertRevoke) ? 'revoke' : forge.weighted([{ weight: 85, value: 'certify' }, { weight: 15, value: 'delegate' }]),
          reviewerId: reviewer.id,
          itemCount: forge.int(1, 250),
          ...(held ? { entitlement: toEntitlementRef(held) } : {}),
        },
      });
    }
    case 'firefighter.grant': {
      const grantee = requireActiveHuman(gctx, kind);
      const approver = requireApprover(gctx, kind);
      const ff = forge.pick(FIREFIGHTER_ROLES);
      return assembleEvent(gctx, forge, {
        kind, actor: { kind: 'employee', ...toIdentityRef(grantee) },
        location: grantee.location, division: grantee.division, correlationId, causationId,
        payload: {
          role: ff.role, system: ff.system,
          reason: `Incident response for ${ff.system} outage`,
          ticketId: `INC${forge.int(1_000_000, 9_999_999)}`,
          expiresAt: new Date(gctx.clock.now() + forge.int(1, 8) * 3_600_000).toISOString(),
          approverId: approver.id,
        },
      });
    }
    case 'firefighter.revoke': {
      const grantee = requireActiveHuman(gctx, kind);
      const ff = forge.pick(FIREFIGHTER_ROLES);
      return assembleEvent(gctx, forge, {
        kind, actor: { kind: 'employee', ...toIdentityRef(grantee) },
        location: grantee.location, division: grantee.division, correlationId, causationId,
        payload: { role: ff.role, system: ff.system, sessionDurationSec: forge.int(300, 28_800), actionsLogged: forge.int(1, 400) },
      });
    }
    case 'sod.violation':
      return buildSodViolation(kind, gctx, forge, correlationId, causationId);
    case 'orphan.detected': {
      const context = requireActiveHuman(gctx, kind);
      const lastOwner = gctx.pool.pick((e) => e.status === 'terminated' || e.status === 'disabled');
      const system = forge.pick(PROVISIONING_TARGETS);
      const ageDays = forge.int(30, 900);
      return assembleEvent(gctx, forge, {
        kind, actor: systemActor('access-scanner'), subject: lastOwner ? toIdentityRef(lastOwner) : undefined,
        location: context.location, division: context.division, correlationId, causationId,
        payload: {
          accountId: `${system}\\${forge.faker.internet.username().toLowerCase()}`,
          system,
          ...(lastOwner ? { lastOwnerId: lastOwner.id } : {}),
          lastActivityAt: new Date(gctx.clock.now() - ageDays * 86_400_000).toISOString(),
          ageDays,
        },
      });
    }
    case 'dormant.detected': {
      const dormant = gctx.pool.pick((e) => e.status === 'dormant') ?? requireActiveHuman(gctx, kind);
      const system = forge.pick(PROVISIONING_TARGETS);
      const dormantDays = forge.int(90, 720);
      return assembleEvent(gctx, forge, {
        kind, actor: systemActor('access-scanner'), subject: toIdentityRef(dormant),
        location: dormant.location, division: dormant.division, correlationId, causationId,
        payload: {
          accountId: `${system}\\${dormant.username}`,
          system,
          dormantDays,
          lastLoginAt: new Date(gctx.clock.now() - dormantDays * 86_400_000).toISOString(),
        },
      });
    }
    default:
      return assertNever(kind);
  }
}

/** Build an SoD violation, preferring a genuinely conflicted identity from the pool. */
function buildSodViolation(
  kind: 'sod.violation',
  gctx: GenerationContext,
  forge: Forge,
  correlationId: string,
  causationId: string | undefined,
): WorkdayEvent {
  const conflicted = gctx.pool.pick((e) => !e.isNonHuman && gctx.pool.sodConflicts(e.id).length > 0);
  let subject: Employee;
  let ruleId: string;
  let ruleName: string;
  let severity: RiskLevel;
  let refs: [EntitlementRef, EntitlementRef];

  if (conflicted) {
    const detailed = detectSodConflictsDetailed(conflicted.entitlements)[0];
    subject = conflicted;
    if (detailed) {
      ruleId = detailed.rule.id; ruleName = detailed.rule.name; severity = detailed.rule.severity;
      refs = [toEntitlementRef(detailed.pair[0]), toEntitlementRef(detailed.pair[1])];
    } else {
      const rule = forge.pick(SOD_RULES);
      ruleId = rule.id; ruleName = rule.name; severity = rule.severity;
      refs = synthesizeConflict(forge, gctx, profileOf(conflicted));
    }
  } else {
    subject = requireActiveHuman(gctx, kind);
    const detected = detectFromToxicPair(forge, gctx, profileOf(subject));
    ruleId = detected.ruleId; ruleName = detected.ruleName; severity = detected.severity; refs = detected.refs;
  }

  const mitigation = forge.chance(EVENT_RATES.sodBlocked)
    ? 'blocked'
    : forge.chance(EVENT_RATES.sodException / (1 - EVENT_RATES.sodBlocked))
      ? 'exception_granted'
      : 'flagged';
  return assembleEvent(gctx, forge, {
    kind, actor: systemActor('sod-engine'), subject: toIdentityRef(subject),
    location: subject.location, division: subject.division, correlationId, causationId,
    severity: severity === 'critical' ? 'critical' : 'warning',
    payload: {
      ruleId, ruleName, conflictingEntitlements: refs, severity, mitigation,
      ...(mitigation === 'exception_granted' ? { exceptionApprover: `DB${forge.int(100_000, 999_999)}` } : {}),
    },
  });
}

/** Mint both halves of a random toxic pair and return their references. */
function synthesizeConflict(forge: Forge, gctx: GenerationContext, profile: EntitlementProfile): [EntitlementRef, EntitlementRef] {
  const pair = forge.pick(TOXIC_PAIRS);
  const a = mintEntitlement(forge.faker, pair[0], profile, { grantedAtMs: gctx.clock.now() });
  const b = mintEntitlement(forge.faker, pair[1], profile, { grantedAtMs: gctx.clock.now() });
  return [toEntitlementRef(a), toEntitlementRef(b)];
}

/** Mint a toxic pair and resolve the exact rule it violates via the detector. */
function detectFromToxicPair(
  forge: Forge,
  gctx: GenerationContext,
  profile: EntitlementProfile,
): { ruleId: string; ruleName: string; severity: RiskLevel; refs: [EntitlementRef, EntitlementRef] } {
  const pair = forge.pick(TOXIC_PAIRS);
  const a = mintEntitlement(forge.faker, pair[0], profile, { grantedAtMs: gctx.clock.now() });
  const b = mintEntitlement(forge.faker, pair[1], profile, { grantedAtMs: gctx.clock.now() });
  const detailed = detectSodConflictsDetailed([a, b])[0];
  const rule = detailed?.rule ?? SOD_RULES[0];
  if (!rule) {
    throw new Error('no SoD rules are defined');
  }
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    severity: rule.severity,
    refs: [toEntitlementRef(a), toEntitlementRef(b)],
  };
}

/**
 * Follow-on events for an ACCESS primary. A request runs a four-eyes decision and, if
 * approved, an automated provision. A recertification decided as revoke deprovisions
 * the reviewed grant. A firefighter grant closes with a revoke when the emergency
 * session ends.
 *
 * @param primary The just-generated ACCESS event.
 * @param gctx The generation context.
 * @param forge The seeded RNG facade.
 * @returns Ordered follow-on events (possibly empty).
 */
export function accessSaga(primary: WorkdayEvent, gctx: GenerationContext, forge: Forge): WorkdayEvent[] {
  const followOns: WorkdayEvent[] = [];
  const correlationId = primary.correlationId;

  if (primary.kind === 'access.request') {
    const { requestId, entitlement, forSubjectId } = primary.payload;
    const beneficiary = gctx.pool.ref(forSubjectId) ?? refFromActor(primary.actor) ?? primary.subject;
    const approver = gctx.pool.pick((e) => !e.isNonHuman && e.status === 'active' && GRADE_SENIORITY[e.grade] >= GRADE_SENIORITY.VP);
    if (!approver || !beneficiary) {
      return followOns;
    }
    const denied = primary.payload.sodPreCheck === 'conflict' ? forge.chance(0.7) : forge.chance(EVENT_RATES.accessDeny);
    if (denied) {
      followOns.push(
        assembleEvent(gctx, forge, {
          kind: 'access.deny', actor: { kind: 'employee', ...toIdentityRef(approver) }, subject: beneficiary,
          location: approver.location, division: approver.division, correlationId, causationId: primary.id,
          payload: { requestId, approverId: approver.id, reason: primary.payload.sodPreCheck === 'conflict' ? 'sod_conflict' : 'policy' },
        }),
      );
      return followOns;
    }
    const approve = assembleEvent(gctx, forge, {
      kind: 'access.approve', actor: { kind: 'employee', ...toIdentityRef(approver) }, subject: beneficiary,
      location: approver.location, division: approver.division, correlationId, causationId: primary.id,
      payload: { requestId, approverId: approver.id, approvalLevel: entitlement.risk === 'critical' ? 2 : 1, slaMs: forge.int(60_000, 86_400_000) },
    });
    followOns.push(approve);
    if (forge.chance(EVENT_RATES.accessProvisionAfterApprove)) {
      followOns.push(assembleProvision(gctx, forge, { subject: beneficiary, entitlement, correlationId, causationId: approve.id, requestId }));
    }
    return followOns;
  }

  if (primary.kind === 'recertification' && primary.payload.decision === 'revoke' && primary.payload.entitlement && primary.subject) {
    followOns.push(
      assembleRevoke(gctx, forge, { subject: primary.subject, entitlement: primary.payload.entitlement, reason: 'recert_fail', correlationId, causationId: primary.id }),
    );
    return followOns;
  }

  if (primary.kind === 'firefighter.grant' && forge.chance(0.6)) {
    const grantee = refFromActor(primary.actor);
    if (grantee) {
      followOns.push(
        assembleEvent(gctx, forge, {
          kind: 'firefighter.revoke', actor: primary.actor,
          location: primary.location, division: primary.division, correlationId, causationId: primary.id,
          payload: { role: primary.payload.role, system: primary.payload.system, sessionDurationSec: forge.int(600, 14_400), actionsLogged: forge.int(1, 200) },
        }),
      );
    }
  }

  return followOns;
}
