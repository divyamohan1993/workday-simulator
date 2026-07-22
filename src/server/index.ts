/**
 * Public entry point for the server module.
 *
 * The frozen surface is `buildServer` (matching `BuildServer` in
 * `contracts/factories.ts`): the composition root that assembles every module into a
 * ready Fastify instance. The `BuildServerOverrides` type and `ServerContext` are
 * exported for tests and for embedders that host the app in-process; neither is part
 * of the frozen contract, and the production caller (`main.ts`) uses only
 * `buildServer(config)`.
 */

export { buildServer } from './build-server.js';
export type { BuildServerOverrides } from './build-server.js';
export type { ServerContext } from './context.js';
