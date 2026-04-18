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

// ObservabilityConfig lives in @syncengine/core (it's user-facing config);
// imported here as a type so bootSdk and friends can consume it without a
// circular runtime dependency. See `packages/core/src/config.ts`.
export type { ObservabilityConfig } from '@syncengine/core';
