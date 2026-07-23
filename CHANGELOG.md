# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses semantic
versioning.

## [Unreleased]

### Added

- 2026-07-22 - Reference OneIM receiver, HTTP/WS server, infrastructure, and dashboard;
  full integration verified green.
  - `src/infra/**`: better-sqlite3 + Drizzle stores (runs, scenarios, targets) with soft
    delete and newest-first pagination, an in-memory metrics registry (fixed-bucket and
    reservoir histograms, an rps window, and a recent-events ring), and the pino logger
    factory with always-on secret redaction and correlation ids.
  - `src/receiver/**`: the built-in reference One Identity Manager. SCIM 2.0
    Users/Groups/Bulk, webhook/REST/HR-batch ingest, HMAC verification, per-connector
    asynchronous provisioning with simulated latency and failure, segregation-of-duties
    detection, and orphan/dormant accounting; keeps its own in-memory state.
  - `src/server/**`: the composition root (`buildServer`) and the process entry
    (`main.ts`). Assembles every module, mounts the receiver plugin, registers the REST API
    and the telemetry WebSocket, admin bearer auth with a failed-attempt throttle, uniform
    error bodies, secret redaction, static dashboard serving, and a self-provisioned
    loopback receiver target plus a default scenario.
  - `web/src/**`: the React 19 + Tailwind dashboard. Auth gate, live-ops view (frame-driven
    telemetry over the WebSocket), scenario builder, targets manager, and run history, with
    recharts code-split into a lazy chunk.
  - Integration: `tsc --noEmit`, `build:server`, `build:web`, and the 375-test vitest suite
    all pass. A live-run smoke against the built server generated about 26 events/sec,
    delivered them over the loopback SCIM target, and the built-in receiver provisioned
    them; `GET /api/health` and `GET /api/health/ready` both return 200. `better-sqlite3`
    built and ran natively on Node 24 for Windows in this environment.
- 2026-07-22 - Simulation core recovered post power-cut (prior commit): the workforce
  domain (`src/domain/**`), the engine clock/arrival/bus/runtime and chaos (`src/engine/**`),
  the event generators (`src/events/**`), and the delivery adapters (`src/delivery/**`).
- 2026-07-22 - Project foundation and frozen contracts.
  - Root `package.json` (Node 22 ESM, pnpm) with the full runtime and dev toolchain.
  - `src/types/index.ts`: the shared type universe. Deutsche Bank org and identity model,
    the 46-kind `WorkdayEvent` payload-map discriminated union (AUTH, JML, ACCESS, TXN,
    COMPLIANCE) with an actor/subject split, scenario and chaos config, delivery targets
    and backpressure, telemetry frames, run lifecycle, the WebSocket protocol, and runtime
    taxonomy maps (`EVENT_CATEGORY`, `GRADE_SENIORITY`).
  - `src/contracts/*.ts`: frozen interfaces (Clock, ArrivalProcess, EventBus,
    EventGenerator, IdentityPool, DeliveryAdapter, Receiver, MetricsRegistry, stores,
    ScenarioRuntime), factory-signature contracts, and zod validation schemas with
    compile-time parity guards against the type unions.
  - `src/config/schema.ts`: zod-validated configuration with a startup-only `loadConfig`.
  - `docs/BUILD-CONTRACT.md` and `docs/ARCHITECTURE.md`: the builder contract (ownership
    map, import convention, per-module APIs, REST/WS/SCIM contracts) and the architecture
    overview with the data-flow diagram.
  - Web scaffold: Vite 8 + React 19 + Tailwind 3 wiring, dev proxy, the frontend type
    mirror (`web/src/types/api.ts`), and a minimal mount stub.
  - Ops: multi-stage `Dockerfile`, `docker-compose.yml` (app plus optional NATS), the
    Caddy site snippet, `.env.example`, idempotent `autoconfig.sh`, and `drizzle.config.ts`.

### Fixed

- 2026-07-23 - Dashboard crashed on load. The follow-the-sun strip and the workday clock
  used `Europe/Frankfurt`, which is not a portable IANA zone (several ICU/Node builds omit
  the alias), so `Intl.DateTimeFormat` threw `RangeError: Invalid time zone` and white-
  screened the live dashboard. Both web call sites now use the canonical `Europe/Berlin`,
  matching the backend engine, which already did.
- 2026-07-23 - Receiver SCIM path is now tolerant of pre-existing identities. A PATCH/PUT/
  DELETE for an employee the receiver was never sent a create for (the identity pool is
  seeded independently of a run, so leaver/mover subjects almost always are) now upserts or
  no-ops instead of returning 404, matching the already-tolerant ingest path. This removes
  the spurious ~2% delivery "failures" on the default SCIM demo path and lets pre-seeded
  identities actually deactivate/provision, so orphan and dormancy accounting sees them.

### Security

- 2026-07-23 - CSP explicitly allows only the Cloudflare Web-Analytics beacon
  (`static.cloudflareinsights.com` for script, `cloudflareinsights.com` for connect) so the
  CF-injected script runs on the proxied site without loosening `script-src` to inline.
- 2026-07-23 - Request logging no longer leaks a query-string secret. The telemetry socket
  authenticates via `/ws/telemetry?token=<ADMIN_TOKEN>` (browsers cannot set WebSocket
  headers) and Fastify request logging is on, so the master token was written to stdout on
  every connect. The logger `req` serializer now strips both the URL query string and the
  parsed `query` object; regression-guarded by `src/server/request-logging.test.ts`.
- 2026-07-23 - Origin is never published on `0.0.0.0`. `docker-compose.yml` and
  `autoconfig.sh` bind the app (and NATS) to `127.0.0.1` only, because Docker's DNAT
  precedes the host firewall and a public publish would expose the origin off-Cloudflare and
  off-Caddy. `trustProxy: 'loopback'` derives `request.ip` from the loopback hop's
  X-Forwarded-For, so a client cannot spoof `X-Forwarded-For: 127.0.0.1` to hit the
  rate-limit allow-list or evade the failed-auth throttle. Empty-string optional env vars
  coerce to unset so the documented deploy no longer crash-loops on `RECEIVER_TOKEN=`/`NATS_URL=`.

### Notes

- TypeScript is pinned to 5.9.x rather than 7.0: the native TypeScript 7 compiler
  type-checks the core patterns cleanly, but `typescript-eslint` (and the wider lint
  tooling) does not yet support it, so 5.9 keeps every quality gate working. Revisit when
  the ecosystem catches up.
- Local `better-sqlite3` needs a C++ toolchain to build on Node 24 for Windows; the Docker
  image builds it on Node 22 for Linux where a toolchain is present.
