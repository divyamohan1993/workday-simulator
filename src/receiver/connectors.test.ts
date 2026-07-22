import { describe, expect, it } from 'vitest';
import { createPrng } from '../engine/prng.js';
import { createConnectorPool } from './connectors.js';
import type { ConnectorProfile, ProvisioningTask } from './types.js';

/** A fixed-latency single-lane profile makes queue-wait effects deterministic. */
function lane(overrides: Partial<ConnectorProfile> = {}): ConnectorProfile {
  return { name: 'AD', minLatencyMs: 100, maxLatencyMs: 100, failureRate: 0, concurrency: 1, ...overrides };
}

function task(i: number, connector = 'AD', enqueuedAtMs = 0): ProvisioningTask {
  return { id: `t${i}`, connector, userId: 'u', operation: 'create', resource: 'identity', enqueuedAtMs };
}

describe('connector pool', () => {
  it('deepens the queue and raises measured latency under backpressure', () => {
    const completions: Array<{ id: string; latencyMs: number }> = [];
    const pool = createConnectorPool({
      profiles: [lane()],
      prng: createPrng('t'),
      simulateLatency: true,
      onComplete: (t, _ok, latencyMs) => completions.push({ id: t.id, latencyMs }),
    });

    for (let i = 0; i < 3; i += 1) pool.submit(task(i));
    // Concurrency 1 means only one task runs at a time; the rest wait in queue and
    // accrue that wait as latency.
    expect(pool.queueDepth()).toBe(3);

    pool.pump(0); // start t0 (completes at 100)
    pool.pump(100); // complete t0 (latency 100), start t1 (completes at 200)
    pool.pump(200); // complete t1 (latency 200), start t2 (completes at 300)
    pool.pump(300); // complete t2 (latency 300)

    expect(completions.map((c) => c.latencyMs)).toEqual([100, 200, 300]);
    const totals = pool.totals();
    expect(totals.provisioned).toBe(3);
    expect(totals.queueDepth).toBe(0);
    // The last task waited behind a full queue, so its latency exceeds the first's.
    expect(completions.at(-1)!.latencyMs).toBeGreaterThan(completions[0]!.latencyMs);
    expect(totals.avgProvisionMs).toBe(200);
  });

  it('acknowledges immediately with zero latency when latency simulation is off', () => {
    const pool = createConnectorPool({
      profiles: [lane()],
      prng: createPrng('t'),
      simulateLatency: false,
    });
    for (let i = 0; i < 5; i += 1) pool.submit(task(i));
    pool.pump(0); // zero-latency tasks drain fully within one pump

    const totals = pool.totals();
    expect(totals.provisioned).toBe(5);
    expect(totals.failed).toBe(0);
    expect(totals.avgProvisionMs).toBe(0);
    expect(totals.queueDepth).toBe(0);
  });

  it('counts failures against the connector and still records latency', () => {
    const pool = createConnectorPool({
      profiles: [lane({ failureRate: 1 })],
      prng: createPrng('t'),
      simulateLatency: true,
    });
    pool.submit(task(0));
    pool.pump(0);
    pool.pump(100);
    const stat = pool.stats()['AD'];
    expect(stat?.failed).toBe(1);
    expect(stat?.provisioned).toBe(0);
    expect(stat?.avgProvisionMs).toBe(100);
  });

  it('routes an unknown connector to the default lane rather than dropping it', () => {
    const pool = createConnectorPool({
      profiles: [lane({ name: 'GenericConnector' })],
      prng: createPrng('t'),
      simulateLatency: false,
    });
    pool.submit(task(0, 'DoesNotExist'));
    pool.pump(0);
    expect(pool.totals().provisioned).toBe(1);
  });
});
