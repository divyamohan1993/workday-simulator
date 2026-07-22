# Architecture - Workday Simulator

## What it is

A production-grade workforce and identity traffic generator. It models an entire Deutsche
Bank workday (people joining, moving, and leaving; logging in; requesting access;
processing payments and trades; tripping compliance controls) and streams it as a
realistic, statistically-modeled, high-volume event stream to an Identity Manager (One
Identity Manager / OneIM) over its inbound APIs. It ships a self-contained reference OneIM
receiver so the whole system is demonstrable end-to-end with no external dependency.

## Who uses it and why

IAM and IGA engineers, security researchers, and bank platform teams load-testing and
edge-testing an Identity Manager: validating Joiner/Mover/Leaver automation, segregation-
of-duties enforcement, connector resilience, and provisioning latency under production-
like load and extreme edge cases (credential stuffing, mass reorg, insider threat, audit-
season surge, ransomware lateral movement, payroll batch, mass password reset, connector
outage).

## Runtime shape

A single Node.js 22 process (Fastify) serving three surfaces from one origin:

1. the control and telemetry REST API and the telemetry WebSocket (`/api`, `/ws`),
2. the built-in reference receiver (`/scim/v2`, `/ingest`),
3. the static cinematic dashboard (`dist/web`).

State for the simulator itself (runs, scenarios, targets) lives in a local better-sqlite3
database via Drizzle. The receiver keeps its own separate in-memory provisioning state.

## Module graph

```
                         +------------------+
                         |  server (Fastify)|  composition root
                         |  REST + WS +static|
                         +---------+--------+
                                   | builds and wires
   +-----------+-----------+-------+-------+-----------+-----------+
   |           |           |               |           |           |
 store      metrics     runtime         receiver    (config)    (static web)
 (sqlite/   (histograms  (control loop)  (OneIM ref) (zod)       (React dash)
  drizzle)   telemetry)     |             self-contained
                            | composes per run
        +-------------------+-------------------+
        |          |            |               |
      core       identity     events         delivery
   (clock,      (workforce   (event         (scim/webhook/rest/
    arrival,     pool, JML)   generator,     nats/batch, retry,
    eventbus)                 sagas)         circuit breaker,
                                             backpressure OWNER)
```

Dependency direction is one-way: everything depends on `src/types` and `src/contracts`;
nothing in a leaf module depends on the server. The server is the only place that knows
about all modules at once.

## Data flow (one run)

```
 scenario + target ---> runtime.start()
     |                      |
     |                      +-- seed identity pool (deterministic)
     |                      +-- create per-run clock + arrival process
     |                      +-- create per-run delivery adapter (from target)
     |                      +-- reset metrics; subscribe delivery + metrics to bus
     v
 control loop (tick):
     clock.advance ----> accelerated simulated workday time
     arrival.next -----> exponential inter-arrival at lambda(t), scaled by throttle
     generate ---------> a typed WorkdayEvent (JML kinds mutate the pool)
     bus.publish ------> [ delivery.submit ]  [ metrics.recordEvent ]
     saga -------------> ordered follow-on events sharing correlationId
     throttle = f(delivery.pressure())        // closed-loop safety valve
     every interval ---> metrics.snapshot() -> TelemetryFrame -> WS clients

 delivery worker pool (async):
     dequeue -> map event via event.delivery -> wire call (undici / NATS)
             -> retry (jittered backoff) / circuit breaker
             -> DeliveryResult -> metrics.recordDelivery

 receiver (target = built-in):
     inbound SCIM/webhook/rest/hr-batch/NATS
             -> validate + authenticate
             -> simulate provisioning per connector (latency, failures)
             -> SoD conflict detection, orphan and dormant accounting
             -> ReceiverStats (pulled into each TelemetryFrame)

 runtime.stop():
     halt generation -> delivery.flush() -> compute RunSummary -> persist -> return
```

## Key design decisions

- **Payload-map discriminated union.** `WorkdayEvent` is derived from `EventPayloadMap`, so
  the union and the payload shapes cannot drift. Narrowing on `kind` narrows `payload`.
- **Backpressure has exactly one owner: the DeliveryAdapter.** The EventBus is a synchronous
  unbuffered fan-out and never becomes a hidden queue. The arrival generator is otherwise
  open-loop (it pushes the configured load); the runtime is the single closed-loop control,
  throttling arrivals only when the adapter reports saturation. This is deliberate: a load
  generator should try to sustain target RPS and MEASURE the target's failures, with a
  bounded safety valve rather than silent unbounded buffering.
- **The receiver is a separate system, modeled as such.** It does not share the simulator's
  database. That keeps the "system under test" boundary honest and lets it be reset alone.
- **Determinism by seed.** The identity pool, arrival PRNG, and event payloads all derive
  from a seed, so a run can be replayed and tests are stable.
- **Non-homogeneous Poisson arrivals.** Login and activity volume follow a realistic multi-
  timezone diurnal curve rather than a flat rate, because a bank's day has overlapping
  regional peaks, a lunch dip, market open and close spikes, and overnight and weekend
  troughs.
- **Security-first delivery.** Per-target auth (bearer, basic, oauth2 client-credentials
  with token caching, HMAC body signing); target secrets are redacted in every API
  response; all API mutations require the admin bearer token; all input is validated with
  zod before it reaches a handler.

## Deployment

Docker multi-stage build (deps, build server and web, slim non-root runtime) listening on
8477, behind Caddy (`deploy/caddy/workday.dmj.one.caddy`) which terminates TLS and adds
security headers. `docker-compose.yml` runs the app and an optional NATS service.
`autoconfig.sh` builds the image, runs the container, and health-checks it. See the
project README for the deploy walkthrough.

## Technology

Node 22 ESM + TypeScript 5.9, Fastify 5, better-sqlite3 13 + Drizzle, pino, zod 4, undici 8,
optional NATS. Frontend: Vite 8 + React 19 + Tailwind 3, Recharts, Zustand, Framer Motion,
WebSocket live telemetry. Single root `package.json`, pnpm.
