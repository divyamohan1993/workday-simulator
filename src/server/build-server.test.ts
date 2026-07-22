import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../config/schema.js';
import type { DeliveryAdapter, DeliveryAdapterFactory } from '../contracts/delivery-adapter.js';
import type { BackpressureState, DeliveryResult, DeliveryTarget } from '../types/index.js';
import { buildServer } from './build-server.js';
import { BUILTIN_TARGET_ID } from './built-ins.js';

const ADMIN_TOKEN = 'test-admin-token-0123456789'; // pragma: allowlist secret (deterministic test fixture, not a real credential)
const AUTH = { authorization: `Bearer ${ADMIN_TOKEN}` };

/** Config for an isolated, in-memory instance with a tiny workforce for speed. */
function testConfig(): ReturnType<typeof loadConfig> {
  return loadConfig({
    NODE_ENV: 'test',
    ADMIN_TOKEN,
    DB_PATH: ':memory:',
    LOG_LEVEL: 'silent',
    IDENTITY_POOL_SIZE: '40',
    METRICS_INTERVAL_MS: '1000',
  } as NodeJS.ProcessEnv);
}

/**
 * A no-op delivery factory: it accepts every event and reports it delivered at once,
 * with a benign backpressure snapshot. This lets a run start and produce delivery
 * results without any network or real sink (BUILD-CONTRACT test guidance).
 */
function noopDeliveryFactory(): DeliveryAdapterFactory {
  return {
    create(target: DeliveryTarget): DeliveryAdapter {
      const handlers = new Set<(result: DeliveryResult) => void>();
      return {
        kind: target.kind,
        target,
        async start(): Promise<void> {},
        submit(event): boolean {
          const result: DeliveryResult = {
            eventId: event.id,
            correlationId: event.correlationId,
            targetId: target.id,
            kind: target.kind,
            outcome: 'delivered',
            attempts: 1,
            latencyMs: 0,
            at: new Date().toISOString(),
          };
          for (const handler of handlers) handler(result);
          return true;
        },
        onResult(handler): () => void {
          handlers.add(handler);
          return () => handlers.delete(handler);
        },
        pressure(): BackpressureState {
          return {
            queueDepth: 0,
            highWater: target.queueHighWater,
            inFlight: 0,
            saturated: false,
            circuit: 'closed',
            droppedTotal: 0,
            deliveredTotal: 0,
            failedTotal: 0,
          };
        },
        async flush(): Promise<void> {},
        async stop(): Promise<void> {},
      };
    },
  };
}

describe('buildServer control plane', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer(testConfig(), {
      deliveryFactory: noopDeliveryFactory(),
      simulateReceiverLatency: false,
      serveStatic: false,
      connectNats: false,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves public health without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.version).toBe('string');
    expect(typeof body.uptimeSec).toBe('number');
  });

  it('reports readiness with db and receiver checks', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    expect(body.checks).toEqual({ db: true, receiver: true });
  });

  it('rejects a protected route with no token as 401 in the uniform error shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scenarios' });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body).toMatchObject({ error: expect.any(String), code: 'unauthorized', requestId: expect.any(String) });
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it('accepts a protected route with a valid token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scenarios', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.items)).toBe(true);
    // The default scenario is seeded at boot.
    expect(body.total).toBeGreaterThanOrEqual(1);
  });

  it('returns a uniform 404 body for an unknown resource', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scenarios/does-not-exist', headers: AUTH });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body).toMatchObject({ code: 'scenario_not_found', requestId: expect.any(String) });
  });

  it('redacts target secrets in every response', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/targets/${BUILTIN_TARGET_ID}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.builtIn).toBe(true);
    expect(body.auth.kind).toBe('bearer');
    expect(body.auth.token).toBe('***REDACTED***');
  });

  it('exposes the chaos catalog', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/chaos/injectors', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toHaveProperty('kind');
    expect(body[0]).toHaveProperty('params');
  });

  it('creates a scenario and starts then stops a run', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      headers: AUTH,
      payload: { name: 'Smoke Test', baselineRps: 5, maxRps: 50, targetId: BUILTIN_TARGET_ID },
    });
    expect(createRes.statusCode).toBe(201);
    const scenario = createRes.json();
    expect(scenario.id).toBeTruthy();
    // Per-kind mix is filled from the recommended default when omitted.
    expect(scenario.eventMix.byKind).toBeTruthy();

    const startRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: AUTH,
      payload: { scenarioId: scenario.id },
    });
    expect(startRes.statusCode).toBe(201);
    const run = startRes.json();
    expect(['running', 'starting']).toContain(run.status);
    expect(run.scenarioId).toBe(scenario.id);
    expect(run.targetId).toBe(BUILTIN_TARGET_ID);

    // A second start while one is active is a conflict.
    const conflictRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: AUTH,
      payload: { scenarioId: scenario.id },
    });
    expect(conflictRes.statusCode).toBe(409);

    const stopRes = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/stop`, headers: AUTH });
    expect(stopRes.statusCode).toBe(200);
    const summary = stopRes.json();
    expect(summary.runId).toBe(run.id);
  });
});
