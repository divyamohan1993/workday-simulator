/**
 * Public entry point for the Deutsche Bank workforce domain module.
 *
 * WHY this file exists: it is the single import surface for everything the rest of
 * the simulator needs from the workforce model. Its primary export is the frozen
 * factory `createIdentityPool` (matching `IdentityPoolFactory`); alongside it the
 * module re-exports the domain reference data, the entitlement catalog and its
 * baseline planners, the SoD rule set and detector, the SCIM 2.0 types and mappers,
 * and the delta-returning lifecycle helpers the event engine uses.
 *
 * INTEGRATION NOTE (read this): despite the frozen ownership map and the comment in
 * `src/contracts/factories.ts` placing `createIdentityPool` at `src/identity/`, this
 * module was assigned and built at `src/domain/`. Consumers must import from
 * `../domain/index.js`:
 *   - server (composition root) wires `createIdentityPool` from here;
 *   - runtime receives the resulting pool as `RuntimeDependencies.pool`;
 *   - events imports the lifecycle helpers (`applyHire`, `applyTransfer`, ...),
 *     `baselineTemplatesFor`/`mintEntitlement`, and the SCIM mappers from here.
 *
 * Key public surface:
 *   - createIdentityPool(options): IdentityPool                      [pool.js]
 *   - applyHire/applyTransfer/applyPromotion/applyTermination/
 *     applyLoa/applyRehire/applyConversion -> JmlOutcome (with delta) [pool.js]
 *   - baselineTemplatesFor, mintEntitlement, ENTITLEMENT_TEMPLATES,
 *     TOXIC_PAIRS, SOD_TAG                                            [entitlements.js]
 *   - SOD_RULES, detectSodConflicts, detectSodConflictsDetailed      [sod.js]
 *   - toScimUser, toScimGroup, scimActiveFor, SCIM_SCHEMA, Scim*      [scim.js]
 *   - LOCATIONS, resolveLegalEntity, businessActivityWeight,
 *     DIVISION_CODE, JOB_FAMILIES_BY_DIVISION, LEGAL_ENTITIES         [org.js]
 *   - NameAllocator, generateName, slugForEmail                       [names.js]
 */

export * from './org.js';
export * from './names.js';
export * from './entitlements.js';
export * from './sod.js';
export * from './scim.js';
export * from './pool.js';
