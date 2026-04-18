# Event Bus — Phase 2b (modifiers, test mode, escape hatch)

> **STATUS: ✅ substantively shipped; 5 slices deferred with rationale** (table below). End-to-end verified live:
> `scripts/smoke-docker.sh --buses` + the apps/test vitest harness demo. See
> `2026-04-21-event-bus-epic-completion.md` for the consolidated epic closeout.

> Phase 2a made dispatchers real and proved the end-to-end loop via
> `apps/test` as the kitchen-sink demo. Phase 2b finishes the
> subscriber DSL that the spec [§6](../specs/2026-04-20-event-bus-design.md#6-scope--ordering)
> advertises, plus the two items that block test-writing DX
> (`BusMode.inMemory`) and power-user control
> (`JetStream.*` escape hatch).

## Status (as of 2026-04-21)

| Slice | Status | Notes |
|---|---|---|
| 2b-A — `.ordered` / `.orderedBy` / `.key` | ✅ shipped (`4be0ead`) | Wire-verified: Restate invocations keyed `orderEvents:O1` not `orderEvents:<seq>`. |
| 2b-B1 — `Concurrency.*` + `Rate.*` factory surfaces | ✅ shipped (`ac5fdb2`) | `Concurrency.global(n)` wired to `max_ack_pending`. |
| 2b-B2 — `Rate.*` token-bucket runtime | ✅ shipped (`32fd400`) | Lazy-refill bucket; NAKs with exact `delayMs`. |
| 2b-B2.5 — `Concurrency.perKey` runtime | ⏸ deferred | Blocked on concurrent-dispatch refactor; per-key capping collapses to 1-in-flight in a serial loop. |
| 2b-C1 — `BusMode` + `override(bus)` + capturing harness | ✅ shipped (`ad48b0c`) | `@syncengine/server/test` entrypoint. |
| 2b-C2 — Synchronous subscriber dispatch in harness | ✅ shipped (`631f167`) | Includes DLQ fan-out, `.where` filter, `ctx.services` resolution. |
| 2b-C3 — Config auto-pathway for bus overrides | ✅ shipped (`c456743` + `ad1448d`) | Loader splits `services.overrides` results by `$tag`; service overrides hit `ServiceContainer`, bus overrides become a `modeOf` resolver. `InMemoryBusDriver` extracted for harness + production to share. |
| 2b-D — `JetStream.*` escape hatch | ⏸ deferred | Requires per-bus streams (currently one `WS_<wsId>` stream shared across buses). |
| 2b-E — Devtools Buses tab | ⏸ deferred | UI work. |
| 2b-F — `WORKSPACE_DELETED` handling | ⏸ deferred | Waits on workspace lifecycle teardown broadcast. |

## Scope (ordered by DX impact)

### 2b-A. `on()` modifiers — ordering + dedup family

**What lands:**
- `.ordered()` — one in-flight invocation per subscriber (singleton key).
- `.orderedBy(fn: (event) => string)` — one in-flight per key; distinct keys parallel.
- `.key(fn: (event) => string)` — custom Restate invocation id beyond
  the framework default.

**Why first:** These three share implementation — they all come down to
how the dispatcher derives the Restate invocation id from the incoming
event. Today the dispatcher uses `${busName}:${m.seq}`, which gives
exactly-once processing per message but no ordering guarantees. All
three modifiers just swap the derivation function.

**Runtime:**
- `.ordered()` compiles to `.orderedBy(() => 'singleton')` — Restate's
  single-writer-per-key gives the serialisation for free.
- `.orderedBy(fn)` → `invocationId = \`${busName}:${fn(event)}\``.
  Redeliveries within the same logical key land on the same invocation
  (idempotent), parallel keys run concurrently.
- `.key(fn)` is the same mechanism but with "user owns the full id"
  semantics — bypasses the `${busName}:` prefix.

**Files:**
- `packages/server/src/bus-on.ts` — add three builder methods +
  propagate them onto `Subscription<T>`.
- `packages/gateway-core/src/bus-dispatcher.ts` — replace the
  hardcoded `${busName}:${m.seq}` with a pluggable derivation.
- `packages/server/src/bus-manager.ts` — thread the derivation from
  `$subscription` into `BusDispatcherConfig`.
- Tests: unit the derivation function alone; add an apps/test demo
  workflow that uses `.orderedBy(e => e.orderId)` so serialised
  per-order processing is visible in the smoke logs.

### 2b-B. `.concurrency` + `.rate` modifiers

**What lands:**
- `Concurrency.global(n)` / `Concurrency.perKey(n)` — cap in-flight
  invocations. `perKey` only makes sense paired with `.orderedBy`.
- `Rate.perSecond(n)` / `Rate.perMinute(n)` / `Rate.perHour(n)` —
  token-bucket throttle.

**Runtime:**
- `Concurrency.global` maps cleanly to JetStream's `max_ack_pending`
  on the durable consumer — set it, done.
- `Concurrency.perKey` requires an in-process counter inside the
  dispatcher keyed on `orderedBy(fn)` output. NAK when the counter is
  at cap; release on ack.
- `Rate` is a token bucket in the dispatcher: refill at the configured
  cadence, consume one per message, NAK with explicit delay when empty.

**Files:**
- `packages/core/src/bus-config.ts` — add `Concurrency` + `Rate`
  factory namespaces.
- `packages/server/src/bus-on.ts` — builder methods.
- `packages/gateway-core/src/bus-dispatcher.ts` — the throttle/cap
  logic inside the dispatch loop.

### 2b-C. `BusMode.inMemory()` + bus `override()`

**What lands:**
- `BusMode.inMemory()` — a bus mode that replaces NATS publish +
  JetStream consume with an in-process ring buffer; subscribers fire
  synchronously within the same task.
- `override(bus, { mode: BusMode.inMemory() })` — same mechanism users
  already know from `override(service, ...)`.
- A test harness that captures published events:
  `harness.dispatchedFor('shipOnPay')`.

**Why:** unlocks writing bus-aware tests without Docker. Right now
`publish()` + imperative `bus.publish(ctx, ...)` both require a live
NATS; unit-testing the "did this entity publish?" question means a
full smoke run.

**Files:**
- `packages/core/src/bus.ts` — `BusMode` factory + carry `$mode` on
  BusRef.
- `packages/core/src/bus-override.ts` (new) — `override(bus, opts)`
  returns a `BusOverride` tagged object.
- `packages/server/src/bus-in-memory.ts` (new) — ring-buffer publisher
  + synchronous dispatch to registered subscribers.
- Service container equivalent for buses: `BusContainer` that resolves
  BusRef → concrete driver (NATS or in-memory).

### 2b-D. `JetStream.*` escape hatch (Layer 3)

**What lands:** typed re-exports of every NATS stream/consumer option
as a factory so power users can drop to full JetStream control without
string literals.

**Scope:** type-only plumbing — mostly a translation layer from
user-facing `JetStream.retention.limits` / `JetStream.storage.file` /
`JetStream.compression.s2` / `JetStream.placement({ cluster, tags })`
to the `@nats-io/jetstream` config shape.

**Files:**
- `packages/core/src/jetstream.ts` (new) — the namespace.
- `packages/core/src/bus.ts` — `bus()` accepts an optional
  `jetstream:` option that wins over the Layer 2 factories.
- `packages/gateway-core/src/bus-dispatcher.ts` — pass through raw
  options when provided.

### 2b-E. Devtools **Buses** tab

Deferred — UI work, non-blocking for runtime correctness.

### 2b-F. `WORKSPACE_DELETED` handling

Deferred — waits for the workspace lifecycle to publish teardown
messages (currently only provision is broadcast).

## Verification

1. `pnpm -r test` green.
2. `bash scripts/smoke-docker.sh --buses` still passes.
3. New apps/test subscriber using `.orderedBy(e => e.orderId)` shows
   serialised per-order processing in logs (parallel orders interleave,
   same-order events don't).
4. A new `apps/test/src/__tests__/bus-in-memory.test.ts` exercises
   publish + subscribe without booting NATS.

## Sequencing proposal

- **2b-A first** (ordering family) — immediate DX win, small surface.
- **2b-C next** (in-memory mode) — unblocks test-writing across the
  rest of the epic.
- **2b-B after** (throttles) — bigger dispatcher delta; depends on 2b-A
  for the `perKey` counter path.
- **2b-D last** before deferrals — mostly mechanical.
