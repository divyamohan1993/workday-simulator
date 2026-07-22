/**
 * Catalog routes: the static, read-only vocabulary the dashboard needs to build its
 * scenario editor and chaos console without hard-coding enums client-side.
 *
 * `/api/catalog` is a superset convenience (event taxonomy, org model, delivery and
 * chaos vocabularies, the recommended default mix). `/api/chaos/injectors` is the
 * exact shape BUILD-CONTRACT section 7 pins for the chaos console. Both derive from
 * the frozen constant maps and the engine's own catalog, so they can never drift from
 * what the generator and runtime actually implement.
 */

import type { FastifyInstance } from 'fastify';
import { CHAOS_INJECTOR_CATALOG } from '../../engine/index.js';
import { DEFAULT_EVENT_MIX } from '../../events/index.js';
import { LOCATIONS } from '../../domain/index.js';
import {
  ALL_DIVISIONS,
  ALL_EVENT_CATEGORIES,
  ALL_EVENT_KINDS,
  ALL_LOCATIONS,
  EVENT_KINDS_BY_CATEGORY,
  GRADE_SENIORITY,
} from '../../types/index.js';
import type { EmployeeType, Grade } from '../../types/index.js';

/** The employment relationships the workforce models (stable union, listed for the UI). */
const EMPLOYEE_TYPES: readonly EmployeeType[] = ['FTE', 'Contractor', 'Intern', 'External', 'Service'];

/** Delivery kinds a target may use. */
const DELIVERY_KINDS = ['scim', 'webhook', 'rest', 'nats', 'batch'] as const;

/** Overflow policies a target's bounded queue may apply. */
const OVERFLOW_POLICIES = ['block', 'drop_new', 'drop_oldest'] as const;

/** Risk levels used across entitlements and events. */
const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;

/** Grades ordered from most junior to most senior (derived from the seniority map). */
const GRADES: readonly Grade[] = (Object.keys(GRADE_SENIORITY) as Grade[]).sort(
  (a, b) => GRADE_SENIORITY[a] - GRADE_SENIORITY[b],
);

/** Register `/catalog` and `/chaos/injectors` on the `/api` instance. */
export function registerCatalogRoutes(app: FastifyInstance): void {
  app.get('/catalog', async () => ({
    eventCategories: ALL_EVENT_CATEGORIES,
    eventKinds: ALL_EVENT_KINDS,
    eventKindsByCategory: EVENT_KINDS_BY_CATEGORY,
    divisions: ALL_DIVISIONS,
    locations: LOCATIONS,
    locationCodes: ALL_LOCATIONS,
    grades: GRADES,
    employeeTypes: EMPLOYEE_TYPES,
    deliveryKinds: DELIVERY_KINDS,
    overflowPolicies: OVERFLOW_POLICIES,
    riskLevels: RISK_LEVELS,
    chaosInjectors: CHAOS_INJECTOR_CATALOG,
    defaultEventMix: DEFAULT_EVENT_MIX,
  }));

  app.get('/chaos/injectors', async () => CHAOS_INJECTOR_CATALOG);
}
