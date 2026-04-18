// SDK bootstrap.
//
// `bootSdk` starts the OTel Node SDK with OTLP/HTTP exporters for traces
// and metrics, a parent-based sampler at the configured ratio, and the
// resource built by `resource.ts`. The SDK registers a global tracer
// provider so `trace.getTracer(...)` inside framework seams and user code
// picks it up without further plumbing.
//
// When `config.exporter === false` the function returns an inert handle
// and does not import `@opentelemetry/sdk-node` at all — keeps the
// disabled path free of the SDK's multi-megabyte transitive graph.
//
// For unit tests, `traceExporterOverride` injects an arbitrary
// `SpanExporter` (typically `InMemorySpanExporter`) wrapped in a
// `SimpleSpanProcessor` so spans flush quickly on end. Tests then call
// `forceFlush(handle)` before asserting on span contents, because the
// simple processor's export is dispatched to a microtask — reads that
// skip the flush will see an empty buffer.

import {
    context,
    metrics,
    propagation,
    trace,
    type TracerProvider,
} from '@opentelemetry/api';
import {
    ParentBasedSampler,
    SimpleSpanProcessor,
    TraceIdRatioBasedSampler,
    type SpanExporter,
    type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import { buildResource } from './resource.ts';
import type { ObservabilityConfig } from './types.ts';

export interface SdkHandle {
    readonly enabled: boolean;
}

export interface BootSdkOptions {
    readonly config?: ObservabilityConfig;
    /**
     * Test-only: replace the default OTLP trace exporter. When set, the
     * SDK is configured with a `SimpleSpanProcessor(override)` so tests
     * read spans with `forceFlush(handle)` then `exporter.getFinishedSpans()`.
     */
    readonly traceExporterOverride?: SpanExporter;
}

interface EnabledHandle extends SdkHandle {
    readonly enabled: true;
    readonly forceFlush: () => Promise<void>;
    readonly shutdown: () => Promise<void>;
}

interface DisabledHandle extends SdkHandle {
    readonly enabled: false;
}

const DISABLED_HANDLE: DisabledHandle = { enabled: false };

function resolveSamplerRatio(config: ObservabilityConfig | undefined): number {
    if (config?.sampling?.ratio !== undefined) return config.sampling.ratio;
    return process.env['NODE_ENV'] === 'production' ? 0.1 : 1.0;
}

/** Resolve the active tracer provider — following the API proxy through
 *  to the real delegate. The delegate is the BasicTracerProvider (or
 *  subclass) that SimpleSpanProcessor and friends are attached to, so
 *  its `forceFlush` drains the pending export queue. */
function resolveActiveProvider(): TracerProvider & { forceFlush?: () => Promise<void> } {
    const top = trace.getTracerProvider() as TracerProvider & {
        getDelegate?: () => TracerProvider;
    };
    return top.getDelegate ? (top.getDelegate() as TracerProvider & { forceFlush?: () => Promise<void> }) : top;
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

    const resource = buildResource(config);
    const sampler = new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(resolveSamplerRatio(config)),
    });

    const isTestOverride = opts.traceExporterOverride !== undefined;

    const spanProcessors: SpanProcessor[] = isTestOverride
        ? [new SimpleSpanProcessor(opts.traceExporterOverride!)]
        : [];

    // Split prod vs test-override paths so we only construct OTLP
    // exporters on the real prod path. In tests, spinning up OTLP
    // exporters against the default localhost:4318 endpoint creates
    // background failing exporter state that interferes with the
    // in-memory exporter we're injecting.
    let sdk: InstanceType<typeof NodeSDK>;
    if (isTestOverride) {
        sdk = new NodeSDK({ resource, sampler, spanProcessors });
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
            metricReader: new PeriodicExportingMetricReader({
                exporter: new OTLPMetricExporter(),
                exportIntervalMillis: 60_000,
            }),
        });
    }

    sdk.start();

    // Snapshot the provider now so forceFlush can drive it directly.
    const provider = resolveActiveProvider();

    const handle: EnabledHandle = {
        enabled: true,
        forceFlush: async () => {
            if (typeof provider.forceFlush === 'function') {
                await provider.forceFlush();
            }
        },
        shutdown: () => sdk.shutdown(),
    };
    return handle;
}

/** Drain any pending span exports. Called by tests before reading the
 *  in-memory exporter's buffer, and available in prod as a graceful-
 *  shutdown helper before the process exits. */
export async function forceFlush(handle: SdkHandle): Promise<void> {
    if (!handle.enabled) return;
    await (handle as EnabledHandle).forceFlush();
}

export async function shutdownSdk(handle: SdkHandle): Promise<void> {
    if (!handle.enabled) return;
    await (handle as EnabledHandle).shutdown();
    // NodeSDK.shutdown() closes the providers but leaves them wired into
    // the OTel API globals. Clearing them makes shutdown fully symmetric
    // with boot — necessary for test isolation across repeated boots and
    // harmless in prod where shutdown fires on process exit.
    trace.disable();
    metrics.disable();
    context.disable();
    propagation.disable();
}
