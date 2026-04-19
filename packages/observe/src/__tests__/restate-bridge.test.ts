// Phase C, Task C4 — Restate handler-entry adapter.
//
// Restate is a separate process that emits its own OTel spans when
// RESTATE_TRACING_ENDPOINT is set. For the two trace pipelines to
// stitch into one trace in the APM we propagate W3C TraceContext
// across the HTTP hop: outbound calls (RPC proxy, bus dispatcher,
// workflow trigger) set `traceparent` on the fetch; on the handler
// side we read `traceparent` from `ctx.request().headers` and make
// it the active parent for every span emitted inside the handler.
//
// These tests cover the handler-entry adapter in isolation. The
// outbound injection sites are covered by their owning package's
// tests (C1's rpc.test.ts verifies headers, C3's bus.test.ts already
// verifies traceparent round-trips through NATS).

import { afterEach, describe, expect, it } from 'bun:test';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';

import { bootSdk, type SdkHandle } from '../sdk';
import { instrument } from '../internal';

const teardown: SdkHandle[] = [];
afterEach(async () => {
    while (teardown.length > 0) {
        await teardown.shift()!.shutdown();
    }
});

async function bootWith(exporter: InMemorySpanExporter): Promise<SdkHandle> {
    const handle = await bootSdk({
        config: { exporter: 'otlp', serviceName: 'restate-bridge-test' },
        traceExporterOverride: exporter,
    });
    teardown.push(handle);
    return handle;
}

function makeHeaders(entries: Record<string, string>): ReadonlyMap<string, string> {
    // Matches the shape Restate's TS SDK exposes via ctx.request().headers.
    return new Map(Object.entries(entries));
}

describe('instrument.withRemoteParent', () => {
    it('makes any span started inside fn a child of the extracted traceparent', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        // First capture a real traceparent from an upstream span.
        let carrier: Record<string, string> = {};
        await instrument.request(
            { method: 'POST', route: 'rpc', path: '/rpc/x' },
            async () => {
                await instrument.busPublish(
                    { busName: 'x', workspace: 'ws' },
                    async (c) => {
                        carrier = { ...c };
                    },
                );
            },
        );
        const inboundTraceparent = carrier['traceparent']!;
        expect(inboundTraceparent).toBeTruthy();

        // Simulate the Restate hop: the handler runs in a new async
        // boundary, reads headers, and uses withRemoteParent to restore
        // the trace.
        await instrument.withRemoteParent(
            makeHeaders({ traceparent: inboundTraceparent }),
            async () => {
                await instrument.entityEffect(
                    { workspace: 'ws', name: 'todos', op: 'add' },
                    async () => undefined,
                );
            },
        );

        await handle.forceFlush();
        const spans = exporter.getFinishedSpans();
        const entity = spans.find((s) => s.name === 'entity.todos.add')!;
        expect(entity).toBeDefined();

        // The entity span's trace id matches the upstream traceparent's
        // trace id — continuity preserved across the "wire".
        const upstreamTraceId = inboundTraceparent.split('-')[1];
        expect(entity.spanContext().traceId).toBe(upstreamTraceId!);
    });

    it('no-ops when headers carry no traceparent — fn runs with whatever parent is active', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        await instrument.withRemoteParent(makeHeaders({}), async () => {
            await instrument.entityEffect(
                { workspace: 'ws', name: 'x', op: 'y' },
                async () => undefined,
            );
        });

        await handle.forceFlush();
        const entity = exporter.getFinishedSpans().find((s) => s.name === 'entity.x.y')!;
        expect(entity.parentSpanContext).toBeUndefined();
    });

    it('accepts a Map-of-string-arrays (node http style) too, taking the first value', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        let carrier: Record<string, string> = {};
        await instrument.busPublish(
            { busName: 'x', workspace: 'ws' },
            async (c) => {
                carrier = { ...c };
            },
        );
        const tp = carrier['traceparent']!;

        // Some header shapes (e.g. node's req.headers) return string[].
        // Cast-via-unknown because the helper accepts either shape.
        const headers = new Map<string, string | string[]>([['traceparent', [tp]]]);

        await instrument.withRemoteParent(headers as ReadonlyMap<string, string>, async () => {
            await instrument.entityEffect(
                { workspace: 'ws', name: 'todos', op: 'add' },
                async () => undefined,
            );
        });

        await handle.forceFlush();
        const entity = exporter.getFinishedSpans().find((s) => s.name === 'entity.todos.add')!;
        expect(entity.spanContext().traceId).toBe(tp.split('-')[1]!);
    });

    it('disabled-path is a straight pass-through', async () => {
        // no bootSdk
        const result = await instrument.withRemoteParent(
            makeHeaders({ traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01' }),
            async () => 'ok',
        );
        expect(result).toBe('ok');
    });

    it('works with the noop-tracer scenario (null/undefined headers)', async () => {
        const exporter = new InMemorySpanExporter();
        await bootWith(exporter);

        // Pass through with no headers at all — used by callers that
        // can't guarantee `ctx.request()` returns headers (e.g. direct
        // object-to-object Restate invocation).
        const result = await instrument.withRemoteParent(
            undefined,
            async () => 'still ran',
        );
        expect(result).toBe('still ran');

        // Also ensure trace.getSpan on an empty context doesn't throw.
        expect(() => trace.getTracer('x').startSpan('ok').end()).not.toThrow();
    });
});
