# Observability Primitive Implementation Plan

> **STATUS:** Draft — plan only, not yet started.

**Goal:** Ship OpenTelemetry-native observability as a first-class framework capability. Every framework seam auto-emits OTel spans and metrics; end users reach for one primitive (`ctx.span / ctx.metric / ctx.mark` inside handlers, declared `metric.counter/histogram/gauge` from a `*.metrics.ts` file). Zero-config default via `OTEL_EXPORTER_OTLP_ENDPOINT`; all spans auto-tagged with workspace + user.

**Architecture:** New workspace package `@syncengine/observe` hosts the SDK bootstrap, seam helpers (`instrument.*`), ctx extension, and declared metric factories. Existing packages (`server`, `serve`, `gateway-core`, `vite-plugin`) gain call sites at their seams — each call site is a one-liner wrapping the existing handler. Inside a workflow the ctx exposes `ctx.run` (span-on-step) instead of `ctx.span` to avoid concept duplication with Restate's durable-step model. File-based discovery for `*.metrics.ts` matches the existing `.actor.ts`/`.workflow.ts`/`.webhook.ts`/`.heartbeat.ts` convention in `@syncengine/vite-plugin`.

**Tech Stack:** `@opentelemetry/api`, `@opentelemetry/sdk-node`, `@opentelemetry/resources`, `@opentelemetry/semantic-conventions`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/exporter-metrics-otlp-http`, `@opentelemetry/sdk-trace-base` (for `InMemorySpanExporter` in tests). Pinned versions. Opt-in `@opentelemetry/instrumentation-fetch-node` for the `autoInstrument: ['fetch']` knob.

**Spec:** `docs/superpowers/specs/2026-04-21-observability-primitive.md`

---

## Architectural decisions (locked before Phase A)

### OTel as the wire format — not a custom protocol

Direct OTLP/HTTP export. No in-framework protocol shim. A devtools in-memory exporter is a later spec — v1 optimizes for real APM delivery.

### Server-only in v1

No browser instrumentation. `packages/client` is untouched. Gateway connection spans are emitted from the server side of the WS only.

### Seam integration via one helper per kind

Each seam calls `instrument.entityEffect(ctx, effect, fn)` / `instrument.busPublish(ctx, topic, fn)` / etc. Helpers short-circuit to a no-op when the SDK isn't active; zero allocation on the disabled path. User code never imports OTel directly.

### Restate-as-downstream-service (W3C propagation), no workflow span wrapping

Restate emits its own OTel spans for workflow invocation lifecycle and each `ctx.run` durable step. We do NOT emit `workflow.*` or `workflow.*.step` spans — duplicating them would be noisy and contradicts the propagation model. Instead, we:

- Inject W3C `traceparent` into invocation headers at the caller side so Restate's server-side workflow span nests under our calling span.
- Extract `traceparent` from `ctx.request().headers` at handler entry and use it as the parent context for any non-durable `ctx.span` calls inside the handler.
- Keep BOTH `ctx.run` (durable, Restate-spanned) and `ctx.span` (non-durable, our span) on the workflow ctx — they're orthogonal. `ctx.run` is a pure passthrough to Restate; we do not wrap it.

Both pipelines (ours + Restate server) must export to the same OTLP endpoint. User configures `OTEL_EXPORTER_OTLP_ENDPOINT` and `RESTATE_TRACING_ENDPOINT` (documented in the user guide).

### File-based metric discovery

`*.metrics.ts` files auto-loaded by the vite plugin, same pattern as `.actor.ts` / `.workflow.ts` / `.webhook.ts` / `.heartbeat.ts`. Every exported `metric.counter/histogram/gauge` registers with the global meter provider.

### Sampling default — parent-based

Ratio 1.0 when `NODE_ENV !== 'production'`, 0.1 in production. Parent-based so whole traces stay intact. Overridable via `sampling.ratio` in config.

### Log correlation, no OTel logs pipeline

Inject `traceId` / `spanId` into the existing `@syncengine/serve` JSON logger when a span is active. No OTel logs exporter in v1 — stdout JSON stays the log shipping interface.

### `fetch` auto-instrumentation — opt-in

`observability.autoInstrument: ['fetch']`, default off. Keeps the base install lean; users opt in explicitly.

### Attribute namespace is closed

Every framework-emitted span carries `syncengine.workspace`, `syncengine.user` (when available), `syncengine.primitive`, `syncengine.name`, plus seam-specific constants (`syncengine.op`, `syncengine.topic`, etc.). Constants live in `packages/observe/src/semantic.ts` — no string literals at call sites. User attrs merge on top; workspace/user can't be overwritten.

---

## Dependency graph

```
Phase A — Foundation
  ├── A1 package skeleton + semantic constants + noop
  ├── A2 SDK bootstrap (+ resource, sampling)
  └── A3 core config schema extension
         │
         ▼
Phase B — First vertical slice (entity effect end-to-end)
  ├── B1 instrument.entityEffect + entity-runtime call site
  ├── B2 ObservabilityCtx factory (span/metric/mark) + wire into entity ctx
  └── B3 SDK boot wired into serve + vite-plugin
         │
         ▼  [Checkpoint 1: real APM sees entity spans]
         ▼
Phase C — Remaining seams
  ├── C1 HTTP request + RPC
  ├── C2 Gateway connection + RPC
  ├── C3 Bus publish/consume
  ├── C4 Restate bridge: caller-side span + traceparent extraction (NO workflow wrap)
  ├── C5 Webhook inbound + run
  └── C6 Heartbeat tick
         │
         ▼  [Checkpoint 2: full trace tree visible]
         ▼
Phase D — User-facing DX
  ├── D1 Declared metric factory
  ├── D2 File-based *.metrics.ts discovery
  ├── D3 Log correlation (traceId/spanId in serve logger)
  └── D4 Opt-in fetch auto-instrumentation
         │
         ▼  [Checkpoint 3: zero-code observability works]
         ▼
Phase E — Verification + docs
  ├── E1 End-to-end trace tree test in apps/test
  └── E2 User guide
         │
         ▼  [Checkpoint 4: ship]
```

---

## Phase A — Foundation (3 tasks)

**Goal:** `@syncengine/observe` package exists, boots OTel, and the core config accepts an `observability` block. No seam integration yet.

### Task A1: Scaffold `@syncengine/observe` package

**Description:** Create the new workspace package with public surface (`index.ts` exporting `metric` factory placeholders and types), semantic constants module, and noop implementation. No OTel wiring yet — this is the shell.

**Acceptance criteria:**
- [ ] `packages/observe/package.json` created with correct `name`, `exports`, `types`, `scripts`.
- [ ] `packages/observe/src/index.ts` re-exports public types and (stub) `metric` factory.
- [ ] `packages/observe/src/semantic.ts` defines attribute-key constants (`ATTR_WORKSPACE`, `ATTR_USER`, `ATTR_PRIMITIVE`, `ATTR_NAME`, `ATTR_OP`, `ATTR_TOPIC`, `ATTR_INVOCATION`, `ATTR_DEDUP_HIT`) and the `Primitive` union.
- [ ] `packages/observe/src/noop.ts` exports no-op implementations of the ctx extension and metric factories.
- [ ] Added to `pnpm-workspace.yaml` (or discovered automatically if glob already covers it — verify).
- [ ] Package typechecks and builds.

**Verification:**
- [ ] `pnpm --filter @syncengine/observe build` exits 0.
- [ ] `pnpm --filter @syncengine/observe typecheck` exits 0.
- [ ] `pnpm -w typecheck` still passes.

**Dependencies:** None

**Files likely touched:**
- `packages/observe/package.json`
- `packages/observe/tsconfig.json`
- `packages/observe/src/index.ts`
- `packages/observe/src/semantic.ts`
- `packages/observe/src/noop.ts`

**Estimated scope:** S (package scaffolding)

---

### Task A2: SDK bootstrap + resource + sampling

**Description:** Implement `bootSdk(options)` that starts the OTel Node SDK with OTLP/HTTP trace + metric exporters, parent-based sampler at the configured ratio, and auto-detected resource merged with user-supplied resource attrs. Must honor standard OTel env vars. Expose `shutdownSdk()` for graceful shutdown in `serve`. Disabled path returns early (no allocations, no SDK import cost beyond static import — lazy-require to be addressed if needed).

**Acceptance criteria:**
- [ ] `packages/observe/src/sdk.ts` exports `bootSdk(opts: ObservabilityConfig): SdkHandle` and `shutdownSdk(handle)`.
- [ ] `packages/observe/src/resource.ts` builds the default resource (`service.name`, `service.version`, `process.*`, `host.*` from sdk-node auto-detectors), merged with user `resource`.
- [ ] Parent-based sampler: 1.0 ratio when `NODE_ENV !== 'production'`, `opts.sampling?.ratio ?? 0.1` otherwise.
- [ ] `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` honored.
- [ ] `exporter: false` short-circuits: no SDK started, all seam helpers/ctx methods remain noops.
- [ ] Unit tests with `InMemorySpanExporter` assert: SDK boots, a manually-created span is exported, disabled-config produces no spans.

**Verification:**
- [ ] `pnpm --filter @syncengine/observe test` passes, including the `sdk.test.ts` cases.
- [ ] Package typechecks.

**Dependencies:** A1

**Files likely touched:**
- `packages/observe/src/sdk.ts`
- `packages/observe/src/resource.ts`
- `packages/observe/src/__tests__/sdk.test.ts`
- `packages/observe/package.json` (add OTel deps)

**Estimated scope:** M

---

### Task A3: Extend `@syncengine/core` config schema with `observability`

**Description:** Add the `observability` block to the config schema in `@syncengine/core` so `config({ observability: { ... } })` typechecks. The schema is pure shape — no runtime side effects from core. The server binary reads the validated block at boot and passes it to `bootSdk`.

**Acceptance criteria:**
- [ ] `ObservabilityConfig` type exported from `@syncengine/core` with fields: `serviceName?`, `exporter?: 'otlp' | false`, `resource?: Record<string, unknown>`, `sampling?: { ratio: number }`, `captureFieldValues?: boolean`, `autoInstrument?: Array<'fetch'>`.
- [ ] `config()` accepts and type-narrows `observability`.
- [ ] A unit test in `core` exercises valid + invalid shapes.
- [ ] No runtime OTel imports in `core` — the type is structural; boot happens in `serve` and `vite-plugin`.

**Verification:**
- [ ] `pnpm --filter @syncengine/core test` passes.
- [ ] `pnpm -w typecheck` passes.

**Dependencies:** A1 (semantic types live in observe; config type lives in core — no circular)

**Files likely touched:**
- `packages/core/src/config.ts` (or wherever `config()` lives)
- `packages/core/src/__tests__/config.test.ts`
- `packages/core/src/index.ts` (re-export)

**Estimated scope:** S

---

## Phase B — First vertical slice: entity effect end-to-end (3 tasks)

**Goal:** A real span appears in an OTLP backend for an entity effect. Proves the whole chain works before expanding to more seams.

### Task B1: `instrument.entityEffect` + entity-runtime call site

**Description:** Implement the first seam helper and wire it into `entity-runtime.ts`. The helper starts a span named `entity.<name>.<op>` with workspace/user/primitive/name/op attributes, runs the effect, records exceptions, ends the span.

**Acceptance criteria:**
- [ ] `packages/observe/src/internal.ts` exports `instrument.entityEffect(ctx, effect, fn)`.
- [ ] Helper merges ATTR_WORKSPACE, ATTR_USER, ATTR_PRIMITIVE='entity', ATTR_NAME, ATTR_OP onto the span.
- [ ] Exceptions rethrown after `recordException` + `setStatus({ code: ERROR })`.
- [ ] Disabled-path is a straight pass-through with no span creation.
- [ ] `entity-runtime.ts` wraps the user effect with this helper.
- [ ] Integration test in `packages/server/src/__tests__`: run an entity insert with `InMemorySpanExporter` installed, assert one span with the expected name + attributes.

**Verification:**
- [ ] `pnpm --filter @syncengine/server test` passes.
- [ ] `pnpm --filter @syncengine/observe test` passes.
- [ ] Exception-path test asserts span status code ERROR + recorded exception event.

**Dependencies:** A2

**Files likely touched:**
- `packages/observe/src/internal.ts`
- `packages/observe/src/__tests__/internal.test.ts`
- `packages/server/src/entity-runtime.ts`
- `packages/server/src/__tests__/entity-runtime.observe.test.ts` (new)

**Estimated scope:** M

---

### Task B2: `ObservabilityCtx` factory + wire into entity ctx

**Description:** Build the ctx extension (`span`, `metric`, `mark`) and splice it into the context object the entity runtime hands to user effects. Workflow ctx is NOT touched yet — that's C4. This task adds the factory and proves it works in the entity path.

**Acceptance criteria:**
- [ ] `packages/observe/src/ctx.ts` exports `makeObservabilityCtx({ workspace, user, primitive, name })` returning `{ span, metric, mark }`.
- [ ] `span<T>(name, fn, attrs?)` creates a child span, runs fn, auto-merges workspace/user/primitive/name, records exceptions, returns fn's result.
- [ ] `metric(name, value, attrs?)` records an ad-hoc metric reading via the global meter.
- [ ] `mark(name, attrs?)` calls `addEvent` on the active span.
- [ ] Entity-runtime passes ctx extension into user effects.
- [ ] Unit tests cover: nested spans, thrown exception, no active span (metric still works, mark is a silent no-op), attr merge precedence (auto-tags can't be overwritten).

**Verification:**
- [ ] `pnpm --filter @syncengine/observe test` passes.
- [ ] Entity-runtime integration test shows a parent→child span when user code calls `ctx.span`.

**Dependencies:** B1

**Files likely touched:**
- `packages/observe/src/ctx.ts`
- `packages/observe/src/__tests__/ctx.test.ts`
- `packages/server/src/entity-runtime.ts` (pass ctx in)
- `packages/server/src/__tests__/entity-runtime.observe.test.ts` (extend with ctx.span assertion)

**Estimated scope:** M

---

### Task B3: Boot the SDK in `serve` and `vite-plugin`

**Description:** Call `bootSdk` at startup in both the production binary (`@syncengine/serve`) and the dev middleware (`@syncengine/vite-plugin`). Register `shutdownSdk` on process signals so buffered spans flush. Dev and prod must behave identically from the user's viewpoint.

**Acceptance criteria:**
- [ ] `packages/serve/src/index.ts` calls `bootSdk` after reading the config's `observability` block, before any HTTP listener starts.
- [ ] `packages/vite-plugin/src/index.ts` (or the right entry) calls `bootSdk` during dev-server init.
- [ ] `shutdownSdk` registered on `SIGTERM` / `SIGINT` in `serve`.
- [ ] Manual check: set `OTEL_EXPORTER_OTLP_ENDPOINT` to a local collector (`docker run otel/opentelemetry-collector`), run `apps/test`, trigger an entity effect, see the span arrive.
- [ ] `exporter: false` in config disables boot in both paths.

**Verification:**
- [ ] Existing `serve` + `vite-plugin` tests still pass.
- [ ] `pnpm -w test` green.
- [ ] Manual: collector receives a span for an entity insert.

**Dependencies:** A2, A3, B1

**Files likely touched:**
- `packages/serve/src/index.ts`
- `packages/vite-plugin/src/index.ts`
- Possibly `packages/serve/src/flags.ts` if we pipe env here

**Estimated scope:** S

### Checkpoint 1 — First vertical slice

- [ ] `pnpm -w build` clean.
- [ ] `pnpm -w test` clean.
- [ ] Running `apps/test` with a local OTLP collector shows entity effect spans with workspace/user/primitive/name attributes.
- [ ] `ctx.span` inside a user entity effect produces a nested span in the trace.
- [ ] `exporter: false` path asserted to have zero span exports (benchmarked — see risk mitigation).
- [ ] Review with human before proceeding to Phase C.

---

## Phase C — Remaining seams (6 tasks)

**Goal:** Every framework seam listed in the spec emits spans. Each sub-task follows the same shape as B1 (helper + call site + integration test).

Sub-tasks C1–C6 are **structurally independent** — they can be parallelized if multiple sessions are available. Each one ships:

- An `instrument.<seam>` helper in `packages/observe/src/internal.ts`.
- A single call site edit in the owning package.
- An integration test asserting the span shape.

### Task C1: HTTP request + RPC spans

**Description:** Wrap the top-level HTTP request handler in both `serve` (prod) and `vite-plugin` dev middleware, plus the `/__syncengine/rpc/*` proxy. Root span for the request, child span for the RPC if present.

**Acceptance criteria:**
- [ ] `instrument.request(req, fn)` opens a root span named `http.<method> <route>`.
- [ ] `instrument.rpc(ctx, name, fn)` opens a child span named `rpc.<name>`.
- [ ] Both call sites wired (prod + dev).
- [ ] Integration test in `packages/server` asserts the trace tree for an RPC request.

**Verification:**
- [ ] `pnpm --filter @syncengine/server test` green.
- [ ] Manual: curl an RPC endpoint → see request span in collector.

**Dependencies:** B3

**Files likely touched:**
- `packages/observe/src/internal.ts`
- `packages/serve/src/index.ts`
- `packages/vite-plugin/src/index.ts`
- `packages/server/src/__tests__/http.observe.test.ts` (new)

**Estimated scope:** M

---

### Task C2: Gateway connection + RPC spans

**Description:** In `gateway-core` (and the `gateway/` dir in server), wrap the WS connection lifetime with a span and each inbound RPC call with a child span. Propagate traceparent from the incoming WS handshake if present.

**Acceptance criteria:**
- [ ] `instrument.gatewayConnection(ctx, fn)` — span `gateway.connection`, lifetime of the WS.
- [ ] RPC calls over WS nested under the connection span.
- [ ] Integration test with the existing gateway test harness.

**Verification:** `pnpm --filter @syncengine/gateway-core test` + `pnpm --filter @syncengine/server test` green.

**Dependencies:** B3

**Files likely touched:**
- `packages/observe/src/internal.ts`
- `packages/gateway-core/src/...` (one call site)
- `packages/server/src/gateway/...` (one call site)
- New test file

**Estimated scope:** M

---

### Task C3: Bus publish/consume spans

**Description:** Wrap `bus-on`/`bus-manager` publish and consume paths. Publish span is the parent of the consume span across a topic hop — use W3C trace-context propagation via message headers on NATS.

**Acceptance criteria:**
- [ ] `instrument.busPublish(ctx, topic, fn)` span + trace-context injection into NATS headers.
- [ ] `instrument.busConsume(ctx, topic, fn)` span, extracts parent context from headers.
- [ ] Integration test: publish → consume produces a connected two-span trace.

**Verification:** `pnpm --filter @syncengine/server test` green; trace tree assertion covers the hop.

**Dependencies:** B3

**Files likely touched:**
- `packages/observe/src/internal.ts`
- `packages/server/src/bus-on.ts`
- `packages/server/src/bus-manager.ts`
- `packages/server/src/__tests__/bus.observe.test.ts` (new)

**Estimated scope:** M

---

### Task C4: Restate integration — caller-side span + in-handler context extraction

**Description:** Implement the W3C TraceContext bridge to Restate without emitting any `workflow.*` span ourselves. Two moving parts: (1) at every point the framework dispatches a Restate invocation, wrap with `instrument.workflowInvoke` which opens a short caller-side span and injects `traceparent` into the invocation headers so Restate's server span nests under ours; (2) at handler entry, extract `traceparent` from `ctx.request().headers` via `W3CTraceContextPropagator` and install it as the active context so any user `ctx.span` inside the handler nests under Restate's span in the APM.

Also verify: do Restate invocation attributes carry our auto-tags (`syncengine.workspace`, `syncengine.user`) onto Restate's server-emitted spans? Outcome determines whether auto-tagging is complete or partial — see spec "Restate integration" section.

**Acceptance criteria:**
- [ ] `instrument.workflowInvoke(callerCtx, name, fn)` exists in `packages/observe/src/internal.ts`; opens span `workflow.<name>.invoke` (caller-side only), injects `traceparent` into the headers passed to the Restate client.
- [ ] All framework dispatch paths that invoke Restate (bus-subscriber dispatch, entity-effect → workflow, direct invocation) go through this helper. Identify + enumerate these paths.
- [ ] Handler-entry adapter in `packages/observe/src/restate.ts` (new): extracts `traceparent` from `ctx.request().headers` and installs context via `W3CTraceContextPropagator`. Used by the workflow ctx factory so `ctx.span` inside a handler produces a child of Restate's span.
- [ ] Workflow ctx exposes BOTH `ctx.run` (unwrapped Restate call) AND `ctx.span` (our non-durable span). Orthogonal — documented.
- [ ] Integration test with a real Restate instance: dispatch a workflow, verify Restate's server span shows up with our caller-side span as parent, verify `ctx.span` inside the handler nests under Restate's span.
- [ ] Bus-triggered workflow test: publish a bus message that fans out to a subscriber workflow, verify the trace survives the hop.
- [ ] Verification spike on invocation attributes: attempt to attach `syncengine.workspace` / `syncengine.user` as invocation attributes; document outcome in the spec's "Restate integration" section.

**Verification:**
- [ ] `pnpm --filter @syncengine/server test` green, including new restate-trace tests.
- [ ] Manual: run `apps/test` with real Restate + OTLP collector, open a trace in Jaeger/Honeycomb, confirm the parent-child relationship from caller → Restate workflow span → in-handler spans.

**Dependencies:** B3, C1

**Files likely touched:**
- `packages/observe/src/internal.ts`
- `packages/observe/src/restate.ts` (new — header extraction helper)
- `packages/server/src/workflow.ts`
- `packages/server/src/bus-manager.ts` or `gateway-core` (wherever dispatch happens)
- `packages/server/src/__tests__/workflow.observe.test.ts` (new)

**Estimated scope:** L → split if it grows. Likely two sessions: first the caller-side + header extraction, second the bus-subscriber dispatch path + integration assertions.

---

### Task C5: Webhook inbound + run

**Description:** Wrap the inbound HTTP verification layer and the compiled-workflow handler run with spans. Tag `syncengine.dedup.hit=true` when idempotency dedup fires.

**Acceptance criteria:**
- [ ] `instrument.webhookInbound(req, fn)` span `webhook.<name>.inbound` with verification outcome.
- [ ] `instrument.webhookRun(ctx, fn)` span `webhook.<name>.run` (inside the Restate workflow).
- [ ] Dedup hit path sets `syncengine.dedup.hit=true` and returns early without running user code.
- [ ] Integration test: first invocation creates two spans; retry with same idempotency key shows inbound span only with `dedup.hit=true`.

**Verification:** `pnpm --filter @syncengine/server test` green.

**Dependencies:** B3, C1 (webhook reuses the HTTP helper upstream)

**Files likely touched:**
- `packages/observe/src/internal.ts`
- `packages/server/src/webhook-http.ts`
- `packages/server/src/webhook-workflow.ts`
- `packages/server/src/__tests__/webhook.observe.test.ts` (new)

**Estimated scope:** M

---

### Task C6: Heartbeat tick

**Description:** Wrap the heartbeat tick handler with a span. Simplest seam — scheduler fires, we span the tick.

**Acceptance criteria:**
- [ ] `instrument.heartbeat(ctx, fn)` span `heartbeat.<name>.tick`.
- [ ] Integration test: heartbeat run produces one span per tick with expected attrs.

**Verification:** `pnpm --filter @syncengine/server test` green.

**Dependencies:** B3

**Files likely touched:**
- `packages/observe/src/internal.ts`
- `packages/server/src/heartbeat.ts` or `heartbeat-workflow.ts`
- `packages/server/src/__tests__/heartbeat.observe.test.ts` (new)

**Estimated scope:** S

### Checkpoint 2 — All seams instrumented

- [ ] Every seam in the spec checklist has a helper + call site + passing test.
- [ ] Manual: run `apps/test` scenario that touches HTTP → RPC → entity → bus → workflow; collector shows unbroken trace tree.
- [ ] `pnpm -w typecheck && pnpm -w test && pnpm -w build` green.
- [ ] Review with human before Phase D.

---

## Phase D — User-facing DX (4 tasks)

**Goal:** The things a user actually writes: declared metrics, file-based discovery, correlated logs, opt-in fetch.

### Task D1: Declared metric factory

**Description:** Implement `metric.counter(name, opts?)`, `metric.histogram(name, opts?)`, `metric.gauge(name, opts?)` returning handles with `.add` / `.observe` / `.record`. Each handle auto-merges workspace/user attrs from the current ctx (via AsyncLocalStorage set by seam helpers) and accepts user attrs.

**Acceptance criteria:**
- [ ] `metric.counter/histogram/gauge` exported from `@syncengine/observe`.
- [ ] Handles lazily acquire a `Meter` from the global meter provider using a stable instrumentation scope.
- [ ] When called inside a ctx-bearing handler, workspace/user attrs auto-attached.
- [ ] When called outside a ctx, only user-supplied attrs attached.
- [ ] Unit tests assert attribute merge behavior in both cases.

**Verification:** `pnpm --filter @syncengine/observe test` green; metric handles produce readings an `InMemoryMetricExporter` captures.

**Dependencies:** B2 (ObservabilityCtx carries the workspace/user we pull from ALS)

**Files likely touched:**
- `packages/observe/src/metric.ts` (new)
- `packages/observe/src/ctx.ts` (set ALS on span enter)
- `packages/observe/src/__tests__/metric.test.ts` (new)
- `packages/observe/src/index.ts` (export `metric`)

**Estimated scope:** M

---

### Task D2: File-based `*.metrics.ts` discovery

**Description:** Extend the vite plugin's file discovery to pick up `*.metrics.ts` files and surface them through the same boot-time registration pipeline that handles `.actor.ts` / `.workflow.ts` / `.webhook.ts` / `.heartbeat.ts`. Importing a `*.metrics.ts` file is enough to register its exports with the meter provider at boot.

**Acceptance criteria:**
- [ ] Vite plugin discovers `src/**/*.metrics.ts` files.
- [ ] Discovered files are imported at boot so declared metrics register.
- [ ] Documented in the same place as other file-based conventions.
- [ ] Integration test: an `apps/test` fixture with a `metrics.metrics.ts` file exposes its metrics via the meter provider at boot.

**Verification:** `pnpm --filter @syncengine/vite-plugin test` green; apps/test boot picks up metrics.

**Dependencies:** D1

**Files likely touched:**
- `packages/vite-plugin/src/...` (discovery registration — look at how `.actor.ts` is registered and mirror)
- `apps/test/src/observability.metrics.ts` (new fixture)
- `packages/vite-plugin/src/__tests__/...` or `apps/test` integration test

**Estimated scope:** M

---

### Task D3: Log correlation — `traceId` / `spanId` in serve logger

**Description:** When a logger call happens inside an active OTel span, add `traceId` and `spanId` to the emitted JSON. When no span is active, fields are omitted. Should not introduce an OTel dependency into the logger itself — pull the active context via a minimal adapter owned by `@syncengine/serve`.

**Acceptance criteria:**
- [ ] `packages/serve/src/logger.ts` checks for an active span at emit time and includes `traceId` / `spanId`.
- [ ] Pretty format includes `traceId=...` on info/warn/error lines; omitted if no span.
- [ ] Unit test: emit inside a span → fields present; emit outside → fields absent.
- [ ] Zero bundle-size regression when observability disabled — lookup is a single API call.

**Verification:** `pnpm --filter @syncengine/serve test` green; new logger test passes.

**Dependencies:** B3

**Files likely touched:**
- `packages/serve/src/logger.ts`
- `packages/serve/src/__tests__/logger.test.ts`

**Estimated scope:** S

---

### Task D4: Opt-in `fetch` auto-instrumentation

**Description:** When `autoInstrument` contains `'fetch'`, install `@opentelemetry/instrumentation-fetch-node` so outbound `fetch` calls from handlers auto-propagate traceparent and produce client spans. Default is off.

**Acceptance criteria:**
- [ ] SDK bootstrap reads `autoInstrument` and installs fetch instrumentation if requested.
- [ ] Installed instrumentation produces a client span for an outbound fetch call.
- [ ] Default config does not load or install the instrumentation (verify by bundle inspection or lazy-require).
- [ ] Integration test with `InMemorySpanExporter`: fetch call inside an entity effect produces nested client span.

**Verification:** `pnpm --filter @syncengine/observe test` green; `pnpm --filter @syncengine/server test` green with the fetch test.

**Dependencies:** A2

**Files likely touched:**
- `packages/observe/src/sdk.ts`
- `packages/observe/package.json` (optional dep)
- `packages/observe/src/__tests__/fetch.test.ts` (new)

**Estimated scope:** S

### Checkpoint 3 — Zero-code observability works

- [ ] Setting only `OTEL_EXPORTER_OTLP_ENDPOINT` and writing an app with one entity + one workflow produces a full trace tree in a real APM — no framework-level code changes needed.
- [ ] Writing `metric.counter(...)` in a `*.metrics.ts` file produces the metric in the APM.
- [ ] Log lines emitted inside a span carry `traceId`/`spanId`.
- [ ] `autoInstrument: ['fetch']` produces client spans; default doesn't.
- [ ] Review with human before Phase E.

---

## Phase E — Verification + docs (2 tasks)

### Task E1: End-to-end trace-tree test in `apps/test`

**Description:** Add a scenario that exercises HTTP → RPC → entity effect → bus publish → subscriber workflow → `ctx.run` step. With `InMemorySpanExporter` installed, assert the full trace tree shape (parent/child relationships, expected span names, auto-tags present).

**Acceptance criteria:**
- [ ] New test file in `apps/test` (or `packages/server/src/__tests__` if apps/test isn't the right home).
- [ ] Assertion helpers for span-tree shape (may extract to `packages/test-utils`).
- [ ] Test passes under `pnpm -w test`.

**Verification:** Green test that fails if any seam regresses.

**Dependencies:** C1–C6, D1

**Files likely touched:**
- `apps/test/...` (new scenario file)
- `packages/test-utils/src/...` (span-tree helpers, optional extraction)

**Estimated scope:** M

---

### Task E2: User guide `docs/guides/observability.md`

**Description:** Write the user-facing guide: what they get out of the box (zero-config), how to point at their APM, how to add business-logic instrumentation, the `ctx.run` vs `ctx.span` asymmetry inside workflows, the `*.metrics.ts` convention, opt-in `fetch`, and the privacy defaults (no field values exported).

**Acceptance criteria:**
- [ ] Guide exists at `docs/guides/observability.md`.
- [ ] Covers the five "what users actually do" cases: (1) point at an APM, (2) read default traces, (3) add `ctx.span` / `ctx.run`, (4) declare a metric, (5) opt in to fetch.
- [ ] Matches the tone of existing guides (`docs/guides/event-bus.md`, etc.).
- [ ] Links back to the spec and the plan.

**Verification:**
- [ ] `pnpm -w build` (if docs are in the build) green.
- [ ] Manual: one engineer reads the guide top-to-bottom and can instrument a new app without asking questions.

**Dependencies:** All prior tasks

**Files likely touched:**
- `docs/guides/observability.md`

**Estimated scope:** S

### Checkpoint 4 — Ready to ship

- [ ] All acceptance criteria across A–E met.
- [ ] End-to-end trace-tree test green in CI.
- [ ] User guide reviewed.
- [ ] Disable path (`exporter: false`) benchmark within 1% of pre-change baseline on the entity hot path.
- [ ] Human review + approval.

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| OTel SDK bundle size / startup cost bloats `serve` binary | Medium | Lazy-require `sdk-node` behind `exporter !== false`; benchmark serve startup pre/post (guard: ≤ 100ms cold-start regression). |
| Hot-path overhead from span creation on every entity effect | High | Noop-path is a single boolean check; benchmark entity-runtime insert throughput pre/post (guard: ≥ 95% of pre-change rate). If under, add a per-primitive sampling ratio. |
| `traceparent` drops on a Restate dispatch path (bus subscriber, workflow-from-workflow) | Medium | Enumerate every dispatch path in C4; assert in integration tests that `traceparent` survives each. Fallback: pass the header as an invocation attribute and reconstruct at handler entry. |
| TS SDK 1.13 lacks a native OTel context accessor | Low | Read `traceparent` from `ctx.request().headers` and extract with `W3CTraceContextPropagator`. Wrapped in `packages/observe/src/restate.ts` so a future SDK upgrade is a one-file swap. |
| Restate invocation attributes don't carry our auto-tags onto Restate's spans | Low (cosmetic) | Spike during C4. If unsupported, accept partial tagging — our upstream spans still carry workspace/user so filtering works. |
| `fetch` auto-instrumentation patches user dependencies surprisingly | Low (opt-in) | Documented as opt-in only; default install never loads it. Guide includes a "you probably don't want this unless..." note. |
| File-based `*.metrics.ts` discovery conflicts with user naming | Low | Match the existing convention precisely — users who own `.actor.ts` already understand the pattern. |
| NATS header size growth from trace-context propagation | Low | W3C traceparent is <55 bytes; add a guard in C3 asserting header budget. |
| OTel SDK pinned versions drift out of date | Low | Renovate/Dependabot already handles; note major bumps go through `Ask first` per the spec's Boundaries. |

---

## Parallelization

- **Phase A** must be sequential (A1 → A2, A3 can run parallel to A2).
- **Phase B** sequential (B1 → B2 → B3).
- **Phase C** mostly parallelizable: C2, C3, C5, C6 are independent. C4 depends on C1 (HTTP helper) and is the riskiest sub-task — start it early if multiple sessions are running so its findings (e.g., invocation-attribute support) inform the others.
- **Phase D** mostly parallel: D1 → {D2, D3, D4} in parallel.
- **Phase E** sequential after D.

If multiple agents/sessions are available, the biggest win is fanning out C1–C6 in parallel after Checkpoint 1.

---

## Open questions (for the human before Phase A)

None — all five spec-level questions resolved in spec review. If anything surfaces during implementation (e.g., Restate span-nesting doesn't work as expected in C4), flag as a mid-phase decision request rather than pressing on.
