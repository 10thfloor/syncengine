// Phase A, Task A2 — SDK bootstrap.
//
// These tests drive the NodeSDK setup: a real OTel SDK boots, a manually
// created span flows through to an InMemorySpanExporter we inject via
// the test override, and the disabled-path stays a zero-op.
//
// Sampling is tested deterministically by forcing ratio=0 (never sample)
// and ratio=1 (always sample) — avoids the flakiness of asserting
// "roughly 10%" against random trace IDs.

import { afterEach, describe, expect, it } from 'bun:test';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';

import { bootSdk, forceFlush, shutdownSdk } from '../sdk.ts';

// Track handles so we always tear the SDK down between tests — leaving a
// provider installed globally bleeds state into the next case.
const cleanupQueue: Array<() => Promise<void>> = [];
afterEach(async () => {
    while (cleanupQueue.length > 0) {
        const fn = cleanupQueue.shift()!;
        await fn();
    }
});

async function boot(
    ...args: Parameters<typeof bootSdk>
): Promise<ReturnType<typeof bootSdk>> {
    const handle = await bootSdk(...args);
    cleanupQueue.push(() => shutdownSdk(handle));
    return handle;
}

describe('bootSdk — disabled path', () => {
    it('returns a disabled handle when exporter is false', async () => {
        const handle = await boot({ config: { exporter: false } });
        expect(handle.enabled).toBe(false);
    });

    it('does not install a tracer provider when disabled', async () => {
        // Baseline: before boot, the global provider is the NoopTracerProvider
        // (API-level default). A span created with that provider never gets
        // a recording backend. After bootSdk({exporter:false}), no provider
        // should have been installed — the same no-op tracer wins.
        await boot({ config: { exporter: false } });

        const span = trace.getTracer('test').startSpan('sample');
        // NoopSpan reports a zero span context.
        expect(span.spanContext().spanId).toBe('0000000000000000');
        span.end();
    });

    it('shutdownSdk on a disabled handle is a no-op', async () => {
        const handle = await bootSdk({ config: { exporter: false } });
        await expect(shutdownSdk(handle)).resolves.toBeUndefined();
    });
});

describe('bootSdk — enabled path', () => {
    it('exports manually created spans through the injected exporter', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await boot({
            config: { exporter: 'otlp', serviceName: 'test-app' },
            traceExporterOverride: exporter,
        });

        const span = trace.getTracer('test').startSpan('unit-span');
        span.setAttribute('test.key', 'test-value');
        span.end();

        await forceFlush(handle);
        const finished = exporter.getFinishedSpans();
        expect(finished).toHaveLength(1);
        expect(finished[0]!.name).toBe('unit-span');
        expect(finished[0]!.attributes['test.key']).toBe('test-value');
    });

    it('attaches serviceName to the resource on exported spans', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await boot({
            config: { exporter: 'otlp', serviceName: 'my-service' },
            traceExporterOverride: exporter,
        });

        trace.getTracer('test').startSpan('resource-check').end();

        await forceFlush(handle);
        const finished = exporter.getFinishedSpans();
        expect(finished).toHaveLength(1);
        expect(finished[0]!.resource.attributes['service.name']).toBe(
            'my-service',
        );
    });

    it('merges user-supplied resource attributes onto the default resource', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await boot({
            config: {
                exporter: 'otlp',
                serviceName: 'resource-merge',
                resource: { environment: 'ci', region: 'us-east-1' },
            },
            traceExporterOverride: exporter,
        });

        trace.getTracer('test').startSpan('merge').end();

        await forceFlush(handle);
        const finished = exporter.getFinishedSpans();
        const attrs = finished[0]!.resource.attributes;
        expect(attrs['service.name']).toBe('resource-merge');
        expect(attrs['environment']).toBe('ci');
        expect(attrs['region']).toBe('us-east-1');
    });

    it('sampling ratio 0 drops every root span', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await boot({
            config: {
                exporter: 'otlp',
                sampling: { ratio: 0 },
            },
            traceExporterOverride: exporter,
        });

        for (let i = 0; i < 20; i++) {
            trace.getTracer('test').startSpan(`n-${i}`).end();
        }

        await forceFlush(handle);
        expect(exporter.getFinishedSpans()).toHaveLength(0);
    });

    it('sampling ratio 1 exports every root span', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await boot({
            config: {
                exporter: 'otlp',
                sampling: { ratio: 1 },
            },
            traceExporterOverride: exporter,
        });

        for (let i = 0; i < 5; i++) {
            trace.getTracer('test').startSpan(`s-${i}`).end();
        }

        await forceFlush(handle);
        expect(exporter.getFinishedSpans()).toHaveLength(5);
    });
});

describe('bootSdk — config defaults', () => {
    it('absent config is equivalent to exporter: "otlp"', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await boot({ traceExporterOverride: exporter });

        trace.getTracer('test').startSpan('default-cfg').end();

        await forceFlush(handle);
        expect(exporter.getFinishedSpans()).toHaveLength(1);
    });
});
