// Zero-cost fall-through used when the SDK hasn't been booted or the
// user set `observability: { exporter: false }`. The real ctx factory
// (B2) and real metric factory (D1) detect the disabled case and
// return these directly, so seam helpers and user code call into a
// straight pass-through — no OTel imports, no allocations beyond the
// pre-constructed constants below.

import type {
    Attrs,
    CounterHandle,
    GaugeHandle,
    HistogramHandle,
    MetricFactory,
    MetricOptions,
    ObservabilityCtx,
} from './types';

// ── ctx ────────────────────────────────────────────────────────────────────

const NOOP_CTX: ObservabilityCtx = {
    async span<T>(_name: string, fn: () => Promise<T> | T, _attrs?: Attrs): Promise<T> {
        return await fn();
    },
    metric(_name: string, _value: number, _attrs?: Attrs): void {
        // intentionally empty
    },
    mark(_name: string, _attrs?: Attrs): void {
        // intentionally empty
    },
};

export function noopCtx(): ObservabilityCtx {
    return NOOP_CTX;
}

// ── metric factory ─────────────────────────────────────────────────────────

const NOOP_COUNTER: CounterHandle = {
    add(_value?: number, _attrs?: Attrs): void {
        // intentionally empty
    },
};

const NOOP_HISTOGRAM: HistogramHandle = {
    observe(_value: number, _attrs?: Attrs): void {
        // intentionally empty
    },
};

const NOOP_GAUGE: GaugeHandle = {
    record(_value: number, _attrs?: Attrs): void {
        // intentionally empty
    },
};

export const noopMetric: MetricFactory = {
    counter(_name: string, _opts?: MetricOptions): CounterHandle {
        return NOOP_COUNTER;
    },
    histogram(_name: string, _opts?: MetricOptions): HistogramHandle {
        return NOOP_HISTOGRAM;
    },
    gauge(_name: string, _opts?: MetricOptions): GaugeHandle {
        return NOOP_GAUGE;
    },
};
