/**
 * SCIM 2.0 resource types and Employee -> SCIM mapping.
 *
 * WHY this module lives in the domain: the primary delivery channel to the identity
 * manager is SCIM 2.0, and both the delivery adapter (which serializes outbound
 * User/Group operations) and the built-in receiver (which stores them) need ONE
 * agreed representation of a Deutsche Bank identity as a SCIM resource. Defining the
 * SCIM shapes and the mapping here, next to the `Employee` model they derive from,
 * stops the two consumers from redefining subtly different SCIM types and drifting.
 *
 * The types cover the core User (RFC 7643 s.4.1), the enterprise user extension
 * (s.4.3) and Group (s.4.2), which is the subset the JML and access flows exercise.
 */

import type { Employee, Entitlement, IdentityStatus } from '../types/index.js';
import { DIVISION_CODE } from './org.js';

/** Canonical SCIM 2.0 schema URNs. */
export const SCIM_SCHEMA = {
  USER: 'urn:ietf:params:scim:schemas:core:2.0:User',
  ENTERPRISE_USER: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User',
  GROUP: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  LIST_RESPONSE: 'urn:ietf:params:scim:api:messages:2.0:ListResponse',
  PATCH_OP: 'urn:ietf:params:scim:api:messages:2.0:PatchOp',
  BULK_REQUEST: 'urn:ietf:params:scim:api:messages:2.0:BulkRequest',
  BULK_RESPONSE: 'urn:ietf:params:scim:api:messages:2.0:BulkResponse',
  ERROR: 'urn:ietf:params:scim:api:messages:2.0:Error',
  SERVICE_PROVIDER_CONFIG: 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig',
  RESOURCE_TYPE: 'urn:ietf:params:scim:schemas:core:2.0:ResourceType',
} as const;

/** SCIM complex name attribute. */
export interface ScimName {
  formatted: string;
  familyName: string;
  givenName: string;
}

/** SCIM multi-valued email attribute. */
export interface ScimEmail {
  value: string;
  type: 'work' | 'home' | 'other';
  primary: boolean;
}

/** SCIM common resource metadata. */
export interface ScimMeta {
  resourceType: 'User' | 'Group';
  created: string;
  lastModified: string;
  location: string;
  version?: string;
}

/** A SCIM group membership reference carried on a user or a group. */
export interface ScimMemberRef {
  value: string;
  display: string;
  type?: 'direct' | 'indirect' | 'User' | 'Group';
  $ref?: string;
}

/** SCIM manager reference inside the enterprise extension. */
export interface ScimManager {
  value: string;
  displayName?: string;
}

/** SCIM enterprise user extension attributes. */
export interface ScimEnterpriseUser {
  employeeNumber: string;
  costCenter: string;
  organization: string;
  division: string;
  department: string;
  manager?: ScimManager;
}

/** A SCIM 2.0 core User with the enterprise extension. */
export interface ScimUser {
  schemas: string[];
  id: string;
  externalId: string;
  userName: string;
  name: ScimName;
  displayName: string;
  title?: string;
  userType: string;
  active: boolean;
  emails: ScimEmail[];
  groups: ScimMemberRef[];
  [SCIM_SCHEMA.ENTERPRISE_USER]?: ScimEnterpriseUser;
  meta: ScimMeta;
}

/** A SCIM 2.0 core Group. */
export interface ScimGroup {
  schemas: string[];
  id: string;
  displayName: string;
  members: ScimMemberRef[];
  meta: ScimMeta;
}

/** Entitlement types that map onto SCIM group memberships. */
const GROUP_MAPPED_TYPES = new Set(['group', 'role', 'profile']);

/**
 * Map an identity's lifecycle status onto the SCIM `active` flag. Only truly enabled
 * states map to true; leave, suspension, termination, disablement and dormancy all
 * disable the account. This is the single definition both delivery and the receiver
 * should rely on so the enabled/disabled semantics never disagree.
 *
 * @param status The identity lifecycle status.
 * @returns Whether the SCIM account should be active (enabled).
 */
export function scimActiveFor(status: IdentityStatus): boolean {
  return status === 'active' || status === 'onboarding';
}

/** Read a string attribute from an employee's loose attribute bag, if present. */
function stringAttr(employee: Employee, key: string): string | undefined {
  const value = employee.attributes[key];
  return typeof value === 'string' ? value : undefined;
}

/** Map one entitlement to a SCIM group membership reference. */
function entitlementToMember(entitlement: Entitlement): ScimMemberRef {
  return {
    value: entitlement.id,
    display: entitlement.name,
    type: 'direct',
    $ref: `Groups/${entitlement.id}`,
  };
}

/**
 * Convert an `Employee` into a SCIM 2.0 User resource (with the enterprise
 * extension). Group-like entitlements (groups, roles, profiles) become group
 * memberships; account/application/privileged grants are conveyed separately by the
 * access flow and are intentionally not folded into `groups`.
 *
 * @param employee The identity to serialize.
 * @param baseUrl Optional SCIM base path for `meta.location` (default "/scim/v2").
 * @returns The SCIM user resource.
 */
export function toScimUser(employee: Employee, baseUrl = '/scim/v2'): ScimUser {
  const manager: ScimManager | undefined = employee.managerId
    ? { value: employee.managerId }
    : undefined;

  const enterprise: ScimEnterpriseUser = {
    employeeNumber: employee.employeeId,
    costCenter: employee.costCenter,
    organization: employee.legalEntity,
    division: `${employee.division} (${DIVISION_CODE[employee.division]})`,
    department: employee.jobFamily,
  };
  if (manager) {
    enterprise.manager = manager;
  }

  const user: ScimUser = {
    schemas: [SCIM_SCHEMA.USER, SCIM_SCHEMA.ENTERPRISE_USER],
    id: employee.id,
    externalId: employee.employeeId,
    userName: employee.username,
    name: {
      formatted: employee.displayName,
      familyName: employee.lastName,
      givenName: employee.firstName,
    },
    displayName: employee.displayName,
    userType: employee.type,
    active: scimActiveFor(employee.status),
    emails: [{ value: employee.email, type: 'work', primary: true }],
    groups: employee.entitlements
      .filter((e) => GROUP_MAPPED_TYPES.has(e.type))
      .map(entitlementToMember),
    [SCIM_SCHEMA.ENTERPRISE_USER]: enterprise,
    meta: {
      resourceType: 'User',
      created: employee.createdAt,
      lastModified: employee.updatedAt,
      location: `${baseUrl}/Users/${employee.id}`,
    },
  };

  const title = stringAttr(employee, 'title');
  if (title) {
    user.title = title;
  }
  return user;
}

/**
 * Build a SCIM Group resource from an entitlement definition and its members.
 *
 * @param id Stable group id (typically the entitlement id or key).
 * @param displayName Human-readable group name.
 * @param members The member references (usually users holding the grant).
 * @param opts.created/opts.lastModified Timestamps; default to a stable epoch label.
 * @param baseUrl SCIM base path for `meta.location` (default "/scim/v2").
 * @returns The SCIM group resource.
 */
export function toScimGroup(
  id: string,
  displayName: string,
  members: ScimMemberRef[],
  opts: { created: string; lastModified: string },
  baseUrl = '/scim/v2',
): ScimGroup {
  return {
    schemas: [SCIM_SCHEMA.GROUP],
    id,
    displayName,
    members,
    meta: {
      resourceType: 'Group',
      created: opts.created,
      lastModified: opts.lastModified,
      location: `${baseUrl}/Groups/${id}`,
    },
  };
}
