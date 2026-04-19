// Phase C, Task C1 — instrument.request + instrument.rpc.
//
// These tests cover the top two spans in the framework's trace tree:
//
//   http.POST rpc          ← instrument.request  (root server span)
//     rpc.entity.<n>.<op>  ← instrument.rpc      (child)
//       ↓ Restate invocation (C4)
//         entity.<n>.<op>  ← instrument.entityEffect (B1)
//
// Assertions:
//   - request span carries SERVER kind, http.request.method, http.route,
//     url.path, and syncengine.primitive='http' auto-tags.
//   - rpc span nests under request and carries rpc.system / rpc.service /
//     rpc.method semconv keys plus syncengine.workspace.
//   - Exception paths record the error + set ERROR status before rethrow.
//   - Disabled-path (no SDK) is a straight pass-through.

import { afterEach, describe, expect, it } from 'bun:test';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';

import { bootSdk, type SdkHandle } from '../sdk';
import { instrument } from '../internal';
import {
    ATTR_NAME,
    ATTR_OP,
    ATTR_PRIMITIVE,
    ATTR_WORKSPACE,
} from '../semantic';

const teardown: SdkHandle[] = [];
afterEach(async () => {
    while (teardown.length > 0) {
        await teardown.shift()!.shutdown();
    }
});

async function bootWith(exporter: InMemorySpanExporter): Promise<SdkHandle> {
    const handle = await bootSdk({
        config: { exporter: 'otlp', serviceName: 'http-rpc-test' },
        traceExporterOverride: exporter,
    });
    teardown.push(handle);
    return handle;
}

describe('instrument.request', () => {
    it('opens a SERVER-kind span named "<method> <route>" with http attrs', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        await instrument.request(
            { method: 'POST', route: 'rpc', path: '/__syncengine/rpc/todos/k1/add' },
            async () => undefined,
        );

        await handle.forceFlush();
        const spans = exporter.getFinishedSpans();
        expect(spans).toHaveLength(1);
        const span = spans[0]!;
        expect(span.name).toBe('POST rpc');
        expect(span.kind).toBe(SpanKind.SERVER);
        expect(span.attributes[ATTR_PRIMITIVE]).toBe('http');
        expect(span.attributes[ATTR_NAME]).toBe('rpc');
        expect(span.attributes['http.request.method']).toBe('POST');
        expect(span.attributes['http.route']).toBe('rpc');
        expect(span.attributes['url.path']).toBe('/__syncengine/rpc/todos/k1/add');
    });

    it('records exception and sets ERROR status on throw, then rethrows', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        await expect(
            instrument.request(
                { method: 'GET', route: 'static', path: '/assets/app.js' },
                async () => {
                    throw new Error('disk read failed');
                },
            ),
        ).rejects.toThrow('disk read failed');

        await handle.forceFlush();
        const span = exporter.getFinishedSpans()[0]!;
        expect(span.status.code).toBe(SpanStatusCode.ERROR);
        expect(span.events.find((e) => e.name === 'exception')).toBeDefined();
    });
});

describe('instrument.rpc', () => {
    it('nests under an active request span and tags rpc semconv attrs', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        await instrument.request(
            { method: 'POST', route: 'rpc', path: '/__syncengine/rpc/todos/k1/add' },
            async () => {
                await instrument.rpc(
                    {
                        kind: 'entity',
                        name: 'todos',
                        handler: 'add',
                        workspace: 'ws_alpha',
                    },
                    async () => undefined,
                );
            },
        );

        await handle.forceFlush();
        const spans = exporter.getFinishedSpans();
        const request = spans.find((s) => s.name === 'POST rpc')!;
        const rpc = spans.find((s) => s.name.startsWith('rpc.'))!;
        expect(request).toBeDefined();
        expect(rpc).toBeDefined();
        expect(rpc.name).toBe('rpc.entity.todos.add');
        expect(rpc.parentSpanContext?.spanId).toBe(request.spanContext().spanId);

        // semconv keys — standard rpc.* namespace, plus our syncengine.*
        // auto-tags for cross-signal filtering.
        expect(rpc.attributes['rpc.system']).toBe('syncengine');
        expect(rpc.attributes['rpc.service']).toBe('entity');
        expect(rpc.attributes['rpc.method']).toBe('todos.add');
        expect(rpc.attributes[ATTR_WORKSPACE]).toBe('ws_alpha');
        expect(rpc.attributes[ATTR_NAME]).toBe('todos');
        expect(rpc.attributes[ATTR_OP]).toBe('add');
    });

    it('workflow RPC omits the handler attr (no ATTR_OP)', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        await instrument.rpc(
            { kind: 'workflow', name: 'placeOrder', workspace: 'ws' },
            async () => undefined,
        );

        await handle.forceFlush();
        const span = exporter.getFinishedSpans()[0]!;
        expect(span.name).toBe('rpc.workflow.placeOrder');
        expect(span.attributes['rpc.method']).toBe('placeOrder');
        expect(span.attributes[ATTR_OP]).toBeUndefined();
    });

    it('heartbeat RPC follows the same shape', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        await instrument.rpc(
            { kind: 'heartbeat', name: 'pulse', workspace: 'ws' },
            async () => undefined,
        );

        await handle.forceFlush();
        const span = exporter.getFinishedSpans()[0]!;
        expect(span.name).toBe('rpc.heartbeat.pulse');
        expect(span.attributes['rpc.service']).toBe('heartbeat');
    });

    it('records exception + ERROR status on throw, propagates to parent request', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        await expect(
            instrument.request(
                { method: 'POST', route: 'rpc', path: '/__syncengine/rpc/x/y/z' },
                async () => {
                    await instrument.rpc(
                        { kind: 'entity', name: 'x', handler: 'z', workspace: 'ws' },
                        async () => {
                            throw new Error('user code broke');
                        },
                    );
                },
            ),
        ).rejects.toThrow('user code broke');

        await handle.forceFlush();
        const spans = exporter.getFinishedSpans();
        for (const s of spans) {
            expect(s.status.code).toBe(SpanStatusCode.ERROR);
        }
    });
});

describe('disabled-path', () => {
    it('request is a straight pass-through when no SDK is booted', async () => {
        const result = await instrument.request(
            { method: 'GET', route: 'html', path: '/' },
            async () => 'ok',
        );
        expect(result).toBe('ok');
    });

    it('rpc is a straight pass-through when no SDK is booted', async () => {
        const result = await instrument.rpc(
            { kind: 'entity', name: 'x', handler: 'y', workspace: 'ws' },
            async () => 42,
        );
        expect(result).toBe(42);
    });
});
