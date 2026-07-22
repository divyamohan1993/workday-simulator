/**
 * Event-mix resolution and weighted kind selection.
 *
 * The runtime picks each primary event's kind by weight. The base weight of a kind
 * is its category weight times an optional per-kind override; active chaos injectors
 * then multiply the weights of their signature kinds so the stream visibly shifts
 * toward, say, login failures during a credential-stuffing burst. Resolution is
 * separated from selection so the runtime can resolve once per tick (only when the
 * active-chaos set changes) and then pick cheaply per event.
 */

import type { EventKind, EventMixWeights } from '../types/index.js';
import { ALL_EVENT_KINDS, EVENT_CATEGORY } from '../types/index.js';
import type { Prng } from './prng.js';

/**
 * A precomputed selection table: the enabled kinds and a parallel cumulative-weight
 * array for O(log n) or O(n) sampling. Kinds with zero effective weight are omitted.
 */
export interface ResolvedMix {
  kinds: EventKind[];
  cumulative: number[];
  total: number;
}

/**
 * Build a selection table from the scenario mix and optional per-kind bias
 * multipliers (from active chaos injectors). A kind's effective weight is
 * `byCategory[category] * (byKind[kind] ?? 1) * (bias[kind] ?? 1)`. A non-positive
 * category weight disables every kind in that category unless a per-kind override or
 * bias lifts the specific kind above zero.
 *
 * @param mix Scenario event-mix weights.
 * @param biases Optional per-kind multipliers applied on top of the base weights.
 */
export function resolveMix(
  mix: EventMixWeights,
  biases?: ReadonlyMap<EventKind, number>,
): ResolvedMix {
  const kinds: EventKind[] = [];
  const cumulative: number[] = [];
  let total = 0;

  for (const kind of ALL_EVENT_KINDS) {
    const category = EVENT_CATEGORY[kind];
    if (!category) continue;
    const categoryWeight = mix.byCategory[category] ?? 0;
    const kindOverride = mix.byKind?.[kind] ?? 1;
    const bias = biases?.get(kind) ?? 1;
    const weight = categoryWeight * kindOverride * bias;
    if (!Number.isFinite(weight) || weight <= 0) continue;
    total += weight;
    kinds.push(kind);
    cumulative.push(total);
  }

  return { kinds, cumulative, total };
}

/**
 * Pick a kind from a resolved mix using the PRNG. Returns null only when the mix is
 * empty (every category weighted zero), which the runtime treats as "generate
 * nothing this arrival".
 */
export function pickKind(prng: Prng, resolved: ResolvedMix): EventKind | null {
  const { kinds, cumulative, total } = resolved;
  if (kinds.length === 0 || total <= 0) return null;
  const target = prng.next() * total;
  // Linear scan: the kind universe is small (46), so a binary search would not pay
  // for its added complexity on this path.
  for (let i = 0; i < cumulative.length; i += 1) {
    const bound = cumulative[i];
    if (bound !== undefined && target < bound) return kinds[i] ?? null;
  }
  return kinds[kinds.length - 1] ?? null;
}

/**
 * Merge several per-kind bias maps by multiplying overlapping entries. Used by the
 * runtime to compose the biases of all currently-active chaos injectors.
 */
export function mergeBiases(maps: ReadonlyArray<ReadonlyMap<EventKind, number>>): Map<EventKind, number> {
  const merged = new Map<EventKind, number>();
  for (const map of maps) {
    for (const [kind, factor] of map) {
      merged.set(kind, (merged.get(kind) ?? 1) * factor);
    }
  }
  return merged;
}
