// Phase B, Task B2 — ObservabilityCtx factory.
//
// Builds the span/metric/mark surface that Phase C wires into every
// non-pure handler ctx (workflow body, webhook run, heartbeat tick,
// topic handler). Entity handlers are pure by design and do NOT
// receive a ctx — that's covered by B1's framework-level instrument
// .entityEffect span.
//
// Tests assert:
//   - span wraps fn in a child span with auto-tags
//   - nested ctx.span calls produce a parent→child tree
//   - thrown exceptions are recorded + ERROR status set before rethrow
//   - caller-supplied attrs can't overwrite workspace/user/primitive/name
//   - mark adds a span event on the active span (silent outside one)
//   - the disabled-path (no SDK) passes everything through without throw
//
// Nested-span propagation relies on AsyncLocalStorage (NodeSDK installs
// it), so every `span()` call runs its body in a child context.

import { afterEach, describe, expect, it } from 'bun:test';
import { context, trace } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';

import { bootSdk, type SdkHandle } from '../sdk';
import { makeObservabilityCtx } from '../ctx';
import {
    ATTR_NAME,
    ATTR_PRIMITIVE,
    ATTR_USER,
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
        config: { exporter: 'otlp', serviceName: 'ctx-test' },
        traceExporterOverride: exporter,
    });
    teardown.push(handle);
    return handle;
}

describe('makeObservabilityCtx.span — happy path', () => {
    it('wraps fn in a child span and auto-tags workspace/user/primitive/name', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);
        const ctx = makeObservabilityCtx({
            workspace: 'ws_alpha',
            user: 'user_1',
            primitive: 'workflow',
            name: 'placeOrder',
        });

        const result = await ctx.span('charge-card', async () => 'charged');

        expect(result).toBe('charged');
        await handle.forceFlush();
        const spans = exporter.getFinishedSpans();
        expect(spans).toHaveLength(1);
        expect(spans[0]!.name).toBe('charge-card');
        expect(spans[0]!.attributes[ATTR_WORKSPACE]).toBe('ws_alpha');
        expect(spans[0]!.attributes[ATTR_USER]).toBe('user_1');
        expect(spans[0]!.attributes[ATTR_PRIMITIVE]).toBe('workflow');
        expect(spans[0]!.attributes[ATTR_NAME]).toBe('placeOrder');
    });

    it('propagates both sync and async return values', async () => {
        const exporter = new InMemorySpanExporter();
        await bootWith(exporter);
        const ctx = makeObservabilityCtx({
            workspace: 'ws',
            primitive: 'webhook',
            name: 'githubPush',
        });

        const syncResult = await ctx.span('sync-step', () => 1);
        const asyncResult = await ctx.span('async-step', async () => 2);

        expect(syncResult).toBe(1);
        expect(asyncResult).toBe(2);
    });
});

describe('makeObservabilityCtx.span — nesting', () => {
    it('produces a parent/child tree when spans nest', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);
        const ctx = makeObservabilityCtx({
            workspace: 'ws',
            primitive: 'workflow',
            name: 'outer',
        });

        await ctx.span('parent', async () => {
            await ctx.span('child', async () => undefined);
        });

        await handle.forceFlush();
        const spans = exporter.getFinishedSpans();
        const parent = spans.find((s) => s.name === 'parent')!;
        const child = spans.find((s) => s.name === 'child')!;
        expect(parent).toBeDefined();
        expect(child).toBeDefined();
        expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    });
});

describe('makeObservabilityCtx.span — exception path', () => {
    it('records the exception, sets ERROR status, and rethrows', async () => {
        const { SpanStatusCode } = await import('@opentelemetry/api');
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);
        const ctx = makeObservabilityCtx({
            workspace: 'ws',
            primitive: 'workflow',
            name: 'flaky',
        });

        await expect(
            ctx.span('step', async () => {
                throw new Error('nope');
            }),
        ).rejects.toThrow('nope');

        await handle.forceFlush();
        const span = exporter.getFinishedSpans()[0]!;
        expect(span.status.code).toBe(SpanStatusCode.ERROR);
        const ex = span.events.find((e) => e.name === 'exception');
        expect(ex).toBeDefined();
        expect(ex!.attributes?.['exception.message']).toBe('nope');
    });
});

describe('makeObservabilityCtx.span — attr merge precedence', () => {
    it('auto-tags win: a caller cannot overwrite workspace/user/primitive/name', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);
        const ctx = makeObservabilityCtx({
            workspace: 'ws_correct',
            user: 'user_correct',
            primitive: 'workflow',
            name: 'winner',
        });

        await ctx.span(
            'step',
            async () => undefined,
            {
                // These keys should be ignored — framework's auto-tags are
                // the source of truth.
                [ATTR_WORKSPACE]: 'ws_spoofed',
                [ATTR_USER]: 'user_spoofed',
                [ATTR_PRIMITIVE]: 'entity',
                [ATTR_NAME]: 'loser',
                // This key is free for the caller to add.
                'app.custom': 'allowed',
            },
        );

        await handle.forceFlush();
        const span = exporter.getFinishedSpans()[0]!;
        expect(span.attributes[ATTR_WORKSPACE]).toBe('ws_correct');
        expect(span.attributes[ATTR_USER]).toBe('user_correct');
        expect(span.attributes[ATTR_PRIMITIVE]).toBe('workflow');
        expect(span.attributes[ATTR_NAME]).toBe('winner');
        expect(span.attributes['app.custom']).toBe('allowed');
    });
});

describe('makeObservabilityCtx.mark', () => {
    it('adds a timestamped event on the active span', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);
        const ctx = makeObservabilityCtx({
            workspace: 'ws',
            primitive: 'workflow',
            name: 'wf',
        });

        await ctx.span('outer', async () => {
            ctx.mark('charged', { amount: 42 });
        });

        await handle.forceFlush();
        const span = exporter.getFinishedSpans()[0]!;
        const marker = span.events.find((e) => e.name === 'charged');
        expect(marker).toBeDefined();
        expect(marker!.attributes?.['amount']).toBe(42);
    });

    it('is a silent no-op when there is no active span', async () => {
        // Boot an SDK (enabled path) but call mark without being inside a span.
        const exporter = new InMemorySpanExporter();
        await bootWith(exporter);
        const ctx = makeObservabilityCtx({
            workspace: 'ws',
            primitive: 'workflow',
            name: 'wf',
        });

        // No active span in the current context.
        const active = trace.getSpan(context.active());
        expect(active).toBeUndefined();

        // Must not throw.
        expect(() => ctx.mark('ignored')).not.toThrow();
    });
});

describe('makeObservabilityCtx.metric', () => {
    it('does not throw with or without an active span', async () => {
        const exporter = new InMemorySpanExporter();
        await bootWith(exporter);
        const ctx = makeObservabilityCtx({
            workspace: 'ws',
            primitive: 'workflow',
            name: 'wf',
        });

        // Outside a span
        expect(() => ctx.metric('sample.value', 1)).not.toThrow();

        // Inside a span — the helper pulls workspace/primitive/name onto
        // the metric attrs. Full metric shape assertion is D1's concern
        // (declared factory with InMemoryMetricExporter); here we only
        // verify the call surface is safe.
        await ctx.span('parent', async () => {
            expect(() => ctx.metric('another', 2, { bucket: 'x' })).not.toThrow();
        });
    });
});

describe('makeObservabilityCtx — disabled path', () => {
    it('passes through span / metric / mark when no SDK is booted', async () => {
        // Note: no bootSdk() call. Global tracer is the API noop.
        const ctx = makeObservabilityCtx({
            workspace: 'ws',
            primitive: 'workflow',
            name: 'wf',
        });

        const result = await ctx.span('step', async () => 'ok');
        expect(result).toBe('ok');
        expect(() => ctx.metric('m', 1)).not.toThrow();
        expect(() => ctx.mark('e')).not.toThrow();
    });

    it('rethrows exceptions on the disabled path too', async () => {
        const ctx = makeObservabilityCtx({
            workspace: 'ws',
            primitive: 'workflow',
            name: 'wf',
        });

        await expect(
            ctx.span('step', () => {
                throw new Error('still throws');
            }),
        ).rejects.toThrow('still throws');
    });
});
