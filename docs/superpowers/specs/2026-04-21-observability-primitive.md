# Observability Primitive

**Date:** 2026-04-21
**Status:** Draft
**Scope:** New framework capability — `@syncengine/observe` (new package), instrumentation seams in `@syncengine/server`, `@syncengine/serve`, `@syncengine/gateway-core`, `@syncengine/vite-plugin`

## Summary

Ship first-class observability with Meteor-like DX: the framework auto-instruments its own seams (bus, entity runtime, workflows, gateway, heartbeats, webhooks, HTTP/RPC proxies) with **OpenTelemetry** from the very first boot, and end users reach for **one primitive** — context-scoped `ctx.span / ctx.metric` inside handlers, plus declared `metric.counter / histogram / gauge` for business-logic signals usable anywhere. Every span and metric is auto-tagged with the workspace and user derived from the existing runtime context.

Zero code in user business logic is required for 80% of useful observability. Exporting to any APM that speaks OTLP (Honeycomb, Datadog, Grafana Tempo + Mimir, New Relic, Jaeger, Dash0, …) is a single env var or config block.

This spec covers **server-side only** for v1. Browser instrumentation is deferred.

## Context: why bake this in

The framework already owns every high-value observability seam:

- **Bus (`bus-manager`, `bus-on`, `bus-boot`)** — every topic publish and subscription hop.
- **Entity runtime (`entity-runtime`)** — every table effect (insert / update / delete).
- **Workflows (`workflow`)** — every Restate invocation and step.
- **Gateway (`gateway-core`, `gateway` dir in server)** — every WS connection and RPC call.
- **Heartbeats (`heartbeat`, `heartbeat-workflow`)** — every tick.
- **Webhooks (`webhook`, `webhook-http`, `webhook-workflow`)** — every inbound verification and handler run.
- **HTTP / static server in `serve`** — every request.

Users write `entity(...)`, `topic(...)`, `workflow(...)`, `webhook(...)`, `heartbeat(...)`. They do not wire tracers. If the framework drops OTel at those boundaries, the user gets a full request / event flow "for free" — the same Meteor-style magic value-objects and workflows already deliver.

APM export is the primary consumer: the target user deploys a syncengine app and wants traces in Honeycomb or Datadog the same day. The devtools panel is a secondary consumer that reads the same OTel data in-process via an in-memory exporter (covered in a future devtools-panel spec, not here).

## Goals

- **Zero-config default.** Set `OTEL_EXPORTER_OTLP_ENDPOINT` (or configure `observability` in `syncengine.config.ts`) and traces/metrics start flowing. Nothing else required.
- **Framework seams auto-instrumented.** Entity ops, bus publish/consume, workflow invocation/steps, gateway connections + RPCs, heartbeat ticks, webhook inbound + handler, HTTP/RPC proxy — each emits a span and contributes to metrics without user code.
- **Auto-scoping on every signal.** Every span and metric carries `syncengine.workspace` and (when available) `syncengine.user`, plus the primitive kind and name (`syncengine.primitive=entity`, `syncengine.name=todos`).
- **One user-facing primitive, two shapes.** `ctx.span / ctx.metric / ctx.mark` inside any framework-invoked handler (workflow, entity effect, topic handler, webhook, heartbeat); declared `metric.counter/histogram/gauge` factories for metrics that live outside a ctx. (`mark` is a span annotation / breadcrumb — named to avoid colliding with the existing "event" vocabulary around the bus and topics.)
- **OpenTelemetry-native wire format.** No custom protocol. Users plug in any OTLP backend.
- **Safe by default.** Failures in the exporter never block the hot path. No field values are exported from entity rows (names only) unless the user opts in.

## Non-Goals (v1)

- **Browser / client-side instrumentation.** `packages/client` stays untouched in v1. The WS server side of the gateway still emits spans; the browser just doesn't. (Phase 2 candidate.)
- **Vendor-specific exporters baked into core.** OTLP over HTTP is the only built-in. Users wanting e.g. the Datadog native exporter install it themselves and swap the exporter via config — documented but not bundled.
- **Log correlation via a log-export pipeline.** The existing `@syncengine/serve` logger gains a `traceId` / `spanId` field when a span is active, but logs stay on the stdout JSON pipeline (structured). Real log shipping is out of scope.
- **Custom sampling strategies.** OTel's built-in parent-based + trace-id-ratio is enough for v1. Tail sampling etc. is deferred.
- **PII policy / redaction framework.** v1 is "names, not values." Any richer policy lands later.
- **Distributed trace propagation across user-defined HTTP boundaries.** Framework boundaries propagate (gateway, webhook, workflow, bus). A user calling `fetch()` in their handler does not auto-propagate — they use `ctx.span` to wrap it.

## Mental model

Three layers, top-down:

```
┌─ User business logic ───────────────────────────────┐
│  • ctx.span('charge-card', fn)  ctx.metric(...)     │  ← primitive
│  • ctx.mark('charged', { amount })                  │  ← breadcrumb
│  • metric.counter('orders.placed').add(1)           │  ← declared
└────────────────────┬────────────────────────────────┘
                     │ (parent trace + auto-tags inherited)
┌─ Framework seams (auto-instrumented) ───────────────┐
│  entity  topic  workflow  gateway  heartbeat        │
│  webhook  HTTP/RPC  bus publish/consume             │
└────────────────────┬────────────────────────────────┘
                     │ OTel SDK
              ┌──────┴──────┐
              │ OTLP/HTTP   │  →  Honeycomb / Datadog / Tempo / …
              └─────────────┘
```

The runtime `ctx` that entities/workflows/webhooks/heartbeats already carry gains three methods — `span`, `metric`, `mark`. These are thin wrappers around `@opentelemetry/api` with the current workspace/user attributes pre-applied. Users writing handler code never import OTel directly. We deliberately avoid the word "event" here because the framework already uses it for bus / topic events; `mark` names the OTel concept (a timestamped annotation on the current span) without overloading domain vocabulary.

Declared primitives (`metric.counter(...)`) are registered at config boot, the same way entities/topics are, so devtools (later) can enumerate them.

## API surface

### 1. Config

```ts
// syncengine.config.ts
import { config } from '@syncengine/core';

export default config({
  workspaces: { /* ... */ },
  observability: {
    // Default service name comes from package.json; override here.
    serviceName: 'notepad',
    // Default is OTLP/HTTP honoring OTEL_EXPORTER_OTLP_ENDPOINT env.
    // Set to `false` to disable entirely (e.g. in tests).
    exporter: 'otlp',
    // Optional extra resource attrs merged with auto-detected ones.
    resource: { environment: process.env.VERCEL_ENV ?? 'dev' },
    // Parent-based sampling. Default ratio: 1.0 when NODE_ENV !== 'production',
    // 0.1 in production. Override here if needed.
    sampling: { ratio: 0.1 },
    // Opt in to including entity field values on spans (off by default).
    captureFieldValues: false,
    // Opt-in auto-instrumentation of third-party surfaces. Default: [] (nothing).
    // Currently supported: 'fetch' — patches global fetch so outbound HTTP from
    // handlers auto-propagates traceparent and produces client spans.
    autoInstrument: [],
  },
});
```

Environment variables matching the OTel spec (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`) are honored with no config at all. A user who sets `OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io` in their deploy gets traces with no code change.

### 2. Context-scoped primitive (inside handlers)

Handler ctxs that already exist — topic handlers, webhook `run`, heartbeat `tick`, workflow body — are extended with observability methods. Entity handlers are the exception: they are **pure** by design (identical execution on client for optimistic UI and on server for durable writes), so they receive no `ctx`. Entity handlers rely on framework-emitted auto-spans (`entity.<name>.<op>`, added by `instrument.entityEffect`) and declared metrics. A future follow-up may add AsyncLocalStorage-based helpers for user-written spans inside a pure handler, but v1 keeps the surface small.

For the handler types that do have a ctx:

```ts
interface ObservabilityCtx {
  /** Run `fn` inside a child span; auto-records errors and duration. */
  span<T>(name: string, fn: () => Promise<T> | T, attrs?: Attrs): Promise<T>;
  /** Shortcut for an ad-hoc metric recording. Prefer declared metrics for anything reused. */
  metric(name: string, value: number, attrs?: Attrs): void;
  /** Timestamped annotation (breadcrumb) on the active span. Named `mark` — not `event` — to avoid colliding with bus/topic events. */
  mark(name: string, attrs?: Attrs): void;
}
```

**Inside a workflow, `ctx.run` and `ctx.span` coexist.** Restate emits its own span for each `ctx.run` durable step (server-side, via Restate's own OTel pipeline — see "Restate integration" below), so we do not wrap `ctx.run`. `ctx.span` is available for non-durable, purely-for-tracing spans *within* a step (e.g., inside a `ctx.run` body, a user wants to time a sub-operation without making it durable). The two primitives are orthogonal:

- `ctx.run(name, fn)` — durable step, Restate emits the span.
- `ctx.span(name, fn)` — non-durable nested span, we emit it.
- `ctx.metric(...)` / `ctx.mark(...)` — same semantics everywhere.

Example (workflow):

```ts
// src/workflows/place-order.workflow.ts
export const placeOrder = workflow('placeOrder', async (ctx, order) => {
  // Durable step — Restate owns the span for this.
  const charge = await ctx.run('charge-card', () => stripe.charge(order));
  ctx.mark('charged', { amount: order.amount });

  // Non-durable nested span inside a step — useful for finer-grained tracing
  // of work the user doesn't want persisted as a separate retry boundary.
  await ctx.run('send-receipt', async () => {
    await ctx.span('render-template', () => templates.render(order));
    await ctx.span('smtp-send',       () => email.send(order, charge));
  });
});
```

Example (webhook / heartbeat / topic handler):

```ts
// Anywhere outside a workflow that has a ctx, ctx.span wraps work.
await ctx.span('validate-payload', () => schema.parse(input));
```

All framework-emitted spans inherit `syncengine.workspace`, `syncengine.user`, `syncengine.primitive`, and `syncengine.name` automatically. Restate-emitted spans carry the workspace/user via Restate's invocation attributes where the server version supports it (see Restate integration).

### 3. Declared metric primitive (anywhere)

```ts
// src/metrics.ts
import { metric } from '@syncengine/observe';

export const orderLatency = metric.histogram('order.latency', {
  unit: 'ms',
  description: 'End-to-end order placement latency',
});
export const orderFailed = metric.counter('order.failed');
export const activeCarts = metric.gauge('cart.active');
```

```ts
// Used from anywhere, including plain utility modules:
import { orderLatency, orderFailed } from './metrics.ts';

orderLatency.observe(ms, { reason: 'ok' });
orderFailed.add(1, { reason: 'card-declined' });
```

When called from inside a ctx-bearing handler, workspace/user/primitive attrs are auto-merged. When called outside (cron-like utility, module init), only the attrs you pass are attached — same behavior as the OTel API, just with the prefixed attribute namespace kept consistent.

**Discovery is file-based** — `*.metrics.ts` files under `src/` are auto-loaded at boot, matching the existing convention for `.actor.ts` / `.workflow.ts` / `.webhook.ts` / `.heartbeat.ts`. Every exported `metric.counter/histogram/gauge` is registered with the global meter provider and made available for devtools enumeration later. No explicit import in `syncengine.config.ts` required.

### 4. No API change for framework authors (much)

Framework seams call into an internal `@syncengine/observe/internal` shim that returns a no-op when observability is disabled. E.g. in `entity-runtime.ts`:

```ts
import { instrument } from '@syncengine/observe/internal';

export async function applyEffect(ctx, effect) {
  return instrument.entityEffect(ctx, effect, async () => {
    // existing effect logic
  });
}
```

`instrument.entityEffect` starts a span named `entity.<name>.<op>`, tags the standard attrs, records exceptions, and returns the handler's result. One helper per seam type.

## Attribute conventions

All framework-emitted spans and metrics follow this schema:

| Attribute               | When                     | Example                      |
| ----------------------- | ------------------------ | ---------------------------- |
| `syncengine.workspace`  | Always when ctx has one  | `"ws_room1"`                 |
| `syncengine.user`       | When ctx has a user      | `"user_alice"`               |
| `syncengine.primitive`  | Always                   | `entity \| topic \| workflow \| webhook \| heartbeat \| gateway \| bus` |
| `syncengine.name`       | Always                   | `"todos"` / `"placeOrder"`   |
| `syncengine.op`         | Entity spans             | `insert \| update \| delete` |
| `syncengine.topic`      | Bus spans                | `"order.placed"`             |
| `syncengine.invocation` | Workflow spans           | Restate invocation id        |
| `syncengine.dedup.hit`  | Webhook spans            | `true` when idempotency hit  |

User code adding its own attrs through `ctx.span` or declared metrics gets them merged *after* the auto-tags — users can't accidentally overwrite workspace/user, but can add their own keys freely.

## Restate integration

Restate is a separate process that already emits its own OTel traces for invocation lifecycle, suspend/resume, retries, and each `ctx.run` durable step. Duplicating those spans in our pipeline would be wasteful and noisy. Instead, we treat Restate as a downstream service in a distributed trace and use standard W3C TraceContext propagation to stitch the two pipelines into one trace in the APM.

### Division of labor

| Span | Emitted by |
| --- | --- |
| HTTP request, RPC, gateway connection, bus publish/consume, webhook inbound, heartbeat tick, entity effect | us |
| Workflow invocation lifecycle (invoke / suspend / resume / retry / journal entries / `ctx.run` step) | Restate |
| Non-durable spans inside a workflow handler (`ctx.span`, user business logic) | us |

### Propagation

- **Caller → Restate:** when the framework dispatches a workflow invocation (bus subscriber, entity effect emitting a workflow, direct invocation) we inject the current active span's W3C `traceparent` into the invocation headers. Restate's server-side workflow span nests under ours automatically.
- **Restate → handler:** the TypeScript SDK (1.13) does not expose the OTel context directly to handlers. We read `traceparent` from `ctx.request().headers` at handler entry and extract the context with `@opentelemetry/core`'s `W3CTraceContextPropagator`. That extracted context becomes the parent of any `ctx.span` we open inside the handler — so our in-handler spans nest under Restate's invocation span in the APM.

### Configuration

Both pipelines must export to the same collector / APM. Users set:

```
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.com   # our SDK
RESTATE_TRACING_ENDPOINT=https://otel.example.com      # Restate server
```

The user guide calls this out prominently. A future DX polish (out of v1 scope) is a single env var that the bootstrap fans out to both.

### Auto-tagging Restate's spans

Restate's invocation spans carry the invocation's key and name by default. For our auto-tags (`syncengine.workspace`, `syncengine.user`) to appear on Restate's spans, we would need to attach them as *invocation attributes* via the SDK. This is a verification item during implementation (Task C4). Outcomes:

- **If supported:** we set `syncengine.workspace` / `syncengine.user` as invocation attributes at invocation time; they show up on every Restate-emitted span for that invocation.
- **If not supported:** our auto-tags live on the caller-side span and on every span we emit inside the handler. Restate's workflow span carries only Restate's own attributes. Users can still filter traces by our upstream spans carrying workspace/user. Acceptable fallback.

### No Restate-span wrapping on our side

We explicitly do NOT emit a `workflow.<name>` or `workflow.<name>.<step>` span. That would produce duplicate spans in the APM and contradict the propagation model. `ctx.run` is a pure Restate call; `instrument.workflowStep` is not a thing.

## Package layout

```
packages/observe/
  package.json
  src/
    index.ts              ← public: metric factories, types
    ctx.ts                ← ObservabilityCtx factory used by server primitives
    internal.ts           ← instrument.* seam helpers (not re-exported publicly)
    sdk.ts                ← bootSdk(config): starts OTel NodeSDK with OTLP exporter
    noop.ts               ← zero-cost no-op when disabled
    resource.ts           ← default resource attrs (service, runtime, region)
    __tests__/
      ctx.test.ts
      metric.test.ts
      sdk.test.ts         ← uses InMemorySpanExporter
```

Dependencies added (all `@opentelemetry/*`, pinned, peer-optional where it helps):

- `api` — public types, used everywhere.
- `sdk-node` — bootstrap.
- `resources`, `semantic-conventions` — resource + attr keys.
- `exporter-trace-otlp-http`, `exporter-metrics-otlp-http`.
- `sdk-trace-base` — `InMemorySpanExporter` for tests.

## Seam checklist

Each seam gets an `instrument.*` helper and a test that asserts the span shape:

- [ ] `instrument.request(req)` — top-level HTTP span in `serve` and Vite middleware.
- [ ] `instrument.rpc(ctx, name, fn)` — `/__syncengine/rpc/...`.
- [ ] `instrument.gatewayConnection(ctx, fn)` — WS lifetime.
- [ ] `instrument.entityEffect(ctx, effect, fn)` — entity runtime.
- [ ] `instrument.busPublish(ctx, topic, fn)` — `bus-on` + `bus-manager`.
- [ ] `instrument.busConsume(ctx, topic, fn)` — `bus-on`.
- [ ] `instrument.workflowInvoke(callerCtx, name, fn)` — **caller-side** span around a workflow invocation. Injects W3C `traceparent` into the invocation so Restate's server-side spans nest under ours. The workflow's own lifecycle + each `ctx.run` step are spanned by Restate, not by us.
- [ ] `instrument.webhookInbound(req, fn)` — HTTP layer.
- [ ] `instrument.webhookRun(ctx, fn)` — handler layer (workflow-compiled).
- [ ] `instrument.heartbeat(ctx, fn)` — tick.

Each helper: starts a child span, records exception on throw, records duration metric of the same name, merges auto-tags.

## Log correlation

The existing `@syncengine/serve` logger gets trace-aware without adopting OTel's logs pipeline:

- When a logger call happens while an OTel span is active, `traceId` and `spanId` are pulled from the active context and added to the emitted JSON line.
- When no span is active, the fields are omitted — the logger stays silent about things it doesn't know.
- The logger does **not** become an OTel log exporter. Logs still ship via stdout JSON; users pick them up with whatever agent they already run (Vector, Fluent Bit, Datadog Agent, etc.) and correlate by `traceId` in the APM UI.

This keeps the logger's "no pino, no winston" lean stance while making the correlation just work. A real OTel logs pipeline is a later spec.

## Tech Stack

- **OpenTelemetry JS SDK** (Node), pinned versions.
- **OTLP/HTTP exporter** as the default export path.
- Lives in a new `packages/observe/` workspace package.
- Imported into `server`, `serve`, `gateway-core`, `vite-plugin`.

## Commands

```
Build all:        pnpm build
Build observe:    pnpm --filter @syncengine/observe build
Test observe:     pnpm --filter @syncengine/observe test
Test integration: pnpm --filter @syncengine/server test -- observe
Lint:             pnpm lint
Dev (with OTel):  OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 pnpm dev
```

## Project Structure

```
packages/observe/src/        → new package (public primitives + internal seams)
packages/server/src/         → seam call sites (entity-runtime, bus-*, workflow, heartbeat, webhook-*)
packages/serve/src/          → HTTP request span + SDK bootstrap in the production binary
packages/gateway-core/src/   → gateway connection + RPC span call sites
packages/vite-plugin/src/    → dev-server HTTP span + SDK bootstrap for dev
apps/test/                   → integration tests exercising all seams with InMemorySpanExporter
docs/guides/observability.md → user-facing guide (new)
```

## Code Style

Follows existing syncengine conventions. Lean module surface, no default exports, no magic strings — span names derive from declared primitive names, attribute keys are constants in `semantic.ts`:

```ts
// packages/observe/src/semantic.ts
export const ATTR_WORKSPACE = 'syncengine.workspace' as const;
export const ATTR_USER      = 'syncengine.user' as const;
export const ATTR_PRIMITIVE = 'syncengine.primitive' as const;
export const ATTR_NAME      = 'syncengine.name' as const;
// ...

export type Primitive =
  | 'entity' | 'topic' | 'workflow' | 'webhook'
  | 'heartbeat' | 'gateway' | 'bus' | 'http';
```

## Testing Strategy

- **Unit** (`packages/observe/src/__tests__`) — ctx span lifecycle, metric factory lifecycle, attr merging, noop fallback when disabled.
- **Integration** (`packages/server/src/__tests__`) — boot the SDK with `InMemorySpanExporter`, exercise each primitive (entity effect, workflow, bus publish, webhook inbound, heartbeat tick), assert one span per seam with the expected name + auto-tags.
- **End-to-end** (`apps/test`) — one happy-path test per primitive flowing through the real bus (in-memory mode), assert the full trace tree shape (root → child → grandchild).
- **Coverage target:** the observe package tracks 90%+ line coverage; seam call sites are covered through server integration tests rather than branch-by-branch.
- **No real OTLP calls in tests.** Always `InMemorySpanExporter` / `InMemoryMetricExporter`.

## Boundaries

- **Always:**
  - Auto-tag `workspace` / `user` / `primitive` / `name` on every framework-emitted signal.
  - Wrap handler invocations so exceptions are recorded on the active span before rethrowing.
  - Return no-ops when observability is disabled (`exporter: false` or no env/config).
  - Honor `OTEL_*` env vars with equal precedence to `observability.*` config.
- **Ask first:**
  - Adding a new auto-instrumented seam (changes the default surface area).
  - Changing default sampling ratios.
  - Adding attributes whose values are user data (row fields, request bodies).
  - Bumping OTel SDK major versions.
  - Introducing a second exporter path beyond OTLP/HTTP.
- **Never:**
  - Export entity field values without `captureFieldValues: true`.
  - Block the hot path on exporter failures — always fire-and-forget, log a single warning.
  - Instrument the browser client in v1 (deferred).
  - Emit PII (user IDs are emitted; email / names / raw payloads are not).
  - Throw from inside an `instrument.*` helper — swallow + one-time warn.

## Success Criteria

A deployment passes v1 if all of these are true:

1. A user who adds `OTEL_EXPORTER_OTLP_ENDPOINT` to their env and redeploys sees traces in their APM within one request cycle, with zero code change.
2. A trace for a single user action (e.g. placing an order) shows: HTTP request → RPC → entity effect → bus publish → workflow → workflow steps, in one unbroken tree.
3. Every span in that trace has `syncengine.workspace` and `syncengine.user` attributes without the user writing any attribute code.
4. A user writes `ctx.span('charge-card', fn)` inside a workflow and sees a child span under the workflow span in their APM.
5. A user declares `metric.counter('order.failed')` and calls `.add(1)` — the metric appears in the APM's metrics namespace with the declared name.
6. Disabling observability (`exporter: false`) produces zero OTel-related allocations in a hot loop benchmark (compare pre/post with `--prof`).
7. Every seam listed in the checklist has an integration test asserting its span shape.

## Risks & Mitigations

- **OTel SDK bundle size** — sdk-node is ~1.5MB. Mitigation: keep it out of the browser build (already out of scope in v1); lazy-require in `serve` behind the bootstrap check so apps disabling observability don't pay the load cost.
- **Hot-path overhead** — span creation is cheap but not free. Mitigation: seam helpers short-circuit to noop when the SDK isn't active; benchmark entity effect path before/after.
- **Restate span propagation edge cases** — the design relies on W3C TraceContext propagating through invocation headers into Restate and back out via `ctx.request().headers` at handler entry. Bus-triggered workflows and workflows invoked from other workflows are the paths most likely to drop the header. Mitigation: assert in integration tests that the `traceparent` header survives every dispatch path; if it doesn't, pass it via an invocation attribute as a backup and reconstruct the context from that.
- **TS SDK lacks a first-class OTel context accessor** — Java/Kotlin SDKs expose `handlerRequest.openTelemetryContext()`; TypeScript 1.13 does not. We work around by reading `traceparent` from `ctx.request().headers` and extracting with `W3CTraceContextPropagator`. Mitigation: a thin helper in `@syncengine/observe/restate` that wraps the extraction; if the SDK adds a native API later, swap the implementation behind the helper.
- **User confusion with two metric shapes** (`ctx.metric` vs declared `metric.counter`) — Mitigation: docs lead with declared metrics as the default; `ctx.metric` presented as the "quick and dirty" variant. Guide has a one-paragraph "when to use which."
- **Namespace collision on `syncengine.*` attrs** — vanishingly low, but Mitigation: constants module, grep-able, single source of truth.

## Resolved decisions

These started as open questions and were resolved during spec review:

1. **Declared metric discovery — file-based (`*.metrics.ts`).** Matches every other framework primitive and enables devtools enumeration later without user annotations.
2. **Default sampling — parent-based, ratio 0.1 in production / 1.0 elsewhere.** Keeps APM bills sane out of the box; `sampling.ratio` overrides. Parent-based so whole traces stay intact.
3. **Log correlation — inject `traceId`/`spanId` into the existing `serve` logger only.** No OTel logs exporter in v1; the stdout-JSON pipeline stays lean. Separate spec later for real logs shipping.
4. **`fetch` auto-instrumentation — opt-in via `observability.autoInstrument: ['fetch']`, default off.** Avoids surprise global patching and keeps the zero-config install minimal. Users who want outbound propagation flip the knob.
5. **`ctx.span` vs Restate `ctx.run` inside workflows — both exist and are orthogonal.** Restate emits the span for each durable `ctx.run` step (via its own OTel pipeline). We do not wrap `ctx.run`. `ctx.span` remains available inside workflow handlers for *non-durable* nested spans (e.g., timing a sub-operation within a step without making it a retry boundary). Traces from the two pipelines stitch via W3C TraceContext propagation — see "Restate integration" above. Earlier decision to hide `ctx.span` on the workflow ctx is reversed.

## Phase 2 preview (not this spec)

- Browser client instrumentation: a `@syncengine/observe/client` entry that auto-instruments the gateway connection and propagates traceparent over WS.
- Devtools panel: reads from an in-memory OTel exporter, shows live trace trees + metric sparklines, enumerates declared metrics.
- Vendor-specific exporters shipped as optional packages (`@syncengine/observe-datadog`) when OTLP overhead isn't acceptable.
- Richer sampling policies (tail-sampling proxy, per-workspace sampling).
