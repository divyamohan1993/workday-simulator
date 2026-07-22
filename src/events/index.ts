/**
 * Public entry point for the event taxonomy and generators.
 *
 * The primary export is the frozen factory `createEventGenerator` (matching
 * `EventGeneratorFactory`); the server's composition root wires it as the runtime's
 * `generator` dependency. Alongside it the module exports the recommended default
 * event mix (which scenarios should adopt so per-kind frequencies are realistic), the
 * documented outcome/failure rates, and the runtime event validators, all of which are
 * safe, dependency-light utilities other modules and tests can reuse.
 */

import type { EventGeneratorFactory } from '../contracts/factories.js';
import { createEventGenerator } from './generator.js';

export { createEventGenerator } from './generator.js';

// Compile-time conformance guard: assigning the factory to the frozen alias here makes
// any drift from `EventGeneratorFactory` a build failure in this module.
const _factory: EventGeneratorFactory = createEventGenerator;
void _factory;

export { DEFAULT_EVENT_MIX, defaultEventMix } from './event-mix.js';
export { EVENT_RATES, type EventRateKey } from './rates.js';
export { SEVERITY_BY_KIND, DELIVERY_BASE, deliveryMetaFor } from './taxonomy.js';
export {
  parseEvent,
  isValidEvent,
  eventEnvelopeSchema,
  PAYLOAD_SCHEMAS,
  geoPointSchema,
  identityRefSchema,
  actorRefSchema,
  entitlementRefSchema,
  eventDeliveryMetaSchema,
} from './schema.js';
export { generateIban, isValidIban, generateUetr, pickBic, type BankRng } from './banking.js';
export { geoForLocation, distanceKm, impliedSpeedKmh, REMOTE_GEOS } from './geo.js';
