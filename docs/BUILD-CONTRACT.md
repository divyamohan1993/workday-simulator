# BUILD CONTRACT - Workday Simulator

This is the frozen source of truth for every builder. Read it, `src/types/index.ts`,
and `src/contracts/*.ts` before writing a line. If anything here conflicts with your
assumptions, this document wins.

---

## 0. Golden rules

1. **Import shared types from the frozen sources.** All cross-module types come from
   `src/types/index.ts`; all interfaces and factory signatures from
   `src/contracts/*.ts`. Never redefine a shared shape locally.
2. **Own only your directory.** Implement inside the one directory assigned to you.
   Do not edit files outside it. You MAY read any file.
3. **No git. No installs.** Do not run any `git` command. Do not run `pnpm install` or
   `pnpm add`. `node_modules` is already populated. If you need a new dependency, list
   it in `extraDepsNeeded` and code against it as if present.
4. **Production-grade only.** No TODOs in code paths, no placeholders, no mocked core
   logic. Full error handling, input validation, structured logging (`pino`), JSDoc on
   public APIs explaining WHY. Parameterized queries only. No secrets in code. Output
   encoding on anything user-influenced.
5. **One public entry.** Expose your module through a single `index.ts` whose exports
   match the factory signature in `src/contracts/factories.ts`.
6. **Write colocated tests.** `*.test.ts` next to the code, covering core logic. Do not
   run the full build or the whole suite; the integrator does that. Just write correct
   code and tests.
7. **No em dashes in prose or comments.** Use commas, semicolons, colons, or periods.

---

## 1. The import convention (the #1 thing to get right)

The backend is Node.js native ESM with `moduleResolution: nodenext`. That means:

- **Every relative import carries an explicit `.js` extension**, even though the file on
  disk is `.ts`. The `.js` refers to the compiled output; every tool (tsc, tsx, vite,
  vitest) resolves it back to the `.ts` source.
- **There is no `@/*` path alias in backend code.** `tsc` never rewrites path aliases in
  emitted JavaScript, which would break `node dist/server/main.js` at runtime. Use
  relative paths. (The web app under `web/` does use `@/*`; that is a separate build.)
- **Use `import type` for type-only imports.** `verbatimModuleSyntax` is on: a type-only
  import written as a value import is a compile error, and vice versa.

Correct:

```ts
import type { WorkdayEvent, DeliveryResult } from '../types/index.js';
import type { DeliveryAdapter } from '../contracts/index.js';
import { EVENT_CATEGORY } from '../types/index.js'; // runtime value, not a type
import Database from 'better-sqlite3';
```

Wrong (all of these fail the build):

```ts
import { WorkdayEvent } from '../types';          // no extension, and should be `import type`
import type { Clock } from '@/contracts/clock';    // alias + no extension
import { WorkdayEvent } from '../types/index.ts';  // never import a .ts extension
```

## 2. `loadConfig` is startup-only

`loadConfig(env)` (in `src/config/schema.ts`) is called exactly once, by
`src/server/main.ts`, at boot. **No module may call `loadConfig`, read `process.env`, or
read a config singleton at import top-level.** ADMIN_TOKEN is required, so any module that
touches config at import time would crash every unit test that imports it. Receive the
resolved `AppConfig` (and anything derived from it) through your factory's options.

---

## 3. Ownership map

| Builder    | Directory        | Public entry            | Factory signature (from `contracts/factories.ts`) |
| ---------- | ---------------- | ----------------------- | ------------------------------------------------- |
| core       | `src/core/`      | `src/core/index.ts`     | `createClock`, `createArrivalProcess`, `createEventBus` |
| identity   | `src/identity/`  | `src/identity/index.ts` | `createIdentityPool: IdentityPoolFactory`         |
| events     | `src/events/`    | `src/events/index.ts`   | `createEventGenerator: EventGeneratorFactory`     |
| delivery   | `src/delivery/`  | `src/delivery/index.ts` | `createDeliveryAdapterFactory: CreateDeliveryAdapterFactory` |
| receiver   | `src/receiver/`  | `src/receiver/index.ts` | `createReceiver: ReceiverFactory`                 |
| metrics    | `src/metrics/`   | `src/metrics/index.ts`  | `createMetricsRegistry: MetricsFactory`           |
| store      | `src/store/`     | `src/store/index.ts`    | `createStores: StoresFactory` (+ `src/store/schema.ts`) |
| runtime    | `src/runtime/`   | `src/runtime/index.ts`  | `createScenarioRuntime: ScenarioRuntimeFactory`   |
| server     | `src/server/`    | `src/server/index.ts` + `src/server/main.ts` | `buildServer: BuildServer` |
| web        | `web/src/`       | `web/src/main.tsx`      | React app (replaces the scaffold stub)            |

Owned by the architect (do not edit): `src/types/`, `src/contracts/`, `src/config/`, all
ops files, `web/` scaffold except `web/src/**` app code.

---

## 4. Per-module specifications

Exact factory option and return types are in `src/contracts/factories.ts`. The interfaces
they return are in the correspondingly named `src/contracts/*.ts`.

### core - `src/core/index.ts`

- `createClock(options: ClockOptions): Clock` - accelerated workday clock. Never moves
  simulated time backward. Computes `WorkdayPhase` from Frankfurt local time.
- `createArrivalProcess(options: ArrivalOptions): ArrivalProcess` - non-homogeneous
  Poisson via thinning. `rateAt(t)` shapes a realistic multi-timezone diurnal curve from
  `timezoneWeights` (overlapping FFT/LDN/NYC/SIN/HKG/BLR/PNQ/JAX business hours, weekend
  and overnight troughs). `nextInterArrivalMs` draws exponential inter-arrivals; a
  `throttle` in [0,1] lengthens them under backpressure. Seeded PRNG for replay.
- `createEventBus(options): EventBus` - synchronous fan-out, no buffering. A throwing
  handler is caught, logged, and isolated. Backpressure lives in delivery, never here.
- Tests: rate curve monotonic within a business ramp; exponential mean matches 1/lambda;
  bus isolates a throwing subscriber.

### identity - `src/identity/index.ts`

- `createIdentityPool(options: IdentityPoolOptions): IdentityPool`. Seeds a deterministic
  Deutsche Bank workforce (`IDENTITY_POOL_SIZE`): realistic manager chains, cost centers,
  legal entities, grade and division mixes, birthright entitlements, a fraction of
  non-human (service) identities, and deliberate edge cases (unicode and very long names,
  email and username collisions). Owns all identity state; applies JML mutations.
- Tests: determinism (same seed twice is identical), manager chains acyclic, SoD conflict
  detection finds a known toxic pair, hire/leaver/transfer mutate correctly.

### events - `src/events/index.ts`

- `createEventGenerator(options: EventGeneratorOptions): EventGenerator`. `generate(kind,
  ctx)` builds a valid, internally consistent event with a realistic payload (use
  `@faker-js/faker` seeded from `options.seed`). JML kinds mutate the pool. `saga(primary,
  ctx)` returns ordered follow-on events sharing `correlationId` (for example
  request -> approve -> provision; a login-failure streak -> account.lockout). Set
  `actor` and `subject` correctly (see the actor/subject rule below).
- Tests: every `EventKind` produces a payload that matches its type; a JML hire adds an
  identity; a saga chains correlation ids; determinism under a fixed seed.

### delivery - `src/delivery/index.ts`

- `createDeliveryAdapterFactory(options): DeliveryAdapterFactory`; `.create(target)`
  returns a `DeliveryAdapter` for `target.kind`. The adapter OWNS backpressure: a bounded
  internal queue (`target.queueHighWater`, `target.overflowPolicy`), a worker pool
  (`target.concurrency`), a token-bucket rate limit (`target.rateLimit`), jittered
  exponential retry (`target.retry`), and a circuit breaker. Uses `undici` for HTTP.
  Auth per `target.auth` (bearer, basic, oauth2 client-credentials with token caching,
  HMAC body signing). SCIM maps events to User/Group operations via `event.delivery`;
  webhook and rest POST the event; batch accumulates to `batchSize`; nats publishes to
  `natsSubject`. Reports `pressure()`; emits a `DeliveryResult` per event via `onResult`.
- Tests: retry then success on a flaky sink; circuit opens after a failure threshold;
  overflow policy drops as configured; HMAC signature is correct; rate limit caps rps.

### receiver - `src/receiver/index.ts`

- `createReceiver(options: ReceiverOptions): Receiver`. Self-contained reference OneIM.
  `plugin` is a Fastify plugin exposing SCIM 2.0 and ingest endpoints (Section 8).
  Simulates provisioning per connector (latency and failure rates), detects SoD conflicts,
  and accounts for orphan and dormant accounts. Keeps its own in-memory state; never reads
  or writes the simulator store. Authenticates inbound requests with `options.token`.
- Tests: SCIM create then get round-trips; PATCH deactivate flips status; bulk applies all
  ops; an unauthenticated request is 401; stats increment on ingest.

### metrics - `src/metrics/index.ts`

- `createMetricsRegistry(options: MetricsOptions): MetricsRegistry`. Records events and
  delivery results on the hot path with bounded memory (fixed-bucket or reservoir
  histograms, never an unbounded sample array). Maintains a newest-first recent-events
  ring of `recentEventsSize`. `snapshot(ctx)` assembles a full `TelemetryFrame`.
- Tests: p50/p95/p99 correct for a known distribution; rps smoothing; ring buffer evicts
  oldest; snapshot shape matches `TelemetryFrame`.

### store - `src/store/index.ts` (+ `src/store/schema.ts`)

- `createStores(options: StoresOptions): StoresBundle` with `{ runs, scenarios, targets,
  close() }`. Backed by `better-sqlite3` via Drizzle. Define the schema in
  `src/store/schema.ts` (referenced by `drizzle.config.ts`). Every table has `id`,
  `created_at`, `updated_at`, `deleted_at` (soft delete). Parameterized queries only.
  `remove` is a soft delete; the built-in target is protected.
- Tests: CRUD round-trips; soft delete hides from `list` but keeps `get` resolvable for
  historical references; pagination totals correct.

### runtime - `src/runtime/index.ts`

- `createScenarioRuntime(deps: RuntimeDependencies): ScenarioRuntime`. The composition of
  the control loop (Section 6). One active run at a time. Creates a per-run clock and
  arrival process (via `deps.createClock` / `deps.createArrival`) and a per-run delivery
  adapter (via `deps.deliveryFactory`). Reseeds pool and generator, resets metrics,
  subscribes delivery and metrics to the bus, reads `adapter.pressure()` each tick to
  throttle, fires chaos injectors, and emits a `TelemetryFrame` every
  `METRICS_INTERVAL_MS`.
- Tests: start then stop produces a persisted summary; throttle engages when saturated;
  a chaos injector raises the injected count; duration-bounded run auto-completes.

### server - `src/server/index.ts` + `src/server/main.ts`

- `buildServer(config: AppConfig): Promise<FastifyInstance>` - composition root. Builds the
  logger, stores, singletons, receiver, and runtime; registers `@fastify/helmet`,
  `@fastify/cors` (explicit origins from `CORS_ORIGINS`), `@fastify/rate-limit`,
  `@fastify/websocket`, `@fastify/static` (serving `WEB_DIST_PATH`); registers the receiver
  plugin at root (the plugin owns the `/scim/v2` and `/ingest` path trees); registers the
  REST API (Section 7) and the WS
  channel (Section 8). Admin auth (Section 5) guards `/api/*` except health.
- `main.ts` - `loadConfig(process.env)`, `buildServer`, `listen(PORT, HOST)`,
  health-check self-probe, graceful shutdown on SIGTERM/SIGINT. On `ConfigError`, log the
  issues and `process.exit(1)`.
- Tests: health returns ok; an unauthenticated `/api/scenarios` is 401; a valid token
  passes; the error body matches the uniform schema.

---

## 5. Auth and error contract

- Every `/api/*` route except `GET /api/health` and `GET /api/health/ready` requires
  `Authorization: Bearer <ADMIN_TOKEN>`. Missing or wrong token is `401` with the error
  body below. Three failed auths from an IP within a short window escalate to `429`.
- The WebSocket `/ws/telemetry` authenticates with `?token=<ADMIN_TOKEN>` (browsers cannot
  set WebSocket headers). A bad token closes the socket with code `4401`.
- The built-in receiver endpoints (`/scim/v2/*`, `/ingest/*`) authenticate with the
  receiver token (`RECEIVER_TOKEN`, defaulting to `ADMIN_TOKEN`).
- Uniform error body on every non-2xx: `{ error, code, requestId, details? }`.
- **Secret redaction:** any response that echoes a `DeliveryTarget` replaces auth secrets
  (`token`, `password`, `clientSecret`, `secret`) with `"***REDACTED***"`.

---

## 6. Cross-cutting protocol (frozen)

Data flow for one run:

```
runtime.tick:
  clock.advance(realDelta)                       // accelerated sim time
  due? = arrival.nextInterArrivalMs(clock.now(), throttle)
  on due:
    kind   = weighted pick from scenario.eventMix (+ active chaos bias)
    event  = generator.generate(kind, ctx)       // may mutate identity pool (JML)
    bus.publish(event)                            // synchronous fan-out
      -> delivery.submit(event)                   // bounded queue; owns backpressure
      -> metrics.recordEvent(event)               // hot-path counters + recent ring
    for follow in generator.saga(event, ctx): bus.publish(follow)
  throttle = f(delivery.pressure())               // closed-loop safety valve
  every METRICS_INTERVAL_MS: emit metrics.snapshot(ctx) -> onFrame subscribers
delivery worker:
  dequeue -> HTTP/NATS with retry + circuit breaker -> DeliveryResult
    -> metrics.recordDelivery(result)             // wired by runtime via onResult
receiver (the target, when builtIn):
  ingest -> validate -> simulate provisioning (latency, SoD, orphan) -> ReceiverStats
```

Frozen decisions:

- **EventBus is a synchronous, unbuffered fan-out.** It never queues. Backpressure is owned
  entirely by the DeliveryAdapter's bounded internal queue plus circuit breaker.
- **The runtime is the only closed-loop control.** It reads `adapter.pressure()` each tick
  and throttles the arrival rate when saturated. Everything else is open-loop.
- **The receiver is self-contained.** Its state is separate from the simulator store.
- **actor vs subject.** `actor` caused the event (an employee, a service/NHI, or the
  system for detectors and campaigns). `subject` is whom it is about, set only when it
  differs from the actor (a manager requesting access for a report; a monitor flagging an
  identity). Consumers that want "the affected identity" read `subject ?? actor`.
- **Correlation.** Saga events share one `correlationId`; each follow-on sets `causationId`
  to the id of the event that triggered it.
- **kind -> category.** Import `EVENT_CATEGORY` (or `eventCategoryOf`) from
  `src/types/index.js`. Never hand-maintain a parallel mapping.

---

## 7. REST API contract

Base path `/api`. JSON in and out. `limit` defaults to 50 (max 500); `offset` defaults 0.
`Paginated<T> = { items, total, limit, offset }`.

### Health (no auth)

| Method | Path                | Response |
| ------ | ------------------- | -------- |
| GET    | `/api/health`       | `200 { status: "ok", uptimeSec, version }` |
| GET    | `/api/health/ready` | `200 { status: "ready"\|"not_ready", checks: { db, receiver } }` |

### Config

| Method | Path          | Response |
| ------ | ------------- | -------- |
| GET    | `/api/config` | `200 { port, defaultTargetKind, workdayAccel, maxRps, metricsIntervalMs, natsEnabled, identityPoolSize, version }` (no secrets) |

### Scenarios

| Method | Path                  | Request body            | Response |
| ------ | --------------------- | ----------------------- | -------- |
| GET    | `/api/scenarios`      | -                       | `200 Paginated<ScenarioConfig>` |
| POST   | `/api/scenarios`      | `scenarioInputSchema`   | `201 ScenarioConfig` |
| GET    | `/api/scenarios/:id`  | -                       | `200 ScenarioConfig` \| `404` |
| PUT    | `/api/scenarios/:id`  | `scenarioInputSchema`   | `200 ScenarioConfig` \| `404` |
| DELETE | `/api/scenarios/:id`  | -                       | `204` \| `404` |

### Targets (secrets redacted in every response)

| Method | Path                    | Request body                | Response |
| ------ | ----------------------- | --------------------------- | -------- |
| GET    | `/api/targets`          | -                           | `200 Paginated<DeliveryTarget>` |
| POST   | `/api/targets`          | `deliveryTargetInputSchema` | `201 DeliveryTarget` |
| GET    | `/api/targets/:id`      | -                           | `200 DeliveryTarget` \| `404` |
| PUT    | `/api/targets/:id`      | `deliveryTargetInputSchema` | `200 DeliveryTarget` \| `404` |
| DELETE | `/api/targets/:id`      | -                           | `204` \| `404` \| `409` (built-in is protected) |
| POST   | `/api/targets/:id/test` | -                           | `200 { ok, latencyMs?, httpStatus?, error? }` |

### Runs

| Method | Path                    | Request body               | Response |
| ------ | ----------------------- | -------------------------- | -------- |
| GET    | `/api/runs`             | -                          | `200 Paginated<RunState>` |
| POST   | `/api/runs`             | `runStartSchema`           | `201 RunState` \| `404` \| `409` (run active) |
| GET    | `/api/runs/:id`         | -                          | `200 RunState` \| `404` |
| GET    | `/api/runs/:id/summary` | -                          | `200 RunSummary` \| `404` \| `409` (not finished) |
| POST   | `/api/runs/:id/stop`    | -                          | `200 RunSummary` \| `404` \| `409` |
| POST   | `/api/runs/:id/pause`   | -                          | `200 RunState` |
| POST   | `/api/runs/:id/resume`  | -                          | `200 RunState` |
| POST   | `/api/runs/:id/chaos`   | `chaosInjectorConfigSchema`| `202 { injected }` \| `409` (run not active) |

### Chaos, Identities, Telemetry, Receiver

| Method | Path                       | Response |
| ------ | -------------------------- | -------- |
| GET    | `/api/chaos/injectors`     | `200 [{ kind, description, params: [{ name, type, default }] }]` |
| GET    | `/api/identities`          | `200 Paginated<Employee>` (filters: `status`, `division`, `type`) |
| GET    | `/api/identities/:id`      | `200 Employee` \| `404` |
| GET    | `/api/identities/stats`    | `200 IdentityPoolStats` |
| GET    | `/api/telemetry/current`   | `200 TelemetryFrame` \| `204` (no active run) |
| GET    | `/api/telemetry/events`    | `200 WorkdayEvent[]` (query `limit`) |
| GET    | `/api/receiver/stats`      | `200 ReceiverStats` |
| POST   | `/api/receiver/reset`      | `204` |

---

## 8. WebSocket and built-in receiver

### `/ws/telemetry`

Upgrade at `GET /ws/telemetry?token=<ADMIN_TOKEN>`. On connect the server sends
`{ type: "hello", serverTime, metricsIntervalMs, protocolVersion }`, then a `frame`
message (`WsServerMessage`, see `src/types/index.ts`) every `METRICS_INTERVAL_MS`, plus
`event` and `run` messages as they occur. The client may send `{ type: "ping" }` (answered
with `pong`) and `{ type: "subscribe", channels }`.

### Built-in receiver - SCIM 2.0 under `/scim/v2`

| Method | Path                            | Purpose |
| ------ | ------------------------------- | ------- |
| POST   | `/scim/v2/Users`                | Create a provisioned user (201) |
| GET    | `/scim/v2/Users/:id`            | Fetch a user (200/404) |
| GET    | `/scim/v2/Users`                | List/filter (`filter=userName eq ...`) |
| PUT    | `/scim/v2/Users/:id`            | Replace a user |
| PATCH  | `/scim/v2/Users/:id`            | Partial update (activate/deactivate, attribute change) |
| DELETE | `/scim/v2/Users/:id`            | Deprovision (204) |
| POST   | `/scim/v2/Groups`               | Create a group |
| PATCH  | `/scim/v2/Groups/:id`           | Membership add/remove |
| POST   | `/scim/v2/Bulk`                 | Bulk operations |
| GET    | `/scim/v2/ServiceProviderConfig`| SCIM capabilities |
| GET    | `/scim/v2/ResourceTypes`        | Resource types |
| GET    | `/scim/v2/Schemas`              | Schemas |

### Built-in receiver - other ingest under `/ingest`

| Method | Path                | Purpose |
| ------ | ------------------- | ------- |
| POST   | `/ingest/webhook`   | Webhook events (HMAC verified when the target uses HMAC) |
| POST   | `/ingest/events`    | REST batch of events |
| POST   | `/ingest/hr-batch`  | Batch HR feed |

NATS: when `NATS_URL` is set, the receiver subscribes to the target's subject; delivery
publishes there. No HTTP endpoint for NATS.

---

## 9. Configuration keys

Defined and validated in `src/config/schema.ts`. See `.env.example`. Key ones:
`PORT` (8477), `HOST`, `DB_PATH`, `ADMIN_TOKEN` (required, >= 16 chars), `RECEIVER_TOKEN`
(optional; defaults to `ADMIN_TOKEN`), `LOG_LEVEL`, `DEFAULT_TARGET_KIND`, `NATS_URL`
(optional), `WORKDAY_ACCEL` (60), `MAX_RPS` (2000), `SEED`, `IDENTITY_POOL_SIZE` (20000),
`METRICS_INTERVAL_MS` (1000), `TELEMETRY_RECENT_EVENTS` (50), `WEB_DIST_PATH`,
`CORS_ORIGINS`.

---

## 10. Testing conventions

- Vitest, Node environment, globals OFF. Import `{ describe, it, expect, vi } from
  "vitest"`. Import the module under test via its `.js` specifier.
- Test behavior, not implementation. Seed anything random so tests are deterministic.
- Do not start real network servers in unit tests; use in-memory fakes or the built-in
  receiver mounted on a Fastify test instance (`app.inject`).

## 11. Needing a dependency

Do not install anything. Add the package name and reason to your handoff's
`extraDepsNeeded`, and code against it as if installed. The integrator installs and
verifies. Everything listed in `package.json` is already available.
