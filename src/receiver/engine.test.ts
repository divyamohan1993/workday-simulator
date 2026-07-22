import { describe, expect, it } from 'vitest';
import type { Logger } from 'pino';
import type { EventOfKind, IdentityRef, WorkdayEvent } from '../types/index.js';
import { createReceiverEngine } from './engine.js';

const logger = {
  info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {},
  child() { return logger; },
  level: 'info',
} as unknown as Logger;

const subject: IdentityRef = {
  id: 'usr_1',
  employeeId: 'DB00100000',
  displayName: 'Grace Hopper',
  email: 'grace.hopper@db.com',
  division: 'Corporate Bank',
  location: 'FFT',
  grade: 'VP',
  type: 'FTE',
};

function grantEvent(
  entId: string,
  name: string,
  key: string,
  requiresApproval = false,
): WorkdayEvent {
  const event: EventOfKind<'access.provision'> = {
    id: `evt_${entId}`,
    kind: 'access.provision',
    category: 'ACCESS',
    timestamp: '2026-07-22T09:00:00.000Z',
    emittedAtWall: '2026-07-22T09:00:00.050Z',
    correlationId: 'corr',
    severity: 'notice',
    actor: { kind: 'system', id: 'sys', component: 'provisioning' },
    subject,
    location: 'FFT',
    division: 'Corporate Bank',
    delivery: { operation: 'grant', resource: 'entitlement', idempotencyKey: key, priority: 'high', requiresApproval },
    seq: 1,
    payload: {
      entitlement: { id: entId, system: 'SAP', name, type: 'role', risk: 'high' },
      targetSystem: 'SAP',
      connector: 'sap-connector',
      provisioningMode: 'automated',
      latencyMs: 800,
    },
  };
  return event;
}

describe('ReceiverEngine SoD', () => {
  it('raises a violation when a user accumulates a toxic entitlement pair', () => {
    const engine = createReceiverEngine({ logger, seed: 't', now: () => 1000 });
    engine.ingestEvent(grantEvent('e1', 'SAP Payment Posting', 'k1'));
    expect(engine.stats().sodViolations).toBe(0);
    engine.ingestEvent(grantEvent('e2', 'SAP Payment Release', 'k2'));
    expect(engine.stats().sodViolations).toBeGreaterThanOrEqual(1);
    // The same accumulation does not double-count on a repeat delivery.
    engine.ingestEvent(grantEvent('e2', 'SAP Payment Release', 'k2'));
    expect(engine.stats().sodViolations).toBe(1);
  });
});

describe('ReceiverEngine idempotency', () => {
  it('counts a repeated delivery once', () => {
    const engine = createReceiverEngine({ logger, seed: 't', now: () => 1000 });
    const event = grantEvent('e1', 'Bloomberg Terminal', 'dup-key');
    engine.ingestEvent(event);
    engine.ingestEvent(event);
    engine.ingestEvent(event);
    expect(engine.stats().totalIngested).toBe(1);
  });
});

describe('ReceiverEngine provisioning', () => {
  it('completes connector work after the clock advances', () => {
    const engine = createReceiverEngine({ logger, seed: 't', now: () => 1000, simulateLatency: true });
    engine.ingestEvent(grantEvent('e1', 'SAP Payment Posting', 'k1'));
    expect(engine.stats().provisioned + engine.stats().failed).toBe(0); // nothing drained yet
    engine.pump(1_000); // connector picks the task off its queue
    engine.pump(30_000); // enough elapsed time for it to complete
    const stats = engine.stats();
    expect(stats.provisioned + stats.failed).toBeGreaterThan(0);
    expect(stats.byConnector['SAP']).toBeDefined();
    expect(stats.avgProvisionMs).toBeGreaterThan(0);
  });

  it('gates approval-required provisioning behind the approval delay', () => {
    const engine = createReceiverEngine({
      logger, seed: 't', now: () => 1000, simulateLatency: false, approvalDelayMs: 5000, approvalApproveRate: 1,
    });
    engine.ingestEvent(grantEvent('e1', 'Bloomberg Terminal', 'k1', true));
    expect(engine.approvalTally().pending).toBe(1);
    engine.pump(2000); // before the approval is due
    expect(engine.stats().provisioned).toBe(0);
    engine.pump(6000); // approval due -> approved -> provisioned within the same pump
    expect(engine.approvalTally().approved).toBe(1);
    expect(engine.stats().provisioned).toBeGreaterThanOrEqual(1);
  });
});

describe('ReceiverEngine admission', () => {
  it('sheds inbound requests once total queued work reaches the high-water', () => {
    const engine = createReceiverEngine({
      logger, seed: 't', now: () => 0, backpressureHighWater: 2, rateLimit: { ratePerSec: 0 },
    });
    engine.scimCreateUser({ userName: 'a', id: 'u1' }, 'k1'); // enqueues AD + Exchange = 2 tasks
    expect(engine.backpressureDepth()).toBe(2);
    const decision = engine.admit('ip');
    expect(decision.admitted).toBe(false);
    expect(decision.reason).toBe('backpressure');
    expect(decision.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it('rate-limits a single noisy source', () => {
    const engine = createReceiverEngine({
      logger, seed: 't', now: () => 0, rateLimit: { ratePerSec: 1, burst: 1 }, backpressureHighWater: 1_000_000,
    });
    expect(engine.admit('ip').admitted).toBe(true);
    const second = engine.admit('ip');
    expect(second.admitted).toBe(false);
    expect(second.reason).toBe('rate_limited');
  });
});
