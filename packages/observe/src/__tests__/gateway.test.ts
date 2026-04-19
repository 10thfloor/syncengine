// Phase C, Task C2 — instrument.gatewayMessage.
//
// WebSocket connection lifetimes can be hours; a span that lives that
// long is incompatible with OTel batch exporters (they don't flush
// until span.end()). We span each inbound message individually and
// tag it with the session id so APM queries can group spans by session.

import { afterEach, describe, expect, it } from 'bun:test';
import { SpanKind } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';

import { bootSdk, type SdkHandle } from '../sdk';
import { instrument } from '../internal';
import {
    ATTR_NAME,
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
        config: { exporter: 'otlp', serviceName: 'gateway-test' },
        traceExporterOverride: exporter,
    });
    teardown.push(handle);
    return handle;
}

describe('instrument.gatewayMessage', () => {
    it('opens a SERVER span named gateway.<messageType> with session + workspace attrs', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        await instrument.gatewayMessage(
            { messageType: 'subscribe', sessionId: 'sess_1', workspace: 'ws_a' },
            async () => undefined,
        );

        await handle.forceFlush();
        const span = exporter.getFinishedSpans()[0]!;
        expect(span.kind).toBe(SpanKind.SERVER);
        expect(span.name).toBe('gateway.subscribe');
        expect(span.attributes[ATTR_PRIMITIVE]).toBe('gateway');
        expect(span.attributes[ATTR_NAME]).toBe('subscribe');
        expect(span.attributes['syncengine.session_id']).toBe('sess_1');
        expect(span.attributes[ATTR_WORKSPACE]).toBe('ws_a');
    });

    it('omits optional session and workspace attrs when not provided', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        await instrument.gatewayMessage(
            { messageType: 'init' },
            async () => undefined,
        );

        await handle.forceFlush();
        const span = exporter.getFinishedSpans()[0]!;
        expect(span.attributes['syncengine.session_id']).toBeUndefined();
        expect(span.attributes[ATTR_WORKSPACE]).toBeUndefined();
    });

    it('each message is an independent root (sibling not nested) by default', async () => {
        // Verifies that gatewayMessage doesn't accidentally keep a span
        // active across back-to-back calls — each invocation is its
        // own atomic unit of WS message processing.
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        await instrument.gatewayMessage(
            { messageType: 'a', sessionId: 's' },
            async () => undefined,
        );
        await instrument.gatewayMessage(
            { messageType: 'b', sessionId: 's' },
            async () => undefined,
        );

        await handle.forceFlush();
        const spans = exporter.getFinishedSpans();
        expect(spans).toHaveLength(2);
        expect(spans[0]!.parentSpanContext).toBeUndefined();
        expect(spans[1]!.parentSpanContext).toBeUndefined();
    });

    it('disabled-path is a straight pass-through', async () => {
        const result = await instrument.gatewayMessage(
            { messageType: 'ping' },
            async () => 42,
        );
        expect(result).toBe(42);
    });
});
