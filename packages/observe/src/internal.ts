// Seam helpers.
//
// Every framework seam (entity effect, bus publish/consume, workflow
// invoke, gateway connection, webhook inbound, heartbeat tick, HTTP
// request/RPC) calls into one of these helpers rather than touching
// `@opentelemetry/api` directly. The helpers own:
//
//   - span name conventions (`<primitive>.<name>.<op>`)
//   - the closed `syncengine.*` attribute namespace
//   - exception recording + span status on failure
//   - the disabled-path pass-through (noop tracer when no SDK booted)
//
// Callers pass only the raw context (workspace / user / name / op
// strings) — the helper maps them onto semantic-convention keys so
// changing a key is a single-file edit.

import {
    SpanKind,
    SpanStatusCode,
    context,
    propagation,
    trace,
    type Attributes,
} from '@opentelemetry/api';

import {
    ATTR_DEDUP_HIT,
    ATTR_INVOCATION,
    ATTR_NAME,
    ATTR_OP,
    ATTR_PRIMITIVE,
    ATTR_TOPIC,
    ATTR_USER,
    ATTR_WORKSPACE,
} from './semantic';
import { runInScope } from './scope';

const TRACER_NAME = '@syncengine/observe';

export interface EntityEffectAttrs {
    /** The workspace id derived from the Restate object key. */
    readonly workspace: string;
    /** The authenticated user, when the caller has one. Omit for
     *  server-to-server effects (no user context). */
    readonly user?: string;
    /** The entity definition name (e.g. `'todos'`). */
    readonly name: string;
    /** The handler name being invoked (e.g. `'add'`, `'reset'`). */
    readonly op: string;
}

/**
 * Run a user-defined entity effect inside a child span. Auto-tags the
 * span with workspace / user / primitive / name / op, records any
 * exception on the way out, and sets ERROR status before rethrowing
 * so the caller's failure handling is unaffected.
 */
async function entityEffect<T>(
    attrs: EntityEffectAttrs,
    fn: () => Promise<T> | T,
): Promise<T> {
    const spanAttrs: Attributes = {
        [ATTR_PRIMITIVE]: 'entity',
        [ATTR_NAME]: attrs.name,
        [ATTR_OP]: attrs.op,
        [ATTR_WORKSPACE]: attrs.workspace,
    };
    if (attrs.user !== undefined) spanAttrs[ATTR_USER] = attrs.user;

    const tracer = trace.getTracer(TRACER_NAME);
    // startActiveSpan — NOT startSpan — so the span becomes the active
    // parent for the duration of fn(). Child spans created inside the
    // user effect (Phase B2 `ObservabilityCtx.span`, Phase C bus/HTTP
    // auto-instrumentation) nest under this one instead of becoming
    // siblings of the outer request span.
    return tracer.startActiveSpan(
        `entity.${attrs.name}.${attrs.op}`,
        { attributes: spanAttrs },
        async (span) => {
            try {
                return await runInScope(
                    {
                        workspace: attrs.workspace,
                        primitive: 'entity',
                        name: attrs.name,
                        ...(attrs.user !== undefined && { user: attrs.user }),
                    },
                    fn,
                );
            } catch (err) {
                span.recordException(err as Error);
                span.setStatus({ code: SpanStatusCode.ERROR });
                throw err;
            } finally {
                span.end();
            }
        },
    );
}

export interface RequestAttrs {
    readonly method: string;
    /** Low-cardinality classifier used for span naming — `rpc`,
     *  `static`, `html`, `webhook`, `health`, etc. Span name becomes
     *  `<method> <route>` so traces group naturally in APMs regardless
     *  of user-supplied path cardinality. */
    readonly route: string;
    /** Full URL path — attached as the `url.path` attribute for
     *  debugging / root-cause, NOT for grouping. */
    readonly path: string;
}

/**
 * Wrap an HTTP request handler in a root SERVER-kind span. Used at
 * the outer edge of `serve` (Bun) and the Vite dev middleware; every
 * downstream seam (rpc, entity, bus …) nests under this one.
 */
async function request<T>(
    attrs: RequestAttrs,
    fn: () => Promise<T> | T,
): Promise<T> {
    const tracer = trace.getTracer(TRACER_NAME);
    return tracer.startActiveSpan(
        `${attrs.method} ${attrs.route}`,
        {
            kind: SpanKind.SERVER,
            attributes: {
                [ATTR_PRIMITIVE]: 'http',
                [ATTR_NAME]: attrs.route,
                'http.request.method': attrs.method,
                'http.route': attrs.route,
                'url.path': attrs.path,
            },
        },
        async (span) => {
            try {
                return await fn();
            } catch (err) {
                span.recordException(err as Error);
                span.setStatus({ code: SpanStatusCode.ERROR });
                throw err;
            } finally {
                span.end();
            }
        },
    );
}

export type RpcKind = 'entity' | 'workflow' | 'heartbeat';

export interface RpcAttrs {
    /** What kind of target the RPC addresses — drives `rpc.service`. */
    readonly kind: RpcKind;
    /** Entity / workflow / heartbeat definition name. */
    readonly name: string;
    /** Handler name — only set for `kind: 'entity'`. Workflows and
     *  heartbeats are addressed by invocation key instead. */
    readonly handler?: string;
    readonly workspace: string;
}

/**
 * Wrap an RPC dispatch (the edge → Restate / server-side RPC handler)
 * in a child span. Sits between the outer `request` span and the
 * target-specific seam (entity effect / workflow invoke / heartbeat
 * tick). Uses OTel RPC semconv keys plus our `syncengine.*` auto-tags
 * so both native OTel tooling and custom `syncengine.*` filters work.
 */
async function rpc<T>(
    attrs: RpcAttrs,
    fn: () => Promise<T> | T,
): Promise<T> {
    const method = attrs.handler !== undefined
        ? `${attrs.name}.${attrs.handler}`
        : attrs.name;
    const spanAttrs: Attributes = {
        'rpc.system': 'syncengine',
        'rpc.service': attrs.kind,
        'rpc.method': method,
        [ATTR_WORKSPACE]: attrs.workspace,
        [ATTR_NAME]: attrs.name,
    };
    if (attrs.handler !== undefined) spanAttrs[ATTR_OP] = attrs.handler;

    const tracer = trace.getTracer(TRACER_NAME);
    return tracer.startActiveSpan(
        `rpc.${attrs.kind}.${method}`,
        { attributes: spanAttrs },
        async (span) => {
            try {
                return await fn();
            } catch (err) {
                span.recordException(err as Error);
                span.setStatus({ code: SpanStatusCode.ERROR });
                throw err;
            } finally {
                span.end();
            }
        },
    );
}

export interface BusPublishAttrs {
    readonly busName: string;
    readonly workspace: string;
}

/** W3C TraceContext carrier handed to the busPublish callback. Callers
 *  copy these entries onto outbound NATS message headers so downstream
 *  consumers can extract the parent span context. */
export type TraceCarrier = Record<string, string>;

/**
 * Wrap a bus publish in a PRODUCER-kind span and expose a trace-context
 * carrier the caller injects into the outbound message headers. The
 * carrier is only populated when the SDK is enabled — on the disabled
 * path it's an empty object, so callers can unconditionally forward
 * whatever's in it without polluting NATS messages with stale headers.
 */
async function busPublish<T>(
    attrs: BusPublishAttrs,
    fn: (carrier: TraceCarrier) => Promise<T> | T,
): Promise<T> {
    const tracer = trace.getTracer(TRACER_NAME);
    return tracer.startActiveSpan(
        `bus.${attrs.busName} publish`,
        {
            kind: SpanKind.PRODUCER,
            attributes: {
                'messaging.system': 'nats',
                'messaging.destination.name': attrs.busName,
                'messaging.operation': 'publish',
                [ATTR_PRIMITIVE]: 'bus',
                [ATTR_NAME]: attrs.busName,
                [ATTR_TOPIC]: attrs.busName,
                [ATTR_WORKSPACE]: attrs.workspace,
            },
        },
        async (span) => {
            const carrier: TraceCarrier = {};
            propagation.inject(context.active(), carrier);
            try {
                return await fn(carrier);
            } catch (err) {
                span.recordException(err as Error);
                span.setStatus({ code: SpanStatusCode.ERROR });
                throw err;
            } finally {
                span.end();
            }
        },
    );
}

export interface BusConsumeAttrs {
    readonly busName: string;
    /** Durable consumer / subscriber name — the logical "who's
     *  listening" identifier used for messaging.consumer.group.name. */
    readonly subscriber: string;
    readonly workspace: string;
    /** W3C traceparent extracted from the inbound NATS message headers.
     *  Absent when the publisher side wasn't instrumented (pre-rollout
     *  producers, external tooling) — consume becomes a new trace root. */
    readonly traceparent?: string;
    /** Optional tracestate companion. */
    readonly tracestate?: string;
}

/**
 * Wrap a bus consume callback in a CONSUMER-kind span. If a
 * `traceparent` is supplied, the span nests under the producer span so
 * the full producer→consumer trace continuity is preserved across the
 * NATS hop.
 */
async function busConsume<T>(
    attrs: BusConsumeAttrs,
    fn: () => Promise<T> | T,
): Promise<T> {
    const carrier: TraceCarrier = {};
    if (attrs.traceparent) carrier['traceparent'] = attrs.traceparent;
    if (attrs.tracestate) carrier['tracestate'] = attrs.tracestate;
    const parentCtx = propagation.extract(context.active(), carrier);

    const tracer = trace.getTracer(TRACER_NAME);
    return context.with(parentCtx, () =>
        tracer.startActiveSpan(
            `bus.${attrs.busName} consume`,
            {
                kind: SpanKind.CONSUMER,
                attributes: {
                    'messaging.system': 'nats',
                    'messaging.destination.name': attrs.busName,
                    'messaging.operation': 'receive',
                    'messaging.consumer.group.name': attrs.subscriber,
                    [ATTR_PRIMITIVE]: 'bus',
                    [ATTR_NAME]: attrs.busName,
                    [ATTR_TOPIC]: attrs.busName,
                    [ATTR_WORKSPACE]: attrs.workspace,
                },
            },
            async (span) => {
                try {
                    return await runInScope(
                        { workspace: attrs.workspace, primitive: 'bus', name: attrs.busName },
                        fn,
                    );
                } catch (err) {
                    span.recordException(err as Error);
                    span.setStatus({ code: SpanStatusCode.ERROR });
                    throw err;
                } finally {
                    span.end();
                }
            },
        ),
    );
}

/** Minimal shape for the various header containers Restate exposes —
 *  the TS SDK 1.13's `ctx.request().headers` is a `ReadonlyMap<string,
 *  string>`, but some callers (node http, Connect) expose `string | string[]`
 *  values. The adapter accepts either and normalizes. */
export type RemoteHeaders = ReadonlyMap<string, string | string[]> | undefined;

const W3C_KEYS = ['traceparent', 'tracestate'] as const;

function firstHeader(headers: RemoteHeaders, key: string): string | undefined {
    if (!headers) return undefined;
    const v = headers.get(key);
    if (v === undefined) return undefined;
    return Array.isArray(v) ? v[0] : v;
}

/**
 * Read W3C TraceContext from the inbound Restate handler's request
 * headers and install it as the active parent for `fn`. All spans
 * started inside `fn` become children of the upstream span that set
 * the traceparent, stitching our pipeline's trace with whatever
 * emitted it (another syncengine process, an external caller, or a
 * future Restate-emitted invocation span).
 *
 * Safe to call with no headers / no traceparent — `fn` runs with
 * whatever parent context is already active.
 */
async function withRemoteParent<T>(
    headers: RemoteHeaders,
    fn: () => Promise<T> | T,
): Promise<T> {
    const carrier: TraceCarrier = {};
    for (const key of W3C_KEYS) {
        const v = firstHeader(headers, key);
        if (v !== undefined) carrier[key] = v;
    }
    if (Object.keys(carrier).length === 0) {
        // No propagation headers — run fn with the current context
        // unchanged. Skipping propagation.extract avoids producing a
        // child of nothing (which propagation impls handle gracefully
        // but still wastes a context.with frame).
        return await fn();
    }
    const parentCtx = propagation.extract(context.active(), carrier);
    return context.with(parentCtx, fn);
}

export interface WebhookInboundAttrs {
    readonly name: string;
    /** Workspace may be unknown at the start of inbound processing
     *  (it's derived from the payload inside the helper's fn). Callers
     *  can stamp it later via markWebhookWorkspace. */
    readonly workspace?: string;
}

/**
 * Wrap the HTTP-layer processing of an inbound webhook: signature
 * verification, workspace resolution, and the dispatch to Restate.
 * The caller marks dedup hits and late-resolved workspace via the
 * markWebhookDedup / markWebhookWorkspace helpers below so we don't
 * leak OTel types into the webhook-http module.
 */
async function webhookInbound<T>(
    attrs: WebhookInboundAttrs,
    fn: () => Promise<T> | T,
): Promise<T> {
    const spanAttrs: Attributes = {
        [ATTR_PRIMITIVE]: 'webhook',
        [ATTR_NAME]: attrs.name,
    };
    if (attrs.workspace !== undefined) spanAttrs[ATTR_WORKSPACE] = attrs.workspace;

    const tracer = trace.getTracer(TRACER_NAME);
    return tracer.startActiveSpan(
        `webhook.${attrs.name}.inbound`,
        { kind: SpanKind.SERVER, attributes: spanAttrs },
        async (span) => {
            try {
                return await fn();
            } catch (err) {
                span.recordException(err as Error);
                span.setStatus({ code: SpanStatusCode.ERROR });
                throw err;
            } finally {
                span.end();
            }
        },
    );
}

/** Mark the active span as a Restate-dedup'd webhook retry. Called
 *  by webhook-http when the upstream POST returns 409 / "already
 *  completed" so the APM shows which retries absorbed load without
 *  running user code. */
function markWebhookDedup(): void {
    trace.getActiveSpan()?.setAttribute(ATTR_DEDUP_HIT, true);
}

/** Late-stamp the workspace on the active webhook.inbound span —
 *  workspace is derived from the request payload after signature
 *  verification, so we can't tag it up-front. */
function markWebhookWorkspace(workspace: string): void {
    trace.getActiveSpan()?.setAttribute(ATTR_WORKSPACE, workspace);
}

export interface GatewayMessageAttrs {
    /** Incoming message type — 'init', 'subscribe', 'unsubscribe',
     *  'rpc', 'ping', etc. Low-cardinality so it's safe as a span
     *  name suffix. */
    readonly messageType: string;
    /** Client session id (stable for the connection lifetime).
     *  APM queries filter by this to see one client's stream. */
    readonly sessionId?: string;
    readonly workspace?: string;
}

/**
 * Wrap a single inbound WebSocket message's processing. We do NOT
 * span the connection lifetime — OTel exporters don't flush until
 * span.end() which would hold spans for the duration of a
 * long-running WS. Tagging each message with the session id lets
 * APMs group spans by session on read.
 */
async function gatewayMessage<T>(
    attrs: GatewayMessageAttrs,
    fn: () => Promise<T> | T,
): Promise<T> {
    const spanAttrs: Attributes = {
        [ATTR_PRIMITIVE]: 'gateway',
        [ATTR_NAME]: attrs.messageType,
    };
    if (attrs.sessionId !== undefined) {
        spanAttrs['syncengine.session_id'] = attrs.sessionId;
    }
    if (attrs.workspace !== undefined) {
        spanAttrs[ATTR_WORKSPACE] = attrs.workspace;
    }
    const tracer = trace.getTracer(TRACER_NAME);
    return tracer.startActiveSpan(
        `gateway.${attrs.messageType}`,
        { kind: SpanKind.SERVER, attributes: spanAttrs },
        async (span) => {
            try {
                return await fn();
            } catch (err) {
                span.recordException(err as Error);
                span.setStatus({ code: SpanStatusCode.ERROR });
                throw err;
            } finally {
                span.end();
            }
        },
    );
}

export interface HeartbeatTickAttrs {
    readonly name: string;
    readonly workspace: string;
    /** 1-based run index within the scheduler loop — tagged so APM
     *  queries can distinguish the first tick (often slower due to
     *  cold caches) from steady state. */
    readonly runNumber: number;
}

/**
 * Wrap a heartbeat's user-handler invocation in a span. Emitted once
 * per scheduler tick so APM timing reflects the handler body, not the
 * surrounding sleep / status-check loop.
 */
async function heartbeatTick<T>(
    attrs: HeartbeatTickAttrs,
    fn: () => Promise<T> | T,
): Promise<T> {
    const tracer = trace.getTracer(TRACER_NAME);
    return tracer.startActiveSpan(
        `heartbeat.${attrs.name}.tick`,
        {
            attributes: {
                [ATTR_PRIMITIVE]: 'heartbeat',
                [ATTR_NAME]: attrs.name,
                [ATTR_WORKSPACE]: attrs.workspace,
                'syncengine.run_number': attrs.runNumber,
            },
        },
        async (span) => {
            try {
                return await runInScope(
                    { workspace: attrs.workspace, primitive: 'heartbeat', name: attrs.name },
                    fn,
                );
            } catch (err) {
                span.recordException(err as Error);
                span.setStatus({ code: SpanStatusCode.ERROR });
                throw err;
            } finally {
                span.end();
            }
        },
    );
}

export interface WebhookRunAttrs {
    readonly name: string;
    readonly workspace: string;
    readonly idempotencyKey: string;
}

/**
 * Wrap the user's webhook handler run (inside the Restate workflow).
 * The inbound span is on a different process; parent context arrives
 * via the `traceparent` header stamped by webhook-http, extracted by
 * the caller with instrument.withRemoteParent before invoking this.
 */
async function webhookRun<T>(
    attrs: WebhookRunAttrs,
    fn: () => Promise<T> | T,
): Promise<T> {
    const tracer = trace.getTracer(TRACER_NAME);
    return tracer.startActiveSpan(
        `webhook.${attrs.name}.run`,
        {
            attributes: {
                [ATTR_PRIMITIVE]: 'webhook',
                [ATTR_NAME]: attrs.name,
                [ATTR_WORKSPACE]: attrs.workspace,
                [ATTR_INVOCATION]: attrs.idempotencyKey,
            },
        },
        async (span) => {
            try {
                return await runInScope(
                    { workspace: attrs.workspace, primitive: 'webhook', name: attrs.name },
                    fn,
                );
            } catch (err) {
                span.recordException(err as Error);
                span.setStatus({ code: SpanStatusCode.ERROR });
                throw err;
            } finally {
                span.end();
            }
        },
    );
}

/**
 * Build an object containing W3C TraceContext headers (traceparent,
 * and tracestate when present) for the currently active span. Callers
 * spread the result onto outbound fetch headers so the downstream
 * service can extract the parent context on receipt.
 *
 * When the SDK is disabled the result is `{}` so callers can unconditionally
 * spread it without polluting headers with stale values.
 */
function traceHeaders(): TraceCarrier {
    const carrier: TraceCarrier = {};
    propagation.inject(context.active(), carrier);
    return carrier;
}

export const instrument = {
    entityEffect,
    request,
    rpc,
    busPublish,
    busConsume,
    withRemoteParent,
    traceHeaders,
    webhookInbound,
    webhookRun,
    markWebhookDedup,
    markWebhookWorkspace,
    heartbeatTick,
    gatewayMessage,
};
