// Phase E, Task E1 — end-to-end observability trace tree.
//
// Exercises every seam helper from Phases B and C in the topology a
// real request follows. Asserts the full parent→child tree shape,
// auto-tags, and W3C traceparent propagation across simulated process
// boundaries (bus NATS hop, webhook HTTP→Restate hop, entity
// invocation).
//
// This is a COMPOSITION test of the observability layer: it calls
// instrument.* helpers in the same order + nesting that serve/rpc.ts,
// entity-runtime.ts, bus-dispatcher.ts, webhook-http.ts, and
// webhook-workflow.ts call them in production. The actual call sites
// are unit-tested inside each package; here we verify they compose.
//
// Gap: Restate's own invocation spans aren't emitted by this test
// (no real Restate process). That verification happens when the
// framework runs against a real Restate server + OTLP collector —
// the manual check at the top of Checkpoint 2.

import { afterEach, describe, expect, it } from 'vitest';
import { bootSdk, instrument, type SdkHandle } from '@syncengine/observe';
import {
    InMemorySpanExporter,
    type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { SpanKind } from '@opentelemetry/api';

const teardown: SdkHandle[] = [];
afterEach(async () => {
    while (teardown.length > 0) {
        await teardown.shift()!.shutdown();
    }
});

async function bootWith(exporter: InMemorySpanExporter): Promise<SdkHandle> {
    const handle = await bootSdk({
        config: { exporter: 'otlp', serviceName: 'apps/test e2e' },
        traceExporterOverride: exporter,
    });
    teardown.push(handle);
    return handle;
}

function byName(spans: readonly ReadableSpan[]): Map<string, ReadableSpan> {
    return new Map(spans.map((s) => [s.name, s]));
}

function parentOf(
    child: ReadableSpan,
    spans: readonly ReadableSpan[],
): ReadableSpan | undefined {
    const parentId = child.parentSpanContext?.spanId;
    if (!parentId) return undefined;
    return spans.find((s) => s.spanContext().spanId === parentId);
}

describe('observability e2e — full trace tree', () => {
    it('HTTP POST rpc → rpc.entity → entity.effect → bus.publish nests in one trace', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        // Topology: the Bun fetch handler opens a request span; the
        // RPC proxy opens an rpc child; Restate invokes the entity
        // handler which our entity-runtime wraps in entityEffect;
        // inside that handler, an emit triggers bus.publish which
        // opens a PRODUCER span and would stamp traceparent onto
        // NATS headers.

        let capturedCarrier: Record<string, string> = {};

        await instrument.request(
            { method: 'POST', route: 'rpc', path: '/__syncengine/rpc/orders/o-1/place' },
            async () => {
                await instrument.rpc(
                    {
                        kind: 'entity',
                        name: 'orders',
                        handler: 'place',
                        workspace: 'ws_alpha',
                    },
                    async () => {
                        // Cross-process hop simulation: Restate-side
                        // entry extracts traceparent from the inbound
                        // headers and makes it the parent for the
                        // entity effect span.
                        const inboundHeaders = new Map(
                            Object.entries(instrument.traceHeaders()),
                        );
                        await instrument.withRemoteParent(
                            inboundHeaders,
                            async () => {
                                await instrument.entityEffect(
                                    {
                                        workspace: 'ws_alpha',
                                        user: 'user_42',
                                        name: 'orders',
                                        op: 'place',
                                    },
                                    async () => {
                                        // User handler emits a bus event.
                                        await instrument.busPublish(
                                            { busName: 'orderPlaced', workspace: 'ws_alpha' },
                                            async (carrier) => {
                                                capturedCarrier = { ...carrier };
                                            },
                                        );
                                    },
                                );
                            },
                        );
                    },
                );
            },
        );

        await handle.forceFlush();
        const spans = exporter.getFinishedSpans();
        const byN = byName(spans);

        // ── Span presence ──
        const request = byN.get('POST rpc');
        const rpc = byN.get('rpc.entity.orders.place');
        const entity = byN.get('entity.orders.place');
        const busPub = byN.get('bus.orderPlaced publish');
        expect(request).toBeDefined();
        expect(rpc).toBeDefined();
        expect(entity).toBeDefined();
        expect(busPub).toBeDefined();

        // ── Kinds ──
        expect(request!.kind).toBe(SpanKind.SERVER);
        expect(busPub!.kind).toBe(SpanKind.PRODUCER);

        // ── Tree shape: request → rpc → entity → busPub ──
        expect(parentOf(rpc!, spans)?.name).toBe('POST rpc');
        expect(parentOf(entity!, spans)?.name).toBe('rpc.entity.orders.place');
        expect(parentOf(busPub!, spans)?.name).toBe('entity.orders.place');

        // ── All spans share one trace id ──
        const traceIds = new Set(spans.map((s) => s.spanContext().traceId));
        expect(traceIds.size).toBe(1);

        // ── Auto-tags propagate correctly ──
        expect(rpc!.attributes['syncengine.workspace']).toBe('ws_alpha');
        expect(entity!.attributes['syncengine.workspace']).toBe('ws_alpha');
        expect(entity!.attributes['syncengine.user']).toBe('user_42');
        expect(busPub!.attributes['syncengine.workspace']).toBe('ws_alpha');

        // ── Carrier stamped with the active traceparent ──
        expect(capturedCarrier['traceparent']).toMatch(
            /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/,
        );
        // Trace id in the carrier matches the trace's id.
        const carrierTraceId = capturedCarrier['traceparent']!.split('-')[1];
        expect(carrierTraceId).toBe(request!.spanContext().traceId);
    });

    it('bus publish → NATS hop → bus consume preserves trace continuity', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        // Simulate a bus-triggered subscriber workflow: producer emits,
        // the message travels through NATS (carrier payload survives
        // on headers), the dispatcher consumes, posts to Restate,
        // workflow handler runs.

        let carrier: Record<string, string> = {};
        await instrument.request(
            { method: 'POST', route: 'rpc', path: '/upstream' },
            async () => {
                await instrument.busPublish(
                    { busName: 'orderPlaced', workspace: 'ws' },
                    async (c) => { carrier = { ...c }; },
                );
            },
        );

        // Now on the subscriber process: dispatcher pulls the message,
        // reads traceparent off the headers, wraps the Restate POST
        // in busConsume.
        await instrument.busConsume(
            {
                busName: 'orderPlaced',
                subscriber: 'notifier',
                workspace: 'ws',
                traceparent: carrier['traceparent']!,
            },
            async () => {
                // The subscriber workflow would then invoke Restate;
                // we stop at the consume boundary here because that's
                // where the hop ends. Restate invocation spans come
                // from Restate itself via W3C propagation.
            },
        );

        await handle.forceFlush();
        const spans = exporter.getFinishedSpans();
        const byN = byName(spans);

        const producer = byN.get('bus.orderPlaced publish');
        const consumer = byN.get('bus.orderPlaced consume');
        expect(producer).toBeDefined();
        expect(consumer).toBeDefined();

        // Same trace across the hop.
        expect(consumer!.spanContext().traceId).toBe(producer!.spanContext().traceId);
        // Consumer's parent IS the producer (W3C propagation).
        expect(consumer!.parentSpanContext?.spanId).toBe(producer!.spanContext().spanId);

        expect(producer!.kind).toBe(SpanKind.PRODUCER);
        expect(consumer!.kind).toBe(SpanKind.CONSUMER);
    });

    it('webhook inbound → Restate hop → webhook run nests correctly', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        // webhook-http dispatches: verify → POST to Restate with
        // traceparent on headers. Restate workflow's run handler
        // extracts the header and opens webhookRun.

        let outboundHeaders: Record<string, string> = {};
        await instrument.webhookInbound({ name: 'stripe' }, async () => {
            instrument.markWebhookWorkspace('ws_stripe');
            outboundHeaders = {
                'content-type': 'application/json',
                ...instrument.traceHeaders(),
            };
        });

        // Now Restate side: build headers map from what was sent,
        // extract traceparent, open webhookRun.
        const headersMap = new Map(Object.entries(outboundHeaders));
        await instrument.withRemoteParent(headersMap, async () => {
            await instrument.webhookRun(
                {
                    name: 'stripe',
                    workspace: 'ws_stripe',
                    idempotencyKey: 'evt_abc123',
                },
                async () => undefined,
            );
        });

        await handle.forceFlush();
        const spans = exporter.getFinishedSpans();
        const inbound = spans.find((s) => s.name === 'webhook.stripe.inbound');
        const run = spans.find((s) => s.name === 'webhook.stripe.run');
        expect(inbound).toBeDefined();
        expect(run).toBeDefined();

        expect(run!.spanContext().traceId).toBe(inbound!.spanContext().traceId);
        expect(inbound!.attributes['syncengine.workspace']).toBe('ws_stripe');
        expect(run!.attributes['syncengine.workspace']).toBe('ws_stripe');
        expect(run!.attributes['syncengine.invocation']).toBe('evt_abc123');
    });

    it('heartbeat tick produces one span per iteration with run_number', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        for (let i = 1; i <= 4; i++) {
            await instrument.heartbeatTick(
                { name: 'nightly-cleanup', workspace: 'ws', runNumber: i },
                async () => undefined,
            );
        }

        await handle.forceFlush();
        const ticks = exporter
            .getFinishedSpans()
            .filter((s) => s.name === 'heartbeat.nightly-cleanup.tick')
            .sort(
                (a, b) =>
                    Number(a.attributes['syncengine.run_number']) -
                    Number(b.attributes['syncengine.run_number']),
            );
        expect(ticks).toHaveLength(4);
        expect(ticks.map((s) => s.attributes['syncengine.run_number'])).toEqual([1, 2, 3, 4]);
    });

    it('gateway message spans are independent (siblings, not nested)', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        // Back-to-back WS messages on one session should each get their
        // own root span — long-running connections don't span.
        await instrument.gatewayMessage(
            { messageType: 'init', sessionId: 'sess_1' },
            async () => undefined,
        );
        await instrument.gatewayMessage(
            {
                messageType: 'subscribe',
                sessionId: 'sess_1',
                workspace: 'ws_alpha',
            },
            async () => undefined,
        );

        await handle.forceFlush();
        const spans = exporter.getFinishedSpans();
        expect(spans.every((s) => s.parentSpanContext === undefined)).toBe(true);
        expect(spans).toHaveLength(2);
    });
});
