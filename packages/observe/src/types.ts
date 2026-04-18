// Public types shared by the ctx factory, metric factory, and seam
// helpers. Kept dependency-free so downstream packages can import
// these without pulling in @opentelemetry/api.

/** Primitive values accepted as span/metric attribute values. */
export type AttrValue = string | number | boolean;

/** Attribute bag shape used throughout. Undefined entries are dropped. */
export type Attrs = Readonly<Record<string, AttrValue | undefined>>;

/**
 * The observability surface we splice into every framework-invoked
 * handler's ctx. Inside a workflow handler, `span` still works — it
 * opens a non-durable span as a child of Restate's invocation span.
 * `ctx.run` remains the durable-step primitive; we do not wrap it.
 */
export interface ObservabilityCtx {
    /** Run `fn` inside a child span; auto-records exceptions and duration. */
    span<T>(name: string, fn: () => Promise<T> | T, attrs?: Attrs): Promise<T>;
    /** Ad-hoc metric reading. Prefer declared metrics for anything reused. */
    metric(name: string, value: number, attrs?: Attrs): void;
    /** Timestamped breadcrumb on the active span. Named `mark` to avoid
     *  colliding with bus/topic "events." */
    mark(name: string, attrs?: Attrs): void;
}

/** Counter — monotonic increment, tags per increment. */
export interface CounterHandle {
    add(value?: number, attrs?: Attrs): void;
}

/** Histogram — distributional measurement (latency, size, etc). */
export interface HistogramHandle {
    observe(value: number, attrs?: Attrs): void;
}

/** Gauge — last-value sampling; used for point-in-time readings. */
export interface GaugeHandle {
    record(value: number, attrs?: Attrs): void;
}

export interface MetricOptions {
    readonly description?: string;
    readonly unit?: string;
}

export interface MetricFactory {
    counter(name: string, opts?: MetricOptions): CounterHandle;
    histogram(name: string, opts?: MetricOptions): HistogramHandle;
    gauge(name: string, opts?: MetricOptions): GaugeHandle;
}

/**
 * User-facing configuration block. Passed as `config({ observability: ... })`
 * in `syncengine.config.ts`; consumed by `bootSdk` in `serve` and
 * `vite-plugin`. Kept in this package so `@syncengine/core` can re-export
 * the type without pulling in OTel at type-check time (A3).
 */
export interface ObservabilityConfig {
    /** Overrides `OTEL_SERVICE_NAME`. Falls back to `'syncengine-app'`. */
    readonly serviceName?: string;
    /** Source of truth for turning telemetry on / off.
     *  - `'otlp'` (default) boots the Node SDK with OTLP/HTTP exporters.
     *  - `false` disables entirely — no SDK is started, seam helpers stay noops. */
    readonly exporter?: 'otlp' | false;
    /** Extra resource attributes merged on top of auto-detected ones. */
    readonly resource?: Readonly<Record<string, string | number | boolean>>;
    /** Parent-based sampler ratio. Defaults: 1.0 in non-production, 0.1 in production. */
    readonly sampling?: { readonly ratio: number };
    /** Opt in to exporting entity field values on spans. Off by default. */
    readonly captureFieldValues?: boolean;
    /** Opt-in auto-instrumentation. Currently supported: 'fetch' (phase D4). */
    readonly autoInstrument?: readonly 'fetch'[];
}
