/**
 * AUTH event builders: logins, MFA, sessions, SSO, step-up and impossible travel.
 *
 * These are the highest-volume events in a bank day and the ones whose failure rates
 * matter most to an identity manager's risk signals. Payloads are internally
 * consistent (a session end has a plausible duration, an impossible-travel speed is
 * computed from the two coordinates and the interval) and shift under an active
 * credential-stuffing or ransomware injector toward hostile IPs, remote geographies
 * and higher risk scores.
 */

import type { GenerationContext } from '../../contracts/index.js';
import type {
  Employee,
  LoginFailurePayload,
  LoginSuccessPayload,
  MfaChallengePayload,
  WorkdayEvent,
} from '../../types/index.js';
import type { AuthKind } from '../kinds.js';
import { distanceKm, geoForLocation, impliedSpeedKmh, REMOTE_GEOS } from '../geo.js';
import {
  assembleEvent,
  assertNever,
  chaosActive,
  type Forge,
  primaryCorrelationId,
  refFromActor,
  requireActiveHuman,
  systemActor,
  toIdentityRef,
} from '../internal.js';
import { EVENT_RATES } from '../rates.js';

/** Threshold of failed attempts at which a streak locks the account. */
const LOCKOUT_THRESHOLD = 5;

const DB_APPS = [
  'db-workspace',
  'murex-web',
  'db-mail',
  'avaloq-portal',
  'db-trader',
  'sap-fiori',
  'db-mobile',
  'servicenow',
] as const;

const STEPUP_RESOURCES = [
  'SWIFT wire release',
  'CyberArk privileged vault',
  'SAP payment run',
  'Murex trade blotter',
  'admin console',
] as const;

/** True when an injector is driving hostile authentication traffic. */
function underAuthAttack(gctx: GenerationContext): boolean {
  return chaosActive(gctx, 'credential_stuffing') || chaosActive(gctx, 'ransomware_lateral');
}

function pickMethod(forge: Forge): LoginSuccessPayload['method'] {
  return forge.weighted([
    { weight: 55, value: 'password' },
    { weight: 30, value: 'sso' },
    { weight: 13, value: 'passkey' },
    { weight: 7, value: 'certificate' },
  ]);
}

function pickFactor(forge: Forge): MfaChallengePayload['factor'] {
  return forge.weighted([
    { weight: 40, value: 'push' },
    { weight: 35, value: 'totp' },
    { weight: 12, value: 'webauthn' },
    { weight: 8, value: 'sms' },
    { weight: 5, value: 'hardware_token' },
  ]);
}

/** MFA verification latency by factor: push and SMS are slow, TOTP/WebAuthn fast. */
function mfaLatency(forge: Forge, factor: MfaChallengePayload['factor']): number {
  switch (factor) {
    case 'push':
      return forge.int(2000, 8000);
    case 'sms':
      return forge.int(3000, 10_000);
    case 'hardware_token':
      return forge.int(1000, 4000);
    case 'totp':
    case 'webauthn':
      return forge.int(400, 3000);
    default:
      return forge.int(500, 4000);
  }
}

function buildLoginSuccessPayload(forge: Forge, gctx: GenerationContext, employee: Employee): LoginSuccessPayload {
  const attack = underAuthAttack(gctx);
  const geo = attack && forge.chance(0.5) ? forge.pick(REMOTE_GEOS) : geoForLocation(employee.location);
  return {
    ip: forge.faker.internet.ipv4(),
    userAgent: forge.faker.internet.userAgent(),
    method: pickMethod(forge),
    geo,
    deviceId: forge.id('dev'),
    sessionId: forge.id('sess'),
    riskScore: attack ? forge.int(60, 100) : forge.int(0, 35),
  };
}

function buildLoginFailurePayload(forge: Forge, gctx: GenerationContext, employee: Employee): LoginFailurePayload {
  const attack = underAuthAttack(gctx);
  const geo = attack && forge.chance(0.6) ? forge.pick(REMOTE_GEOS) : geoForLocation(employee.location);
  return {
    ip: forge.faker.internet.ipv4(),
    userAgent: forge.faker.internet.userAgent(),
    reason: forge.weighted([
      { weight: 60, value: 'bad_password' },
      { weight: 12, value: 'unknown_user' },
      { weight: 10, value: 'mfa_required' },
      { weight: 8, value: 'expired' },
      { weight: 5, value: 'disabled' },
      { weight: 5, value: 'locked' },
    ]),
    attemptCount: attack ? forge.int(3, 15) : forge.weighted([
      { weight: 70, value: 1 },
      { weight: 20, value: 2 },
      { weight: 10, value: 3 },
    ]),
    geo,
  };
}

/**
 * Build a primary AUTH event of the given kind. Human-actor kinds draw an active
 * identity weighted by where people are at work; the two detector kinds (lockout,
 * impossible travel) are raised by the platform against a human subject, from whom the
 * event's location and division are sourced.
 *
 * @param kind The AUTH kind to build.
 * @param gctx The generation context.
 * @param forge The seeded RNG facade.
 * @returns The assembled event.
 */
export function generateAuth(kind: AuthKind, gctx: GenerationContext, forge: Forge): WorkdayEvent {
  const correlationId = primaryCorrelationId(gctx, forge);
  const causationId = gctx.causationId;
  const human = requireActiveHuman(gctx, kind);
  const actor = { kind: 'employee' as const, ...toIdentityRef(human) };
  const loc = { location: human.location, division: human.division };

  switch (kind) {
    case 'login.success':
      return assembleEvent(gctx, forge, {
        kind, actor, ...loc, correlationId, causationId,
        payload: buildLoginSuccessPayload(forge, gctx, human),
      });
    case 'login.failure':
      return assembleEvent(gctx, forge, {
        kind, actor, ...loc, correlationId, causationId,
        payload: buildLoginFailurePayload(forge, gctx, human),
      });
    case 'mfa.challenge':
      return assembleEvent(gctx, forge, {
        kind, actor, ...loc, correlationId, causationId,
        payload: {
          sessionId: forge.id('sess'),
          factor: pickFactor(forge),
          reason: forge.weighted([
            { weight: 55, value: 'login' },
            { weight: 20, value: 'new_device' },
            { weight: 15, value: 'stepup' },
            { weight: 10, value: 'high_risk' },
          ]),
        },
      });
    case 'mfa.success': {
      const factor = pickFactor(forge);
      return assembleEvent(gctx, forge, {
        kind, actor, ...loc, correlationId, causationId,
        payload: { sessionId: forge.id('sess'), factor, latencyMs: mfaLatency(forge, factor) },
      });
    }
    case 'mfa.failure': {
      const factor = pickFactor(forge);
      return assembleEvent(gctx, forge, {
        kind, actor, ...loc, correlationId, causationId,
        payload: {
          sessionId: forge.id('sess'),
          factor,
          reason: forge.weighted([
            { weight: 40, value: 'timeout' },
            { weight: 30, value: 'wrong_code' },
            { weight: 20, value: 'rejected' },
            { weight: 10, value: 'exhausted' },
          ]),
          attemptCount: forge.int(1, 5),
        },
      });
    }
    case 'password.reset': {
      const channel = forge.weighted([
        { weight: 55, value: 'self_service' as const },
        { weight: 30, value: 'forced' as const },
        { weight: 15, value: 'helpdesk' as const },
      ]);
      return assembleEvent(gctx, forge, {
        kind, actor, ...loc, correlationId, causationId,
        payload: {
          channel,
          reason: forge.weighted([
            { weight: 50, value: 'forgotten' },
            { weight: 25, value: 'expired' },
            { weight: 15, value: 'policy' },
            { weight: 10, value: 'compromise' },
          ]),
          ...(channel === 'helpdesk' ? { ticketId: `INC${forge.int(1_000_000, 9_999_999)}` } : {}),
        },
      });
    }
    case 'account.lockout': {
      const reason = forge.weighted([
        { weight: 70, value: 'failed_attempts' as const },
        { weight: 15, value: 'risk' as const },
        { weight: 10, value: 'impossible_travel' as const },
        { weight: 5, value: 'admin' as const },
      ]);
      return assembleEvent(gctx, forge, {
        kind, actor: systemActor('auth-service'), subject: toIdentityRef(human), ...loc, correlationId, causationId,
        payload: {
          reason,
          failedAttempts: forge.int(LOCKOUT_THRESHOLD, 12),
          ...(reason === 'admin' ? {} : { unlockAt: isoAfterMinutes(gctx, forge.int(15, 60)) }),
        },
      });
    }
    case 'session.start':
      return assembleEvent(gctx, forge, {
        kind, actor, ...loc, correlationId, causationId,
        payload: { sessionId: forge.id('sess'), ip: forge.faker.internet.ipv4(), deviceId: forge.id('dev'), appId: forge.pick(DB_APPS) },
      });
    case 'session.end':
      return assembleEvent(gctx, forge, {
        kind, actor, ...loc, correlationId, causationId,
        payload: {
          sessionId: forge.id('sess'),
          durationSec: forge.int(60, 36_000),
          reason: forge.weighted([
            { weight: 60, value: 'logout' },
            { weight: 25, value: 'timeout' },
            { weight: 10, value: 'expired' },
            { weight: 5, value: 'revoked' },
          ]),
        },
      });
    case 'sso.federation':
      return assembleEvent(gctx, forge, {
        kind, actor, ...loc, correlationId, causationId,
        payload: {
          idp: forge.weighted([
            { weight: 60, value: 'AzureAD' },
            { weight: 20, value: 'PingFederate' },
            { weight: 10, value: 'ADFS' },
            { weight: 10, value: 'Okta' },
          ]),
          protocol: forge.weighted([{ weight: 65, value: 'SAML' }, { weight: 35, value: 'OIDC' }]),
          spEntityId: `https://${forge.pick(DB_APPS)}.db.com/saml`,
          assertionId: forge.id('assert'),
        },
      });
    case 'stepup':
      return assembleEvent(gctx, forge, {
        kind, actor, ...loc, correlationId, causationId,
        payload: {
          sessionId: forge.id('sess'),
          resource: forge.pick(STEPUP_RESOURCES),
          reason: forge.weighted([
            { weight: 45, value: 'high_value_txn' },
            { weight: 35, value: 'privileged_access' },
            { weight: 20, value: 'policy' },
          ]),
          satisfied: forge.chance(EVENT_RATES.stepUpSatisfied),
        },
      });
    case 'impossible.travel': {
      const fromGeo = geoForLocation(human.location);
      const toGeo = forge.pick(REMOTE_GEOS);
      const km = distanceKm(fromGeo, toGeo);
      const deltaMinutes = forge.int(20, 180);
      return assembleEvent(gctx, forge, {
        kind, actor: systemActor('geo-velocity-monitor'), subject: toIdentityRef(human), ...loc, correlationId, causationId,
        payload: {
          fromGeo,
          toGeo,
          distanceKm: km,
          deltaMinutes,
          impliedSpeedKmh: impliedSpeedKmh(km, deltaMinutes),
          priorIp: forge.faker.internet.ipv4(),
          currentIp: forge.faker.internet.ipv4(),
        },
      });
    }
    default:
      return assertNever(kind);
  }
}

/** ISO timestamp `minutes` after the current simulated instant. */
function isoAfterMinutes(gctx: GenerationContext, minutes: number): string {
  return new Date(gctx.clock.now() + minutes * 60_000).toISOString();
}

/**
 * Follow-on events for an AUTH primary. A successful login may prompt an MFA challenge
 * and open a session; a failed-login streak or an impossible-travel detection locks
 * the account. Each follow-on inherits the primary's correlation and chains its
 * causation to the event that directly triggered it.
 *
 * @param primary The just-generated AUTH event.
 * @param gctx The generation context.
 * @param forge The seeded RNG facade.
 * @returns Ordered follow-on events (possibly empty).
 */
export function authSaga(primary: WorkdayEvent, gctx: GenerationContext, forge: Forge): WorkdayEvent[] {
  const followOns: WorkdayEvent[] = [];
  const correlationId = primary.correlationId;
  const loc = { location: primary.location, division: primary.division };
  let lastId = primary.id;

  if (primary.kind === 'login.success') {
    const sessionId = primary.payload.sessionId;
    let mfaFailed = false;
    if (forge.chance(EVENT_RATES.loginTriggersMfa)) {
      const factor = pickFactor(forge);
      const challenge = assembleEvent(gctx, forge, {
        kind: 'mfa.challenge', actor: primary.actor, ...loc, correlationId, causationId: lastId,
        payload: { sessionId, factor, reason: 'login' },
      });
      followOns.push(challenge);
      lastId = challenge.id;
      mfaFailed = forge.chance(EVENT_RATES.mfaFailure);
      const verify = mfaFailed
        ? assembleEvent(gctx, forge, {
            kind: 'mfa.failure', actor: primary.actor, ...loc, correlationId, causationId: lastId,
            payload: { sessionId, factor, reason: 'timeout', attemptCount: forge.int(1, 3) },
          })
        : assembleEvent(gctx, forge, {
            kind: 'mfa.success', actor: primary.actor, ...loc, correlationId, causationId: lastId,
            payload: { sessionId, factor, latencyMs: mfaLatency(forge, factor) },
          });
      followOns.push(verify);
      lastId = verify.id;
    }
    if (!mfaFailed && forge.chance(EVENT_RATES.loginOpensSession)) {
      const ipForSession = primary.payload.ip;
      followOns.push(
        assembleEvent(gctx, forge, {
          kind: 'session.start', actor: primary.actor, ...loc, correlationId, causationId: lastId,
          payload: { sessionId, ip: ipForSession, deviceId: primary.payload.deviceId, appId: forge.pick(DB_APPS) },
        }),
      );
    }
    return followOns;
  }

  if (primary.kind === 'login.failure') {
    const attempts = primary.payload.attemptCount;
    if (attempts >= LOCKOUT_THRESHOLD || forge.chance(EVENT_RATES.lockoutOnFailure)) {
      const subject = refFromActor(primary.actor);
      followOns.push(
        assembleEvent(gctx, forge, {
          kind: 'account.lockout', actor: systemActor('auth-service'), subject, ...loc, correlationId, causationId: lastId,
          payload: { reason: 'failed_attempts', failedAttempts: Math.max(attempts, LOCKOUT_THRESHOLD), unlockAt: isoAfterMinutes(gctx, forge.int(15, 60)) },
        }),
      );
    }
    return followOns;
  }

  if (primary.kind === 'impossible.travel' && forge.chance(EVENT_RATES.impossibleTravelLockout)) {
    followOns.push(
      assembleEvent(gctx, forge, {
        kind: 'account.lockout', actor: systemActor('auth-service'), subject: primary.subject, ...loc, correlationId, causationId: lastId,
        payload: { reason: 'impossible_travel', failedAttempts: 0, unlockAt: isoAfterMinutes(gctx, forge.int(30, 120)) },
      }),
    );
  }

  return followOns;
}
