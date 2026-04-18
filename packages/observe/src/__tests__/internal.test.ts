// Phase B, Task B1 — instrument.entityEffect.
//
// These tests drive the first seam helper end-to-end: a real SDK
// boots with an InMemorySpanExporter, the helper produces a span
// with the right name and auto-tags, and the exception path records
// the error + sets status before rethrowing. The disabled-path
// verification lives here too because the helper MUST be safe to
// call when no SDK has been booted — other packages call through
// unconditionally.

import { afterEach, describe, expect, it } from 'bun:test';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { SpanStatusCode } from '@opentelemetry/api';

import { bootSdk, type SdkHandle } from '../sdk.ts';
import { instrument } from '../internal.ts';
import {
    ATTR_NAME,
    ATTR_OP,
    ATTR_PRIMITIVE,
    ATTR_USER,
    ATTR_WORKSPACE,
} from '../semantic.ts';

const teardown: SdkHandle[] = [];
afterEach(async () => {
    while (teardown.length > 0) {
        await teardown.shift()!.shutdown();
    }
});

async function bootWith(exporter: InMemorySpanExporter): Promise<SdkHandle> {
    const handle = await bootSdk({
        config: { exporter: 'otlp', serviceName: 'entity-effect-test' },
        traceExporterOverride: exporter,
    });
    teardown.push(handle);
    return handle;
}

describe('instrument.entityEffect — happy path', () => {
    it('names the span entity.<name>.<op> and tags all auto-attrs', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        const result = await instrument.entityEffect(
            { workspace: 'ws_alpha', user: 'user_42', name: 'todos', op: 'add' },
            async () => 'value',
        );

        expect(result).toBe('value');

        await handle.forceFlush();
        const spans = exporter.getFinishedSpans();
        expect(spans).toHaveLength(1);
        const span = spans[0]!;
        expect(span.name).toBe('entity.todos.add');
        expect(span.attributes[ATTR_PRIMITIVE]).toBe('entity');
        expect(span.attributes[ATTR_NAME]).toBe('todos');
        expect(span.attributes[ATTR_OP]).toBe('add');
        expect(span.attributes[ATTR_WORKSPACE]).toBe('ws_alpha');
        expect(span.attributes[ATTR_USER]).toBe('user_42');
    });

    it('omits ATTR_USER when user is not provided (common for server-to-server effects)', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        await instrument.entityEffect(
            { workspace: 'ws_alpha', name: 'todos', op: 'reset' },
            async () => undefined,
        );

        await handle.forceFlush();
        const span = exporter.getFinishedSpans()[0]!;
        expect(span.attributes[ATTR_WORKSPACE]).toBe('ws_alpha');
        expect(span.attributes[ATTR_USER]).toBeUndefined();
    });

    it('propagates the effect return value (sync)', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        const result = await instrument.entityEffect(
            { workspace: 'ws', name: 'counter', op: 'inc' },
            () => 42,
        );

        expect(result).toBe(42);
        await handle.forceFlush();
        expect(exporter.getFinishedSpans()).toHaveLength(1);
    });
});

describe('instrument.entityEffect — exception path', () => {
    it('records the exception, sets status ERROR, and rethrows', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        const err = new Error('handler blew up');

        await expect(
            instrument.entityEffect(
                { workspace: 'ws', name: 'cart', op: 'pay' },
                async () => {
                    throw err;
                },
            ),
        ).rejects.toThrow('handler blew up');

        await handle.forceFlush();
        const span = exporter.getFinishedSpans()[0]!;
        expect(span.status.code).toBe(SpanStatusCode.ERROR);
        // The exception is recorded as a span event named 'exception'.
        const exEvent = span.events.find((e) => e.name === 'exception');
        expect(exEvent).toBeDefined();
        expect(exEvent!.attributes?.['exception.message']).toBe('handler blew up');
    });

    it('still ends the span on throw (no span leak)', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        try {
            await instrument.entityEffect(
                { workspace: 'ws', name: 'x', op: 'y' },
                () => {
                    throw new Error('boom');
                },
            );
        } catch {
            // expected
        }

        await handle.forceFlush();
        const spans = exporter.getFinishedSpans();
        expect(spans).toHaveLength(1);
        expect(spans[0]!.endTime).toBeDefined();
    });
});

describe('instrument.entityEffect — disabled-path pass-through', () => {
    it('is a pass-through when no SDK is booted (framework may call it unconditionally)', async () => {
        // No bootSdk call — global tracer is the API-level noop.
        const result = await instrument.entityEffect(
            { workspace: 'ws', name: 'anything', op: 'anything' },
            async () => 'still works',
        );
        expect(result).toBe('still works');
    });

    it('rethrows exceptions on the disabled path too', async () => {
        await expect(
            instrument.entityEffect(
                { workspace: 'ws', name: 'x', op: 'y' },
                () => {
                    throw new Error('disabled but still throws');
                },
            ),
        ).rejects.toThrow('disabled but still throws');
    });
});
