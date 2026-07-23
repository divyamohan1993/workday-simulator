/**
 * The organic threat scheduler.
 *
 * WHY: a real bank day is not scripted. The event mix already carries a low AMBIENT
 * rate of exceptions (failed logins, the odd lockout, an SoD violation, a break-glass),
 * but coordinated INCIDENTS, a credential-stuffing wave, an insider acting off-hours, a
 * ransomware attempt, a quarter-end audit surge, occur at unpredictable moments, a few
 * times a day, and overlap only occasionally. This scheduler reproduces that rhythm by
 * firing the existing {@link createChaosInjector} injectors on a Poisson schedule in
 * SIMULATED time, with a randomized kind (attack classes weighted over benign
 * operational shocks and nudged by time of day), a randomized intensity, and a hard cap
 * on how many incidents run at once, so a day never degrades into a constant-attack
 * stress test.
 *
 * Determinism: driven entirely by an injected PRNG. The runtime forks it off
 * `${seed}:${runId}:threat`, so the workforce and the arrival stream stay reproducible
 * for a given seed while the incident timeline differs on every run, which is what
 * "feels like a different day every day" requires. Nothing here reads the wall clock.
 */

import type { ChaosInjectorConfig, ChaosInjectorKind, ThreatProfile } from '../types/index.js';
import type { Prng } from './prng.js';

/**
 * The incident kinds the scheduler draws from, in a FIXED order. The order is the index
 * space for the resolved weight array, so it must never be reordered without updating
 * {@link resolveThreatProfile}.
 */
export const THREAT_INCIDENT_KINDS: readonly ChaosInjectorKind[] = [
  'credential_stuffing',
  'insider_threat',
  'ransomware_lateral',
  'mass_password_reset',
  'audit_season_surge',
  'mass_termination_reorg',
  'payroll_batch',
  'connector_outage',
];

/** Attack-class kinds whose incidence rises in the quiet hours (an attacker prefers the dark). */
const NIGHT_BIASED: ReadonlySet<ChaosInjectorKind> = new Set<ChaosInjectorKind>([
  'credential_stuffing',
  'insider_threat',
  'ransomware_lateral',
]);

/** Default relative incidence: attack classes slightly over operational shocks. */
const DEFAULT_KIND_WEIGHTS: Record<ChaosInjectorKind, number> = {
  credential_stuffing: 3,
  insider_threat: 2,
  ransomware_lateral: 1.2,
  mass_password_reset: 1.5,
  audit_season_surge: 1.5,
  mass_termination_reorg: 1,
  payroll_batch: 1,
  connector_outage: 1,
};

const DEFAULTS = {
  meanIntervalSimMin: 60,
  maxConcurrent: 2,
  intensityMin: 0.35,
  intensityMax: 0.85,
} as const;

/** Clamp a possibly-undefined number into [lo, hi], falling back when absent/non-finite. */
function clampNum(value: number | undefined, fallback: number, lo: number, hi: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value < lo ? lo : value > hi ? hi : value;
}

/** A {@link ThreatProfile} with every optional field resolved to a concrete value. */
export interface ResolvedThreatProfile {
  meanIntervalSimMin: number;
  maxConcurrent: number;
  intensityMin: number;
  intensityMax: number;
  /** Weights aligned index-for-index to {@link THREAT_INCIDENT_KINDS}. */
  weights: number[];
}

/**
 * Resolve a (possibly sparse) profile against defaults, clamping to sane ranges. A
 * kindWeight of 0 is preserved (it excludes that kind); an absent one takes the default.
 */
export function resolveThreatProfile(profile: ThreatProfile | undefined): ResolvedThreatProfile {
  const meanIntervalSimMin = clampNum(profile?.meanIntervalSimMin, DEFAULTS.meanIntervalSimMin, 1, 1440);
  const maxConcurrent = Math.round(clampNum(profile?.maxConcurrent, DEFAULTS.maxConcurrent, 1, 8));
  let intensityMin = clampNum(profile?.intensityMin, DEFAULTS.intensityMin, 0, 1);
  let intensityMax = clampNum(profile?.intensityMax, DEFAULTS.intensityMax, 0, 1);
  if (intensityMin > intensityMax) [intensityMin, intensityMax] = [intensityMax, intensityMin];
  const weights = THREAT_INCIDENT_KINDS.map((kind) => {
    const w = profile?.kindWeights?.[kind];
    return typeof w === 'number' && Number.isFinite(w) && w >= 0 ? w : DEFAULT_KIND_WEIGHTS[kind];
  });
  return { meanIntervalSimMin, maxConcurrent, intensityMin, intensityMax, weights };
}

/** A live threat scheduler bound to one run. */
export interface ThreatScheduler {
  /**
   * Advance to simulated time `simNowMs` and return the incident configs to spawn now.
   * Emits at most one incident per call, and none while `activeCount` has reached the
   * profile's maxConcurrent (the pending incident simply waits for a free slot rather
   * than piling up). Each returned config omits `startAtSec`; the runtime normalizes it
   * to fire immediately.
   */
  due(simNowMs: number, activeCount: number): ChaosInjectorConfig[];
  /** The resolved profile in force (telemetry and tests). */
  readonly profile: ResolvedThreatProfile;
}

/**
 * Create a threat scheduler.
 *
 * @param deps `prng` (forked off the run id so timing varies per run) and the resolved
 *   `profile`.
 */
export function createThreatScheduler(deps: { prng: Prng; profile: ResolvedThreatProfile }): ThreatScheduler {
  const { prng, profile } = deps;
  const ratePerSimSec = 1 / (profile.meanIntervalSimMin * 60);
  let nextIncidentSimMs: number | null = null;

  const sampleIntensity = (): number =>
    profile.intensityMin + prng.next() * (profile.intensityMax - profile.intensityMin);

  const pickKind = (simNowMs: number): ChaosInjectorKind => {
    const hourUtc = Math.floor(simNowMs / 3_600_000) % 24;
    const night = hourUtc < 6 || hourUtc >= 22;
    const weights = night
      ? profile.weights.map((w, i) => (NIGHT_BIASED.has(THREAT_INCIDENT_KINDS[i] as ChaosInjectorKind) ? w * 2 : w))
      : profile.weights;
    return THREAT_INCIDENT_KINDS[prng.weightedIndex(weights)] ?? 'credential_stuffing';
  };

  return {
    profile,
    due(simNowMs: number, activeCount: number): ChaosInjectorConfig[] {
      if (nextIncidentSimMs === null) {
        // Warm-up: land the first incident sooner than a full mean interval so a run
        // shows a coordinated incident early rather than only ambient noise for minutes.
        nextIncidentSimMs = simNowMs + prng.exponentialMs(ratePerSimSec) * 0.4;
        return [];
      }
      if (simNowMs < nextIncidentSimMs) return [];
      // At capacity: hold the pending incident (do NOT reschedule) until a slot frees, so
      // a busy stretch defers new incidents rather than dropping or stacking them.
      if (activeCount >= profile.maxConcurrent) return [];
      const kind = pickKind(simNowMs);
      const intensity = sampleIntensity();
      nextIncidentSimMs = simNowMs + prng.exponentialMs(ratePerSimSec);
      return [{ kind, enabled: true, intensity, params: {} }];
    },
  };
}
