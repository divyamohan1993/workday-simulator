/**
 * The `/ws/telemetry` WebSocket channel.
 *
 * Auth: browsers cannot set WebSocket headers, so the admin token is presented as a
 * query parameter and compared in constant time; a bad token closes the socket with
 * code 4401 (BUILD-CONTRACT sections 5 and 8) before any data is streamed. On success
 * the server sends `hello`, replays the last frame so the dashboard paints at once,
 * and registers the client with the telemetry hub, which pushes `frame`/`event`/`run`
 * messages as they occur.
 *
 * Per-client backpressure: a slow reader must never grow the server's memory. Each
 * send checks the socket's `bufferedAmount`; when a client is behind, high-volume
 * frame and event messages are dropped for that client (it will catch up on the next
 * frame) rather than queued without bound. Control messages (hello, pong, run) are
 * small and always attempted while the socket is open.
 */

import { nanoid } from 'nanoid';
import type { FastifyInstance } from 'fastify';
import { WS_PROTOCOL_VERSION } from '../types/index.js';
import type { WsClientMessage, WsServerMessage } from '../types/index.js';
import type { ServerContext } from './context.js';
import { timingSafeEqualStr } from './auth.js';
import { firstString } from './helpers.js';
import { ALL_CHANNELS, type TelemetryChannel, type WsClient } from './telemetry-hub.js';

/** WebSocket readyState for an open connection (ws library constant value). */
const WS_OPEN = 1;

/** Close code for an unauthenticated telemetry socket (BUILD-CONTRACT section 8). */
const WS_CLOSE_UNAUTHORIZED = 4401;

/** Drop high-volume messages for a client whose send buffer exceeds this many bytes. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/** Channels that carry bulk telemetry and may be dropped under per-client backpressure. */
const DROPPABLE: ReadonlySet<TelemetryChannel> = new Set<TelemetryChannel>(['frame', 'event']);

/** Narrow an unknown decoded payload to a valid client message, or null. */
function parseClientMessage(raw: unknown): WsClientMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const type = (raw as { type?: unknown }).type;
  if (type === 'ping') return { type: 'ping' };
  if (type === 'subscribe') {
    const channels = (raw as { channels?: unknown }).channels;
    if (!Array.isArray(channels)) return null;
    const valid = channels.filter(
      (c): c is TelemetryChannel => c === 'frame' || c === 'event' || c === 'run',
    );
    return { type: 'subscribe', channels: valid };
  }
  return null;
}

/**
 * Register the telemetry WebSocket route at root (outside the `/api` auth scope; it
 * authenticates by token query parameter instead).
 *
 * @param app The root Fastify instance (with `@fastify/websocket` already registered).
 * @param ctx The server context (token, config, telemetry hub, logger).
 */
export function registerTelemetryWebSocket(app: FastifyInstance, ctx: ServerContext): void {
  // Opt the upgrade out of the global REST rate limiter: a WebSocket is a single
  // persistent connection (per-request limiting is the wrong model), unauthenticated
  // sockets are already shed with an immediate 4401 close, message-rate abuse is
  // bounded by per-client backpressure, and connection floods are the edge's job.
  app.get('/ws/telemetry', { websocket: true, config: { rateLimit: false } }, (socket, request) => {
    const token = firstString((request.query as { token?: unknown }).token);
    if (token === undefined || !timingSafeEqualStr(token, ctx.adminToken)) {
      socket.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
      return;
    }

    const channel = (message: WsServerMessage): TelemetryChannel | null => {
      if (message.type === 'frame') return 'frame';
      if (message.type === 'event') return 'event';
      if (message.type === 'run') return 'run';
      return null;
    };

    const client: WsClient = {
      id: nanoid(),
      channels: new Set<TelemetryChannel>(ALL_CHANNELS),
      send(message: WsServerMessage): void {
        if (socket.readyState !== WS_OPEN) return;
        const ch = channel(message);
        if (ch !== null && DROPPABLE.has(ch) && socket.bufferedAmount > MAX_BUFFERED_BYTES) {
          return; // Shed bulk telemetry for a client that is behind.
        }
        try {
          socket.send(JSON.stringify(message));
        } catch (err) {
          ctx.logger.debug({ err }, 'telemetry socket send failed');
        }
      },
      close(code: number, reason: string): void {
        try {
          socket.close(code, reason);
        } catch {
          /* already closing */
        }
      },
    };

    ctx.telemetry.register(client);

    // Greet, then replay the latest frame so a mid-run client paints immediately.
    client.send({
      type: 'hello',
      serverTime: new Date().toISOString(),
      metricsIntervalMs: ctx.config.METRICS_INTERVAL_MS,
      protocolVersion: WS_PROTOCOL_VERSION,
    });
    const last = ctx.telemetry.lastFrame();
    if (last) client.send({ type: 'frame', frame: last });

    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      let decoded: unknown;
      try {
        const text = Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Array.isArray(data)
            ? Buffer.concat(data).toString('utf8')
            : Buffer.from(data as ArrayBuffer).toString('utf8');
        decoded = JSON.parse(text);
      } catch {
        client.send({ type: 'error', error: 'malformed message', code: 'bad_message' });
        return;
      }
      const message = parseClientMessage(decoded);
      if (!message) {
        client.send({ type: 'error', error: 'unsupported message', code: 'bad_message' });
        return;
      }
      if (message.type === 'ping') {
        client.send({ type: 'pong' });
      } else {
        client.channels = new Set<TelemetryChannel>(message.channels);
      }
    });

    const teardown = (): void => {
      ctx.telemetry.unregister(client);
    };
    socket.on('close', teardown);
    socket.on('error', (err: Error) => {
      ctx.logger.debug({ err, clientId: client.id }, 'telemetry socket error');
      teardown();
    });
  });
}
