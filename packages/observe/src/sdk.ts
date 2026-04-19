// SDK bootstrap.
//
// `bootSdk` is a factory — it constructs an `SdkHandle` whose methods
// drive the SDK's lifecycle. Lifecycle ops live on the handle
// (`handle.forceFlush()`, `handle.shutdown()`) rather than as
// top-level functions: one less thing to import, autocomplete reveals
// the whole surface, and the disabled-path degrades to no-op methods
// without any cast.
//
// When `config.exporter === false` the function returns an inert handle
// and does not import `@opentelemetry/sdk-node` at all — keeps the
// disabled path free of the SDK's multi-megabyte transitive graph.
//
// For unit tests, `traceExporterOverride` injects an arbitrary
// `SpanExporter` (typically `InMemorySpanExporter`) wrapped in a
// `SimpleSpanProcessor`. Tests then call `handle.forceFlush()` before
// asserting on span contents, because the simple processor's export
// is dispatched to a microtask — reads that skip the flush will see
// an empty buffer.

import {
    context,
    metrics,
    propagation,
    trace,
    type MeterProvider,
    type TracerProvider,
} from '@opentelemetry/api';
import {
    ParentBasedSampler,
    SimpleSpanProcessor,
    TraceIdRatioBasedSampler,
    type SpanExporter,
    type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { PushMetricExporter } from '@opentelemetry/sdk-metrics';

import type { ObservabilityConfig } from '@syncengine/core';

import { buildResource } from './resource';

export interface SdkHandle {
    readonly enabled: boolean;
    /** Drain any pending span exports. Useful as a graceful-shutdown
     *  preamble in prod, and required in tests to read the in-memory
     *  exporter after `span.end()` — `SimpleSpanProcessor` dispatches
     *  the export to a microtask. */
    forceFlush(): Promise<void>;
    /** Tear down the SDK and clear the OTel API globals. Safe to call
     *  multiple times; on a disabled handle this is a no-op. */
    shutdown(): Promise<void>;
}

export interface BootSdkOptions {
    readonly config?: ObservabilityConfig;
    /**
     * Test-only: replace the default OTLP trace exporter. When set, the
     * SDK is configured with a `SimpleSpanProcessor(override)` so tests
     * read spans with `handle.forceFlush()` then
     * `exporter.getFinishedSpans()`.
     */
    readonly traceExporterOverride?: SpanExporter;
    /**
     * Test-only: replace the default OTLP metric exporter. Wrapped in a
     * `PeriodicExportingMetricReader` with a long interval — tests
     * drive export via `handle.forceFlush()` rather than waiting on
     * the timer.
     */
    readonly metricExporterOverride?: PushMetricExporter;
}

const DISABLED_HANDLE: SdkHandle = Object.freeze({
    enabled: false,
    forceFlush: async () => {},
    shutdown: async () => {},
});

function resolveSamplerRatio(config: ObservabilityConfig | undefined): number {
    if (config?.sampling?.ratio !== undefined) return config.sampling.ratio;
    return process.env['NODE_ENV'] === 'production' ? 0.1 : 1.0;
}

/** Resolve the active tracer provider — following the API proxy through
 *  to the real delegate. The delegate is the BasicTracerProvider (or
 *  subclass) that SimpleSpanProcessor and friends are attached to, so
 *  its `forceFlush` drains the pending export queue. */
function resolveActiveTracerProvider(): TracerProvider & { forceFlush?: () => Promise<void> } {
    const top = trace.getTracerProvider() as TracerProvider & {
        getDelegate?: () => TracerProvider;
    };
    return top.getDelegate ? (top.getDelegate() as TracerProvider & { forceFlush?: () => Promise<void> }) : top;
}

/** Resolve the active meter provider — unlike trace, metrics API
 *  doesn't use a proxy pattern, so the global IS the real provider.
 *  Cast covers the forceFlush method on concrete MeterProvider impls. */
function resolveActiveMeterProvider(): MeterProvider & { forceFlush?: () => Promise<void> } {
    return metrics.getMeterProvider() as MeterProvider & {
        forceFlush?: () => Promise<void>;
    };
}

export async function bootSdk(opts: BootSdkOptions = {}): Promise<SdkHandle> {
    const config = opts.config;

    if (config?.exporter === false) {
        return DISABLED_HANDLE;
    }

    // Lazy-require sdk-node + exporters only on the enabled path so
    // applications that disable observability don't pay the module
    // load cost.
    const { NodeSDK } = await import('@opentelemetry/sdk-node');

    // Opt-in auto-instrumentations. Loaded only when the user explicitly
    // asked so the default install doesn't pay the bundle / patch cost.
    const instrumentations: import('@opentelemetry/instrumentation').Instrumentation[] = [];
    if (config?.autoInstrument?.includes('fetch')) {
        const { UndiciInstrumentation } = await import(
            '@opentelemetry/instrumentation-undici'
        );
        // Node 20+'s native fetch is backed by undici. The Undici
        // instrumentation patches at the request-client layer so every
        // outbound fetch gets a CLIENT span + auto-propagated
        // traceparent header.
        instrumentations.push(new UndiciInstrumentation());
    }

    const resource = buildResource(config);
    const sampler = new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(resolveSamplerRatio(config)),
    });

    const isTestOverride =
        opts.traceExporterOverride !== undefined ||
        opts.metricExporterOverride !== undefined;

    const spanProcessors: SpanProcessor[] = opts.traceExporterOverride
        ? [new SimpleSpanProcessor(opts.traceExporterOverride)]
        : [];

    // Split prod vs test-override paths so we only construct OTLP
    // exporters on the real prod path. In tests, spinning up OTLP
    // exporters against the default localhost:4318 endpoint creates
    // background failing exporter state that interferes with the
    // in-memory exporter we're injecting.
    let sdk: InstanceType<typeof NodeSDK>;
    if (isTestOverride) {
        const ctorOpts: ConstructorParameters<typeof NodeSDK>[0] = {
            resource,
            sampler,
            spanProcessors,
            ...(instrumentations.length > 0 && { instrumentations }),
        };
        if (opts.metricExporterOverride) {
            const { PeriodicExportingMetricReader } = await import(
                '@opentelemetry/sdk-metrics'
            );
            ctorOpts.metricReaders = [
                new PeriodicExportingMetricReader({
                    exporter: opts.metricExporterOverride,
                    // Long interval — tests drive via handle.forceFlush().
                    exportIntervalMillis: 3_600_000,
                }),
            ];
        }
        sdk = new NodeSDK(ctorOpts);
    } else {
        const [
            { OTLPTraceExporter },
            { OTLPMetricExporter },
            { PeriodicExportingMetricReader },
        ] = await Promise.all([
            import('@opentelemetry/exporter-trace-otlp-http'),
            import('@opentelemetry/exporter-metrics-otlp-http'),
            import('@opentelemetry/sdk-metrics'),
        ]);
        sdk = new NodeSDK({
            resource,
            sampler,
            traceExporter: new OTLPTraceExporter(),
            metricReaders: [
                new PeriodicExportingMetricReader({
                    exporter: new OTLPMetricExporter(),
                    exportIntervalMillis: 60_000,
                }),
            ],
            ...(instrumentations.length > 0 && { instrumentations }),
        });
    }

    sdk.start();

    // Snapshot providers now so forceFlush can drive them directly —
    // subsequent boot/shutdown cycles reinstall globals, and a handle
    // referring to its original provider is the only way forceFlush
    // survives that churn.
    const tracerProvider = resolveActiveTracerProvider();
    const meterProvider = resolveActiveMeterProvider();

    return {
        enabled: true,
        async forceFlush() {
            if (typeof tracerProvider.forceFlush === 'function') {
                await tracerProvider.forceFlush();
            }
            if (typeof meterProvider.forceFlush === 'function') {
                await meterProvider.forceFlush();
            }
        },
        async shutdown() {
            await sdk.shutdown();
            // NodeSDK.shutdown() closes the providers but leaves them
            // wired into the OTel API globals. Clearing them makes
            // shutdown fully symmetric with boot — necessary for test
            // isolation across repeated boots and harmless in prod
            // where shutdown fires on process exit.
            trace.disable();
            metrics.disable();
            context.disable();
            propagation.disable();
        },
    };
}
