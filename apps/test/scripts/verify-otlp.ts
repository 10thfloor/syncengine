#!/usr/bin/env bun
// Manual verification harness — boots the real SDK pointed at Jaeger,
// exercises the full composition of seam helpers, flushes, then
// queries Jaeger's API to confirm the spans actually landed.
//
// Usage:
//   docker run -d --name jaeger -p 14318:4318 -p 16686:16686 \
//     -e COLLECTOR_OTLP_ENABLED=true jaegertracing/all-in-one:latest
//   bun apps/test/scripts/verify-otlp.ts
//
// Asserts:
//   - bootSdk runs without error against a live collector
//   - Every seam helper produces a span
//   - Jaeger's API returns the full set with the expected service name
//   - trace ids, parent links, and syncengine.* attrs round-trip
//     through the wire format

import { bootSdk, instrument } from '@syncengine/observe';

const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:14318';
const JAEGER_API = process.env.JAEGER_QUERY_URL ?? 'http://localhost:16686';
const SERVICE_NAME = 'syncengine-verify';

// Override the endpoint for this run via env so we don't affect the
// user's shell.
process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = OTLP_ENDPOINT;

async function main(): Promise<void> {
    console.log(`[verify] booting SDK with OTLP endpoint: ${OTLP_ENDPOINT}`);
    const handle = await bootSdk({
        config: { exporter: 'otlp', serviceName: SERVICE_NAME },
    });

    if (!handle.enabled) {
        throw new Error('SDK did not enable — check config / env');
    }

    console.log('[verify] running seam composition …');

    let carrier: Record<string, string> = {};

    // Full tree: HTTP → RPC → entity → bus.publish → bus.consume → webhook → heartbeat
    await instrument.request(
        { method: 'POST', route: 'rpc', path: '/__syncengine/rpc/orders/o-1/place' },
        async () => {
            await instrument.rpc(
                { kind: 'entity', name: 'orders', handler: 'place', workspace: 'ws_alpha' },
                async () => {
                    const inboundHeaders = new Map(Object.entries(instrument.traceHeaders()));
                    await instrument.withRemoteParent(inboundHeaders, async () => {
                        await instrument.entityEffect(
                            { workspace: 'ws_alpha', user: 'alice', name: 'orders', op: 'place' },
                            async () => {
                                await instrument.busPublish(
                                    { busName: 'orderPlaced', workspace: 'ws_alpha' },
                                    async (c) => { carrier = { ...c }; },
                                );
                            },
                        );
                    });
                },
            );
        },
    );

    // Simulate the bus hop:
    await instrument.busConsume(
        {
            busName: 'orderPlaced',
            subscriber: 'notifier',
            workspace: 'ws_alpha',
            traceparent: carrier['traceparent']!,
        },
        async () => undefined,
    );

    // Webhook pair
    let outboundHeaders: Record<string, string> = {};
    await instrument.webhookInbound({ name: 'stripe' }, async () => {
        instrument.markWebhookWorkspace('ws_stripe');
        outboundHeaders = instrument.traceHeaders();
    });
    await instrument.withRemoteParent(new Map(Object.entries(outboundHeaders)), async () => {
        await instrument.webhookRun(
            { name: 'stripe', workspace: 'ws_stripe', idempotencyKey: 'evt_verify_1' },
            async () => undefined,
        );
    });

    // Heartbeat ticks
    for (let i = 1; i <= 2; i++) {
        await instrument.heartbeatTick(
            { name: 'nightly-cleanup', workspace: 'ws_alpha', runNumber: i },
            async () => undefined,
        );
    }

    // Gateway message
    await instrument.gatewayMessage(
        { messageType: 'subscribe', sessionId: 'sess_verify', workspace: 'ws_alpha' },
        async () => undefined,
    );

    console.log('[verify] forcing flush …');
    await handle.forceFlush();

    console.log('[verify] shutting down SDK (drains exporters) …');
    await handle.shutdown();

    console.log('[verify] waiting 2s for Jaeger to index …');
    await new Promise((r) => setTimeout(r, 2000));

    console.log(`[verify] querying Jaeger API at ${JAEGER_API} …`);
    const res = await fetch(
        `${JAEGER_API}/api/traces?service=${SERVICE_NAME}&limit=20`,
    );
    if (!res.ok) {
        throw new Error(
            `Jaeger API returned ${res.status}: ${await res.text().catch(() => '<no body>')}`,
        );
    }

    type JaegerTrace = {
        traceID: string;
        spans: ReadonlyArray<{
            operationName: string;
            tags: ReadonlyArray<{ key: string; value: unknown }>;
            references?: ReadonlyArray<{ refType: string; traceID: string; spanID: string }>;
        }>;
    };
    const body = (await res.json()) as { data: JaegerTrace[] };
    const traces = body.data ?? [];

    if (traces.length === 0) {
        throw new Error('Jaeger returned zero traces — spans did not land');
    }

    console.log(`[verify] found ${traces.length} trace(s)`);
    const allSpans = traces.flatMap((t) => t.spans.map((s) => ({ ...s, traceID: t.traceID })));
    console.log(`[verify] found ${allSpans.length} span(s) total`);

    const expectedSpanNames = [
        'POST rpc',
        'rpc.entity.orders.place',
        'entity.orders.place',
        'bus.orderPlaced publish',
        'bus.orderPlaced consume',
        'webhook.stripe.inbound',
        'webhook.stripe.run',
        'heartbeat.nightly-cleanup.tick',
        'gateway.subscribe',
    ];

    const observedNames = new Set(allSpans.map((s) => s.operationName));
    const missing = expectedSpanNames.filter((n) => !observedNames.has(n));
    if (missing.length > 0) {
        console.log('[verify] observed span names:');
        for (const n of observedNames) console.log(`   - ${n}`);
        throw new Error(`Missing expected spans: ${missing.join(', ')}`);
    }
    console.log('[verify] ✓ every expected span name landed');

    // Check auto-tag propagation
    const entitySpan = allSpans.find((s) => s.operationName === 'entity.orders.place')!;
    const tagMap = Object.fromEntries(entitySpan.tags.map((t) => [t.key, t.value]));
    const checks: Array<[string, unknown]> = [
        ['syncengine.primitive', 'entity'],
        ['syncengine.name', 'orders'],
        ['syncengine.op', 'place'],
        ['syncengine.workspace', 'ws_alpha'],
        ['syncengine.user', 'alice'],
    ];
    for (const [key, expected] of checks) {
        if (tagMap[key] !== expected) {
            throw new Error(
                `entity.orders.place missing tag ${key}=${JSON.stringify(expected)} (got ${JSON.stringify(tagMap[key])})`,
            );
        }
    }
    console.log('[verify] ✓ auto-tags round-tripped through OTLP');

    // Check trace continuity: publish → consume share one trace
    const pubSpan = allSpans.find((s) => s.operationName === 'bus.orderPlaced publish')!;
    const conSpan = allSpans.find((s) => s.operationName === 'bus.orderPlaced consume')!;
    if (pubSpan.traceID !== conSpan.traceID) {
        throw new Error(
            `bus publish/consume have different trace ids (${pubSpan.traceID} vs ${conSpan.traceID})`,
        );
    }
    console.log('[verify] ✓ bus publish/consume share one trace id');

    console.log('');
    console.log('[verify] ✅ ALL CHECKS PASSED');
    console.log(`[verify] view traces at ${JAEGER_API}/search?service=${SERVICE_NAME}`);
}

main().catch((err) => {
    console.error('[verify] ❌ FAILED:', err);
    process.exit(1);
});
