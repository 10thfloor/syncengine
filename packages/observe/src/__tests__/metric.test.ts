// Phase D, Task D1 — declared metric factory.
//
// metric.counter/histogram/gauge are the user-facing primitive for
// declared metrics. Handles lazily acquire their OTel instrument per
// call so the factory survives SDK boot/shutdown cycles. Attribute
// auto-merge pulls the current observe scope (workspace / user /
// primitive / name) from AsyncLocalStorage installed by the seam
// helpers (Phase B1 + C), so user code doesn't need to thread the ctx
// through to every metric call.

import { afterEach, describe, expect, it } from 'bun:test';
import {
    AggregationTemporality,
    InMemoryMetricExporter,
    type DataPoint,
    type Histogram,
    type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';

import { bootSdk, type SdkHandle } from '../sdk';
import { metric } from '../metric';
import { instrument } from '../internal';
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

async function bootWith(
    metricExporter: InMemoryMetricExporter,
): Promise<SdkHandle> {
    const handle = await bootSdk({
        config: { exporter: 'otlp', serviceName: 'metric-test' },
        metricExporterOverride: metricExporter,
    });
    teardown.push(handle);
    return handle;
}

function collectReadings(
    metrics: readonly ResourceMetrics[],
    instrumentName: string,
): readonly DataPoint<number | Histogram>[] {
    const readings: DataPoint<number | Histogram>[] = [];
    for (const rm of metrics) {
        for (const scope of rm.scopeMetrics) {
            for (const m of scope.metrics) {
                if (m.descriptor.name !== instrumentName) continue;
                readings.push(...(m.dataPoints as DataPoint<number | Histogram>[]));
            }
        }
    }
    return readings;
}

describe('metric.counter', () => {
    it('records an increment that survives to the exporter', async () => {
        const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
        const handle = await bootWith(exporter);

        const orders = metric.counter('orders.placed');
        orders.add(1);
        orders.add(2, { region: 'us' });

        await handle.forceFlush();
        const readings = collectReadings(exporter.getMetrics(), 'orders.placed');
        // Two data points (one per attribute set) or one merged — depends
        // on aggregation. Either way, total value should be 3.
        const total = readings.reduce(
            (n, p) => n + (typeof p.value === 'number' ? p.value : 0),
            0,
        );
        expect(total).toBe(3);
    });

    it('counter.add() with no value defaults to 1', async () => {
        const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
        const handle = await bootWith(exporter);

        const c = metric.counter('ticks');
        c.add();
        c.add();
        c.add();

        await handle.forceFlush();
        const readings = collectReadings(exporter.getMetrics(), 'ticks');
        const total = readings.reduce(
            (n, p) => n + (typeof p.value === 'number' ? p.value : 0),
            0,
        );
        expect(total).toBe(3);
    });

    it('auto-merges workspace/user/primitive/name from the active observe scope', async () => {
        const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
        const handle = await bootWith(exporter);

        const orders = metric.counter('orders.tagged');

        await instrument.entityEffect(
            {
                workspace: 'ws_alpha',
                user: 'user_42',
                name: 'orders',
                op: 'place',
            },
            async () => {
                orders.add(1);
            },
        );

        await handle.forceFlush();
        const readings = collectReadings(exporter.getMetrics(), 'orders.tagged');
        expect(readings).toHaveLength(1);
        const attrs = readings[0]!.attributes;
        expect(attrs[ATTR_WORKSPACE]).toBe('ws_alpha');
        expect(attrs[ATTR_USER]).toBe('user_42');
        expect(attrs[ATTR_PRIMITIVE]).toBe('entity');
        expect(attrs[ATTR_NAME]).toBe('orders');
    });

    it('user-supplied attrs merge UNDER auto-tags — auto-tags always win', async () => {
        const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
        const handle = await bootWith(exporter);

        const c = metric.counter('attr.precedence');

        await instrument.entityEffect(
            { workspace: 'ws_correct', name: 'orders', op: 'place' },
            async () => {
                c.add(1, {
                    // Spoofed value should be ignored.
                    [ATTR_WORKSPACE]: 'ws_spoofed',
                    // Free-form key is kept.
                    reason: 'test',
                });
            },
        );

        await handle.forceFlush();
        const readings = collectReadings(exporter.getMetrics(), 'attr.precedence');
        expect(readings).toHaveLength(1);
        const attrs = readings[0]!.attributes;
        expect(attrs[ATTR_WORKSPACE]).toBe('ws_correct');
        expect(attrs['reason']).toBe('test');
    });

    it('calls outside a ctx attach only user-supplied attrs (no scope leak)', async () => {
        const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
        const handle = await bootWith(exporter);

        const c = metric.counter('attr.free');
        c.add(1, { kind: 'standalone' });

        await handle.forceFlush();
        const readings = collectReadings(exporter.getMetrics(), 'attr.free');
        expect(readings).toHaveLength(1);
        const attrs = readings[0]!.attributes;
        expect(attrs['kind']).toBe('standalone');
        expect(attrs[ATTR_WORKSPACE]).toBeUndefined();
        expect(attrs[ATTR_PRIMITIVE]).toBeUndefined();
    });
});

describe('metric.histogram', () => {
    it('records observations to a histogram instrument', async () => {
        const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
        const handle = await bootWith(exporter);

        const latency = metric.histogram('order.latency', { unit: 'ms' });
        latency.observe(12);
        latency.observe(34);
        latency.observe(56);

        await handle.forceFlush();
        const readings = collectReadings(exporter.getMetrics(), 'order.latency');
        expect(readings.length).toBeGreaterThan(0);
        const hist = readings[0]!.value as Histogram;
        expect(hist.count).toBe(3);
        expect(hist.sum).toBe(102);
    });
});

describe('metric.gauge', () => {
    it('records the most recent value', async () => {
        const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
        const handle = await bootWith(exporter);

        const carts = metric.gauge('cart.active');
        carts.record(10);
        carts.record(42);

        await handle.forceFlush();
        const readings = collectReadings(exporter.getMetrics(), 'cart.active');
        expect(readings).toHaveLength(1);
        expect(readings[0]!.value).toBe(42);
    });
});

describe('disabled-path', () => {
    it('metric calls are pass-throughs when no SDK is booted', () => {
        // No boot — trace.getTracer and metrics.getMeter return noops.
        // Handle construction and add/observe/record must not throw.
        const c = metric.counter('nobody.home');
        const h = metric.histogram('nobody.home.latency');
        const g = metric.gauge('nobody.home.gauge');
        expect(() => c.add(1)).not.toThrow();
        expect(() => h.observe(1)).not.toThrow();
        expect(() => g.record(1)).not.toThrow();
    });
});
