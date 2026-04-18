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
    SpanStatusCode,
    trace,
    type Attributes,
} from '@opentelemetry/api';

import {
    ATTR_NAME,
    ATTR_OP,
    ATTR_PRIMITIVE,
    ATTR_USER,
    ATTR_WORKSPACE,
} from './semantic';

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

export const instrument = {
    entityEffect,
};
