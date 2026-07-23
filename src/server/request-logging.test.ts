/**
 * Regression guard: no secret presented in a request's query string may ever reach
 * the logs. The telemetry WebSocket authenticates via `GET /ws/telemetry?token=<ADMIN_TOKEN>`
 * (browsers cannot set WebSocket headers), and Fastify's request logging is on by
 * default, so without query-string stripping the cleartext master token would be
 * written on every socket connect and shipped to the log collector.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DestinationStream } from 'pino';
import { loadConfig } from '../config/schema.js';
import type { DeliveryAdapter, DeliveryAdapterFactory } from '../contracts/delivery-adapter.js';
import type { BackpressureState, DeliveryResult, DeliveryTarget } from '../types/index.js';
import { createLogger } from '../infra/index.js';
import { buildServer } from './build-server.js';

const ADMIN_TOKEN = 'log-leak-admin-token-0123456789'; // pragma: allowlist secret (deterministic test fixture, not a real credential)

/** A pino destination that captures every emitted line and joins them for scanning. */
function capture(): { dest: DestinationStream; text: () => string } {
  const lines: string[] = [];
  return {
    dest: {
      write(chunk: string): void {
        lines.push(chunk);
      },
    },
    text: () => lines.join(''),
  };
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

async function buildLoggingServer(dest: DestinationStream): Promise<FastifyInstance> {
  const config = loadConfig({
    NODE_ENV: 'test',
    ADMIN_TOKEN,
    DB_PATH: ':memory:',
    // NOT silent: request logging must actually emit so the test can observe it.
    LOG_LEVEL: 'info',
    IDENTITY_POOL_SIZE: '20',
    METRICS_INTERVAL_MS: '1000',
  } as NodeJS.ProcessEnv);
  const app = await buildServer(config, {
    logger: createLogger({ level: 'info' }, dest),
    deliveryFactory: noopDeliveryFactory(),
    simulateReceiverLatency: false,
    serveStatic: false,
    connectNats: false,
  });
  await app.ready();
  return app;
}

describe('request logging never leaks a query-string secret', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it('does not log the token from a GET query string', async () => {
    const sink = capture();
    app = await buildLoggingServer(sink.dest);
    const secret = 'SUPER-SECRET-QUERY-VALUE-42'; // pragma: allowlist secret (fake fixture asserted absent from logs)
    const res = await app.inject({ method: 'GET', url: `/api/health?token=${secret}` });
    expect(res.statusCode).toBe(200);
    expect(sink.text()).not.toContain(secret);
  });

  it('does not log the ADMIN_TOKEN from the /ws/telemetry?token= handshake', async () => {
    const sink = capture();
    app = await buildLoggingServer(sink.dest);
    const socket = await app.injectWS(`/ws/telemetry?token=${ADMIN_TOKEN}`);
    // Give the upgrade request a tick to be logged, then tear down.
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.close();
    expect(sink.text()).not.toContain(ADMIN_TOKEN);
  });
});
