// Phase A, Task A1 — scaffolding verification.
//
// These tests don't exercise the OTel SDK (that's A2); they verify the
// package exports its public surface and that the attribute namespace is
// closed. If a seam helper in a later phase wants to tag a span with a
// new syncengine.* attribute, it MUST go through the semantic constants
// module — not a string literal at the call site. These tests guard that.

import { describe, it, expect } from 'bun:test';

import {
    ATTR_WORKSPACE,
    ATTR_USER,
    ATTR_PRIMITIVE,
    ATTR_NAME,
    ATTR_OP,
    ATTR_TOPIC,
    ATTR_INVOCATION,
    ATTR_DEDUP_HIT,
} from '../semantic.ts';
import type { Primitive } from '../semantic.ts';
import { noopCtx, noopMetric } from '../noop.ts';
import * as pkg from '../index.ts';

describe('semantic constants', () => {
    it('use the syncengine.* attribute namespace exclusively', () => {
        const all = [
            ATTR_WORKSPACE,
            ATTR_USER,
            ATTR_PRIMITIVE,
            ATTR_NAME,
            ATTR_OP,
            ATTR_TOPIC,
            ATTR_INVOCATION,
            ATTR_DEDUP_HIT,
        ];
        for (const k of all) {
            expect(k.startsWith('syncengine.')).toBe(true);
        }
    });

    it('are unique', () => {
        const all = [
            ATTR_WORKSPACE,
            ATTR_USER,
            ATTR_PRIMITIVE,
            ATTR_NAME,
            ATTR_OP,
            ATTR_TOPIC,
            ATTR_INVOCATION,
            ATTR_DEDUP_HIT,
        ];
        expect(new Set(all).size).toBe(all.length);
    });

    it('bind the expected string values for cross-package consumers', () => {
        // Spec: "Attribute conventions" table. Changing any of these is a
        // breaking change for anyone consuming exported spans.
        expect(ATTR_WORKSPACE).toBe('syncengine.workspace');
        expect(ATTR_USER).toBe('syncengine.user');
        expect(ATTR_PRIMITIVE).toBe('syncengine.primitive');
        expect(ATTR_NAME).toBe('syncengine.name');
        expect(ATTR_OP).toBe('syncengine.op');
        expect(ATTR_TOPIC).toBe('syncengine.topic');
        expect(ATTR_INVOCATION).toBe('syncengine.invocation');
        expect(ATTR_DEDUP_HIT).toBe('syncengine.dedup.hit');
    });

    it('Primitive union covers every seam kind called out in the spec', () => {
        // Compile-time assertion: if this array compiles, the union
        // contains at least these members. The runtime check is a
        // smoke test against typos in the union itself.
        const primitives: Primitive[] = [
            'entity',
            'topic',
            'workflow',
            'webhook',
            'heartbeat',
            'gateway',
            'bus',
            'http',
        ];
        expect(primitives).toHaveLength(8);
    });
});

describe('noopCtx', () => {
    it('runs span callbacks and returns their value', async () => {
        const ctx = noopCtx();
        const result = await ctx.span('anything', () => 42);
        expect(result).toBe(42);
    });

    it('propagates async span results', async () => {
        const ctx = noopCtx();
        const result = await ctx.span('async', async () => 'ok');
        expect(result).toBe('ok');
    });

    it('rethrows errors thrown inside a span without swallowing', async () => {
        const ctx = noopCtx();
        await expect(
            ctx.span('boom', () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');
    });

    it('accepts metric and mark calls without throwing', () => {
        const ctx = noopCtx();
        expect(() => ctx.metric('latency', 12)).not.toThrow();
        expect(() => ctx.mark('arrived', { at: 'entry' })).not.toThrow();
    });
});

describe('noopMetric factories', () => {
    it('produce handles with the expected shapes', () => {
        const counter = noopMetric.counter('orders.placed');
        const histogram = noopMetric.histogram('order.latency', { unit: 'ms' });
        const gauge = noopMetric.gauge('cart.active');

        // Shape guard — handles match the declared API so call sites
        // written against the real factory in D1 compile cleanly here.
        expect(typeof counter.add).toBe('function');
        expect(typeof histogram.observe).toBe('function');
        expect(typeof gauge.record).toBe('function');

        expect(() => counter.add(1, { reason: 'ok' })).not.toThrow();
        expect(() => histogram.observe(5)).not.toThrow();
        expect(() => gauge.record(42)).not.toThrow();
    });
});

describe('package index', () => {
    it('re-exports the metric factory and semantic constants', () => {
        expect(typeof pkg.metric.counter).toBe('function');
        expect(typeof pkg.metric.histogram).toBe('function');
        expect(typeof pkg.metric.gauge).toBe('function');
        expect(pkg.ATTR_WORKSPACE).toBe('syncengine.workspace');
    });
});
