// ObservabilityCtx factory.
//
// Produces a `{ span, metric, mark }` trio bound to a specific handler
// invocation's scope — workspace + (optional) user + primitive + name.
// The framework wires this into every non-pure handler ctx in Phase C:
// workflow body, webhook `run`, heartbeat tick, topic handler.
//
// Entity handlers are pure by design (same code runs client-side for
// optimistic UI and server-side for durable writes), so they do NOT
// receive a ctx. Entity observability is covered by the framework-
// emitted span from `instrument.entityEffect` + declared metrics.
//
// Every method here is safe to call on the disabled path (no SDK
// booted) — `trace.getTracer()` returns a noop, so spans and marks
// silently drop. The disabled metric path goes through a dummy meter
// whose instruments are likewise noops.

import {
    SpanStatusCode,
    context,
    metrics,
    trace,
    type Attributes,
} from '@opentelemetry/api';

import {
    ATTR_NAME,
    ATTR_PRIMITIVE,
    ATTR_USER,
    ATTR_WORKSPACE,
    type Primitive,
} from './semantic';
import type { Attrs, ObservabilityCtx } from './types';

const TRACER_NAME = '@syncengine/observe';
const METER_NAME = '@syncengine/observe';

export interface ObservabilityCtxScope {
    readonly workspace: string;
    readonly user?: string;
    readonly primitive: Primitive;
    readonly name: string;
}

/** Build the auto-tags bag from the scope, dropping undefined values
 *  (OTel rejects `undefined` attribute values at runtime). */
function autoTags(scope: ObservabilityCtxScope): Attributes {
    const tags: Attributes = {
        [ATTR_PRIMITIVE]: scope.primitive,
        [ATTR_NAME]: scope.name,
        [ATTR_WORKSPACE]: scope.workspace,
    };
    if (scope.user !== undefined) tags[ATTR_USER] = scope.user;
    return tags;
}

/** Merge caller attrs underneath the auto-tags — auto-tags always win
 *  because they're the framework's source of truth. Users keep any
 *  non-colliding keys. */
function mergeAttrs(
    scope: ObservabilityCtxScope,
    userAttrs: Attrs | undefined,
): Attributes {
    if (!userAttrs) return autoTags(scope);
    const merged: Attributes = { ...userAttrs } as Attributes;
    Object.assign(merged, autoTags(scope));
    return merged;
}

export function makeObservabilityCtx(
    scope: ObservabilityCtxScope,
): ObservabilityCtx {
    return {
        async span<T>(
            name: string,
            fn: () => Promise<T> | T,
            attrs?: Attrs,
        ): Promise<T> {
            const tracer = trace.getTracer(TRACER_NAME);
            const span = tracer.startSpan(name, {
                attributes: mergeAttrs(scope, attrs),
            });
            // Run fn inside the span's context so nested `ctx.span` calls
            // (and any other trace-aware code) see this span as the parent.
            const activeCtx = trace.setSpan(context.active(), span);
            try {
                const result = await context.with(activeCtx, fn);
                span.end();
                return result;
            } catch (err) {
                span.recordException(err as Error);
                span.setStatus({ code: SpanStatusCode.ERROR });
                span.end();
                throw err;
            }
        },

        metric(name: string, value: number, attrs?: Attrs): void {
            // Ad-hoc metric reading — uses a histogram by default since
            // it's the most general shape (accepts any numeric value,
            // keeps percentile info). Declared metrics in D1 give users
            // finer control (counter / gauge).
            const meter = metrics.getMeter(METER_NAME);
            const histogram = meter.createHistogram(name);
            histogram.record(value, mergeAttrs(scope, attrs));
        },

        mark(name: string, attrs?: Attrs): void {
            const active = trace.getSpan(context.active());
            if (!active) return; // silent no-op outside a span
            active.addEvent(name, mergeAttrs(scope, attrs));
        },
    };
}
