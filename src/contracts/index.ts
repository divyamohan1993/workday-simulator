/**
 * Barrel for the frozen contracts. Builders may import from here
 * (`import type { Clock, EventBus } from '../contracts/index.js'`) or from the
 * individual files. Interfaces are type-only; validation.ts also exports runtime
 * zod schemas.
 */
export * from './clock.js';
export * from './arrival.js';
export * from './event-bus.js';
export * from './event-generator.js';
export * from './identity-pool.js';
export * from './delivery-adapter.js';
export * from './receiver.js';
export * from './metrics-registry.js';
export * from './stores.js';
export * from './scenario-runtime.js';
export * from './factories.js';
export * from './validation.js';
