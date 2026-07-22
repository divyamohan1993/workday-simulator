# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses semantic
versioning.

## [Unreleased]

### Added

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

### Notes

- TypeScript is pinned to 5.9.x rather than 7.0: the native TypeScript 7 compiler
  type-checks the core patterns cleanly, but `typescript-eslint` (and the wider lint
  tooling) does not yet support it, so 5.9 keeps every quality gate working. Revisit when
  the ecosystem catches up.
- Local `better-sqlite3` needs a C++ toolchain to build on Node 24 for Windows; the Docker
  image builds it on Node 22 for Linux where a toolchain is present.
