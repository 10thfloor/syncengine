// ── BusTestHarness — in-process bus capture for vitest/jest ────────────────
//
// Slice 2b-C1 of the bus epic: swap the `@syncengine/core` publisher
// seam for an in-process buffer so tests can:
//
//   - assert "did this entity handler publish to `orderEvents`?" without
//     booting NATS.
//   - drive imperative `bus.publish(ctx, payload)` from a workflow body
//     against a mock ctx and inspect the captured events.
//   - extract declarative `publish()` effects from a pure entity handler
//     return value.
//
// Slice 2b-C2 layers synchronous subscriber dispatch on top (so
// `harness.dispatchedFor(shipOnPay)` is testable); 2b-C3 auto-selects
// the in-memory driver from declared `override()` files.
//
// This slice is intentionally small: no subscriber invocation, no DLQ
// replay, no retry semantics. It just captures. That covers the
// "I want to unit-test my entity's publish() effect" use case, which
// is the most common ask.

import { setBusPublisher, extractPublishes } from '@syncengine/core';
import type { BusRef, BusPublishCtx } from '@syncengine/core';

export interface BusCaptureEntry<T = unknown> {
    readonly bus: string;
    readonly payload: T;
    readonly at: number;
}

export interface BusTestHarness {
    /** Every event that reached the publisher seam for `bus`, oldest
     *  first. Typed on the bus's payload. */
    publishedOn<T>(bus: BusRef<T>): readonly T[];
    /** Every captured event across all buses, in arrival order. */
    all(): readonly BusCaptureEntry[];
    /** Drain the capture buffer. Use between `it()` blocks when the
     *  harness is shared at the `describe` level. */
    clear(): void;
    /** Restore the previous publisher (null if this harness installed
     *  the first one). Always call in `afterEach` / `afterAll` so a
     *  leaked installation doesn't bleed into the next file. */
    dispose(): void;
    /** Pull `publish()` effects off a pure entity handler return value.
     *  Entity handlers attach these via a Symbol key that extractPublishes
     *  reads; the harness surfaces them as capture entries for uniform
     *  assertions with the imperative path. */
    capturePublishEffects(state: unknown): readonly BusCaptureEntry[];
    /** Minimal ctx that drives imperative `bus.publish(ctx, payload)` in
     *  tests. `run(name, fn)` invokes fn synchronously (no journaling),
     *  matching Restate's semantics on a single replay. */
    ctx(): BusPublishCtx;
}

/**
 * Install a capturing bus publisher for the duration of the harness.
 * Overwrites any previously registered publisher — tests that need
 * the production publisher back should call `dispose()` (or install
 * their own after this).
 *
 * Thread safety: tests run serially per file in vitest's default mode.
 * Running multiple harnesses in parallel is not supported — the last
 * one to install wins.
 */
export function createBusTestHarness(): BusTestHarness {
    const buffer: BusCaptureEntry[] = [];

    setBusPublisher(async (_ctx, busName, payload) => {
        buffer.push({ bus: busName, payload, at: Date.now() });
    });

    const harness: BusTestHarness = {
        publishedOn<T>(bus: BusRef<T>): readonly T[] {
            const out: T[] = [];
            for (const e of buffer) {
                if (e.bus === bus.$name) out.push(e.payload as T);
            }
            return out;
        },
        all: () => buffer.slice(),
        clear: () => {
            buffer.length = 0;
        },
        dispose: () => {
            setBusPublisher(null);
        },
        capturePublishEffects: (state) => {
            const effects = extractPublishes(state as never) ?? [];
            const now = Date.now();
            return effects.map((e) => ({
                bus: e.bus.$name,
                payload: e.payload,
                at: now,
            }));
        },
        ctx: () => ({
            async run<R>(_name: string, fn: () => Promise<R>): Promise<R> {
                return fn();
            },
        }),
    };

    return harness;
}
