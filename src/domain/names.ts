/**
 * Identity name generation and email/username collision handling.
 *
 * WHY this module exists: a realistic identity manager must survive the messy
 * reality of human names, so the workforce is seeded with deliberate edge cases,
 * accented and CJK and emoji-bearing names, mononyms, apostrophes and hyphens,
 * pathologically long names, and duplicate people, then forced through the same
 * deterministic derivation of `first.last@db.com` emails and sAMAccountName-style
 * usernames a real HR-to-AD pipeline would use. Collisions are inevitable by
 * construction and are resolved with the exact strategies the `NameCollisionPayload`
 * event models: numeric suffix, middle initial, or location suffix.
 *
 * Determinism: every random choice is drawn from the injected seeded RNG, so a
 * given seed reproduces the same names, the same collisions and the same
 * resolutions.
 */

import type { LocationCode } from '../types/index.js';

/** The RNG surface used for name generation (satisfied structurally by Faker). */
export interface NameRng {
  number: { int(options: { min: number; max: number }): number };
  helpers: {
    arrayElement<T>(array: readonly T[]): T;
    weightedArrayElement<T>(array: ReadonlyArray<{ weight: number; value: T }>): T;
  };
  string: { alphanumeric(length: number): string };
  person: { firstName(sex?: 'male' | 'female'): string; lastName(): string };
}

/** The categories of name the seeder can request to exercise downstream systems. */
export type NameKind =
  | 'normal'
  | 'unicode'
  | 'cjk'
  | 'emoji'
  | 'long'
  | 'mononym'
  | 'hyphenated'
  | 'apostrophe';

/** The three collision-resolution strategies, matching NameCollisionPayload. */
export type CollisionStrategy = 'numeric_suffix' | 'middle_initial' | 'location_suffix';

/** Attributes that can collide and be resolved. */
export type CollidingAttribute = 'email' | 'username' | 'displayName';

/** Metadata describing how a single attribute collision was resolved. */
export interface CollisionInfo {
  attribute: CollidingAttribute;
  /** Ids of the previously-allocated identities that already held the value. */
  collidingWith: string[];
  strategy: CollisionStrategy;
  /** The disambiguating suffix/token that was applied (e.g. "2", "m", "ldn"). */
  generatedSuffix: string;
}

/** A fully-allocated, collision-resolved identity name bundle. */
export interface AllocatedName {
  firstName: string;
  lastName: string;
  displayName: string;
  email: string;
  username: string;
  /** Present when the email or username had to be disambiguated. */
  collisions: CollisionInfo[];
}

/* --- Curated multicultural edge-case name pools ---------------------------- */

const UNICODE_FIRST: readonly string[] = [
  'José',
  'Zoë',
  'Renée',
  'Søren',
  'Björn',
  'François',
  'Łukasz',
  'Anaïs',
  'André',
  'Céline',
  'Jörg',
  'Élodie',
  'Mónica',
  'Nadège',
  'Þóra',
  'Sinéad',
];

const UNICODE_LAST: readonly string[] = [
  'Müller',
  'Skłodowska',
  'Nguyễn',
  'Öztürk',
  'Größ',
  'Håkonsen',
  'Đoković',
  'Češková',
  'Åberg',
  'Fernández',
  'Krämer',
  'Lindqvist',
];

/** [family, given] pairs across Chinese, Japanese and Korean naming. */
const CJK_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['李', '明'],
  ['王', '芳'],
  ['张', '伟'],
  ['陈', '静'],
  ['刘', '洋'],
  ['黄', '磊'],
  ['佐藤', '健'],
  ['鈴木', '一郎'],
  ['田中', '花子'],
  ['김', '민준'],
  ['이', '서연'],
  ['박', '지훈'],
];

const EMOJI_SUFFIXES: readonly string[] = ['🚀', '⚡', '🐋', '🔥', '💡', '🦅'];

const HYPHEN_JOINS: readonly string[] = ['-', '‑']; // ASCII hyphen and non-breaking hyphen.

/**
 * Normalize an arbitrary display string into an email-safe local-part fragment:
 * decompose accents (NFKD), drop combining marks, and keep only ASCII letters and
 * digits. Returns an empty string for scripts with no ASCII transliteration (e.g.
 * pure CJK), which the allocator handles by falling back to a stable token.
 */
export function slugForEmail(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();
}

/** Build a raw (pre-collision) email local part from first and last names. */
function localPart(first: string, last: string, rng: NameRng): string {
  const f = slugForEmail(first) || 'x';
  const l = slugForEmail(last) || rng.string.alphanumeric(5).toLowerCase();
  return `${f}.${l}`;
}

/** Build a raw (pre-collision) sAMAccountName-style username (<= 20 chars). */
function rawUsername(first: string, last: string, rng: NameRng): string {
  const f = slugForEmail(first) || 'x';
  const l = slugForEmail(last) || rng.string.alphanumeric(5).toLowerCase();
  const initial = f.charAt(0) || 'x';
  return `${initial}${l}`.slice(0, 16);
}

/**
 * Generate a first/last/display name of the requested kind. Only the mechanics of
 * shaping the name live here; the distribution of kinds is the seeder's decision.
 *
 * @param rng Seeded RNG.
 * @param kind The edge-case category to produce.
 * @returns The raw name parts before email/username allocation.
 */
export function generateName(
  rng: NameRng,
  kind: NameKind,
): { firstName: string; lastName: string; displayName: string } {
  switch (kind) {
    case 'unicode': {
      const firstName = rng.helpers.arrayElement(UNICODE_FIRST);
      const lastName = rng.helpers.arrayElement(UNICODE_LAST);
      return { firstName, lastName, displayName: `${firstName} ${lastName}` };
    }
    case 'cjk': {
      const [family, given] = rng.helpers.arrayElement(CJK_NAMES);
      // Rendered family-name-first, as the source cultures write them.
      return { firstName: given, lastName: family, displayName: `${family} ${given}` };
    }
    case 'emoji': {
      const firstName = `${rng.person.firstName()} ${rng.helpers.arrayElement(EMOJI_SUFFIXES)}`;
      const lastName = rng.person.lastName();
      return { firstName, lastName, displayName: `${firstName} ${lastName}` };
    }
    case 'long': {
      // A pathologically long multi-barrelled surname. Keep appending components
      // until the surname alone is very long (>= 60 chars) so the case genuinely
      // stresses field-length handling downstream.
      const parts: string[] = [];
      let lastName = '';
      while (lastName.length < 60) {
        parts.push(rng.person.lastName());
        lastName = parts.join('-');
      }
      const firstName = `${rng.person.firstName()}-${rng.person.firstName()}`;
      return { firstName, lastName, displayName: `${firstName} ${lastName}` };
    }
    case 'mononym': {
      // Single legal name; the surname is intentionally empty.
      const firstName = rng.person.firstName();
      return { firstName, lastName: '', displayName: firstName };
    }
    case 'hyphenated': {
      const firstName = rng.person.firstName();
      const lastName = `${rng.person.lastName()}${rng.helpers.arrayElement(HYPHEN_JOINS)}${rng.person.lastName()}`;
      return { firstName, lastName, displayName: `${firstName} ${lastName}` };
    }
    case 'apostrophe': {
      const firstName = rng.person.firstName();
      const lastName = `O'${rng.person.lastName()}`;
      return { firstName, lastName, displayName: `${firstName} ${lastName}` };
    }
    case 'normal':
    default: {
      const firstName = rng.person.firstName();
      const lastName = rng.person.lastName();
      return { firstName, lastName, displayName: `${firstName} ${lastName}` };
    }
  }
}

/** Strategy mix: numeric suffixes dominate real directories; others add variety. */
const STRATEGY_MIX: ReadonlyArray<{ weight: number; value: CollisionStrategy }> = [
  { weight: 6, value: 'numeric_suffix' },
  { weight: 2, value: 'middle_initial' },
  { weight: 2, value: 'location_suffix' },
];

/**
 * Allocates unique emails and usernames across a population, resolving the
 * inevitable collisions deterministically. One allocator instance owns the used-set
 * for a whole seeded population (and continues to own it for runtime hires), so
 * uniqueness holds across the entire run.
 *
 * The allocator is intentionally the ONLY place `@db.com` addresses are minted so
 * the collision policy cannot drift.
 */
export class NameAllocator {
  private readonly rng: NameRng;
  /** email -> id of the first identity that claimed it. */
  private readonly emailOwners = new Map<string, string>();
  /** username -> id of the first identity that claimed it. */
  private readonly usernameOwners = new Map<string, string>();

  constructor(rng: NameRng) {
    this.rng = rng;
  }

  /** Number of distinct emails allocated so far. */
  public emailCount(): number {
    return this.emailOwners.size;
  }

  /**
   * Allocate a unique email and username for an identity, resolving collisions.
   *
   * @param params.ownerId The identity's stable id (used to report collidingWith).
   * @param params.firstName Given name (may be unicode/emoji/empty for mononyms).
   * @param params.lastName Family name (may be empty for mononyms).
   * @param params.location Site code, used by the location_suffix strategy.
   * @param params.displayName Optional pre-built display name; derived otherwise.
   * @returns The resolved name bundle including any collision metadata.
   */
  public allocate(params: {
    ownerId: string;
    firstName: string;
    lastName: string;
    location: LocationCode;
    displayName?: string;
  }): AllocatedName {
    const { ownerId, firstName, lastName, location } = params;
    const displayName = params.displayName ?? `${firstName} ${lastName}`.trim();
    const collisions: CollisionInfo[] = [];

    const email = this.resolveEmail(ownerId, firstName, lastName, location, collisions);
    const username = this.resolveUsername(ownerId, firstName, lastName, collisions);

    return { firstName, lastName, displayName, email, username, collisions };
  }

  private resolveEmail(
    ownerId: string,
    first: string,
    last: string,
    location: LocationCode,
    collisions: CollisionInfo[],
  ): string {
    const base = localPart(first, last, this.rng);
    const candidate = `${base}@db.com`;
    if (!this.emailOwners.has(candidate)) {
      this.emailOwners.set(candidate, ownerId);
      return candidate;
    }

    const priorOwner = this.emailOwners.get(candidate);
    const strategy = this.rng.helpers.weightedArrayElement(STRATEGY_MIX);
    const { value, suffix } = this.disambiguateEmail(base, first, location, strategy);
    this.emailOwners.set(value, ownerId);
    collisions.push({
      attribute: 'email',
      collidingWith: priorOwner ? [priorOwner] : [],
      strategy,
      generatedSuffix: suffix,
    });
    return value;
  }

  private disambiguateEmail(
    base: string,
    first: string,
    location: LocationCode,
    strategy: CollisionStrategy,
  ): { value: string; suffix: string } {
    if (strategy === 'middle_initial') {
      const [f, l] = base.split('.');
      for (let code = 0; code < 26; code += 1) {
        const initial = String.fromCharCode(97 + code);
        const value = `${f}.${initial}.${l}@db.com`;
        if (!this.emailOwners.has(value)) {
          return { value, suffix: initial };
        }
      }
      // Exhausted initials; fall through to numeric.
    } else if (strategy === 'location_suffix') {
      const loc = location.toLowerCase();
      const value = `${base}.${loc}@db.com`;
      if (!this.emailOwners.has(value)) {
        return { value, suffix: loc };
      }
      // Location already used too; fall through to numeric.
    }
    // numeric_suffix (also the guaranteed-terminating fallback).
    for (let n = 2; ; n += 1) {
      const value = `${base}${n}@db.com`;
      if (!this.emailOwners.has(value)) {
        return { value, suffix: String(n) };
      }
    }
  }

  private resolveUsername(
    ownerId: string,
    first: string,
    last: string,
    collisions: CollisionInfo[],
  ): string {
    const base = rawUsername(first, last, this.rng);
    if (!this.usernameOwners.has(base)) {
      this.usernameOwners.set(base, ownerId);
      return base;
    }
    const priorOwner = this.usernameOwners.get(base);
    for (let n = 2; ; n += 1) {
      const value = `${base.slice(0, 14)}${n}`;
      if (!this.usernameOwners.has(value)) {
        this.usernameOwners.set(value, ownerId);
        collisions.push({
          attribute: 'username',
          collidingWith: priorOwner ? [priorOwner] : [],
          strategy: 'numeric_suffix',
          generatedSuffix: String(n),
        });
        return value;
      }
    }
  }
}
