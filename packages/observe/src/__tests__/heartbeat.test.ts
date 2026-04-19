// Phase C, Task C6 — instrument.heartbeatTick.
//
// Heartbeats run a user handler on a scheduler loop. We span each tick
// (handler invocation) individually rather than the enclosing workflow
// so APM timings measure the handler body, not the sleep.

import { afterEach, describe, expect, it } from 'bun:test';
import { SpanStatusCode } from '@opentelemetry/api';
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
        config: { exporter: 'otlp', serviceName: 'heartbeat-test' },
        traceExporterOverride: exporter,
    });
    teardown.push(handle);
    return handle;
}

describe('instrument.heartbeatTick', () => {
    it('opens a span per tick with heartbeat.<name>.tick and run_number', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        for (let run = 1; run <= 3; run++) {
            await instrument.heartbeatTick(
                { name: 'pulse', workspace: 'ws', runNumber: run },
                async () => undefined,
            );
        }

        await handle.forceFlush();
        const spans = exporter.getFinishedSpans();
        expect(spans).toHaveLength(3);
        for (const [i, s] of spans.entries()) {
            expect(s.name).toBe('heartbeat.pulse.tick');
            expect(s.attributes[ATTR_PRIMITIVE]).toBe('heartbeat');
            expect(s.attributes[ATTR_NAME]).toBe('pulse');
            expect(s.attributes[ATTR_WORKSPACE]).toBe('ws');
            expect(s.attributes['syncengine.run_number']).toBe(i + 1);
        }
    });

    it('records exception + ERROR status on throw', async () => {
        const exporter = new InMemorySpanExporter();
        const handle = await bootWith(exporter);

        await expect(
            instrument.heartbeatTick(
                { name: 'pulse', workspace: 'ws', runNumber: 1 },
                async () => {
                    throw new Error('handler boom');
                },
            ),
        ).rejects.toThrow('handler boom');

        await handle.forceFlush();
        const span = exporter.getFinishedSpans()[0]!;
        expect(span.status.code).toBe(SpanStatusCode.ERROR);
    });

    it('disabled-path is a straight pass-through', async () => {
        const result = await instrument.heartbeatTick(
            { name: 'pulse', workspace: 'ws', runNumber: 1 },
            async () => 42,
        );
        expect(result).toBe(42);
    });
});
