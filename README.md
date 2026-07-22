# Workday Simulator

**A full Deutsche Bank workday, streamed at your Identity Manager.**

Workday Simulator models an entire bank day, people joining, moving, and leaving; logging
in from eight cities; requesting access; pushing SEPA and SWIFT payments; tripping
segregation-of-duties and compliance controls, then emits it as a realistic, statistically
modeled, high-volume event stream to a OneIM-class Identity Manager over SCIM 2.0,
webhooks, REST, NATS, and batch HR feeds. Point it at your IGA platform and watch
provisioning, deprovisioning, and access governance work under production-like load and
deliberately brutal edge cases.

It ships its own reference receiver, so it demonstrates end to end with nothing else
installed.

## Why

Identity Managers fail in the gaps: a leaver whose access lingers, a mover who keeps toxic
combinations, a connector that melts under an audit-season surge, an orphan nobody owns.
You cannot find those by hand. Workday Simulator manufactures them, at scale, on demand,
and shows you exactly how the system under test responds, live.

## Who it is for

IAM and IGA engineers, security researchers, and bank platform teams validating
Joiner/Mover/Leaver automation, SoD enforcement, connector resilience, and provisioning
latency before real users, or real auditors, do it for them.

## Extreme scenarios, on a switch

Credential stuffing. Mass termination and reorg. Insider threat. Audit-season surge.
Ransomware lateral movement. Payroll batch. Mass password reset. Connector outage. Each is
an injector you layer onto a live run and dial from a whisper to a storm.

## Quick start

```bash
# 1. configure
cp .env.example .env          # set ADMIN_TOKEN to a long random secret

# 2. develop (two terminals)
pnpm dev                      # backend on :8477
pnpm dev:web                  # dashboard on :5173 (proxies to :8477)

# or run the built app
pnpm build && pnpm start      # serves API, receiver, and dashboard on :8477
```

Deploy with Docker:

```bash
cp .env.example .env          # set ADMIN_TOKEN
./autoconfig.sh               # build image, run on :8477, health-check
# or: docker compose up --build
```

Open `http://localhost:8477/` for the live telemetry dashboard.

## How it works

A single Fastify process runs the control API and telemetry WebSocket, the built-in
reference OneIM receiver, and the static dashboard. A non-homogeneous Poisson arrival
process shapes a realistic multi-timezone diurnal curve; a seeded generator produces typed,
correlated events and mutates a seeded Deutsche Bank workforce; a delivery layer streams
them to the target with per-target auth, retries, a circuit breaker, and bounded
backpressure. Full detail in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

Building a module? Start with [`docs/BUILD-CONTRACT.md`](docs/BUILD-CONTRACT.md),
`src/types/index.ts`, and `src/contracts/`.

## Tech

Node 22 ESM and TypeScript, Fastify 5, better-sqlite3 with Drizzle, pino, zod, undici,
optional NATS. Dashboard: Vite 8, React 19, Tailwind 3, Recharts, Zustand, Framer Motion,
WebSocket telemetry. Single root `package.json`, pnpm, Docker behind Caddy.

## Status

Foundation and frozen contracts are in place. Module implementations follow the build
contract.
