import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../config/schema.js';
import type { DeliveryAdapter, DeliveryAdapterFactory } from '../contracts/delivery-adapter.js';
import type { BackpressureState, DeliveryResult, DeliveryTarget } from '../types/index.js';
import { buildServer } from './build-server.js';
import { BUILTIN_TARGET_ID } from './built-ins.js';

const ADMIN_TOKEN = 'ws-admin-token-01234567890'; // pragma: allowlist secret (deterministic test fixture, not a real credential)
const AUTH = { authorization: `Bearer ${ADMIN_TOKEN}` };

function testConfig(): ReturnType<typeof loadConfig> {
  return loadConfig({
    NODE_ENV: 'test',
    ADMIN_TOKEN,
    DB_PATH: ':memory:',
    LOG_LEVEL: 'silent',
    IDENTITY_POOL_SIZE: '40',
    // Fast frame cadence so the push test resolves quickly.
    METRICS_INTERVAL_MS: '200',
  } as NodeJS.ProcessEnv);
}

/** A no-op delivery factory: accept and immediately mark delivered, no network. */
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

/** A connected test socket that buffers every server message from the moment it opens. */
interface TestSocket {
  close(): void;
  /** Resolve with the first buffered message of `type`, even if it already arrived. */
  waitForType(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
}

/**
 * Connect a telemetry socket and start buffering messages in `onInit` (before the
 * server's one-shot `hello` can be missed by a late listener).
 */
async function connect(app: FastifyInstance, token: string): Promise<TestSocket> {
  const messages: Record<string, unknown>[] = [];
  const checks = new Set<() => void>();
  const socket = await app.injectWS(`/ws/telemetry?token=${token}`, undefined, {
    onInit: (ws) => {
      ws.on('message', (data: unknown) => {
        try {
          messages.push(JSON.parse(String(data)) as Record<string, unknown>);
        } catch {
          return;
        }
        for (const check of checks) check();
      });
    },
  });
  return {
    close(): void {
      socket.close();
    },
    waitForType(type: string, timeoutMs = 3_000): Promise<Record<string, unknown>> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          checks.delete(check);
          reject(new Error(`timeout waiting for '${type}' message`));
        }, timeoutMs);
        const check = (): void => {
          const found = messages.find((m) => m['type'] === type);
          if (found) {
            clearTimeout(timer);
            checks.delete(check);
            resolve(found);
          }
        };
        checks.add(check);
        check();
      });
    },
  };
}

describe('/ws/telemetry channel', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer(testConfig(), {
      deliveryFactory: noopDeliveryFactory(),
      simulateReceiverLatency: false,
      serveStatic: false,
      connectNats: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('closes an unauthenticated socket with code 4401', async () => {
    const socket = await app.injectWS('/ws/telemetry?token=wrong-token');
    const code = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for close')), 3_000);
      socket.on('close', (c: number) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    expect(code).toBe(4401);
  });

  it('greets an authenticated socket with a hello message', async () => {
    const socket = await connect(app, ADMIN_TOKEN);
    const hello = await socket.waitForType('hello');
    expect(hello['protocolVersion']).toBe(1);
    expect(typeof hello['metricsIntervalMs']).toBe('number');
    socket.close();
  });

  it('pushes a telemetry frame while a run is active', async () => {
    const scenarioRes = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      headers: AUTH,
      payload: { name: 'WS Frame', baselineRps: 20, maxRps: 100, targetId: BUILTIN_TARGET_ID },
    });
    const scenario = scenarioRes.json();

    const runRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: AUTH,
      payload: { scenarioId: scenario.id },
    });
    const run = runRes.json();
    expect(['running', 'starting']).toContain(run.status);

    const socket = await connect(app, ADMIN_TOKEN);
    const message = await socket.waitForType('frame');
    const frame = message['frame'] as Record<string, unknown>;
    expect(frame).toBeTruthy();
    expect(frame['clock']).toBeTruthy();
    expect(typeof frame['currentRps']).toBe('number');
    socket.close();

    await app.inject({ method: 'POST', url: `/api/runs/${run.id}/stop`, headers: AUTH });
  });
});
