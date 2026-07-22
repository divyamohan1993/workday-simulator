/**
 * The seeded, deterministic Deutsche Bank workforce and its IdentityPool.
 *
 * WHY this module exists: it is the single owner of identity state for the whole
 * simulator. It seeds a realistic Deutsche Bank population (org hierarchy, cost
 * centers, legal entities, grade and division mixes, birthright entitlements, a
 * fraction of machine identities, and deliberate edge cases) deterministically from
 * a seed string, and it applies the Joiner/Mover/Leaver lifecycle mutations the
 * event generator drives. Determinism is the contract: the same (size, seed) always
 * yields byte-identical people, so runs replay exactly.
 *
 * Design decisions that matter to consumers:
 * - Acyclicity by construction. A manager always has strictly higher grade
 *   seniority than the report, so the reporting graph is a DAG and cycles are
 *   impossible. `changeManager` additionally rejects any edit that would close a
 *   cycle at runtime.
 * - The pool applies entitlement changes INSIDE its mutation methods (hire attaches
 *   birthright access, transfer/promotion recompute the division and grade baseline,
 *   grant/revoke are explicit). The frozen `IdentityPool` methods return the updated
 *   `Employee`. For the engine to emit provision/revoke it needs the delta, so this
 *   module also exports standalone `apply*` helpers that wrap a pool mutation and
 *   return `{ employee, granted, revoked, retained }` by diffing before/after.
 * - Sampling (`pick`, `pickActive`) draws from a SEPARATE seeded RNG so that reads
 *   can never perturb the structural/mint RNG and change what gets generated.
 *
 * No wall clock is read during `seed()`: every seeded timestamp derives from a fixed
 * reference epoch and the seeded RNG.
 */

import { Faker, base, en } from '@faker-js/faker';
import type { Logger } from 'pino';
import type { IdentityPoolFactory } from '../contracts/factories.js';
import type { IdentityPool } from '../contracts/identity-pool.js';
import type {
  CostCenter,
  Division,
  Employee,
  EmployeeType,
  Entitlement,
  Grade,
  IdentityPoolStats,
  IdentityRef,
  IdentityStatus,
  JobFamily,
  LocationCode,
} from '../types/index.js';
import { ALL_DIVISIONS, ALL_LOCATIONS, GRADE_SENIORITY } from '../types/index.js';
import {
  baselineTemplatesFor,
  mintEntitlement,
  TOXIC_PAIRS,
  type EntitlementProfile,
} from './entitlements.js';
import { generateName, NameAllocator, type NameKind } from './names.js';
import {
  buildCostCenterCatalog,
  indexCostCentersByDivision,
  isoFromEpoch,
  pickDivision,
  pickEmployeeType,
  pickGrade,
  pickJobFamily,
  pickLocation,
  resolveLegalEntity,
  SEED_REFERENCE_EPOCH_MS,
  titleFor,
  businessActivityWeight,
} from './org.js';
import { detectSodConflicts } from './sod.js';

/** All lifecycle statuses, for stats initialization and iteration. */
const ALL_STATUSES: readonly IdentityStatus[] = [
  'active',
  'onboarding',
  'suspended',
  'on_leave',
  'terminated',
  'disabled',
  'dormant',
];

/** All employment types, for stats initialization. */
const ALL_TYPES: readonly EmployeeType[] = ['FTE', 'Contractor', 'Intern', 'External', 'Service'];

/** All grades, for stats initialization. */
const ALL_GRADES: readonly Grade[] = Object.keys(GRADE_SENIORITY) as Grade[];

const MS_PER_DAY = 86_400_000;

/** Deterministic 32-bit FNV-1a hash so a seed STRING can seed the numeric RNG. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Weighted per-identity distribution of edge-case name kinds. */
const NAME_KIND_MIX: ReadonlyArray<{ weight: number; value: NameKind }> = [
  { weight: 82, value: 'normal' },
  { weight: 6, value: 'unicode' },
  { weight: 3, value: 'cjk' },
  { weight: 3, value: 'hyphenated' },
  { weight: 2, value: 'apostrophe' },
  { weight: 2, value: 'long' },
  { weight: 1, value: 'mononym' },
  { weight: 1, value: 'emoji' },
];

/** Weighted lifecycle status distribution for a freshly-seeded human identity. */
const STATUS_MIX: ReadonlyArray<{ weight: number; value: IdentityStatus }> = [
  { weight: 85, value: 'active' },
  { weight: 3, value: 'onboarding' },
  { weight: 3, value: 'on_leave' },
  { weight: 2, value: 'suspended' },
  { weight: 3, value: 'dormant' },
  { weight: 3, value: 'terminated' },
  { weight: 1, value: 'disabled' },
];

/**
 * An O(1) random-access multiset of ids: add, remove and uniform random sampling all
 * run in constant time. Used to keep a live per-location index of active human
 * identities so `pickActive` never scans the population. Removal is swap-with-last.
 */
class IndexedBag {
  private readonly items: string[] = [];
  private readonly positions = new Map<string, number>();

  public add(id: string): void {
    if (this.positions.has(id)) {
      return;
    }
    this.positions.set(id, this.items.length);
    this.items.push(id);
  }

  public remove(id: string): void {
    const idx = this.positions.get(id);
    if (idx === undefined) {
      return;
    }
    const lastIdx = this.items.length - 1;
    const lastId = this.items[lastIdx];
    if (lastId !== undefined) {
      this.items[idx] = lastId;
      this.positions.set(lastId, idx);
    }
    this.items.pop();
    this.positions.delete(id);
  }

  public size(): number {
    return this.items.length;
  }

  /** Uniformly sample an id using an integer draw in [0, size). */
  public sample(drawInt: (maxExclusive: number) => number): string | undefined {
    if (this.items.length === 0) {
      return undefined;
    }
    return this.items[drawInt(this.items.length)];
  }
}

/** Per-entitlement bookkeeping the pool keeps privately to drive baseline diffs. */
interface EntitlementMeta {
  /** Template key this grant was minted from ("ADHOC" for explicit grants). */
  templateKey: string;
  /** True when the grant is part of the role-based baseline (JML managed). */
  baseline: boolean;
}

/** The entitlement delta a lifecycle mutation produced. */
export interface EntitlementDelta {
  granted: Entitlement[];
  revoked: Entitlement[];
  retained: Entitlement[];
}

/** The outcome of a lifecycle helper: the affected identity plus its delta. */
export interface JmlOutcome extends EntitlementDelta {
  employee: Employee;
}

/** Slot decided in the grade pre-pass, before employees are materialized. */
interface Slot {
  type: EmployeeType;
  grade: Grade;
  isNonHuman: boolean;
}

/**
 * The concrete workforce. Implements the frozen `IdentityPool` contract and owns all
 * identity state. Constructed once by the server via `createIdentityPool`; seeded per
 * run by the runtime.
 */
class WorkforceIdentityPool implements IdentityPool {
  private readonly logger: Logger;

  /** Structural + mint RNG: drives population generation and entitlement ids. */
  private readonly structural: Faker = new Faker({ locale: [en, base] });
  /** Sampling RNG: drives pick/pickActive so reads never shift generation. */
  private readonly sampling: Faker = new Faker({ locale: [en, base] });

  private readonly byId = new Map<string, Employee>();
  private readonly order: string[] = [];
  private readonly entMeta = new Map<string, EntitlementMeta>();
  private readonly activeHumansByLoc = new Map<LocationCode, IndexedBag>();

  private costCenters: CostCenter[] = [];
  private ccByDivision: Record<Division, CostCenter[]> = indexCostCentersByDivision([]);
  private nameAllocator = new NameAllocator(this.structural);

  private currentSeed = '';
  private currentSize = 0;
  private nextEmployeeNumber = 100_000;

  /**
   * Monotonic id counter. `faker.string.nanoid()` costs ~70us/call, which dominates
   * seeding when ~10 entitlements per identity are minted (hundreds of thousands of
   * ids at 90k). A base36 counter is unique, deterministic and effectively free.
   */
  private idSeq = 0;
  /** Fast id-token source injected into `mintEntitlement` in place of nanoid. */
  private readonly entRng = { string: { nanoid: (): string => this.nextToken() } };

  /** Manager-candidate buckets, built once per seed from human identities. */
  private humanIdsBySeniority = new Map<number, string[]>();
  private humanIdsByDivSeniority = new Map<string, string[]>();

  /** Cached pickActive location weights, keyed by simulated minute. */
  private weightBucket = Number.NaN;
  private weightVector: Record<LocationCode, number> = emptyLocationRecord();

  constructor(logger: Logger) {
    this.logger = logger.child({ module: 'identity-pool' });
    for (const loc of ALL_LOCATIONS) {
      this.activeHumansByLoc.set(loc, new IndexedBag());
    }
  }

  /* --- Seeding ------------------------------------------------------------ */

  public seed(size: number, seed: string): void {
    if (!Number.isInteger(size) || size < 1) {
      throw new Error(`IdentityPool.seed: size must be a positive integer, got ${size}`);
    }
    const started = Date.now();
    this.reset(seed);

    const perDivision = Math.max(3, Math.min(40, Math.round(size / 500)));
    this.costCenters = buildCostCenterCatalog(this.structural, perDivision);
    this.ccByDivision = indexCostCentersByDivision(this.costCenters);

    const slots = this.planSlots(size);
    for (let i = 0; i < size; i += 1) {
      const slot = slots[i];
      if (slot) {
        this.materialize(slot);
      }
    }
    this.buildManagerBuckets();
    this.assignManagers();

    this.logger.info(
      {
        size: this.byId.size,
        seed,
        nonHuman: this.countNonHuman(),
        costCenters: this.costCenters.length,
        ms: Date.now() - started,
      },
      'identity pool seeded',
    );
  }

  /** Clear every piece of per-seed state and re-seed both RNGs. */
  private reset(seed: string): void {
    this.byId.clear();
    this.order.length = 0;
    this.entMeta.clear();
    // Drop every prior identity reference by replacing all location bags.
    for (const loc of ALL_LOCATIONS) {
      this.activeHumansByLoc.set(loc, new IndexedBag());
    }
    this.humanIdsBySeniority = new Map();
    this.humanIdsByDivSeniority = new Map();
    this.nextEmployeeNumber = 100_000;
    this.idSeq = 0;
    this.weightBucket = Number.NaN;
    this.currentSeed = seed;
    this.currentSize = 0;
    this.structural.seed(hashSeed(seed));
    this.sampling.seed(hashSeed(`${seed}::sampling`));
    this.nameAllocator = new NameAllocator(this.structural);
  }

  /**
   * Decide the (type, grade) of every identity up front and guarantee at least one
   * MD exists so every non-MD has a valid, more-senior manager candidate (the MD is
   * the root of the reporting tree). Deterministic given the structural RNG.
   */
  private planSlots(size: number): Slot[] {
    const slots: Slot[] = [];
    let topHumanIdx = -1;
    let topHumanSeniority = -1;
    let hasMd = false;

    for (let i = 0; i < size; i += 1) {
      const type = pickEmployeeType(this.structural);
      const isNonHuman = type === 'Service';
      const grade = pickGrade(this.structural, type);
      slots.push({ type, grade, isNonHuman });
      if (!isNonHuman) {
        const sen = GRADE_SENIORITY[grade];
        if (grade === 'MD') {
          hasMd = true;
        }
        if (sen > topHumanSeniority) {
          topHumanSeniority = sen;
          topHumanIdx = i;
        }
      }
    }

    // If no MD was drawn but humans exist, promote the most senior human so the tree
    // has a legitimate root and the "non-MD has a manager" invariant stays crisp.
    if (!hasMd && topHumanIdx >= 0) {
      const top = slots[topHumanIdx];
      if (top) {
        top.grade = 'MD';
      }
    }
    return slots;
  }

  /** Materialize one identity from its slot and insert it into the pool. */
  private materialize(slot: Slot): void {
    const id = `emp_${this.nextToken()}`;
    const employeeId = this.mintEmployeeNumber();
    const division = pickDivision(this.structural);
    const location = pickLocation(this.structural);
    const jobFamily = pickJobFamily(this.structural, division, slot.isNonHuman);
    const preferFund = division === 'Asset Management' && this.chance(0.25);
    const legalEntity = resolveLegalEntity(division, location, preferFund);
    const costCenter = this.pickCostCenter(division);
    const status = slot.isNonHuman ? this.serviceStatus() : this.humanStatus();

    const startDateMs = this.seededStartDate();
    const name = this.buildName(id, slot, location);

    const profile: EntitlementProfile = {
      division,
      grade: slot.grade,
      type: slot.type,
      location,
      jobFamily,
      isNonHuman: slot.isNonHuman,
    };

    const edgeCases: string[] = [];
    if (name.edgeCase) {
      edgeCases.push(name.edgeCase);
    }
    if (name.hadCollision) {
      edgeCases.push('name_collision');
    }

    let entitlements = this.mintBaseline(profile, startDateMs);
    const orphan = this.decideOrphan(status, slot.isNonHuman);
    if ((status === 'terminated' || status === 'disabled') && !orphan) {
      // Cleanly offboarded: access was deprovisioned, so no lingering grants.
      for (const ent of entitlements) {
        this.entMeta.delete(ent.id);
      }
      entitlements = [];
    } else if (orphan) {
      edgeCases.push('orphan');
    }
    const dormant = status === 'dormant';
    if (dormant) {
      edgeCases.push('dormant');
    }

    // Deliberately seed a fraction of identities with a toxic SoD combination.
    if (!slot.isNonHuman && entitlements.length > 0 && this.chance(0.03)) {
      this.injectToxicPair(entitlements, profile, startDateMs);
      edgeCases.push('sod_conflict');
    }

    const employee: Employee = {
      id,
      employeeId,
      firstName: name.firstName,
      lastName: name.lastName,
      displayName: name.displayName,
      email: name.email,
      username: name.username,
      managerId: null,
      division,
      jobFamily,
      grade: slot.grade,
      type: slot.type,
      status,
      location,
      legalEntity,
      costCenter,
      entitlements,
      startDate: isoFromEpoch(startDateMs),
      attributes: this.buildAttributes(profile, startDateMs, status, dormant, edgeCases),
      isNonHuman: slot.isNonHuman,
      createdAt: isoFromEpoch(startDateMs),
      updatedAt: isoFromEpoch(startDateMs),
    };
    if (status === 'terminated' || status === 'disabled') {
      employee.endDate = isoFromEpoch(this.seededEndDate(startDateMs));
    }

    this.insert(employee);
  }

  /** Insert an identity, maintaining order, id map and the active-human index. */
  private insert(employee: Employee): void {
    this.byId.set(employee.id, employee);
    this.order.push(employee.id);
    this.currentSize = this.byId.size;
    if (!employee.isNonHuman && employee.status === 'active') {
      this.bagFor(employee.location).add(employee.id);
    }
  }

  private mintBaseline(profile: EntitlementProfile, startDateMs: number): Entitlement[] {
    const templates = baselineTemplatesFor(profile);
    const grantedAtMs = startDateMs + this.structural.number.int({ min: 0, max: 3 }) * MS_PER_DAY;
    const out: Entitlement[] = [];
    for (const template of templates) {
      const ent = mintEntitlement(this.entRng, template, profile, { grantedAtMs });
      this.entMeta.set(ent.id, { templateKey: template.key, baseline: true });
      out.push(ent);
    }
    return out;
  }

  /** Grant both sides of a random toxic pair the identity does not already hold. */
  private injectToxicPair(
    entitlements: Entitlement[],
    profile: EntitlementProfile,
    startDateMs: number,
  ): void {
    const pair = this.structural.helpers.arrayElement(TOXIC_PAIRS);
    const heldKeys = new Set(
      entitlements.map((e) => this.entMeta.get(e.id)?.templateKey).filter(Boolean),
    );
    for (const template of pair) {
      if (heldKeys.has(template.key)) {
        continue;
      }
      const ent = mintEntitlement(this.entRng, template, profile, { grantedAtMs: startDateMs });
      this.entMeta.set(ent.id, { templateKey: template.key, baseline: false });
      entitlements.push(ent);
    }
  }

  private buildManagerBuckets(): void {
    for (const id of this.order) {
      const emp = this.byId.get(id);
      if (!emp || emp.isNonHuman) {
        continue;
      }
      const sen = GRADE_SENIORITY[emp.grade];
      pushToBucket(this.humanIdsBySeniority, sen, id);
      pushToBucket(this.humanIdsByDivSeniority, `${emp.division}|${sen}`, id);
    }
  }

  private assignManagers(): void {
    for (const id of this.order) {
      const emp = this.byId.get(id);
      if (!emp) {
        continue;
      }
      if (!emp.isNonHuman && emp.grade === 'MD') {
        continue; // MDs are the top of house; no manager.
      }
      // Deliberate missing-manager edge case for a small fraction of non-MD humans.
      if (!emp.isNonHuman && this.chance(0.005)) {
        this.addEdgeCase(emp, 'missing_manager');
        continue;
      }
      const managerId = this.selectManager(emp);
      if (managerId) {
        emp.managerId = managerId;
      } else if (!emp.isNonHuman && emp.grade !== 'MD') {
        // No senior human available (degenerate tiny pool): treat as a root.
        this.addEdgeCase(emp, 'root_no_senior');
      }
    }
  }

  /** Choose a strictly-more-senior human manager, preferring same division and band. */
  private selectManager(emp: Employee): string | null {
    const sen = GRADE_SENIORITY[emp.grade];
    if (emp.isNonHuman) {
      const ownerFloor = Math.max(sen + 1, GRADE_SENIORITY.VP);
      return (
        this.pickFromDivision(emp.division, ownerFloor, GRADE_SENIORITY.MD) ??
        this.pickFromGlobal(GRADE_SENIORITY.VP, GRADE_SENIORITY.MD) ??
        this.pickFromGlobal(sen + 1, GRADE_SENIORITY.MD)
      );
    }
    const bandTop = Math.min(sen + 3, GRADE_SENIORITY.MD);
    return (
      this.pickFromDivision(emp.division, sen + 1, bandTop) ??
      this.pickFromDivision(emp.division, sen + 1, GRADE_SENIORITY.MD) ??
      this.pickFromGlobal(sen + 1, GRADE_SENIORITY.MD)
    );
  }

  private pickFromDivision(division: Division, lo: number, hi: number): string | null {
    return this.pickWeightedAcrossBands(
      (level) => this.humanIdsByDivSeniority.get(`${division}|${level}`),
      lo,
      hi,
    );
  }

  private pickFromGlobal(lo: number, hi: number): string | null {
    return this.pickWeightedAcrossBands((level) => this.humanIdsBySeniority.get(level), lo, hi);
  }

  /**
   * Pick one id uniformly across the union of seniority buckets in [lo, hi] without
   * concatenating them. Buckets in the largest divisions hold thousands of ids;
   * spreading them per identity would make seeding O(n * bucketSize). Instead this
   * sums the (at most eight) bucket sizes, draws a single index, and locates it in
   * the owning bucket, so each of the ~90k manager assignments is O(1) with no large
   * allocation.
   */
  private pickWeightedAcrossBands(
    bucketAt: (level: number) => string[] | undefined,
    lo: number,
    hi: number,
  ): string | null {
    let total = 0;
    for (let level = lo; level <= hi; level += 1) {
      const bucket = bucketAt(level);
      if (bucket) {
        total += bucket.length;
      }
    }
    if (total === 0) {
      return null;
    }
    let offset = this.structural.number.int({ min: 0, max: total - 1 });
    for (let level = lo; level <= hi; level += 1) {
      const bucket = bucketAt(level);
      if (!bucket || bucket.length === 0) {
        continue;
      }
      if (offset < bucket.length) {
        return bucket[offset] ?? null;
      }
      offset -= bucket.length;
    }
    return null;
  }

  /* --- Name / attribute / value helpers ----------------------------------- */

  private buildName(
    id: string,
    slot: Slot,
    location: LocationCode,
  ): {
    firstName: string;
    lastName: string;
    displayName: string;
    email: string;
    username: string;
    edgeCase?: string;
    hadCollision: boolean;
  } {
    if (slot.isNonHuman) {
      return this.buildServiceName(id, location);
    }
    const kind = this.structural.helpers.weightedArrayElement(NAME_KIND_MIX);
    // Force a duplicate name for a fraction of people to drive collision handling.
    const forceDuplicate = this.chance(0.015) && this.order.length > 0;
    const raw = forceDuplicate ? this.duplicateOfExisting() : generateName(this.structural, kind);
    const allocated = this.nameAllocator.allocate({
      ownerId: id,
      firstName: raw.firstName,
      lastName: raw.lastName,
      location,
      displayName: raw.displayName,
    });
    const edgeCase = forceDuplicate ? 'duplicate_name' : nameKindEdge(kind);
    const result = {
      firstName: allocated.firstName,
      lastName: allocated.lastName,
      displayName: allocated.displayName,
      email: allocated.email,
      username: allocated.username,
      hadCollision: allocated.collisions.length > 0,
    };
    return edgeCase ? { ...result, edgeCase } : result;
  }

  private buildServiceName(
    id: string,
    location: LocationCode,
  ): {
    firstName: string;
    lastName: string;
    displayName: string;
    email: string;
    username: string;
    hadCollision: boolean;
  } {
    const app = this.structural.helpers.arrayElement([
      'batch',
      'etl',
      'reconcile',
      'feed',
      'sync',
      'scanner',
      'connector',
      'gateway',
    ]);
    const token = this.structural.string.alphanumeric(4).toLowerCase();
    const svc = `svc-${app}-${token}`;
    const allocated = this.nameAllocator.allocate({
      ownerId: id,
      firstName: 'Service',
      lastName: `${app}-${token}`,
      location,
      displayName: svc,
    });
    return {
      firstName: 'Service',
      lastName: `${app}-${token}`,
      displayName: svc,
      email: allocated.email,
      username: `svc.${app}.${token}`.slice(0, 20),
      hadCollision: allocated.collisions.length > 0,
    };
  }

  private duplicateOfExisting(): { firstName: string; lastName: string; displayName: string } {
    const existingId = this.order[this.structural.number.int({ min: 0, max: this.order.length - 1 })];
    const existing = existingId ? this.byId.get(existingId) : undefined;
    if (existing) {
      return {
        firstName: existing.firstName,
        lastName: existing.lastName,
        displayName: `${existing.firstName} ${existing.lastName}`.trim(),
      };
    }
    return generateName(this.structural, 'normal');
  }

  private buildAttributes(
    profile: EntitlementProfile,
    startDateMs: number,
    status: IdentityStatus,
    dormant: boolean,
    edgeCases: string[],
  ): Record<string, string | number | boolean | null> {
    const lastLoginMs = dormant
      ? startDateMs + this.structural.number.int({ min: 1, max: 30 }) * MS_PER_DAY
      : SEED_REFERENCE_EPOCH_MS - this.structural.number.int({ min: 0, max: 5 }) * MS_PER_DAY;
    const attributes: Record<string, string | number | boolean | null> = {
      title: titleFor(profile.jobFamily, profile.grade),
      phone: this.structural.phone.number({ style: 'international' }),
      buildingCode: `${profile.location}-B${this.structural.number.int({ min: 1, max: 6 })}`,
      floor: this.structural.number.int({ min: 1, max: 40 }),
      adGroupOu: `OU=${profile.division};OU=${profile.location};DC=db;DC=com`,
      riskScore: this.structural.number.int({ min: 0, max: 100 }),
      lastLoginAt: isoFromEpoch(lastLoginMs),
      tenureDays: Math.max(0, Math.round((SEED_REFERENCE_EPOCH_MS - startDateMs) / MS_PER_DAY)),
      onboardingComplete: status !== 'onboarding',
    };
    if (profile.type === 'Contractor' || profile.type === 'Intern' || profile.type === 'External') {
      attributes.contractEndDate = isoFromEpoch(
        SEED_REFERENCE_EPOCH_MS + this.structural.number.int({ min: 30, max: 540 }) * MS_PER_DAY,
      );
    }
    if (edgeCases.length > 0) {
      attributes.edgeCase = edgeCases.join(',');
    }
    return attributes;
  }

  private addEdgeCase(employee: Employee, edge: string): void {
    const existing = employee.attributes.edgeCase;
    employee.attributes.edgeCase =
      typeof existing === 'string' && existing.length > 0 ? `${existing},${edge}` : edge;
  }

  private humanStatus(): IdentityStatus {
    return this.structural.helpers.weightedArrayElement(STATUS_MIX);
  }

  private serviceStatus(): IdentityStatus {
    // Service accounts are mostly active; a slice are dormant/orphaned risks.
    return this.structural.helpers.weightedArrayElement([
      { weight: 88, value: 'active' as IdentityStatus },
      { weight: 7, value: 'dormant' as IdentityStatus },
      { weight: 5, value: 'disabled' as IdentityStatus },
    ]);
  }

  private decideOrphan(status: IdentityStatus, isNonHuman: boolean): boolean {
    if (status === 'terminated' || status === 'disabled') {
      // A fraction of leavers/disabled accounts keep lingering access (orphans);
      // service accounts are especially prone to it.
      return this.chance(isNonHuman ? 0.6 : 0.25);
    }
    return false;
  }

  private seededStartDate(): number {
    const ageDays = this.structural.number.int({ min: 20, max: 3650 });
    return SEED_REFERENCE_EPOCH_MS - ageDays * MS_PER_DAY;
  }

  private seededEndDate(startDateMs: number): number {
    const tenureDays = Math.max(
      15,
      Math.round((SEED_REFERENCE_EPOCH_MS - startDateMs) / MS_PER_DAY) -
        this.structural.number.int({ min: 0, max: 200 }),
    );
    return Math.min(SEED_REFERENCE_EPOCH_MS, startDateMs + tenureDays * MS_PER_DAY);
  }

  private pickCostCenter(division: Division): string {
    const pool = this.ccByDivision[division];
    if (pool.length > 0) {
      return this.structural.helpers.arrayElement(pool).code;
    }
    const fallback = this.costCenters[0];
    return fallback ? fallback.code : `CC-${division}-0000`;
  }

  private mintEmployeeNumber(): string {
    const num = this.nextEmployeeNumber;
    this.nextEmployeeNumber += 1;
    return `DB${String(num).padStart(8, '0')}`;
  }

  /** Next unique, deterministic base36 id token (see `idSeq`). */
  private nextToken(): string {
    this.idSeq += 1;
    return this.idSeq.toString(36);
  }

  private chance(probability: number): boolean {
    return this.structural.number.float({ min: 0, max: 1 }) < probability;
  }

  private bagFor(location: LocationCode): IndexedBag {
    let bag = this.activeHumansByLoc.get(location);
    if (!bag) {
      bag = new IndexedBag();
      this.activeHumansByLoc.set(location, bag);
    }
    return bag;
  }

  private countNonHuman(): number {
    let n = 0;
    for (const emp of this.byId.values()) {
      if (emp.isNonHuman) {
        n += 1;
      }
    }
    return n;
  }

  /* --- Reads -------------------------------------------------------------- */

  public size(): number {
    return this.byId.size;
  }

  public get(id: string): Employee | undefined {
    return this.byId.get(id);
  }

  public ref(id: string): IdentityRef | undefined {
    const emp = this.byId.get(id);
    return emp ? toRef(emp) : undefined;
  }

  /**
   * The eight-site activity-weight vector for a simulated instant, recomputed at
   * most once per simulated minute (Intl formatting is the costly part). This is the
   * single source of the location weighting `pickActive` uses.
   */
  private locationWeights(simEpochMs: number): Record<LocationCode, number> {
    const bucket = Math.floor(simEpochMs / 60_000);
    if (bucket !== this.weightBucket) {
      const vector = emptyLocationRecord();
      for (const loc of ALL_LOCATIONS) {
        vector[loc] = businessActivityWeight(simEpochMs, loc);
      }
      this.weightVector = vector;
      this.weightBucket = bucket;
    }
    return this.weightVector;
  }

  public pickActive(simEpochMs: number): Employee | undefined {
    const weights = this.locationWeights(simEpochMs);
    const weighted: Array<{ weight: number; value: LocationCode }> = [];
    for (const loc of ALL_LOCATIONS) {
      const bag = this.bagFor(loc);
      if (bag.size() > 0) {
        // Floor the weight so an at-work-nowhere instant still resolves someone.
        const w = Math.max(weights[loc], 0.0001) * bag.size();
        weighted.push({ weight: w, value: loc });
      }
    }
    if (weighted.length === 0) {
      return undefined;
    }
    const loc = this.sampling.helpers.weightedArrayElement(weighted);
    const id = this.bagFor(loc).sample((max) => this.sampling.number.int({ min: 0, max: max - 1 }));
    return id ? this.byId.get(id) : undefined;
  }

  public pick(predicate?: (employee: Employee) => boolean): Employee | undefined {
    if (this.order.length === 0) {
      return undefined;
    }
    if (!predicate) {
      const id = this.order[this.sampling.number.int({ min: 0, max: this.order.length - 1 })];
      return id ? this.byId.get(id) : undefined;
    }
    // Reservoir sampling: one pass, uniform among matches, O(1) memory.
    let chosen: Employee | undefined;
    let matches = 0;
    for (const id of this.order) {
      const emp = this.byId.get(id);
      if (emp && predicate(emp)) {
        matches += 1;
        if (this.sampling.number.float({ min: 0, max: 1 }) < 1 / matches) {
          chosen = emp;
        }
      }
    }
    return chosen;
  }

  public all(): Employee[] {
    // A new array of LIVE identity references (not deep-copied): callers must treat
    // entries as read-only snapshots and mutate only through pool methods.
    const out: Employee[] = [];
    for (const id of this.order) {
      const emp = this.byId.get(id);
      if (emp) {
        out.push(emp);
      }
    }
    return out;
  }

  public stats(): IdentityPoolStats {
    const byStatus = zeroRecord(ALL_STATUSES);
    const byType = zeroRecord(ALL_TYPES);
    const byDivision = zeroRecord(ALL_DIVISIONS);
    const byLocation = zeroRecord(ALL_LOCATIONS);
    const byGrade = zeroRecord(ALL_GRADES);
    let nonHuman = 0;
    let withSodConflicts = 0;

    for (const emp of this.byId.values()) {
      byStatus[emp.status] += 1;
      byType[emp.type] += 1;
      byDivision[emp.division] += 1;
      byLocation[emp.location] += 1;
      byGrade[emp.grade] += 1;
      if (emp.isNonHuman) {
        nonHuman += 1;
      }
      if (detectSodConflicts(emp.entitlements).length > 0) {
        withSodConflicts += 1;
      }
    }
    return {
      total: this.byId.size,
      byStatus,
      byType,
      byDivision,
      byLocation,
      byGrade,
      nonHuman,
      withSodConflicts,
    };
  }

  public sodConflicts(id: string): Array<[Entitlement, Entitlement]> {
    const emp = this.byId.get(id);
    return emp ? detectSodConflicts(emp.entitlements) : [];
  }

  /* --- Lifecycle mutations ------------------------------------------------ */

  public hire(partial: Partial<Employee>): Employee {
    const nowMs = this.resolveNowMs(partial);
    const id = partial.id ?? `emp_${this.nextToken()}`;
    const type: EmployeeType = partial.type ?? 'FTE';
    const isNonHuman = partial.isNonHuman ?? type === 'Service';
    const division = partial.division ?? pickDivision(this.structural);
    const location = partial.location ?? pickLocation(this.structural);
    const grade: Grade = partial.grade ?? pickGrade(this.structural, type);
    const jobFamily: JobFamily = partial.jobFamily ?? pickJobFamily(this.structural, division, isNonHuman);
    const legalEntity = partial.legalEntity ?? resolveLegalEntity(division, location);
    const costCenter = partial.costCenter ?? this.pickCostCenter(division);
    const status: IdentityStatus = partial.status ?? 'onboarding';

    const profile: EntitlementProfile = { division, grade, type, location, jobFamily, isNonHuman };
    const name = this.resolveHireName(id, partial, isNonHuman, location);
    // mintBaseline registers baseline meta itself; caller-supplied grants are ad-hoc.
    const entitlements = partial.entitlements ?? this.mintBaseline(profile, nowMs);
    if (partial.entitlements) {
      for (const ent of partial.entitlements) {
        if (!this.entMeta.has(ent.id)) {
          this.entMeta.set(ent.id, { templateKey: 'ADHOC', baseline: false });
        }
      }
    }

    const employee: Employee = {
      id,
      employeeId: partial.employeeId ?? this.mintEmployeeNumber(),
      firstName: name.firstName,
      lastName: name.lastName,
      displayName: name.displayName,
      email: name.email,
      username: name.username,
      managerId: partial.managerId ?? this.selectManagerForHire(grade, division, isNonHuman),
      division,
      jobFamily,
      grade,
      type,
      status,
      location,
      legalEntity,
      costCenter,
      entitlements,
      startDate: partial.startDate ?? isoFromEpoch(nowMs),
      attributes: partial.attributes ?? {
        title: titleFor(jobFamily, grade),
        adGroupOu: `OU=${division};OU=${location};DC=db;DC=com`,
        onboardingComplete: status !== 'onboarding',
      },
      isNonHuman,
      createdAt: partial.createdAt ?? isoFromEpoch(nowMs),
      updatedAt: partial.updatedAt ?? isoFromEpoch(nowMs),
    };
    if (partial.endDate !== undefined) {
      employee.endDate = partial.endDate;
    }
    this.insert(employee);
    return employee;
  }

  public transfer(
    id: string,
    changes: Partial<Pick<Employee, 'division' | 'location' | 'costCenter' | 'legalEntity'>>,
  ): Employee | undefined {
    const emp = this.byId.get(id);
    if (!emp) {
      return undefined;
    }
    const oldLocation = emp.location;
    const newDivision = changes.division ?? emp.division;
    const newLocation = changes.location ?? emp.location;
    const newProfile: EntitlementProfile = {
      division: newDivision,
      grade: emp.grade,
      type: emp.type,
      location: newLocation,
      jobFamily: emp.jobFamily,
      isNonHuman: emp.isNonHuman,
    };

    this.recomputeBaseline(emp, newProfile, this.resolveNowMs());

    emp.division = newDivision;
    emp.location = newLocation;
    emp.costCenter =
      changes.costCenter ?? (changes.division ? this.pickCostCenter(newDivision) : emp.costCenter);
    emp.legalEntity = changes.legalEntity ?? resolveLegalEntity(newDivision, newLocation);
    emp.attributes.adGroupOu = `OU=${newDivision};OU=${newLocation};DC=db;DC=com`;
    emp.updatedAt = isoFromEpoch(this.resolveNowMs());

    if (oldLocation !== newLocation && !emp.isNonHuman && emp.status === 'active') {
      this.bagFor(oldLocation).remove(id);
      this.bagFor(newLocation).add(id);
    }
    return emp;
  }

  public promote(id: string, toGrade: Grade): Employee | undefined {
    const emp = this.byId.get(id);
    if (!emp) {
      return undefined;
    }
    if (GRADE_SENIORITY[toGrade] <= GRADE_SENIORITY[emp.grade]) {
      this.logger.warn(
        { id, from: emp.grade, to: toGrade },
        'promote called with a non-senior grade; applying anyway',
      );
    }
    const newProfile: EntitlementProfile = {
      division: emp.division,
      grade: toGrade,
      type: emp.type,
      location: emp.location,
      jobFamily: emp.jobFamily,
      isNonHuman: emp.isNonHuman,
    };
    this.recomputeBaseline(emp, newProfile, this.resolveNowMs());
    emp.grade = toGrade;
    emp.attributes.title = titleFor(emp.jobFamily, toGrade);
    emp.updatedAt = isoFromEpoch(this.resolveNowMs());
    return emp;
  }

  public changeManager(id: string, managerId: string): Employee | undefined {
    const emp = this.byId.get(id);
    const manager = this.byId.get(managerId);
    if (!emp || !manager) {
      return undefined;
    }
    if (managerId === id || this.wouldCycle(id, managerId)) {
      this.logger.warn({ id, managerId }, 'changeManager rejected: would create a cycle');
      return emp;
    }
    emp.managerId = managerId;
    emp.updatedAt = isoFromEpoch(this.resolveNowMs());
    return emp;
  }

  public setStatus(id: string, status: IdentityStatus): Employee | undefined {
    const emp = this.byId.get(id);
    if (!emp) {
      return undefined;
    }
    const wasActive = !emp.isNonHuman && emp.status === 'active';
    emp.status = status;
    if ((status === 'terminated' || status === 'disabled') && !emp.endDate) {
      emp.endDate = isoFromEpoch(this.resolveNowMs());
    }
    emp.updatedAt = isoFromEpoch(this.resolveNowMs());

    const isActive = !emp.isNonHuman && status === 'active';
    if (wasActive && !isActive) {
      this.bagFor(emp.location).remove(id);
    } else if (!wasActive && isActive) {
      this.bagFor(emp.location).add(id);
    }
    return emp;
  }

  public grant(id: string, entitlement: Entitlement): Employee | undefined {
    const emp = this.byId.get(id);
    if (!emp) {
      return undefined;
    }
    if (!emp.entitlements.some((e) => e.id === entitlement.id)) {
      emp.entitlements = [...emp.entitlements, entitlement];
      if (!this.entMeta.has(entitlement.id)) {
        this.entMeta.set(entitlement.id, { templateKey: 'ADHOC', baseline: false });
      }
      emp.updatedAt = isoFromEpoch(this.resolveNowMs());
    }
    return emp;
  }

  public revoke(id: string, entitlementId: string): Employee | undefined {
    const emp = this.byId.get(id);
    if (!emp) {
      return undefined;
    }
    const next = emp.entitlements.filter((e) => e.id !== entitlementId);
    if (next.length !== emp.entitlements.length) {
      emp.entitlements = next;
      this.entMeta.delete(entitlementId);
      emp.updatedAt = isoFromEpoch(this.resolveNowMs());
    }
    return emp;
  }

  /* --- Internal mutation helpers ------------------------------------------ */

  /**
   * Recompute the role-based baseline for a new profile and apply the delta in
   * place: revoke baseline grants whose template is no longer applicable, mint the
   * newly applicable ones, and leave ad-hoc grants and unchanged baselines intact.
   */
  private recomputeBaseline(emp: Employee, newProfile: EntitlementProfile, nowMs: number): void {
    const newTemplates = baselineTemplatesFor(newProfile);
    const newKeys = new Map(newTemplates.map((t) => [t.key, t]));
    const currentBaselineKeys = new Set<string>();

    const kept: Entitlement[] = [];
    for (const ent of emp.entitlements) {
      const meta = this.entMeta.get(ent.id);
      if (meta?.baseline) {
        if (newKeys.has(meta.templateKey)) {
          currentBaselineKeys.add(meta.templateKey);
          kept.push(ent);
        } else {
          this.entMeta.delete(ent.id); // revoked baseline grant
        }
      } else {
        kept.push(ent); // ad-hoc grant: untouched
      }
    }

    for (const [key, template] of newKeys) {
      if (!currentBaselineKeys.has(key)) {
        const ent = mintEntitlement(this.entRng, template, newProfile, { grantedAtMs: nowMs });
        this.entMeta.set(ent.id, { templateKey: key, baseline: true });
        kept.push(ent);
      }
    }
    emp.entitlements = kept;
  }

  /** True when making `managerId` the manager of `id` would close a cycle. */
  private wouldCycle(id: string, managerId: string): boolean {
    let cursor: string | null = managerId;
    const guard = new Set<string>();
    while (cursor) {
      if (cursor === id) {
        return true;
      }
      if (guard.has(cursor)) {
        return false; // pre-existing cycle elsewhere; do not loop forever.
      }
      guard.add(cursor);
      cursor = this.byId.get(cursor)?.managerId ?? null;
    }
    return false;
  }

  private selectManagerForHire(grade: Grade, division: Division, isNonHuman: boolean): string | null {
    if (!isNonHuman && grade === 'MD') {
      return null;
    }
    const floor = GRADE_SENIORITY[grade] + 1;
    const candidate = this.pick(
      (e) => !e.isNonHuman && GRADE_SENIORITY[e.grade] >= floor && e.status === 'active',
    );
    if (candidate && (candidate.division === division || isNonHuman)) {
      return candidate.id;
    }
    return candidate?.id ?? null;
  }

  private resolveHireName(
    id: string,
    partial: Partial<Employee>,
    isNonHuman: boolean,
    location: LocationCode,
  ): { firstName: string; lastName: string; displayName: string; email: string; username: string } {
    if (partial.email && partial.username && partial.firstName !== undefined) {
      return {
        firstName: partial.firstName,
        lastName: partial.lastName ?? '',
        displayName: partial.displayName ?? `${partial.firstName} ${partial.lastName ?? ''}`.trim(),
        email: partial.email,
        username: partial.username,
      };
    }
    const raw = partial.firstName !== undefined
      ? {
          firstName: partial.firstName,
          lastName: partial.lastName ?? '',
          displayName: partial.displayName ?? `${partial.firstName} ${partial.lastName ?? ''}`.trim(),
        }
      : isNonHuman
        ? namePartsFromService(this.buildServiceName(id, location))
        : generateName(this.structural, 'normal');
    const allocated = this.nameAllocator.allocate({
      ownerId: id,
      firstName: raw.firstName,
      lastName: raw.lastName,
      location,
      displayName: raw.displayName,
    });
    return {
      firstName: allocated.firstName,
      lastName: allocated.lastName,
      displayName: allocated.displayName,
      email: partial.email ?? allocated.email,
      username: partial.username ?? allocated.username,
    };
  }

  /** Timestamp source for runtime mutations: prefer supplied sim time, else wall. */
  private resolveNowMs(partial?: Partial<Employee>): number {
    if (partial) {
      const candidate = partial.startDate ?? partial.createdAt ?? partial.updatedAt;
      if (candidate) {
        const parsed = Date.parse(candidate);
        if (!Number.isNaN(parsed)) {
          return parsed;
        }
      }
    }
    return Date.now();
  }
}

/* --- Standalone lifecycle helpers (engine-facing delta API) ---------------- */

function diffEntitlements(before: readonly Entitlement[], after: readonly Entitlement[]): EntitlementDelta {
  const beforeIds = new Set(before.map((e) => e.id));
  const afterIds = new Set(after.map((e) => e.id));
  return {
    granted: after.filter((e) => !beforeIds.has(e.id)),
    revoked: before.filter((e) => !afterIds.has(e.id)),
    retained: after.filter((e) => beforeIds.has(e.id)),
  };
}

/**
 * Hire and report the birthright grants as the "granted" delta. The engine emits a
 * provision per granted entitlement.
 */
export function applyHire(pool: IdentityPool, partial: Partial<Employee>): JmlOutcome {
  const employee = pool.hire(partial);
  return { employee, granted: employee.entitlements.slice(), revoked: [], retained: [] };
}

/** Transfer and report the entitlement delta the move produced. */
export function applyTransfer(
  pool: IdentityPool,
  id: string,
  changes: Partial<Pick<Employee, 'division' | 'location' | 'costCenter' | 'legalEntity'>>,
): JmlOutcome | undefined {
  const current = pool.get(id);
  if (!current) {
    return undefined;
  }
  const before = current.entitlements.slice();
  const employee = pool.transfer(id, changes);
  if (!employee) {
    return undefined;
  }
  return { employee, ...diffEntitlements(before, employee.entitlements) };
}

/** Promote and report the entitlement delta the new grade produced. */
export function applyPromotion(pool: IdentityPool, id: string, toGrade: Grade): JmlOutcome | undefined {
  const current = pool.get(id);
  if (!current) {
    return undefined;
  }
  const before = current.entitlements.slice();
  const employee = pool.promote(id, toGrade);
  if (!employee) {
    return undefined;
  }
  return { employee, ...diffEntitlements(before, employee.entitlements) };
}

/**
 * Terminate an identity: deprovision every held entitlement then flip status. The
 * revoked delta is the full set of prior grants so the engine can emit a revoke per
 * entitlement.
 *
 * @param options.immediate When true the account is disabled outright rather than
 *   moved to the terminated state (identical revocation, different final status).
 */
export function applyTermination(
  pool: IdentityPool,
  id: string,
  options: { immediate?: boolean } = {},
): JmlOutcome | undefined {
  const current = pool.get(id);
  if (!current) {
    return undefined;
  }
  const before = current.entitlements.slice();
  for (const ent of before) {
    pool.revoke(id, ent.id);
  }
  const employee = pool.setStatus(id, options.immediate ? 'disabled' : 'terminated');
  if (!employee) {
    return undefined;
  }
  return { employee, granted: [], revoked: before, retained: [] };
}

/**
 * Place an identity on leave. Access is suspended via the status change; entitlements
 * are retained (not deprovisioned) so they can be restored on return.
 */
export function applyLoa(pool: IdentityPool, id: string): JmlOutcome | undefined {
  const current = pool.get(id);
  if (!current) {
    return undefined;
  }
  const employee = pool.setStatus(id, 'on_leave');
  if (!employee) {
    return undefined;
  }
  return { employee, granted: [], revoked: [], retained: employee.entitlements.slice() };
}

/**
 * Rehire (reactivate) a previously departed identity and restore its role-based
 * baseline access. The granted delta is whatever baseline had to be re-provisioned.
 */
export function applyRehire(pool: IdentityPool, id: string): JmlOutcome | undefined {
  const current = pool.get(id);
  if (!current) {
    return undefined;
  }
  const before = current.entitlements.slice();
  pool.setStatus(id, 'active');
  const restored = restoreBaseline(pool, id);
  const employee = pool.get(id);
  if (!employee) {
    return undefined;
  }
  return { employee, granted: restored, revoked: [], retained: before };
}

/**
 * Convert an identity's employment type (e.g. Contractor -> FTE). Modeled as a clean
 * cut-over: the old record is deprovisioned and disabled and a NEW identity is hired
 * carrying over name, division, location and manager, matching the
 * `ContractorConvertPayload.newEmployeeId` semantics. The delta reports the old
 * grants as revoked and the new baseline as granted.
 */
export function applyConversion(
  pool: IdentityPool,
  id: string,
  toType: EmployeeType,
): JmlOutcome | undefined {
  const old = pool.get(id);
  if (!old) {
    return undefined;
  }
  const revoked = old.entitlements.slice();
  for (const ent of revoked) {
    pool.revoke(id, ent.id);
  }
  pool.setStatus(id, 'disabled');
  const employee = pool.hire({
    firstName: old.firstName,
    lastName: old.lastName,
    displayName: old.displayName,
    division: old.division,
    location: old.location,
    jobFamily: old.jobFamily,
    grade: toType === 'FTE' && old.grade === 'Contractor' ? 'Associate' : old.grade,
    type: toType,
    isNonHuman: toType === 'Service',
    managerId: old.managerId,
    status: 'onboarding',
    attributes: { ...old.attributes, convertedFrom: old.employeeId, edgeCase: 'contractor_convert' },
  });
  return { employee, granted: employee.entitlements.slice(), revoked, retained: [] };
}

/** Grant an identity's current role-based baseline that it is missing; returns grants. */
function restoreBaseline(pool: IdentityPool, id: string): Entitlement[] {
  const emp = pool.get(id);
  if (!emp) {
    return [];
  }
  // A rehire that lost its access is re-provisioned by transferring to its own
  // current division/location, which recomputes and re-grants the baseline.
  const before = emp.entitlements.slice();
  const after = pool.transfer(id, { division: emp.division });
  if (!after) {
    return [];
  }
  const beforeIds = new Set(before.map((e) => e.id));
  return after.entitlements.filter((e) => !beforeIds.has(e.id));
}

/* --- Small module-local helpers -------------------------------------------- */

function toRef(emp: Employee): IdentityRef {
  return {
    id: emp.id,
    employeeId: emp.employeeId,
    displayName: emp.displayName,
    email: emp.email,
    division: emp.division,
    location: emp.location,
    grade: emp.grade,
    type: emp.type,
  };
}

function namePartsFromService(svc: {
  firstName: string;
  lastName: string;
  displayName: string;
}): { firstName: string; lastName: string; displayName: string } {
  return { firstName: svc.firstName, lastName: svc.lastName, displayName: svc.displayName };
}

function nameKindEdge(kind: NameKind): string | undefined {
  switch (kind) {
    case 'unicode':
      return 'unicode_name';
    case 'cjk':
      return 'cjk_name';
    case 'emoji':
      return 'emoji_name';
    case 'long':
      return 'long_name';
    case 'mononym':
      return 'mononym';
    case 'hyphenated':
      return 'hyphenated_name';
    case 'apostrophe':
      return 'apostrophe_name';
    case 'normal':
    default:
      return undefined;
  }
}

function pushToBucket<K>(map: Map<K, string[]>, key: K, value: string): void {
  const bucket = map.get(key);
  if (bucket) {
    bucket.push(value);
  } else {
    map.set(key, [value]);
  }
}

function emptyLocationRecord(): Record<LocationCode, number> {
  return zeroRecord(ALL_LOCATIONS);
}

function zeroRecord<K extends string>(keys: readonly K[]): Record<K, number> {
  const record = {} as Record<K, number>;
  for (const key of keys) {
    record[key] = 0;
  }
  return record;
}

/**
 * The frozen factory. Returns a fresh, unseeded pool; the runtime calls `seed` on
 * each run start. Shape matches `IdentityPoolFactory` exactly so the server can wire
 * it as `createIdentityPool` regardless of the directory this module lives in.
 */
export const createIdentityPool: IdentityPoolFactory = (options) =>
  new WorkforceIdentityPool(options.logger);
