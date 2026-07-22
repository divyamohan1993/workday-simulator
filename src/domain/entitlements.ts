/**
 * Entitlement catalog, role-based baseline planners, and minting.
 *
 * WHY this module exists: an identity manager is exercised by GRANTING and REVOKING
 * access, so the workforce needs a realistic catalog of Deutsche Bank access
 * (Active Directory groups, SAP roles, trading applications, PAM/CyberArk vaults)
 * and a deterministic, PURE mapping from an identity's profile to its birthright
 * (day-one) access plus its division and grade based baseline. Purity matters: the
 * pool recomputes the baseline for a NEW profile on transfer/promotion and diffs it
 * against the old baseline by template key to produce provision/revoke deltas, so
 * the mapping must depend only on the profile, never on the RNG or the clock. The
 * RNG is used solely to mint concrete grant ids and timestamps.
 *
 * Segregation-of-duties tags (`sodTags`) are the abstract duties that the SoD rules
 * in `sod.ts` watch for toxic combinations. They live on the templates here so the
 * catalog and the rule set share one vocabulary.
 */

import type {
  Division,
  EmployeeType,
  Entitlement,
  EntitlementType,
  Grade,
  JobFamily,
  LocationCode,
  RiskLevel,
} from '../types/index.js';
import { GRADE_SENIORITY } from '../types/index.js';
import { DIVISION_CODE, isoFromEpoch, locationOf } from './org.js';

/** RNG surface needed to mint concrete entitlements (satisfied by Faker). */
export interface EntRng {
  string: { nanoid(): string };
}

/** The profile inputs that determine an identity's baseline access. */
export interface EntitlementProfile {
  division: Division;
  grade: Grade;
  type: EmployeeType;
  location: LocationCode;
  jobFamily: JobFamily;
  isNonHuman: boolean;
}

/**
 * A catalog template: the stable definition of an access grant. Concrete
 * `Entitlement` instances are minted from a template, which supplies everything
 * except the per-grant id and timestamps. `key` is the identity of the template and
 * is what transfer/promotion diffing compares, so parameterized templates (per
 * location or division) bake the code into the key.
 */
export interface EntitlementTemplate {
  key: string;
  system: string;
  label: string;
  type: EntitlementType;
  risk: RiskLevel;
  sensitive: boolean;
  sodTags: readonly string[];
  /** Whether the concrete name is suffixed with a site or division for realism. */
  scope: 'global' | 'location' | 'division';
}

/* --- Segregation-of-duties tag vocabulary ---------------------------------- */

/** The abstract duties that SoD rules watch. Kept as constants to avoid typos. */
export const SOD_TAG = {
  PAYMENT_INITIATE: 'payment.initiate',
  PAYMENT_APPROVE: 'payment.approve',
  PAYMENT_RELEASE: 'payment.release',
  TRADE_EXECUTE: 'trade.execute',
  TRADE_SETTLE: 'trade.settle',
  TRADE_CONFIRM: 'trade.confirm',
  VENDOR_MAINTAIN: 'vendor.maintain',
  GL_POST: 'gl.post',
  GL_RECONCILE: 'gl.reconcile',
  USER_ADMIN: 'user.admin',
  ACCESS_APPROVE: 'access.approve',
  AUDIT_REVIEW: 'audit.review',
  AML_REVIEW: 'aml.review',
  PRIV_UNIX: 'privileged.unix',
  PRIV_WINDOWS: 'privileged.windows',
  PRIV_DBA: 'privileged.dba',
} as const;

/* --- Static base templates ------------------------------------------------- */

/**
 * The fixed (non-parameterized) templates, keyed for lookup. Location- and
 * division-scoped birthright groups are generated dynamically (see below) so their
 * keys carry the code and diff correctly on a move.
 */
export const ENTITLEMENT_TEMPLATES = {
  AD_ALL_STAFF: {
    key: 'AD-ALL-STAFF',
    system: 'ActiveDirectory',
    label: 'All Staff',
    type: 'group',
    risk: 'low',
    sensitive: false,
    sodTags: [],
    scope: 'global',
  },
  MAILBOX: {
    key: 'MAILBOX',
    system: 'Exchange',
    label: 'Corporate Mailbox',
    type: 'account',
    risk: 'low',
    sensitive: false,
    sodTags: [],
    scope: 'global',
  },
  SSO: {
    key: 'SSO',
    system: 'AzureAD',
    label: 'Single Sign-On',
    type: 'profile',
    risk: 'low',
    sensitive: false,
    sodTags: [],
    scope: 'global',
  },
  VPN: {
    key: 'VPN',
    system: 'ActiveDirectory',
    label: 'Global Remote Access VPN',
    type: 'group',
    risk: 'medium',
    sensitive: false,
    sodTags: [],
    scope: 'global',
  },
  BLOOMBERG: {
    key: 'BLOOMBERG',
    system: 'Bloomberg',
    label: 'Bloomberg Terminal',
    type: 'application',
    risk: 'medium',
    sensitive: false,
    sodTags: [],
    scope: 'location',
  },
  MUREX_VIEW: {
    key: 'MUREX-VIEW',
    system: 'Murex',
    label: 'Murex Read-Only',
    type: 'role',
    risk: 'medium',
    sensitive: false,
    sodTags: [],
    scope: 'location',
  },
  MUREX_TRADER: {
    key: 'MUREX-TRADER',
    system: 'Murex',
    label: 'Murex Trader',
    type: 'role',
    risk: 'high',
    sensitive: true,
    sodTags: [SOD_TAG.TRADE_EXECUTE],
    scope: 'location',
  },
  MUREX_APPROVER: {
    key: 'MUREX-APPROVER',
    system: 'Murex',
    label: 'Murex Trade Confirmation',
    type: 'role',
    risk: 'high',
    sensitive: true,
    sodTags: [SOD_TAG.TRADE_CONFIRM],
    scope: 'location',
  },
  SETTLEMENTS: {
    key: 'SETTLEMENTS',
    system: 'GPP',
    label: 'Settlement Processing',
    type: 'role',
    risk: 'high',
    sensitive: true,
    sodTags: [SOD_TAG.TRADE_SETTLE],
    scope: 'global',
  },
  SAP_PAY_POST: {
    key: 'SAP-PAY-POST',
    system: 'SAP',
    label: 'SAP Payment Posting',
    type: 'role',
    risk: 'high',
    sensitive: true,
    sodTags: [SOD_TAG.PAYMENT_INITIATE],
    scope: 'global',
  },
  SAP_PAY_RELEASE: {
    key: 'SAP-PAY-RELEASE',
    system: 'SAP',
    label: 'SAP Payment Release',
    type: 'role',
    risk: 'high',
    sensitive: true,
    sodTags: [SOD_TAG.PAYMENT_RELEASE, SOD_TAG.PAYMENT_APPROVE],
    scope: 'global',
  },
  SWIFT_OPERATOR: {
    key: 'SWIFT-OPERATOR',
    system: 'SWIFT-Alliance',
    label: 'SWIFT Alliance Operator',
    type: 'privileged',
    risk: 'critical',
    sensitive: true,
    sodTags: [SOD_TAG.PAYMENT_INITIATE],
    scope: 'location',
  },
  WIRE_APPROVER: {
    key: 'WIRE-APPROVER',
    system: 'SWIFT-Alliance',
    label: 'Wire Approval Authority',
    type: 'role',
    risk: 'high',
    sensitive: true,
    sodTags: [SOD_TAG.PAYMENT_APPROVE],
    scope: 'global',
  },
  SAP_GL_POST: {
    key: 'SAP-GL-POST',
    system: 'SAP',
    label: 'SAP General Ledger Posting',
    type: 'role',
    risk: 'medium',
    sensitive: false,
    sodTags: [SOD_TAG.GL_POST],
    scope: 'global',
  },
  SAP_GL_RECON: {
    key: 'SAP-GL-RECON',
    system: 'SAP',
    label: 'SAP General Ledger Reconciliation',
    type: 'role',
    risk: 'medium',
    sensitive: false,
    sodTags: [SOD_TAG.GL_RECONCILE],
    scope: 'global',
  },
  SAP_VENDOR: {
    key: 'SAP-VENDOR',
    system: 'SAP',
    label: 'SAP Vendor Master Maintenance',
    type: 'role',
    risk: 'high',
    sensitive: true,
    sodTags: [SOD_TAG.VENDOR_MAINTAIN],
    scope: 'global',
  },
  SAP_HCM: {
    key: 'SAP-HCM',
    system: 'SAP',
    label: 'SAP Human Capital Management',
    type: 'role',
    risk: 'medium',
    sensitive: false,
    sodTags: [],
    scope: 'global',
  },
  IGA_APPROVER: {
    key: 'IGA-APPROVER',
    system: 'OneIdentityManager',
    label: 'Access Request Approver',
    type: 'role',
    risk: 'medium',
    sensitive: false,
    sodTags: [SOD_TAG.ACCESS_APPROVE],
    scope: 'global',
  },
  GITHUB: {
    key: 'GITHUB',
    system: 'GitHubEnterprise',
    label: 'GitHub Enterprise',
    type: 'application',
    risk: 'low',
    sensitive: false,
    sodTags: [],
    scope: 'global',
  },
  CICD: {
    key: 'CICD',
    system: 'Jenkins',
    label: 'CI/CD Pipeline',
    type: 'application',
    risk: 'medium',
    sensitive: false,
    sodTags: [],
    scope: 'global',
  },
  AWS_DEV: {
    key: 'AWS-DEV',
    system: 'AWS',
    label: 'Cloud Developer',
    type: 'role',
    risk: 'medium',
    sensitive: false,
    sodTags: [],
    scope: 'global',
  },
  SIEM: {
    key: 'SIEM',
    system: 'Splunk',
    label: 'SIEM Analyst',
    type: 'application',
    risk: 'medium',
    sensitive: false,
    sodTags: [],
    scope: 'global',
  },
  RISK_ENGINE: {
    key: 'RISK-ENGINE',
    system: 'RiskEngine',
    label: 'Risk Analytics Platform',
    type: 'application',
    risk: 'medium',
    sensitive: false,
    sodTags: [],
    scope: 'global',
  },
  ACTIMIZE: {
    key: 'ACTIMIZE',
    system: 'Actimize',
    label: 'Actimize AML Investigator',
    type: 'application',
    risk: 'high',
    sensitive: true,
    sodTags: [SOD_TAG.AML_REVIEW],
    scope: 'global',
  },
  AUDIT_REVIEW: {
    key: 'AUDIT-REVIEW',
    system: 'AuditBoard',
    label: 'Audit Reviewer',
    type: 'role',
    risk: 'medium',
    sensitive: false,
    sodTags: [SOD_TAG.AUDIT_REVIEW],
    scope: 'global',
  },
  AVALOQ: {
    key: 'AVALOQ',
    system: 'Avaloq',
    label: 'Avaloq Banking Suite',
    type: 'application',
    risk: 'medium',
    sensitive: false,
    sodTags: [],
    scope: 'global',
  },
  ALADDIN: {
    key: 'ALADDIN',
    system: 'Aladdin',
    label: 'Aladdin Portfolio Management',
    type: 'application',
    risk: 'medium',
    sensitive: false,
    sodTags: [],
    scope: 'global',
  },
  CYBERARK_UNIX: {
    key: 'CYBERARK-UNIX',
    system: 'CyberArk',
    label: 'CyberArk UNIX Root Vault',
    type: 'privileged',
    risk: 'critical',
    sensitive: true,
    sodTags: [SOD_TAG.PRIV_UNIX],
    scope: 'global',
  },
  CYBERARK_WIN: {
    key: 'CYBERARK-WIN',
    system: 'CyberArk',
    label: 'CyberArk Windows Admin Vault',
    type: 'privileged',
    risk: 'critical',
    sensitive: true,
    sodTags: [SOD_TAG.PRIV_WINDOWS],
    scope: 'global',
  },
  CYBERARK_DBA: {
    key: 'CYBERARK-DBA',
    system: 'CyberArk',
    label: 'CyberArk Database Admin Vault',
    type: 'privileged',
    risk: 'critical',
    sensitive: true,
    sodTags: [SOD_TAG.PRIV_DBA],
    scope: 'global',
  },
  AD_PRIV_ADMIN: {
    key: 'AD-PRIV-ADMIN',
    system: 'ActiveDirectory',
    label: 'Privileged Domain Admins',
    type: 'privileged',
    risk: 'critical',
    sensitive: true,
    sodTags: [SOD_TAG.USER_ADMIN],
    scope: 'global',
  },
  FIREFIGHTER_SAP: {
    key: 'FIREFIGHTER-SAP',
    system: 'SAP',
    label: 'SAP Firefighter (Emergency Access)',
    type: 'firefighter',
    risk: 'critical',
    sensitive: true,
    sodTags: [SOD_TAG.PAYMENT_RELEASE],
    scope: 'global',
  },
  SVC_API_KEY: {
    key: 'SVC-API-KEY',
    system: 'APIGateway',
    label: 'Service API Key',
    type: 'account',
    risk: 'medium',
    sensitive: false,
    sodTags: [],
    scope: 'global',
  },
  SVC_ROLE: {
    key: 'SVC-ROLE',
    system: 'ServiceMesh',
    label: 'Service Automation Role',
    type: 'role',
    risk: 'medium',
    sensitive: false,
    sodTags: [],
    scope: 'global',
  },
  SVC_CERT: {
    key: 'SVC-CERT',
    system: 'PKI',
    label: 'Service mTLS Certificate',
    type: 'account',
    risk: 'medium',
    sensitive: false,
    sodTags: [],
    scope: 'global',
  },
} as const satisfies Record<string, EntitlementTemplate>;

/** A flat list of all static templates, for enumeration by API/consumers. */
export const ALL_ENTITLEMENT_TEMPLATES: readonly EntitlementTemplate[] =
  Object.values(ENTITLEMENT_TEMPLATES);

/* --- Dynamic (parameterized) birthright templates -------------------------- */

/** Per-site AD organizational-unit group; key carries the site so a move diffs. */
function locationGroupTemplate(location: LocationCode): EntitlementTemplate {
  return {
    key: `AD-LOC-${location}`,
    system: 'ActiveDirectory',
    label: `Site ${locationOf(location).city}`,
    type: 'group',
    risk: 'low',
    sensitive: false,
    sodTags: [],
    scope: 'location',
  };
}

/** Per-division AD group; key carries the division so a transfer diffs. */
function divisionGroupTemplate(division: Division): EntitlementTemplate {
  return {
    key: `AD-DIV-${DIVISION_CODE[division]}`,
    system: 'ActiveDirectory',
    label: `Division ${division}`,
    type: 'group',
    risk: 'low',
    sensitive: false,
    sodTags: [],
    scope: 'division',
  };
}

/* --- Baseline planners (PURE: profile in, templates out) ------------------- */

const T = ENTITLEMENT_TEMPLATES;

/** Day-one birthright access every person receives on hire. */
function birthrightTemplates(profile: EntitlementProfile): EntitlementTemplate[] {
  const templates: EntitlementTemplate[] = [
    T.AD_ALL_STAFF,
    T.MAILBOX,
    T.SSO,
    locationGroupTemplate(profile.location),
    divisionGroupTemplate(profile.division),
  ];
  // Interns typically get no remote VPN on day one.
  if (profile.type !== 'Intern') {
    templates.push(T.VPN);
  }
  return templates;
}

/**
 * Division and job-family baseline access, gated by grade where appropriate.
 *
 * Baselines are deliberately kept SoD-clean: the two sides of every toxic
 * combination live in different divisions or job families, so a correctly-modeled
 * identity has no built-in conflict. Payment INITIATION sits with the hands-on
 * payment families; ledger POSTING sits in Finance while RECONCILIATION sits in
 * Operations; trade EXECUTION sits with traders. The approval counterparts are
 * added by `gradePrivilegeTemplates`, gated to avoid stacking on the same person.
 * This keeps `sodConflicts` meaningful: a conflict signals real over-provisioning
 * (the deliberately-seeded toxic pairs or accumulation), not a broken baseline.
 */
function divisionBaselineTemplates(profile: EntitlementProfile): EntitlementTemplate[] {
  const { division, jobFamily, grade } = profile;
  const senior = GRADE_SENIORITY[grade];
  const out: EntitlementTemplate[] = [];

  switch (division) {
    case 'Investment Bank':
      out.push(T.BLOOMBERG, T.MUREX_VIEW);
      // Only front-office traders/sales get execution rights.
      if ((jobFamily === 'Trading' || jobFamily === 'Sales') && senior >= GRADE_SENIORITY.Associate) {
        out.push(T.MUREX_TRADER);
      }
      break;
    case 'Asset Management':
      out.push(T.ALADDIN, T.BLOOMBERG);
      break;
    case 'Corporate Bank':
      out.push(T.BLOOMBERG);
      if (jobFamily === 'Payments Operations' || jobFamily === 'Settlements') {
        out.push(T.SAP_PAY_POST); // payment initiation, hands-on families only
      }
      if (jobFamily === 'Payments Operations') {
        out.push(T.SWIFT_OPERATOR);
      }
      if (jobFamily === 'Settlements') {
        out.push(T.SETTLEMENTS);
      }
      break;
    case 'Private Bank':
      out.push(T.AVALOQ);
      break;
    case 'Operations':
      if (jobFamily === 'Payments Operations') {
        out.push(T.SAP_PAY_POST, T.SWIFT_OPERATOR); // initiation
      }
      if (jobFamily === 'Settlements') {
        out.push(T.SETTLEMENTS); // settlement
      }
      if (jobFamily === 'Operations Processing') {
        out.push(T.SAP_GL_RECON); // reconciliation lives in Operations
      }
      break;
    case 'Technology, Data & Innovation':
      out.push(T.GITHUB, T.CICD, T.AWS_DEV);
      if (jobFamily === 'Cybersecurity') {
        out.push(T.SIEM);
      }
      // Site reliability and cybersecurity leads hold standing privileged access.
      // UNIX and Windows vault duties do not conflict with each other.
      if (
        (jobFamily === 'Site Reliability' || jobFamily === 'Cybersecurity') &&
        senior >= GRADE_SENIORITY.AVP
      ) {
        out.push(T.CYBERARK_UNIX, T.CYBERARK_WIN);
      }
      break;
    case 'Risk':
      out.push(T.RISK_ENGINE, T.MUREX_VIEW);
      break;
    case 'Compliance':
      out.push(T.ACTIMIZE, T.AUDIT_REVIEW);
      break;
    case 'Finance':
      out.push(T.SAP_GL_POST); // posting lives in Finance (reconciliation is in Ops)
      if (jobFamily === 'Audit') {
        out.push(T.AUDIT_REVIEW);
      }
      break;
    case 'Human Resources':
      out.push(T.SAP_HCM);
      break;
    default:
      break;
  }
  return out;
}

/**
 * Grade-based privileges for VP and above. Approval authority is granted only to
 * managers who do NOT already perform the counterpart duty in their baseline, so no
 * single identity is handed both sides of a toxic pair by construction:
 * - trade CONFIRM (Murex approver) goes to IB managers who are not traders;
 * - payment APPROVE (wire approver) goes to Corporate relationship/credit managers,
 *   never to the hands-on payment families that hold initiation;
 * - payment RELEASE goes to Finance managers, whose baseline is ledger-only;
 * - vendor MASTER maintenance goes to Operations Processing directors, who hold no
 *   payment-approval duty.
 */
function gradePrivilegeTemplates(profile: EntitlementProfile): EntitlementTemplate[] {
  const { division, jobFamily } = profile;
  const senior = GRADE_SENIORITY[profile.grade];
  const out: EntitlementTemplate[] = [];

  if (senior >= GRADE_SENIORITY.VP) {
    out.push(T.IGA_APPROVER); // managers can approve access requests bank-wide
    switch (division) {
      case 'Investment Bank':
        if (jobFamily !== 'Trading' && jobFamily !== 'Sales') {
          out.push(T.MUREX_APPROVER);
        }
        break;
      case 'Asset Management':
        out.push(T.MUREX_APPROVER); // no execution baseline in Asset Management
        break;
      case 'Corporate Bank':
        if (jobFamily === 'Relationship Management' || jobFamily === 'Credit Analysis') {
          out.push(T.WIRE_APPROVER);
        }
        break;
      case 'Finance':
        out.push(T.SAP_PAY_RELEASE);
        break;
      default:
        break;
    }
  }

  if (
    senior >= GRADE_SENIORITY.Director &&
    division === 'Operations' &&
    jobFamily === 'Operations Processing'
  ) {
    out.push(T.SAP_VENDOR);
  }
  return out;
}

/** Baseline access for a machine (NHI) identity. */
function serviceTemplates(profile: EntitlementProfile): EntitlementTemplate[] {
  const out: EntitlementTemplate[] = [T.SVC_API_KEY, T.SVC_ROLE, T.SVC_CERT];
  // Payments and settlements automation runs against SWIFT.
  if (
    profile.jobFamily === 'Payments Operations' ||
    profile.jobFamily === 'Settlements' ||
    profile.division === 'Corporate Bank'
  ) {
    out.push(T.SWIFT_OPERATOR);
  }
  return out;
}

/**
 * The full, deterministic baseline template set for a profile. This is the single
 * function the pool uses to attach birthright access on hire and to recompute
 * access on transfer/promotion. It is PURE: identical input yields identical
 * templates (by key), which is what makes delta diffing correct.
 *
 * @param profile The identity's division/grade/type/location/family.
 * @returns The de-duplicated baseline templates (by key), order-stable.
 */
export function baselineTemplatesFor(profile: EntitlementProfile): EntitlementTemplate[] {
  const templates = profile.isNonHuman
    ? [...birthrightServiceTemplates(profile), ...serviceTemplates(profile)]
    : [
        ...birthrightTemplates(profile),
        ...divisionBaselineTemplates(profile),
        ...gradePrivilegeTemplates(profile),
      ];
  return dedupeByKey(templates);
}

/** Minimal directory footprint for a machine identity (account + SSO, no VPN). */
function birthrightServiceTemplates(profile: EntitlementProfile): EntitlementTemplate[] {
  return [T.SSO, divisionGroupTemplate(profile.division)];
}

function dedupeByKey(templates: readonly EntitlementTemplate[]): EntitlementTemplate[] {
  const seen = new Set<string>();
  const out: EntitlementTemplate[] = [];
  for (const t of templates) {
    if (!seen.has(t.key)) {
      seen.add(t.key);
      out.push(t);
    }
  }
  return out;
}

/* --- Minting --------------------------------------------------------------- */

/** Options controlling how a template becomes a concrete grant. */
export interface MintOptions {
  /** Grant timestamp as epoch ms (from the sim clock or the seed reference). */
  grantedAtMs: number;
  /** Optional expiry (firefighter/temporary grants). */
  expiresAtMs?: number;
}

/**
 * Mint a concrete `Entitlement` from a template. The RNG supplies only the unique
 * grant id; everything else is derived deterministically from the template, the
 * profile (for the human-readable name suffix) and the supplied timestamps.
 *
 * @param rng Seeded RNG (for the grant id).
 * @param template The catalog template to instantiate.
 * @param profile The holder's profile (used to name location/division scoped grants).
 * @param options Grant/expiry timestamps.
 * @returns A fully-formed entitlement.
 */
export function mintEntitlement(
  rng: EntRng,
  template: EntitlementTemplate,
  profile: EntitlementProfile,
  options: MintOptions,
): Entitlement {
  const name = concreteName(template, profile);
  const entitlement: Entitlement = {
    id: `ent_${rng.string.nanoid()}`,
    system: template.system,
    name,
    type: template.type,
    risk: template.risk,
    sensitive: template.sensitive,
    grantedAt: isoFromEpoch(options.grantedAtMs),
    sodTags: [...template.sodTags],
  };
  if (options.expiresAtMs !== undefined) {
    entitlement.expiresAt = isoFromEpoch(options.expiresAtMs);
  }
  return entitlement;
}

/** Human-readable grant name, suffixed by site or division for scoped templates. */
export function concreteName(template: EntitlementTemplate, profile: EntitlementProfile): string {
  switch (template.scope) {
    case 'location':
      return `${template.label} - ${locationOf(profile.location).city}`;
    case 'division':
      return `${template.label}`;
    case 'global':
    default:
      return template.label;
  }
}

/* --- Toxic combinations for deliberate SoD seeding ------------------------- */

/**
 * Pairs of templates that form a segregation-of-duties toxic combination when held
 * together. The seeder grants both sides to a small fraction of identities so that
 * SoD detection has real conflicts to find. Each pair's tags conflict under a rule
 * in `sod.ts`.
 */
export const TOXIC_PAIRS: ReadonlyArray<readonly [EntitlementTemplate, EntitlementTemplate]> = [
  [T.SAP_PAY_POST, T.SAP_PAY_RELEASE], // initiate + release
  [T.SAP_PAY_POST, T.WIRE_APPROVER], // initiate + approve
  [T.MUREX_TRADER, T.SETTLEMENTS], // execute + settle
  [T.SAP_VENDOR, T.SAP_PAY_RELEASE], // vendor master + payment release
  [T.AD_PRIV_ADMIN, T.AUDIT_REVIEW], // admin + audit self-review
  [T.SAP_GL_POST, T.SAP_GL_RECON], // post + reconcile
];
