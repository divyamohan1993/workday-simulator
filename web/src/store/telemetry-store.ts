import { create } from 'zustand';
import type { RunState, TelemetryFrame, WorkdayEvent } from '@/types/api';
import type { SocketStatus } from '@/lib/ws-client';
import { TELEMETRY_LIMITS } from '@/lib/constants';

/**
 * Live telemetry state, fed exclusively by the frame-driven WebSocket client.
 * One `ingestFrame` per second drives the entire dashboard, so React updates
 * stay bounded no matter how many events/sec the simulation produces.
 *
 * Two bounded buffers keep memory flat during long runs:
 * - `points`: a compact per-frame series for the time-charts (never the raw frames).
 * - `ticker`: a deduped, newest-first ring merged from each frame's recentEvents.
 */

/** A compact chart row derived from one frame. */
export interface FramePoint {
  /** Monotonic index; stable x for the live charts across the rolling window. */
  i: number;
  /** Wall time (ms) of the frame, for tooltip labels. */
  wallMs: number;
  rpsCurrent: number;
  rpsTarget: number;
  p50: number;
  p95: number;
  p99: number;
  /** Error rate as a percentage (0..100) for a readable axis. */
  errorRatePct: number;
}

interface TelemetryState {
  status: SocketStatus;
  metricsIntervalMs: number;
  frame: TelemetryFrame | null;
  run: RunState | null;
  points: FramePoint[];
  ticker: WorkdayEvent[];
  lastFrameAt: number | null;
  /** Monotonic frame counter for chart x-values. */
  seq: number;

  setStatus: (status: SocketStatus) => void;
  setMetricsInterval: (ms: number) => void;
  ingestFrame: (frame: TelemetryFrame) => void;
  ingestRun: (run: RunState) => void;
  reset: () => void;
}

const INITIAL = {
  status: 'idle' as SocketStatus,
  metricsIntervalMs: 1000,
  frame: null,
  run: null,
  points: [] as FramePoint[],
  ticker: [] as WorkdayEvent[],
  lastFrameAt: null,
  seq: 0,
};

export const useTelemetryStore = create<TelemetryState>((set) => ({
  ...INITIAL,

  setStatus: (status) => set({ status }),
  setMetricsInterval: (metricsIntervalMs) => set({ metricsIntervalMs }),

  ingestFrame: (frame) =>
    set((state) => {
      const seq = state.seq + 1;

      const point: FramePoint = {
        i: seq,
        wallMs: Date.parse(frame.emittedAt) || Date.now(),
        rpsCurrent: frame.currentRps,
        rpsTarget: frame.targetRps,
        p50: frame.latency.p50,
        p95: frame.latency.p95,
        p99: frame.latency.p99,
        errorRatePct: frame.errorRate * 100,
      };
      const points = [...state.points, point];
      if (points.length > TELEMETRY_LIMITS.maxFrames) {
        points.splice(0, points.length - TELEMETRY_LIMITS.maxFrames);
      }

      // Merge newest-first recentEvents into the ticker ring, deduped by id.
      let ticker = state.ticker;
      if (frame.recentEvents.length > 0) {
        const seen = new Set(state.ticker.map((e) => e.id));
        const fresh = frame.recentEvents.filter((e) => !seen.has(e.id));
        if (fresh.length > 0) {
          ticker = [...fresh, ...state.ticker].slice(0, TELEMETRY_LIMITS.maxTickerEvents);
        }
      }

      return {
        frame,
        run: frame.run,
        points,
        ticker,
        seq,
        lastFrameAt: Date.now(),
      };
    }),

  // Out-of-band run transitions (start/stop/pause) arrive as their own messages.
  ingestRun: (run) => set({ run }),

  reset: () => set({ ...INITIAL }),
}));
