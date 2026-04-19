// Phase C, Task C5 — instrument.webhookInbound + webhookRun.
//
// Webhooks have a distinctive two-step observability story:
//   1. Inbound HTTP layer: verify signature, resolve workspace, decide
//      whether the idempotency key is a retry Restate already finished
//      (dedup.hit=true) or a new invocation (dedup.hit absent / false).
//   2. Run layer: inside the compiled Restate workflow, the user's
//      handler executes with access to the payload.
//
// These tests cover both helpers in isolation plus the dedup marker
// helpers that webhook-http calls at the two points it knows dedup
// info (after fetch returns 409 and after resolveWorkspace succeeds).

import { afterEach, describe, expect, it } from 'bun:test';
import { SpanKind } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';

import { bootSdk, type SdkHandle } from '../sdk';
import { instrument } from '../internal';
import {
    ATTR_DEDUP_HIT,
    ATTR_INVOCATION,
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
        config: { exporter: 'otlp', serviceName: 'webhook-test' },
        traceExporterOverride: exporter,
    });
    teardown.push(handle);
    return handle;
}

describe('instrument.webhookInbound', () => {
    it('opens a SERVER span named webhook.<name>.inbound with primitive+name attrs', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        await instrument.webhookInbound(
            { name: 'githubPush' },
            async () => undefined,
        );

        await handle.forceFlush();
        const span = exporter.getFinishedSpans()[0]!;
        expect(span.kind).toBe(SpanKind.SERVER);
        expect(span.name).toBe('webhook.githubPush.inbound');
        expect(span.attributes[ATTR_PRIMITIVE]).toBe('webhook');
        expect(span.attributes[ATTR_NAME]).toBe('githubPush');
    });

    it('includes workspace when provided upfront', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        await instrument.webhookInbound(
            { name: 'stripe', workspace: 'ws_ecom' },
            async () => undefined,
        );

        await handle.forceFlush();
        const span = exporter.getFinishedSpans()[0]!;
        expect(span.attributes[ATTR_WORKSPACE]).toBe('ws_ecom');
    });

    it('markWebhookWorkspace + markWebhookDedup stamp attrs on the active span', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        await instrument.webhookInbound(
            { name: 'stripe' },
            async () => {
                // Simulating the middle of dispatchWebhook: workspace is
                // derived from payload, dedup is detected from Restate's
                // 409 response.
                instrument.markWebhookWorkspace('ws_late');
                instrument.markWebhookDedup();
            },
        );

        await handle.forceFlush();
        const span = exporter.getFinishedSpans()[0]!;
        expect(span.attributes[ATTR_WORKSPACE]).toBe('ws_late');
        expect(span.attributes[ATTR_DEDUP_HIT]).toBe(true);
    });

    it('markWebhookDedup outside an active span is a silent no-op', () => {
        // Deliberately not inside webhookInbound — happens in tests that
        // simulate the dispatch without the full SDK wrap.
        expect(() => instrument.markWebhookDedup()).not.toThrow();
        expect(() => instrument.markWebhookWorkspace('ws')).not.toThrow();
    });
});

describe('instrument.webhookRun', () => {
    it('opens a span with invocation key, workspace, primitive=webhook', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        await instrument.webhookRun(
            { name: 'stripe', workspace: 'ws', idempotencyKey: 'evt_123' },
            async () => undefined,
        );

        await handle.forceFlush();
        const span = exporter.getFinishedSpans()[0]!;
        expect(span.name).toBe('webhook.stripe.run');
        expect(span.attributes[ATTR_PRIMITIVE]).toBe('webhook');
        expect(span.attributes[ATTR_NAME]).toBe('stripe');
        expect(span.attributes[ATTR_WORKSPACE]).toBe('ws');
        expect(span.attributes[ATTR_INVOCATION]).toBe('evt_123');
    });

    it('nests under a parent context extracted via withRemoteParent', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        // Capture a traceparent from an upstream inbound span.
        let carrier: Record<string, string> = {};
        await instrument.webhookInbound(
            { name: 'stripe' },
            async () => {
                await instrument.busPublish(
                    { busName: 'x', workspace: 'ws' },
                    async (c) => { carrier = { ...c }; },
                );
            },
        );

        // Now on the "Restate side" — withRemoteParent extracts the
        // traceparent out of input.headers, webhookRun nests under it.
        const headers = new Map([['traceparent', carrier['traceparent']!]]);
        await instrument.withRemoteParent(headers, async () => {
            await instrument.webhookRun(
                { name: 'stripe', workspace: 'ws', idempotencyKey: 'k1' },
                async () => undefined,
            );
        });

        await handle.forceFlush();
        const spans = exporter.getFinishedSpans();
        const inbound = spans.find((s) => s.name === 'webhook.stripe.inbound')!;
        const run = spans.find((s) => s.name === 'webhook.stripe.run')!;
        expect(run.spanContext().traceId).toBe(inbound.spanContext().traceId);
    });
});

describe('disabled-path', () => {
    it('webhookInbound + markers + webhookRun all pass through when SDK is off', async () => {
        const result = await instrument.webhookInbound(
            { name: 'x' },
            async () => {
                instrument.markWebhookWorkspace('ws');
                instrument.markWebhookDedup();
                return instrument.webhookRun(
                    { name: 'x', workspace: 'ws', idempotencyKey: 'k' },
                    async () => 42,
                );
            },
        );
        expect(result).toBe(42);
    });
});
