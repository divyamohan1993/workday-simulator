import type { RunState, TelemetryFrame, WorkdayEvent, WsServerMessage } from '@/types/api';
import { computeBackoff, DEFAULT_BACKOFF, type BackoffOptions } from '@/lib/backoff';

/**
 * Reconnecting client for the telemetry WebSocket (`/ws/telemetry`).
 *
 * Why a frame-driven design (not the per-event firehose): a run can emit up to
 * MAX_RPS (2000) events/sec. Rendering one React update per event would melt the
 * main thread. The server bundles everything into one complete `TelemetryFrame`
 * every METRICS_INTERVAL_MS (default 1s), including `recentEvents` for the ticker.
 * So this client subscribes to `frame` + `run` only and never asks for the raw
 * `event` channel. The whole dashboard renders off one setState per second.
 *
 * Resilience: jittered exponential backoff on unexpected close; a ping/pong
 * heartbeat detects a dead-but-open socket even while a run is idle (no frames);
 * close code 4401 (bad token) is terminal and surfaces as `auth_error` so the app
 * returns to the sign-in gate instead of hammering the server with a bad token.
 */

export type SocketStatus =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'auth_error'
  | 'closed';

export interface TelemetrySocketHandlers {
  onStatus?: (status: SocketStatus) => void;
  onHello?: (metricsIntervalMs: number) => void;
  onFrame?: (frame: TelemetryFrame) => void;
  onRun?: (run: RunState) => void;
  /** Only fires if the server pushes events despite our subscription. */
  onEvent?: (event: WorkdayEvent) => void;
  onServerError?: (error: string, code: string) => void;
}

export interface TelemetrySocketConfig extends TelemetrySocketHandlers {
  /** Returns the current admin token, read fresh on every (re)connect. */
  getToken: () => string | null;
  /** Override for tests; defaults to a same-origin ws(s) URL. */
  buildUrl?: (token: string) => string;
  /** Override for tests; defaults to the global WebSocket. */
  socketFactory?: (url: string) => WebSocket;
  backoff?: BackoffOptions;
  pingIntervalMs?: number;
  /** How long to wait for any message after a ping before declaring the socket dead. */
  pongTimeoutMs?: number;
}

const AUTH_CLOSE_CODE = 4401;

/** Default same-origin URL, respecting TLS. */
function defaultBuildUrl(token: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws/telemetry?token=${encodeURIComponent(token)}`;
}

export class TelemetrySocket {
  private ws: WebSocket | null = null;
  private status: SocketStatus = 'idle';
  private attempt = 0;
  private intentionalClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly backoff: BackoffOptions;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;

  constructor(private readonly config: TelemetrySocketConfig) {
    this.backoff = config.backoff ?? DEFAULT_BACKOFF;
    this.pingIntervalMs = config.pingIntervalMs ?? 20_000;
    this.pongTimeoutMs = config.pongTimeoutMs ?? 8_000;
  }

  getStatus(): SocketStatus {
    return this.status;
  }

  /** Open the socket. Safe to call repeatedly; tears down any prior socket first. */
  connect(): void {
    this.intentionalClose = false;
    this.clearReconnect();
    this.teardownSocket();

    const token = this.config.getToken();
    if (!token) {
      this.setStatus('auth_error');
      this.config.onServerError?.('Missing admin token', 'no_token');
      return;
    }

    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const url = (this.config.buildUrl ?? defaultBuildUrl)(token);
    const factory = this.config.socketFactory ?? ((u: string) => new WebSocket(u));

    let socket: WebSocket;
    try {
      socket = factory(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      // "open" is transport-level; we treat "hello" as the real ready signal.
      this.setStatus('open');
    };
    socket.onmessage = (ev: MessageEvent) => this.handleMessage(ev);
    socket.onerror = () => {
      // The browser always fires `close` after `error`; reconnect is handled there.
    };
    socket.onclose = (ev: CloseEvent) => this.handleClose(ev);
  }

  /** Close intentionally; no reconnect. */
  close(): void {
    this.intentionalClose = true;
    this.clearReconnect();
    this.stopHeartbeat();
    this.teardownSocket();
    this.setStatus('closed');
  }

  private handleMessage(ev: MessageEvent): void {
    // Any inbound traffic proves the socket is alive: clear the pong watchdog.
    this.clearPongTimer();

    let msg: WsServerMessage;
    try {
      msg = JSON.parse(String(ev.data)) as WsServerMessage;
    } catch {
      return; // Ignore malformed frames rather than crashing the stream.
    }

    switch (msg.type) {
      case 'hello':
        this.attempt = 0; // A successful handshake resets backoff.
        this.setStatus('open');
        this.startHeartbeat();
        this.config.onHello?.(msg.metricsIntervalMs);
        this.send({ type: 'subscribe', channels: ['frame', 'run'] });
        break;
      case 'frame':
        this.config.onFrame?.(msg.frame);
        break;
      case 'run':
        this.config.onRun?.(msg.run);
        break;
      case 'event':
        this.config.onEvent?.(msg.event);
        break;
      case 'pong':
        break; // Liveness already recorded above.
      case 'error':
        this.config.onServerError?.(msg.error, msg.code);
        break;
      default:
        break;
    }
  }

  private handleClose(ev: CloseEvent): void {
    this.stopHeartbeat();
    this.ws = null;

    if (this.intentionalClose) {
      this.setStatus('closed');
      return;
    }
    if (ev.code === AUTH_CLOSE_CODE) {
      // Bad/expired token: terminal. Do not retry with a token the server rejected.
      this.setStatus('auth_error');
      this.config.onServerError?.('Authentication failed', 'ws_unauthorized');
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.setStatus('reconnecting');
    const delay = computeBackoff(this.attempt, this.backoff);
    this.attempt += 1;
    this.clearReconnect();
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping' });
      // If nothing arrives before the pong timeout, force a reconnect.
      this.clearPongTimer();
      this.pongTimer = setTimeout(() => {
        this.teardownSocket();
        this.scheduleReconnect();
      }, this.pongTimeoutMs);
    }, this.pingIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.clearPongTimer();
  }

  private clearPongTimer(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private teardownSocket(): void {
    const socket = this.ws;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      // Ignore: socket may already be closing.
    }
    this.ws = null;
  }

  private send(data: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(data));
      } catch {
        // Ignore transient send failures; the heartbeat/close path will recover.
      }
    }
  }

  private setStatus(next: SocketStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.config.onStatus?.(next);
  }
}
