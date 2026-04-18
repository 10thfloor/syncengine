# Event Bus Epic — Completion Summary

> Written on 2026-04-21 after the final commit (`ae7dc5a`). Captures
> what shipped, the wire-level proofs, what was deliberately deferred,
> and the decisions worth remembering next time we touch this area.

## What shipped

A fourth server-side primitive — `bus` — that slots in next to
`table`, `entity`, and `topic`. 55 commits across ~2 weeks.
Complete surface covers:

**Declaration (`@syncengine/core`)**
- `bus(name, { schema, retention, delivery, storage, dedupWindow, mode })`
- Auto-generated `.dlq` accessor with inherited mode
- Factory namespaces: `Retention`, `Delivery`, `Storage`, `Retry`,
  `Backoff`, `Concurrency`, `Rate`, `BusMode`, `Duration`, `Bytes`
- `DeadEvent<T>` type + schema helper

**Publish paths**
- Declarative `publish(bus, payload)` effect inside entity handlers
  (atomic with state transition via `emit({ state, effects })`)
- Imperative `bus.publish(ctx, payload)` from any workflow /
  webhook / heartbeat body
- Both paths route through a single `setBusPublisher` seam; tests
  swap it, production points at NATS JetStream

**Subscribe DSL (`@syncengine/server`)**
- `defineWorkflow('name', { on, services, retry }, async (ctx, event) => ...)`
- `on(bus)` fluent builder: `.where(predicate)`, `.from(cursor)`,
  `.ordered()`, `.orderedBy(fn)`, `.key(fn)`, `.concurrency(c)`,
  `.rate(r)`
- Typed `ctx.services` inferred from the declared `services: [...]`
  tuple via `ServicesOf<T>` — no casts
- Per-subscriber retry override

**Runtime (`@syncengine/gateway-core` + `@syncengine/server`)**
- `BusDispatcher` per `(workspace × subscriber)` with durable
  JetStream consumer (name: `bus:<busName>:<subscriberName>`,
  dots sanitised to `_`)
- `BusManager` owns dispatcher lifecycle: boot discovery + registry
  subscription (`syncengine.workspaces`) + SIGTERM drain
- `bootBusRuntime()` single bootstrap shared by `syncengine dev` and
  generated production entry
- Retry ownership: JetStream delivers (backoff schedule per `Retry`
  config), Restate dedups on `<bus>:<seq>`-derived invocation id,
  workflow body owns its own step retries — three distinct scopes
- Terminal-vs-retriable classifier: HTTP 500 → DLQ, 502/503/504 →
  retry, 429 → retry, 4xx with terminal marker → DLQ

**Testing (`@syncengine/server/test`)**
- `createBusTestHarness({ workflows, services })` — in-process bus
  runtime for vitest
- Capture paths: `harness.publishedOn(bus)`,
  `harness.capturePublishEffects(state)`, `harness.driveEffects(state)`
- Subscriber dispatch: `harness.dispatchedFor(workflow)` with
  `outcome: 'ok' | 'terminal-error'`; `TerminalError` routes to
  `<bus>.dlq` → DLQ subscribers fire in the same pass
- `BusMode.nats() / .inMemory()` + `override(bus, { mode })` for
  declarative test config

**Tooling**
- `syncengine add bus` CLI subcommand scaffolds `src/events/<name>.bus.ts`
- Vite plugin discovers `.bus.ts` at build time
- Smoke test: `bash scripts/smoke-docker.sh --buses` covers happy
  path + DLQ + consumer-reuse across app-container restart

## Test coverage

| Package | Tests | Notes |
|---|---|---|
| `@syncengine/core` | 319 | bus primitive, factories, entity publish() effect, duration/bytes, override polymorphism |
| `@syncengine/gateway-core` | 38 | BusDispatcher classifier, throttle validation, token-bucket math |
| `@syncengine/server` | 107 | BusManager lifecycle, bus-on DSL, harness capture + dispatch, services container |
| `apps/test` | 78 | kitchen-sink entity/workflow tests, harness demo |
| Smoke | 1 | Docker end-to-end via `scripts/smoke-docker.sh --buses` |

## Wire-level proofs

- **Ordered dispatch** — live Restate logs show
  `workflow_auditOrder/<ws>/orderEvents:O1/run` (keyed by `orderId`,
  not seq). Same-order events land on the same Restate invocation;
  distinct orders run in parallel.
- **Concurrency cap** — JetStream consumer inspection after live
  traffic shows `bus:orderEvents:auditOrder` with
  `max_ack_pending: 8`, while `bus:orderEvents:shipOnPay` (no
  `.concurrency`) has the JetStream default `1000`.
- **DLQ path** — `fail-*` orderIds produce
  `[shipping] create(fail-O2)` → `TerminalError` (HTTP 500) →
  classifier routes to `orderEvents.dlq` →
  `workflow_alertOnShippingFailure/<ws>/orderEvents.dlq:<seq>/run` →
  `[notifications] slack #alerts: shipOnPay failed 1× on order fail-O2`.
- **Imperative publish** — `shipOnPay` calls
  `await orderEvents.publish(ctx, { event: 'shipped' })` after a
  successful ship; `advanceOrderOnShipped` subscribes with
  `.where(e => e.event === 'shipped')` and advances the entity
  state machine — proves the ALS frame wraps every user handler.
- **Consumer reuse** — smoke test restarts the app container; the
  durable consumer names (`bus:<busName>:<subscriberName>`, dots
  sanitised) are deterministic, so the restarted BusManager reuses
  the existing consumers instead of creating duplicates.

## Deferred — and why

| Slice | Status | Why |
|---|---|---|
| `Concurrency.perKey(n)` | Deferred | The dispatch loop is serial, so per-key capping collapses to 1-in-flight. Needs a concurrent-dispatch refactor (not just a counter). Throws at boot with an actionable message. |
| Config auto-pathway for `override(bus)` | Deferred | vitest users have `createBusTestHarness()` directly; the "run `syncengine start` with test-mode buses" case hasn't been asked for. Open to reviving if the need materialises. |
| Layer 3 `JetStream.*` escape hatch | Deferred | Requires per-bus streams — today every bus shares the single `WS_<wsId>` stream. Architectural shift; revisit if a user hits a hard Layer 2 limit. |
| Devtools Buses tab | Deferred | UI work; the `jsz` admin endpoint + Restate's own dashboards already give enough visibility for Phase 2. |
| `WORKSPACE_DELETED` handling | Deferred | Waits on a broader workspace-lifecycle feature — `workspace.teardown` doesn't broadcast yet. |

Each has a pointer in `docs/superpowers/plans/2026-04-20-event-bus-phase-2b.md`.

## Decisions worth remembering

**Hex walls enforced structurally, not by lint.**
- Entity handlers are pure `(state, ...args) => state` — no `ctx`,
  no `async`. `publish(bus, payload)` is an effect _declaration_;
  the runtime executes it atomically with the state write.
- Workflows see `ServicePort<T>` interfaces, never vendor SDKs.
- Subscribers ARE workflows (just with `on:`); no separate primitive.

**Retry ownership is split and locked.**
1. JetStream: delivery retries with a `backoff[]` schedule derived
   from the `Retry` config.
2. Restate: invocation dedup on `<bus>:<seq>` keyed by the
   `invocationIdOf(seq, event)` derivation (default, or
   `.ordered()` / `.orderedBy(fn)` / `.key(fn)`).
3. Workflow body: its own `ctx.run` step retries — doesn't interact
   with the dispatcher.

Three distinct scopes, zero overlap. Documenting this in
`bus-dispatcher.ts`'s header block was the single clearest move in
the whole epic.

**Terminal-vs-retriable needs the HTTP status, not the body shape.**
Restate 1.6's ingress blocks until the workflow reaches a terminal
state, so a 500 means `TerminalError` — every 500 goes to DLQ.
502/503/504 are Restate infra unavailability; retry. 429 is rate-
limiting; retry. This is the single most important piece of wire
knowledge in the whole runtime; got it wrong initially (treated 500
as retriable, DLQ never fired), shipped the fix as `eb0beb1`.

**One bootstrap, two call sites.**
The dev-mode direct-execution branch and the generated production
entry duplicated the bus bootstrap. Dev mode silently no-opped
subscribers for one session (`fd8fc19`) before `ae7dc5a` extracted
`bootBusRuntime()`. If you find yourself string-templating bootstrap
code, stop — write the helper, import it.

**The test harness is a driven adapter, not a stream simulator.**
`createBusTestHarness()` deliberately skips JetStream durability,
retry schedules, and Restate journaling. Those are infra concerns;
unit tests should assert on domain outcomes. The harness models
exactly what the dispatcher does _semantically_ (predicate filter,
invocation id derivation, TerminalError → DLQ) and nothing more.

**Publisher seam is the integration point.**
`setBusPublisher(publisher)` in `@syncengine/core` is the single
place the publish machinery hooks the world. NATS installs its
version at boot; the test harness installs a capturing version.
Entity runtime and imperative `bus.publish(ctx, ...)` both route
through this seam — one integration point, two dispatch paths,
zero divergence.

## Links

- Spec: `docs/superpowers/specs/2026-04-20-event-bus-design.md`
- Phase 1 plan: `docs/superpowers/plans/2026-04-20-event-bus.md`
- Phase 2a plan: `docs/superpowers/plans/2026-04-20-event-bus-phase-2a.md`
- Phase 2b plan: `docs/superpowers/plans/2026-04-20-event-bus-phase-2b.md`
- User guide: `docs/guides/event-bus.md`
- Migration guide: `docs/migrations/2026-04-20-trigger-to-publish.md`
- Kitchen-sink demo: `apps/test/src/events/orders.bus.ts` + workflows under `apps/test/src/workflows/`
