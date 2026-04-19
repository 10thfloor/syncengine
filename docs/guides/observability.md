# Observability Guide

> Traces, metrics, and log correlation — OpenTelemetry-native, wired
> into every framework seam, zero code required for the default
> pipeline. Point `OTEL_EXPORTER_OTLP_ENDPOINT` at an APM and watch
> entity handlers, bus hops, webhooks, and heartbeats land as a
> connected trace.

## Five minutes to first trace

Set one env var:

```shell
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

Boot `syncengine dev` or `syncengine serve`. Every entity handler, RPC call, bus publish, webhook, and heartbeat tick now produces a span. Trigger any user action and the full tree lands in your collector as one trace.

That's it. No imports, no decorators, no handler changes.

## What you get out of the box

Every seam the framework owns emits a span automatically:

| Seam | Span name | When |
|---|---|---|
| HTTP request | `POST rpc` (or `GET static`, `POST webhook`, …) | Every inbound request, server kind |
| RPC dispatch | `rpc.entity.<name>.<handler>`, `rpc.workflow.<name>`, `rpc.heartbeat.<name>` | Every `/__syncengine/rpc/*` call |
| Entity effect | `entity.<name>.<handler>` | Every entity handler invocation |
| Bus publish | `bus.<name> publish` | Every `bus.publish(...)`, producer kind |
| Bus consume | `bus.<name> consume` | Every subscriber-side delivery, consumer kind |
| Webhook inbound | `webhook.<name>.inbound` | Every `POST /webhooks/...` |
| Webhook run | `webhook.<name>.run` | Every compiled-workflow handler run |
| Heartbeat tick | `heartbeat.<name>.tick` | Every scheduler iteration |
| Gateway message | `gateway.<msgType>` | Every inbound WS message |

Every span carries:

- `syncengine.workspace` — workspace id
- `syncengine.user` — authenticated user id (when present)
- `syncengine.primitive` — one of `entity`, `topic`, `workflow`, `webhook`, `heartbeat`, `gateway`, `bus`, `http`
- `syncengine.name` — the declaration name (`'todos'`, `'placeOrder'`, …)

Trace context propagates across every boundary the framework owns:
- Inbound HTTP → RPC → Restate (via `traceparent` header)
- Bus publish → NATS → bus consume (via W3C headers on the message)
- Webhook POST → compiled workflow (via `traceparent` on forwarded headers)

## Pointing at a real APM

Any OTLP/HTTP endpoint works. Examples:

```shell
# Jaeger (local docker)
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318

# Honeycomb
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io:443
OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=<api-key>

# Grafana Tempo / any OTel collector
OTEL_EXPORTER_OTLP_ENDPOINT=http://tempo:4318

# Datadog (via collector sidecar)
OTEL_EXPORTER_OTLP_ENDPOINT=http://dd-otel-collector:4318
```

**Service name** defaults to your package name. Override in config if needed:

```ts
// syncengine.config.ts
export default config({
  workspaces: { ... },
  observability: {
    serviceName: 'my-app',
  },
});
```

## Restate integration

Restate is a separate process that emits its own OTel spans for workflow invocations, `ctx.run` steps, suspensions, and retries. Point it at the same endpoint to get a single unified trace:

```shell
# The framework
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io:443

# Restate server
RESTATE_TRACING_ENDPOINT=otlp+http://api.honeycomb.io:443/v1/traces
```

Both pipelines export to the same backend; W3C TraceContext propagation stitches the trees:

```
POST rpc                                      (framework)
  rpc.entity.orders.place                     (framework)
    Restate invocation: orders.place          (Restate)
      entity.orders.place                     (framework)
        ctx.run: publish-bus-event            (Restate)
```

Without `RESTATE_TRACING_ENDPOINT` set, you still get the framework-side spans; Restate's own internals just don't show up in the trace.

## Disabling observability

```ts
// syncengine.config.ts
observability: { exporter: false }
```

The OTel SDK is never imported when disabled — none of its ~1.5 MB transitive graph lands in your app. Seam helpers turn into no-ops that cost a single branch per call.

## Adding your own spans inside handlers

Handlers that receive a `ctx` (webhooks, heartbeats, topic handlers, workflows) get three extra methods:

```ts
ctx.span('name', async () => { ... }, { extra: 'attr' })  // child span
ctx.metric('name', value, { tag: 'x' })                   // ad-hoc metric reading
ctx.mark('name', { amount: 42 })                          // timestamped breadcrumb
```

### Inside a workflow

Workflows have both `ctx.run` (durable, Restate-backed) and `ctx.span` (non-durable, for tracing only). They're orthogonal:

```ts
export const placeOrder = workflow('placeOrder', async (ctx, order) => {
  // ctx.run — durable step; Restate emits the span server-side.
  const charge = await ctx.run('charge-card', () => stripe.charge(order));

  // ctx.mark — timestamped annotation on the current span.
  ctx.mark('charged', { amount: order.amount });

  // ctx.span — non-durable nested span INSIDE a run, for fine-grained
  // tracing of sub-operations that shouldn't be their own retry boundary.
  await ctx.run('send-receipt', async () => {
    await ctx.span('render-template', () => templates.render(order));
    await ctx.span('smtp-send',       () => email.send(order, charge));
  });
});
```

Rule of thumb: `ctx.run` when the step should survive a crash and replay; `ctx.span` when you just want timing visibility.

### Entity handlers are different

Entity handlers are **pure** by design (the same code runs on the client for optimistic UI and on the server for durable writes) and don't receive a `ctx`. You get a framework-emitted `entity.<name>.<handler>` span automatically; fine-grained sub-spans inside a pure handler aren't supported.

If you want to time something inside an entity handler, move that work to a workflow step.

## Declared metrics

For metrics that survive longer than a single handler invocation, declare them in a `*.metrics.ts` file:

```ts
// src/orders.metrics.ts
import { metric } from '@syncengine/observe';

export const orderPlaced = metric.counter('orders.placed', {
  description: 'Orders successfully placed',
});

export const orderLatency = metric.histogram('orders.latency', {
  unit: 'ms',
});

export const activeCarts = metric.gauge('cart.active');
```

Use anywhere:

```ts
import { orderPlaced, orderLatency, activeCarts } from './orders.metrics';

orderPlaced.add(1, { reason: 'new' });       // 1 by default if omitted
orderLatency.observe(ms);
activeCarts.record(count);
```

**Auto-tagging:** when a metric call fires inside a framework-invoked handler (entity effect, webhook run, heartbeat tick, bus subscriber), the `workspace` / `user` / `primitive` / `name` from the enclosing scope attach to the reading automatically. User-supplied attrs merge **under** auto-tags — a handler can't relabel its own workspace.

Outside a scope (cron-like utility, module-init code), only your attrs are attached.

File discovery: Vite auto-loads every `src/**/*.metrics.ts` at boot so module-level declarations evaluate, matching the existing `.actor.ts` / `.workflow.ts` / `.webhook.ts` / `.heartbeat.ts` convention.

## Log correlation

Log lines emitted during an active span automatically get `trace_id` and `span_id` fields:

```json
{"ts":"2026-04-22T10:03:21Z","level":"info","event":"order.placed","order_id":"o-1","trace_id":"abc…","span_id":"def…"}
```

Ship stdout to your APM's log ingestor; filter by `trace_id` to jump from a log line to the enclosing trace. No separate OTel logs pipeline needed.

Lines emitted outside a span stay untagged.

## Opt-in: outbound fetch instrumentation

Off by default. Opt in to auto-propagate `traceparent` onto outbound `fetch()` calls:

```ts
observability: {
  autoInstrument: ['fetch'],
}
```

When set, every `fetch()` (Node runtime — backed by undici) produces a CLIENT span and stamps a W3C `traceparent` header on the request. Downstream services that honor OTel propagation will continue the trace.

Caveat: the Bun runtime uses its own fetch implementation (not undici), so `autoInstrument: ['fetch']` is a no-op under Bun. Use it in the Vite dev server (Node) for dev-time outbound propagation. Restate, bus dispatch, and webhook forwards already propagate without this option.

## Sampling

Default: 100% in dev, 10% in production. Override:

```ts
observability: {
  sampling: { ratio: 0.5 },   // keep half of root traces
}
```

Parent-based: once a trace starts at a given sampling decision, every child span in the same trace follows suit. No orphan spans.

## Privacy defaults

- **Names are exported, values are not.** Entity column *names* land on spans; row *values* never do.
- **No secrets.** Auth tokens, API keys, request bodies stay off spans by default.
- **User id, yes. PII, no.** `syncengine.user` is the id your auth provider returns (opaque string). Emails, names, and other fields from the user object aren't exported.
- **`syncengine.invocation` on webhook.run** carries the user's `idempotencyKey(req, payload)` return value. If you use something PII-adjacent (email as dedup key, etc.), it will land on the span. Prefer opaque vendor delivery ids (GitHub `x-github-delivery`, Stripe `event.id`, etc.).

To opt in to richer entity-level data (not recommended in production):

```ts
observability: {
  captureFieldValues: true,
}
```

## Full config reference

```ts
observability: {
  /** OTel service.name — falls back to OTEL_SERVICE_NAME env or 'syncengine-app'. */
  serviceName: 'my-app',

  /** 'otlp' (default) boots the OTel SDK. false disables entirely. */
  exporter: 'otlp' | false,

  /** Extra resource attributes merged onto auto-detected ones. */
  resource: { environment: 'prod', region: 'us-east-1' },

  /** Parent-based sampler ratio. Default: 1.0 dev, 0.1 prod. */
  sampling: { ratio: 0.1 },

  /** Opt in to exporting entity row values. Default false. */
  captureFieldValues: false,

  /** Opt-in auto-instrumentation. Currently supported: 'fetch'. */
  autoInstrument: ['fetch'],
}
```

All fields optional. With no block at all, OTel env vars alone drive the pipeline.

## See also

- Spec: `docs/superpowers/specs/2026-04-21-observability-primitive.md`
- Plan: `docs/superpowers/plans/2026-04-21-observability-primitive.md`
- [`@opentelemetry/semantic-conventions`](https://opentelemetry.io/docs/specs/semconv/) — OTel attribute namespace
