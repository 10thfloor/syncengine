// Phase C, Task C3 — instrument.busPublish + instrument.busConsume.
//
// Bus publish/consume happens across a process boundary (NATS JetStream)
// so W3C TraceContext propagation requires round-tripping traceparent /
// tracestate through the message headers. These tests assert:
//
//   - busPublish opens a PRODUCER-kind span with messaging.* semconv
//     attributes AND hands the caller a carrier containing traceparent.
//   - busConsume accepts the carrier's traceparent/tracestate and
//     produces a CONSUMER-kind span that nests under the producer.
//   - The continuation path is verified end-to-end: publish carrier
//     → consume → same trace id, consume's parent = producer's span.
//   - Disabled path is a straight pass-through; busPublish hands an
//     empty carrier so caller doesn't inject garbage headers.

import { afterEach, describe, expect, it } from 'bun:test';
import { SpanKind } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';

import { bootSdk, type SdkHandle } from '../sdk';
import { instrument } from '../internal';
import {
    ATTR_NAME,
    ATTR_PRIMITIVE,
    ATTR_TOPIC,
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
        config: { exporter: 'otlp', serviceName: 'bus-test' },
        traceExporterOverride: exporter,
    });
    teardown.push(handle);
    return handle;
}

describe('instrument.busPublish', () => {
    it('opens a PRODUCER span with messaging.* semconv + syncengine.* auto-tags', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        await instrument.busPublish(
            { busName: 'orderEvents', workspace: 'ws_alpha' },
            async () => undefined,
        );

        await handle.forceFlush();
        const span = exporter.getFinishedSpans()[0]!;
        expect(span.kind).toBe(SpanKind.PRODUCER);
        expect(span.name).toBe('bus.orderEvents publish');
        expect(span.attributes['messaging.system']).toBe('nats');
        expect(span.attributes['messaging.destination.name']).toBe('orderEvents');
        expect(span.attributes['messaging.operation']).toBe('publish');
        expect(span.attributes[ATTR_PRIMITIVE]).toBe('bus');
        expect(span.attributes[ATTR_NAME]).toBe('orderEvents');
        expect(span.attributes[ATTR_TOPIC]).toBe('orderEvents');
        expect(span.attributes[ATTR_WORKSPACE]).toBe('ws_alpha');
    });

    it('populates the carrier with a W3C traceparent', async () => {
        const exporter = new InMemorySpanExporter();
        await bootWith(exporter);

        let seen: Record<string, string> = {};
        await instrument.busPublish(
            { busName: 'x', workspace: 'ws' },
            async (carrier) => {
                seen = { ...carrier };
            },
        );

        // traceparent format: `<version>-<traceId>-<spanId>-<flags>`
        expect(seen['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
    });

    it('disabled path: hands an empty carrier + pass-through result', async () => {
        let seen: Record<string, string> = { bogus: 'yes' };
        const result = await instrument.busPublish(
            { busName: 'x', workspace: 'ws' },
            async (carrier) => {
                seen = { ...carrier };
                return 'ok';
            },
        );
        expect(result).toBe('ok');
        expect(Object.keys(seen)).toHaveLength(0);
    });
});

describe('instrument.busConsume', () => {
    it('opens a CONSUMER span with messaging.* semconv', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        await instrument.busConsume(
            {
                busName: 'orderEvents',
                subscriber: 'notifier',
                workspace: 'ws_alpha',
            },
            async () => undefined,
        );

        await handle.forceFlush();
        const span = exporter.getFinishedSpans()[0]!;
        expect(span.kind).toBe(SpanKind.CONSUMER);
        expect(span.name).toBe('bus.orderEvents consume');
        expect(span.attributes['messaging.system']).toBe('nats');
        expect(span.attributes['messaging.operation']).toBe('receive');
        expect(span.attributes['messaging.consumer.group.name']).toBe('notifier');
        expect(span.attributes[ATTR_PRIMITIVE]).toBe('bus');
        expect(span.attributes[ATTR_NAME]).toBe('orderEvents');
        expect(span.attributes[ATTR_WORKSPACE]).toBe('ws_alpha');
    });

    it('no traceparent → consume span becomes a new trace root', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        await instrument.busConsume(
            { busName: 'x', subscriber: 'y', workspace: 'ws' },
            async () => undefined,
        );

        await handle.forceFlush();
        const span = exporter.getFinishedSpans()[0]!;
        expect(span.parentSpanContext).toBeUndefined();
    });
});

describe('publish → consume continuity', () => {
    it('round-trip traceparent preserves trace id and parents consume under producer', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        // The publisher is wrapped in an upstream workflow-like span so
        // we can see three levels: workflow → producer → consumer. Real
        // deployments show this pattern constantly.
        let carrier: Record<string, string> = {};
        await instrument.request(
            { method: 'POST', route: 'rpc', path: '/x' },
            async () => {
                await instrument.busPublish(
                    { busName: 'orderEvents', workspace: 'ws' },
                    async (c) => {
                        carrier = { ...c };
                    },
                );
            },
        );

        // Now simulate the cross-process hop — traceparent survives
        // as a message header, the consumer side reads it and calls
        // busConsume with the value.
        await instrument.busConsume(
            {
                busName: 'orderEvents',
                subscriber: 'notifier',
                workspace: 'ws',
                traceparent: carrier['traceparent'],
                ...(carrier['tracestate'] && { tracestate: carrier['tracestate'] }),
            },
            async () => undefined,
        );

        await handle.forceFlush();
        const spans = exporter.getFinishedSpans();
        const producer = spans.find((s) => s.name === 'bus.orderEvents publish')!;
        const consumer = spans.find((s) => s.name === 'bus.orderEvents consume')!;
        expect(producer).toBeDefined();
        expect(consumer).toBeDefined();
        // Same trace id across the hop
        expect(consumer.spanContext().traceId).toBe(producer.spanContext().traceId);
        // Consumer span's parent is the producer span (W3C propagation)
        expect(consumer.parentSpanContext?.spanId).toBe(producer.spanContext().spanId);
    });
});
