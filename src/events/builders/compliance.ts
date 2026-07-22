/**
 * COMPLIANCE event builders: GDPR/DPDPA data-subject requests, regulator audit pulls,
 * non-human-identity (NHI/service-account) activity, emergency break-glass access, and
 * the two identity-hygiene edge cases (duplicate identity, name collision).
 *
 * These are the low-volume, high-signal events an identity manager must handle
 * gracefully: a service account acting anomalously, a break-glass session on a shared
 * privileged account, a data-subject erasure with a regulatory clock, an identity
 * matcher flagging a probable duplicate. NHI activity draws a real machine identity
 * from the pool; the edge cases prefer identities the pool deliberately seeded with a
 * collision so the events describe a genuine condition.
 */

import type { GenerationContext } from '../../contracts/index.js';
import type { Employee, NhiActivityPayload, WorkdayEvent } from '../../types/index.js';
import { EVENT_KINDS_BY_CATEGORY, GRADE_SENIORITY } from '../../types/index.js';
import {
  assembleEvent,
  assertNever,
  chaosActive,
  type Forge,
  primaryCorrelationId,
  requireActiveHuman,
  requireMatch,
  systemActor,
  toIdentityRef,
} from '../internal.js';
import { EVENT_RATES } from '../rates.js';

/** The COMPLIANCE event kinds, derived from the frozen category map. */
type ComplianceKind = (typeof EVENT_KINDS_BY_CATEGORY.COMPLIANCE)[number];

const NHI_ACTIONS = [
  'token refresh', 'batch reconciliation', 'secure file transfer', 'downstream API call',
  'certificate rotation', 'database replication', 'message queue publish', 'scheduled report run',
] as const;

const NHI_TARGETS = ['SAP', 'SWIFT-Alliance', 'Murex', 'ActiveDirectory', 'APIGateway', 'DataLake', 'PaymentHub'] as const;

const BREAKGLASS_SYSTEMS = ['SAP Production', 'SWIFT-Alliance', 'CyberArk Vault', 'Core Banking', 'ActiveDirectory'] as const;

/** ISO timestamp a number of hours after the current simulated instant. */
function isoAfterHours(gctx: GenerationContext, hours: number): string {
  return new Date(gctx.clock.now() + hours * 3_600_000).toISOString();
}

/** Date-only rendering a number of days after the current simulated instant. */
function dateAfterDays(gctx: GenerationContext, days: number): string {
  return new Date(gctx.clock.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function buildNhiPayload(forge: Forge, gctx: GenerationContext, service: Employee): NhiActivityPayload {
  const tokenType = forge.weighted<NhiActivityPayload['tokenType']>([
    { weight: 40, value: 'oauth' }, { weight: 30, value: 'api_key' }, { weight: 20, value: 'certificate' }, { weight: 10, value: 'kerberos' },
  ]);
  const anomalous = chaosActive(gctx, 'ransomware_lateral') ? forge.chance(0.6) : forge.chance(EVENT_RATES.nhiAnomalous);
  const payload: NhiActivityPayload = {
    serviceAccountId: service.employeeId,
    action: forge.pick(NHI_ACTIONS),
    targetSystem: forge.pick(NHI_TARGETS),
    tokenType,
    anomalous,
  };
  if (tokenType !== 'kerberos') {
    payload.secretRotatedAt = isoAfterHours(gctx, -forge.int(24, 2160));
  }
  return payload;
}

/**
 * Build a primary COMPLIANCE event.
 *
 * @param kind The COMPLIANCE kind to build.
 * @param gctx The generation context.
 * @param forge The seeded RNG facade.
 * @returns The assembled event.
 */
export function generateCompliance(kind: ComplianceKind, gctx: GenerationContext, forge: Forge): WorkdayEvent {
  const correlationId = primaryCorrelationId(gctx, forge);
  const causationId = gctx.causationId;

  switch (kind) {
    case 'gdpr.request': {
      const subject = requireActiveHuman(gctx, kind);
      const isIndia = subject.location === 'BLR' || subject.location === 'PNQ';
      return assembleEvent(gctx, forge, {
        kind, actor: systemActor('privacy-portal'), subject: toIdentityRef(subject), location: subject.location, division: subject.division, correlationId, causationId,
        payload: {
          requestType: forge.weighted([
            { weight: 45, value: 'access' }, { weight: 25, value: 'erasure' }, { weight: 20, value: 'rectification' }, { weight: 10, value: 'portability' },
          ]),
          dataSubjectId: subject.id,
          regulation: isIndia ? (forge.chance(0.8) ? 'DPDPA' : 'GDPR') : 'GDPR',
          dueDate: dateAfterDays(gctx, 30),
        },
      });
    }
    case 'audit.pull': {
      const auditor = gctx.pool.pick((e) => !e.isNonHuman && e.status === 'active' && (e.division === 'Compliance' || e.division === 'Finance')) ?? requireActiveHuman(gctx, kind);
      const withRegulator = chaosActive(gctx, 'audit_season_surge') || forge.chance(0.4);
      return assembleEvent(gctx, forge, {
        kind, actor: systemActor('audit-service'), subject: toIdentityRef(auditor), location: auditor.location, division: auditor.division, correlationId, causationId,
        payload: {
          auditId: `AUD-${forge.int(2026, 2027)}-${forge.int(1000, 9999)}`,
          scope: forge.pick(['access recertification', 'privileged access review', 'SoD control testing', 'payment controls', 'joiner-leaver reconciliation']),
          requestedBy: auditor.employeeId,
          recordCount: forge.int(50, 500_000),
          ...(withRegulator ? { regulator: forge.pick(['BaFin', 'ECB', 'FCA', 'MAS', 'HKMA', 'RBI', 'FED'] as const) } : {}),
        },
      });
    }
    case 'nhi.activity': {
      const service = requireMatch(gctx, kind, (e) => e.isNonHuman && e.status === 'active', 'no active service identity');
      const payload = buildNhiPayload(forge, gctx, service);
      return assembleEvent(gctx, forge, {
        kind, actor: { kind: 'service', ...toIdentityRef(service) }, location: service.location, division: service.division, correlationId, causationId,
        severity: payload.anomalous ? 'warning' : 'info',
        payload,
      });
    }
    case 'breakglass': {
      const invoker = requireMatch(gctx, kind, (e) => !e.isNonHuman && e.status === 'active' && GRADE_SENIORITY[e.grade] >= GRADE_SENIORITY.AVP, 'no senior human to invoke break-glass');
      return assembleEvent(gctx, forge, {
        kind, actor: { kind: 'employee', ...toIdentityRef(invoker) }, location: invoker.location, division: invoker.division, correlationId, causationId,
        payload: {
          accountId: `bg-admin-${forge.faker.string.alphanumeric(4).toLowerCase()}`,
          system: forge.pick(BREAKGLASS_SYSTEMS),
          reason: forge.pick(['P1 production incident', 'payment cutoff recovery', 'security incident response', 'disaster recovery drill']),
          approverId: `DB${forge.int(100_000, 999_999)}`,
          incidentId: `INC${forge.int(1_000_000, 9_999_999)}`,
          expiresAt: isoAfterHours(gctx, forge.int(1, 4)),
          sessionRecorded: forge.chance(0.95),
        },
      });
    }
    case 'duplicate.identity': {
      const primary = requireActiveHuman(gctx, kind);
      const other = gctx.pool.pick((e) => e.id !== primary.id && !e.isNonHuman);
      const candidateIds = other ? [primary.id, other.id] : [primary.id];
      const sameName = other?.displayName === primary.displayName;
      return assembleEvent(gctx, forge, {
        kind, actor: systemActor('identity-matching'), subject: toIdentityRef(primary), location: primary.location, division: primary.division, correlationId, causationId,
        payload: {
          candidateIds,
          matchScore: Math.round(forge.float(sameName ? 0.85 : 0.7, 0.99) * 100) / 100,
          matchedAttributes: sameName ? ['displayName', 'dateOfBirth', 'nationalId'] : ['email', 'phone'],
          resolution: forge.weighted([{ weight: 50, value: 'flag' }, { weight: 30, value: 'merge' }, { weight: 20, value: 'ignore' }]),
        },
      });
    }
    case 'namecollision': {
      const colliding = gctx.pool.pick((e) => typeof e.attributes.edgeCase === 'string' && e.attributes.edgeCase.includes('collision')) ?? requireActiveHuman(gctx, kind);
      const other = gctx.pool.pick((e) => e.id !== colliding.id);
      const attribute = forge.weighted<'email' | 'username' | 'displayName'>([
        { weight: 55, value: 'email' }, { weight: 35, value: 'username' }, { weight: 10, value: 'displayName' },
      ]);
      const strategy = forge.weighted<'numeric_suffix' | 'middle_initial' | 'location_suffix'>([
        { weight: 60, value: 'numeric_suffix' }, { weight: 25, value: 'middle_initial' }, { weight: 15, value: 'location_suffix' },
      ]);
      return assembleEvent(gctx, forge, {
        kind, actor: systemActor('provisioning-engine'), subject: toIdentityRef(colliding), location: colliding.location, division: colliding.division, correlationId, causationId,
        payload: {
          collidingWith: other ? [other.id] : [],
          attribute,
          generatedSuffix: strategy === 'numeric_suffix' ? String(forge.int(2, 9)) : strategy === 'location_suffix' ? colliding.location.toLowerCase() : forge.faker.string.alpha({ length: 1, casing: 'lower' }),
          resolutionStrategy: strategy,
        },
      });
    }
    default:
      return assertNever(kind);
  }
}

/**
 * Follow-on events for a COMPLIANCE primary. A data-subject access or erasure request
 * triggers a record retrieval (audit pull) to fulfil it. Other compliance events are
 * standalone.
 *
 * @param primary The just-generated COMPLIANCE event.
 * @param gctx The generation context.
 * @param forge The seeded RNG facade.
 * @returns Ordered follow-on events (possibly empty).
 */
export function complianceSaga(primary: WorkdayEvent, gctx: GenerationContext, forge: Forge): WorkdayEvent[] {
  if (
    primary.kind === 'gdpr.request' &&
    (primary.payload.requestType === 'access' || primary.payload.requestType === 'erasure' || primary.payload.requestType === 'portability') &&
    primary.subject
  ) {
    return [
      assembleEvent(gctx, forge, {
        kind: 'audit.pull', actor: systemActor('privacy-portal'), subject: primary.subject,
        location: primary.location, division: primary.division, correlationId: primary.correlationId, causationId: primary.id,
        payload: {
          auditId: `DSAR-${forge.int(100_000, 999_999)}`,
          scope: `data subject retrieval for ${primary.payload.dataSubjectId}`,
          requestedBy: 'privacy-portal',
          recordCount: forge.int(10, 5000),
        },
      }),
    ];
  }
  return [];
}
