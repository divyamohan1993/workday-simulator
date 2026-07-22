/**
 * The telemetry fan-out hub.
 *
 * WHY it derives `event` and `run` messages from frames: the frozen `ScenarioRuntime`
 * exposes exactly one telemetry seam, `onFrame`, plus `state()`. The WebSocket
 * protocol (BUILD-CONTRACT section 8) additionally streams `event` and `run`
 * messages "as they occur". Rather than add a second hot-path subscription to the
 * bus (which would flood clients at thousands of events per second), the hub reads
 * each frame's newest-first `recentEvents` ring and its `run` snapshot and emits the
 * deltas: any event newer than the last forwarded sequence, and a `run` message
 * whenever the run's id or status changes. This bounds event traffic to at most the
 * ring size per frame, which is exactly the sample a live ticker wants, and needs no
 * extra coupling to the runtime internals.
 *
 * The hub also holds the last frame so the REST telemetry endpoints and a freshly
 * connected socket can paint immediately without waiting for the next interval.
 *
 * Per-client backpressure is the sender's concern (see ws.ts): a slow client that
 * lets its buffer grow is skipped for frame sends, never queued unboundedly.
 */

import type { Logger } from 'pino';
import type { RunState, TelemetryFrame, WorkdayEvent, WsServerMessage } from '../types/index.js';

/** The three logical channels a client may subscribe to. */
export type TelemetryChannel = 'frame' | 'event' | 'run';

/** All channels, the default subscription for a new connection. */
export const ALL_CHANNELS: readonly TelemetryChannel[] = ['frame', 'event', 'run'];

/**
 * One connected dashboard socket, as the hub sees it. The concrete WebSocket lives
 * in ws.ts; the hub only holds a channel-filtered, backpressure-aware `send` closure
 * and a `close`, so it never depends on the socket implementation.
 */
export interface WsClient {
  readonly id: string;
  channels: Set<TelemetryChannel>;
  /** Serialize and write a server message, honoring readiness and backpressure. */
  send(message: WsServerMessage): void;
  /** Close the socket with a code and reason. */
  close(code: number, reason: string): void;
}

/** The public surface the server wires: a frame sink, a snapshot getter, registry. */
export interface TelemetryHub {
  /** Runtime `onFrame` callback: store the frame and fan out frame/event/run deltas. */
  ingestFrame(frame: TelemetryFrame): void;
  /** The most recent frame, or null before the first run produces one. */
  lastFrame(): TelemetryFrame | null;
  register(client: WsClient): void;
  unregister(client: WsClient): void;
  clientCount(): number;
  /** Close every connected client (graceful shutdown). */
  closeAll(code: number, reason: string): void;
}

/** Build the telemetry hub. */
export function createTelemetryHub(options: { logger: Logger }): TelemetryHub {
  const { logger } = options;
  const clients = new Set<WsClient>();
  let latest: TelemetryFrame | null = null;
  let lastRunId: string | null = null;
  let lastRunSig: string | null = null;
  let lastEventSeq = 0;

  /** Send a message to every client subscribed to `channel`. */
  const broadcast = (channel: TelemetryChannel, message: WsServerMessage): void => {
    for (const client of clients) {
      if (!client.channels.has(channel)) continue;
      client.send(message);
    }
  };

  /** Emit a `run` message when the run's identity or status transitions. */
  const emitRunDelta = (run: RunState | null): void => {
    if (!run) return;
    if (run.id !== lastRunId) {
      // A new run resets the per-run event sequence watermark.
      lastRunId = run.id;
      lastEventSeq = 0;
    }
    const sig = `${run.id}:${run.status}`;
    if (sig !== lastRunSig) {
      lastRunSig = sig;
      broadcast('run', { type: 'run', run });
    }
  };

  /** Emit `event` messages for every event in the frame newer than the watermark. */
  const emitEventDeltas = (recent: readonly WorkdayEvent[]): void => {
    if (recent.length === 0) return;
    // recentEvents is newest-first; forward those above the watermark in chronological
    // order so the ticker renders oldest-to-newest, then advance the watermark.
    const fresh: WorkdayEvent[] = [];
    let maxSeq = lastEventSeq;
    for (const event of recent) {
      if (event.seq > lastEventSeq) fresh.push(event);
      if (event.seq > maxSeq) maxSeq = event.seq;
    }
    lastEventSeq = maxSeq;
    for (let i = fresh.length - 1; i >= 0; i -= 1) {
      const event = fresh[i];
      if (event) broadcast('event', { type: 'event', event });
    }
  };

  return {
    ingestFrame(frame: TelemetryFrame): void {
      latest = frame;
      try {
        emitRunDelta(frame.run);
        emitEventDeltas(frame.recentEvents);
        broadcast('frame', { type: 'frame', frame });
      } catch (err) {
        logger.error({ err }, 'telemetry fan-out failed');
      }
    },

    lastFrame(): TelemetryFrame | null {
      return latest;
    },

    register(client: WsClient): void {
      clients.add(client);
    },

    unregister(client: WsClient): void {
      clients.delete(client);
    },

    clientCount(): number {
      return clients.size;
    },

    closeAll(code: number, reason: string): void {
      for (const client of clients) {
        try {
          client.close(code, reason);
        } catch (err) {
          logger.debug({ err, clientId: client.id }, 'error closing telemetry client');
        }
      }
      clients.clear();
    },
  };
}
