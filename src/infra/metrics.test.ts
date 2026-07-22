import { describe, expect, it } from 'vitest';
import { createMetricsRegistry } from './metrics.js';
import type { MetricsRegistry } from '../contracts/metrics-registry.js';
import { ALL_EVENT_CATEGORIES } from '../types/index.js';
import {
  makeDeliveryResult,
  makeEvent,
  makeEventWith,
  makeFrameContext,
  makeReceiverStats,
} from './__tests__/fixtures.js';

/** Build a registry with a controllable clock for deterministic rate math. */
function makeRegistry(nowRef: { ms: number }, recentEventsSize = 50): MetricsRegistry {
  return createMetricsRegistry(
    { recentEventsSize },
    { now: () => nowRef.ms, seed: 'test', rpsWindowSec: 5 },
  );
}

describe('createMetricsRegistry', () => {
  it('assembles a fully-populated telemetry frame with zeroed defaults', () => {
    const now = { ms: 0 };
    const reg = makeRegistry(now);
    const ctx = makeFrameContext();
    const frame = reg.snapshot(ctx);

    expect(frame.clock).toBe(ctx.clock);
    expect(frame.run).toBeNull();
    expect(frame.frameSeq).toBe(ctx.frameSeq);
    expect(typeof frame.emittedAt).toBe('string');
    expect(frame.currentRps).toBe(0);
    expect(frame.targetRps).toBe(0);
    expect(frame.errorRate).toBe(0);
    expect(frame.latency).toEqual({ p50: 0, p95: 0, p99: 0, max: 0, count: 0 });
    expect(Object.keys(frame.eventMix.byCategory).sort()).toEqual([...ALL_EVENT_CATEGORIES].sort());
    expect(frame.eventMix.byKind).toEqual({});
    expect(frame.receiver.byConnector).toEqual({});
    expect(frame.receiver.provisioned).toBe(0);
    expect(frame.delivery).toMatchObject({
      targetRps: 0,
      inFlight: 0,
      queueDepth: 0,
      circuit: 'closed',
      deliveredTotal: 0,
      failedTotal: 0,
      droppedTotal: 0,
    });
    expect(Array.isArray(frame.recentEvents)).toBe(true);
    expect(Array.isArray(frame.activeChaos)).toBe(true);
  });

  it('counts the event mix and keeps a newest-first recent ring', () => {
    const now = { ms: 0 };
    const reg = makeRegistry(now, 3);
    reg.recordEvent(makeEvent({ id: 'e1', seq: 1 }));
    reg.recordEvent(makeEvent({ id: 'e2', seq: 2 }));
    reg.recordEvent(makeEventWith('payment.sepa', 3));
    reg.recordEvent(makeEvent({ id: 'e4', seq: 4 }));

    const frame = reg.snapshot(makeFrameContext());
    expect(frame.eventMix.byCategory.AUTH).toBe(3);
    expect(frame.eventMix.byCategory.TXN).toBe(1);
    expect(frame.eventMix.byKind['login.success']).toBe(3);
    expect(frame.eventMix.byKind['payment.sepa']).toBe(1);
    // Ring capacity 3: oldest (e1) evicted, newest first. The payment.sepa event
    // keeps the fixture's default id 'evt-1'.
    expect(frame.recentEvents.map((e) => e.id)).toEqual(['e4', 'evt-1', 'e2']);
  });

  it('classifies delivery outcomes like the runtime and excludes dropped from error rate', () => {
    const now = { ms: 0 };
    const reg = makeRegistry(now);
    reg.recordDelivery(makeDeliveryResult({ outcome: 'delivered' }));
    reg.recordDelivery(makeDeliveryResult({ outcome: 'retried' }));
    reg.recordDelivery(makeDeliveryResult({ outcome: 'failed' }));
    reg.recordDelivery(makeDeliveryResult({ outcome: 'circuit_open' }));
    reg.recordDelivery(makeDeliveryResult({ outcome: 'dropped' }));
    reg.recordDelivery(makeDeliveryResult({ outcome: 'dropped' }));

    const frame = reg.snapshot(makeFrameContext());
    expect(frame.delivery.deliveredTotal).toBe(2); // delivered + retried
    expect(frame.delivery.failedTotal).toBe(2); // failed + circuit_open
    expect(frame.delivery.droppedTotal).toBe(2);
    // 2 failed of 4 attempted; the 2 dropped are excluded.
    expect(frame.errorRate).toBeCloseTo(0.5, 5);
  });

  it('computes latency percentiles from successful deliveries only', () => {
    const now = { ms: 0 };
    const reg = makeRegistry(now);
    for (let ms = 10; ms <= 100; ms += 10) {
      reg.recordDelivery(makeDeliveryResult({ outcome: 'delivered', latencyMs: ms }));
    }
    // A failed delivery has a latency but must not enter the histogram.
    reg.recordDelivery(makeDeliveryResult({ outcome: 'failed', latencyMs: 9_999 }));

    const latency = reg.latency();
    expect(latency.count).toBe(10);
    expect(latency.p50).toBe(50);
    expect(latency.max).toBe(100);
  });

  it('smooths the delivered rate over the window', () => {
    const now = { ms: 0 };
    const reg = makeRegistry(now);
    for (let i = 0; i < 5; i += 1) reg.recordDelivery(makeDeliveryResult({ outcome: 'delivered' }));
    expect(reg.currentRps()).toBe(5);

    now.ms = 4_000;
    for (let i = 0; i < 3; i += 1) reg.recordDelivery(makeDeliveryResult({ outcome: 'delivered' }));
    expect(reg.currentRps()).toBeCloseTo(1.6, 5);
  });

  it('folds in the latest receiver statistics', () => {
    const now = { ms: 0 };
    const reg = makeRegistry(now);
    reg.recordReceiver(makeReceiverStats({ provisioned: 42, sodViolations: 3 }));
    const frame = reg.snapshot(makeFrameContext());
    expect(frame.receiver.provisioned).toBe(42);
    expect(frame.receiver.sodViolations).toBe(3);
  });

  it('exports named metric samples including one per category', () => {
    const now = { ms: 0 };
    const reg = makeRegistry(now);
    reg.recordEvent(makeEvent());
    reg.recordDelivery(makeDeliveryResult({ outcome: 'delivered' }));

    const samples = reg.samples();
    const byName = new Map(samples.map((s) => [s.name, s.value]));
    expect(byName.get('events.generated.total')).toBe(1);
    expect(byName.get('delivery.delivered.total')).toBe(1);
    expect(samples.filter((s) => s.name === 'events.category.count')).toHaveLength(
      ALL_EVENT_CATEGORIES.length,
    );
  });

  it('clears all state on reset', () => {
    const now = { ms: 0 };
    const reg = makeRegistry(now);
    reg.recordEvent(makeEvent());
    reg.recordDelivery(makeDeliveryResult({ outcome: 'delivered', latencyMs: 30 }));
    reg.recordReceiver(makeReceiverStats({ provisioned: 9 }));
    reg.reset();

    const frame = reg.snapshot(makeFrameContext());
    expect(frame.delivery.deliveredTotal).toBe(0);
    expect(frame.latency.count).toBe(0);
    expect(frame.eventMix.byCategory.AUTH).toBe(0);
    expect(frame.eventMix.byKind).toEqual({});
    expect(frame.recentEvents).toEqual([]);
    expect(frame.receiver.provisioned).toBe(0);
  });
});
