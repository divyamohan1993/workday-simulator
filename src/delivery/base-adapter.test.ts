import { describe, expect, it } from 'vitest';
import type { Logger } from 'pino';
import type { DeliveryResult, DeliveryTarget, EventOfKind, WorkdayEvent } from '../types/index.js';
import { createManagedAdapter, type ManagedAdapterOptions } from './base-adapter.js';
import { DeliveryHttpError, DeliveryNetworkError } from './errors.js';
import type { BatchSender, SendResult, SingleSender } from './types.js';

const noopLogger: Logger = {
  warn() {},
  error() {},
  info() {},
  debug() {},
  child() {
    return noopLogger;
  },
} as unknown as Logger;

/** Yield to the macrotask queue so the adapter's drain loop can advance. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function makeTarget(overrides: Partial<DeliveryTarget> = {}): DeliveryTarget {
  return {
    id: 't1',
    name: 'test-target',
    kind: 'rest',
    url: 'http://sink.local',
    auth: { kind: 'none' },
    headers: {},
    rateLimit: { rps: 0, burst: 0 },
    concurrency: 1,
    retry: { maxRetries: 4, baseDelayMs: 100, maxDelayMs: 1_000, jitter: false, retryableStatuses: [408, 429, 500, 502, 503, 504] },
    queueHighWater: 100,
    overflowPolicy: 'drop_oldest',
    builtIn: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeEvent(id: string): WorkdayEvent {
  const event: EventOfKind<'login.success'> = {
    id,
    kind: 'login.success',
    category: 'AUTH',
    timestamp: '2026-07-22T08:00:00.000Z',
    emittedAtWall: '2026-07-22T08:00:00.100Z',
    correlationId: `corr_${id}`,
    severity: 'info',
    actor: {
      kind: 'employee',
      id: `id_${id}`,
      employeeId: 'DB1',
      displayName: 'A B',
      email: 'a@b.com',
      division: 'Finance',
      location: 'FFT',
      grade: 'VP',
      type: 'FTE',
    },
    location: 'FFT',
    division: 'Finance',
    delivery: { operation: 'noop', resource: 'event', idempotencyKey: `k_${id}`, priority: 'low', requiresApproval: false },
    seq: 1,
    payload: {
      ip: '1.1.1.1',
      userAgent: 'ua',
      method: 'password',
      geo: { city: 'FFT', country: 'DE', lat: 0, lng: 0 },
      deviceId: 'd',
      sessionId: 's',
      riskScore: 1,
    },
  };
  return event;
}

/** A single-mode sender whose behaviour per call is scripted. */
function scriptedSender(handler: (callIndex: number) => Promise<SendResult>): SingleSender & { calls: () => number } {
  let calls = 0;
  return {
    mode: 'single',
    calls: () => calls,
    async start() {},
    async stop() {},
    async sendOne(): Promise<SendResult> {
      const n = calls;
      calls += 1;
      return handler(n);
    },
  };
}

/**
 * A sender that parks each send at a barrier until `release()` latches the gate
 * open; thereafter every send (current and future) resolves immediately. The
 * latch matters at concurrency 1, where events are sent one after another.
 */
function gatedSender(): SingleSender & { release: () => void; inFlight: () => number } {
  let waiters: Array<() => void> = [];
  let open = false;
  let active = 0;
  return {
    mode: 'single',
    async start() {},
    async stop() {},
    async sendOne(): Promise<SendResult> {
      active += 1;
      if (!open) await new Promise<void>((resolve) => waiters.push(resolve));
      active -= 1;
      return { httpStatus: 200 };
    },
    release() {
      open = true;
      const current = waiters;
      waiters = [];
      for (const resolve of current) resolve();
    },
    inFlight: () => active,
  };
}

/** Build an adapter with an injected instant clock/sleep for deterministic timing. */
function harness(target: DeliveryTarget, sender: SingleSender, circuit?: ManagedAdapterOptions['circuit']) {
  let clock = 0;
  const sleeps: number[] = [];
  const results: DeliveryResult[] = [];
  const adapter = createManagedAdapter({
    target,
    sender,
    logger: noopLogger,
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    random: () => 0.5,
    ...(circuit ? { circuit } : {}),
  });
  adapter.onResult((r) => results.push(r));
  return { adapter, sleeps, results, clockNow: () => clock };
}

describe('managed adapter: retry', () => {
  it('retries a transient failure and then delivers, counting attempts', async () => {
    const sender = scriptedSender(async (n) => {
      if (n < 2) throw new DeliveryNetworkError('connection reset');
      return { httpStatus: 200 };
    });
    const { adapter, sleeps, results } = harness(makeTarget(), sender);
    await adapter.start();
    adapter.submit(makeEvent('e1'));
    await adapter.flush();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: 'delivered', attempts: 3, httpStatus: 200, eventId: 'e1' });
    // Two backoff waits preceded the successful third attempt.
    expect(sleeps).toEqual([100, 200]); // jitter off: base*2^0, base*2^1
    await adapter.stop();
  });

  it('gives up after maxRetries and dead-letters the event', async () => {
    const sender = scriptedSender(async () => {
      throw new DeliveryNetworkError('always down');
    });
    const { adapter, results } = harness(makeTarget({ retry: { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 100, jitter: false, retryableStatuses: [500] } }), sender);
    await adapter.start();
    adapter.submit(makeEvent('e1'));
    await adapter.flush();

    expect(results[0]).toMatchObject({ outcome: 'failed', attempts: 3 }); // 1 try + 2 retries
    expect(sender.calls()).toBe(3);
    const dead = (adapter as unknown as { deadLetters: () => Array<{ eventId: string }> }).deadLetters();
    expect(dead[0]?.eventId).toBe('e1');
    await adapter.stop();
  });
});

describe('managed adapter: circuit breaker', () => {
  it('opens after the failure threshold and sheds subsequent events', async () => {
    const sender = scriptedSender(async () => {
      throw new DeliveryNetworkError('down');
    });
    // No retries so each event is exactly one failure; open after 2.
    const target = makeTarget({ retry: { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 100, jitter: false, retryableStatuses: [500] } });
    const { adapter, results } = harness(target, sender, { failureThreshold: 2, openMs: 10_000, halfOpenMaxProbes: 1 });
    await adapter.start();
    for (const id of ['e1', 'e2', 'e3', 'e4', 'e5']) adapter.submit(makeEvent(id));
    await adapter.flush();

    const failed = results.filter((r) => r.outcome === 'failed');
    const shed = results.filter((r) => r.outcome === 'circuit_open');
    expect(failed).toHaveLength(2);
    expect(shed).toHaveLength(3);
    // Shed events never reached the sender.
    expect(sender.calls()).toBe(2);
    expect(adapter.pressure().circuit).toBe('open');
    expect(adapter.pressure().droppedTotal).toBe(3); // circuit_open counts as shed load
    await adapter.stop();
  });
});

describe('managed adapter: overflow', () => {
  it('drop_new rejects the incoming event and emits one dropped result for it', async () => {
    const sender = gatedSender();
    const target = makeTarget({ queueHighWater: 2, overflowPolicy: 'drop_new', concurrency: 1 });
    const { adapter, results } = harness(target, sender);
    await adapter.start();

    adapter.submit(makeEvent('e1'));
    await tick(); // e1 is now parked in-flight at the barrier
    expect(sender.inFlight()).toBe(1);

    expect(adapter.submit(makeEvent('e2'))).toBe(true); // queued
    expect(adapter.submit(makeEvent('e3'))).toBe(true); // queued (at high-water)
    expect(adapter.submit(makeEvent('e4'))).toBe(false); // rejected

    const dropped = results.filter((r) => r.outcome === 'dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.eventId).toBe('e4');

    sender.release();
    await adapter.flush();
    const delivered = results.filter((r) => r.outcome === 'delivered').map((r) => r.eventId).sort();
    expect(delivered).toEqual(['e1', 'e2', 'e3']);
    await adapter.stop();
  });

  it('drop_oldest evicts the oldest, keeps the newcomer, and drops the evicted', async () => {
    const sender = gatedSender();
    const target = makeTarget({ queueHighWater: 2, overflowPolicy: 'drop_oldest', concurrency: 1 });
    const { adapter, results } = harness(target, sender);
    await adapter.start();

    adapter.submit(makeEvent('e1'));
    await tick(); // e1 in-flight
    adapter.submit(makeEvent('e2')); // queued
    adapter.submit(makeEvent('e3')); // queued (at high-water)
    expect(adapter.submit(makeEvent('e4'))).toBe(true); // evicts e2

    const dropped = results.filter((r) => r.outcome === 'dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.eventId).toBe('e2'); // the evicted OLDEST, not the newcomer

    sender.release();
    await adapter.flush();
    const delivered = results.filter((r) => r.outcome === 'delivered').map((r) => r.eventId).sort();
    expect(delivered).toEqual(['e1', 'e3', 'e4']);
    await adapter.stop();
  });
});

describe('managed adapter: batch mode', () => {
  it('coalesces events into batches and emits one delivered result per event', async () => {
    const batches: number[] = [];
    const sender: BatchSender = {
      mode: 'batch',
      batchSize: 3,
      async start() {},
      async stop() {},
      async sendBatch(events): Promise<SendResult> {
        batches.push(events.length);
        return { httpStatus: 202 };
      },
    };
    const { adapter, results } = harness(makeTarget({ concurrency: 2 }), sender as unknown as SingleSender);
    await adapter.start();
    for (const id of ['e1', 'e2', 'e3', 'e4', 'e5']) adapter.submit(makeEvent(id));
    await adapter.flush();

    // A full batch of 3, then the remaining 2 flushed by age/force.
    expect(batches).toEqual([3, 2]);
    const delivered = results.filter((r) => r.outcome === 'delivered');
    expect(delivered).toHaveLength(5);
    expect(delivered.every((r) => r.httpStatus === 202)).toBe(true);
    expect(results.map((r) => r.eventId).sort()).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
    await adapter.stop();
  });
});

describe('managed adapter: 429 handling', () => {
  it('honours Retry-After, penalizes the limiter, and then delivers', async () => {
    const sender = scriptedSender(async (n) => {
      if (n === 0) throw new DeliveryHttpError(429, { retryAfterMs: 2_000 });
      return { httpStatus: 200 };
    });
    const { adapter, sleeps, results } = harness(makeTarget(), sender);
    await adapter.start();
    adapter.submit(makeEvent('e1'));
    await adapter.flush();

    expect(results[0]).toMatchObject({ outcome: 'delivered', attempts: 2 });
    // The wait equalled the server-directed Retry-After, not computed backoff.
    expect(sleeps).toContain(2_000);
    await adapter.stop();
  });

  it('marks a non-retryable 4xx as failed without retrying', async () => {
    const sender = scriptedSender(async () => {
      throw new DeliveryHttpError(400, { bodySnippet: 'bad request' });
    });
    const { adapter, results } = harness(makeTarget(), sender);
    await adapter.start();
    adapter.submit(makeEvent('e1'));
    await adapter.flush();

    expect(results[0]).toMatchObject({ outcome: 'failed', attempts: 1, httpStatus: 400 });
    expect(sender.calls()).toBe(1);
    await adapter.stop();
  });
});
