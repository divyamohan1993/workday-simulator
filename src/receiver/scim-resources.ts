/**
 * RFC 7643/7644 static resources and response envelopes for the SCIM 2.0 surface.
 *
 * WHY here: the ServiceProviderConfig, ResourceTypes and Schemas documents, the
 * ListResponse envelope and the Error body are protocol boilerplate that several
 * handlers share. Keeping the canonical, spec-correct shapes in one module stops
 * each handler from emitting a subtly different envelope, which is exactly the kind
 * of drift a real SCIM client trips over. The SCIM resource TYPES themselves come
 * from `../domain/scim.js`, the single agreed representation shared with the
 * delivery adapter, so the bytes this receiver parses are the bytes that sender
 * writes.
 */

import { SCIM_SCHEMA } from '../domain/scim.js';
import {
  MAX_BULK_OPERATIONS,
  MAX_BULK_PAYLOAD_BYTES,
  MAX_LIST_PAGE_SIZE,
  SCIM_BASE_PATH,
} from './constants.js';

/**
 * A SCIM protocol error. Handlers throw it; the plugin catches it and renders the
 * RFC 7644 s.3.12 error body with the right HTTP status. `scimType` is the
 * machine-readable detail code (e.g. "invalidFilter", "invalidValue") for 400s.
 */
export class ScimError extends Error {
  public readonly status: number;
  public readonly scimType: string | undefined;
  constructor(status: number, detail: string, scimType?: string) {
    super(detail);
    this.name = 'ScimError';
    this.status = status;
    this.scimType = scimType;
  }
}

/** The RFC 7644 s.3.12 error response body. `status` is a string, per the spec. */
export function scimErrorBody(
  status: number,
  detail: string,
  scimType?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    schemas: [SCIM_SCHEMA.ERROR],
    detail,
    status: String(status),
  };
  if (scimType) body['scimType'] = scimType;
  return body;
}

/** The RFC 7644 s.3.4.2 ListResponse envelope. */
export interface ScimListResponse<T> {
  schemas: [typeof SCIM_SCHEMA.LIST_RESPONSE];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
}

/**
 * Build a ListResponse for a page of resources.
 *
 * @param resources The page of resources (already sliced).
 * @param totalResults The total number of matching resources (pre-pagination).
 * @param startIndex The 1-based index of the first returned resource.
 * @returns A spec-correct ListResponse envelope.
 */
export function scimListResponse<T>(
  resources: T[],
  totalResults: number,
  startIndex: number,
): ScimListResponse<T> {
  return {
    schemas: [SCIM_SCHEMA.LIST_RESPONSE],
    totalResults,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

/**
 * The ServiceProviderConfig document (RFC 7643 s.5), advertising what this
 * receiver supports. PATCH, Bulk and filter are on; sort, changePassword and
 * ETag-based optimistic concurrency are off (the receiver is deliberately lenient
 * about If-Match so the at-least-once sim never wedges on a version mismatch).
 */
export function serviceProviderConfig(): Record<string, unknown> {
  return {
    schemas: [SCIM_SCHEMA.SERVICE_PROVIDER_CONFIG],
    documentationUri: 'https://datatracker.ietf.org/doc/html/rfc7644',
    patch: { supported: true },
    bulk: { supported: true, maxOperations: MAX_BULK_OPERATIONS, maxPayloadSize: MAX_BULK_PAYLOAD_BYTES },
    filter: { supported: true, maxResults: MAX_LIST_PAGE_SIZE },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'OAuth Bearer Token',
        description: 'Authentication via the receiver bearer token.',
        specUri: 'https://datatracker.ietf.org/doc/html/rfc6750',
        primary: true,
      },
    ],
    meta: {
      resourceType: 'ServiceProviderConfig',
      location: `${SCIM_BASE_PATH}/ServiceProviderConfig`,
    },
  };
}

/** The ResourceType documents (RFC 7643 s.6) for User and Group. */
export function resourceTypes(): Array<Record<string, unknown>> {
  return [
    {
      schemas: [SCIM_SCHEMA.RESOURCE_TYPE],
      id: 'User',
      name: 'User',
      endpoint: '/Users',
      description: 'Deutsche Bank workforce identity.',
      schema: SCIM_SCHEMA.USER,
      schemaExtensions: [{ schema: SCIM_SCHEMA.ENTERPRISE_USER, required: false }],
      meta: { resourceType: 'ResourceType', location: `${SCIM_BASE_PATH}/ResourceTypes/User` },
    },
    {
      schemas: [SCIM_SCHEMA.RESOURCE_TYPE],
      id: 'Group',
      name: 'Group',
      endpoint: '/Groups',
      description: 'Access group / entitlement.',
      schema: SCIM_SCHEMA.GROUP,
      schemaExtensions: [],
      meta: { resourceType: 'ResourceType', location: `${SCIM_BASE_PATH}/ResourceTypes/Group` },
    },
  ];
}

/** One attribute definition inside a SCIM schema document. */
function attr(
  name: string,
  type: string,
  opts: { multiValued?: boolean; required?: boolean; mutability?: string; caseExact?: boolean } = {},
): Record<string, unknown> {
  return {
    name,
    type,
    multiValued: opts.multiValued ?? false,
    required: opts.required ?? false,
    caseExact: opts.caseExact ?? false,
    mutability: opts.mutability ?? 'readWrite',
    returned: 'default',
    uniqueness: name === 'userName' ? 'server' : 'none',
  };
}

/** The Schema documents (RFC 7643 s.7) for the User, enterprise extension and Group. */
export function schemas(): Array<Record<string, unknown>> {
  return [
    {
      id: SCIM_SCHEMA.USER,
      name: 'User',
      description: 'SCIM 2.0 core User.',
      attributes: [
        attr('userName', 'string', { required: true }),
        attr('name', 'complex'),
        attr('displayName', 'string'),
        attr('userType', 'string'),
        attr('active', 'boolean'),
        attr('emails', 'complex', { multiValued: true }),
        attr('groups', 'complex', { multiValued: true, mutability: 'readOnly' }),
      ],
      meta: { resourceType: 'Schema', location: `${SCIM_BASE_PATH}/Schemas/${SCIM_SCHEMA.USER}` },
    },
    {
      id: SCIM_SCHEMA.ENTERPRISE_USER,
      name: 'EnterpriseUser',
      description: 'SCIM 2.0 enterprise User extension.',
      attributes: [
        attr('employeeNumber', 'string'),
        attr('costCenter', 'string'),
        attr('organization', 'string'),
        attr('division', 'string'),
        attr('department', 'string'),
        attr('manager', 'complex'),
      ],
      meta: {
        resourceType: 'Schema',
        location: `${SCIM_BASE_PATH}/Schemas/${SCIM_SCHEMA.ENTERPRISE_USER}`,
      },
    },
    {
      id: SCIM_SCHEMA.GROUP,
      name: 'Group',
      description: 'SCIM 2.0 core Group.',
      attributes: [
        attr('displayName', 'string', { required: true }),
        attr('members', 'complex', { multiValued: true }),
      ],
      meta: { resourceType: 'Schema', location: `${SCIM_BASE_PATH}/Schemas/${SCIM_SCHEMA.GROUP}` },
    },
  ];
}
