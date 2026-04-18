// ── BusTestHarness — in-process bus capture + subscriber dispatch ─────────
//
// Thin capture wrapper around `InMemoryBusDriver` (Phase 2b-C2 core logic,
// now shared with the production in-memory-bus path — see
// `packages/server/src/in-memory-bus.ts`).
//
// The harness adds:
//   - A publish ring buffer (`publishedOn` / `all` / `capturePublishEffects`)
//   - A mock `ctx()` suitable for imperative `bus.publish(ctx, payload)` in tests
//   - Installation of the `setBusPublisher` seam so `@syncengine/core`'s
//     publisher routes through the driver
//
// Everything else — `.where()` filtering, resolved `ctx.services`,
// `TerminalError` → `<bus>.dlq` routing, multi-subscriber fan-out — is the
// driver's job. That keeps the test harness and the production in-memory
// mode from drifting.

import {
    setBusPublisher,
    extractPublishes,
    type BusRef,
    type BusPublishCtx,
    type AnyService,
    type AnyServiceOverride,
} from '@syncengine/core';
import { InMemoryBusDriver, type DispatchEntry, type DriverWorkflowDef } from '../in-memory-bus.js';

export interface BusCaptureEntry<T = unknown> {
    readonly bus: string;
    readonly payload: T;
    readonly at: number;
}

/** Re-exported under the harness's legacy name so existing tests keep
 *  working; same shape as the driver's `DispatchEntry`. */
export type SubscriberDispatchEntry<T = unknown> = DispatchEntry<T>;

/** Re-exported for callers that type their workflow arrays against the
 *  harness signature directly. */
export type HarnessWorkflowDef = DriverWorkflowDef;

export interface BusTestHarnessOptions {
    /** Subscriber workflows eligible for inline dispatch. Filtered by
     *  `$subscription.bus.$name` and `.where()` predicate. Non-subscriber
     *  workflows are ignored (so users can pass the unified `workflows`
     *  array from their app). */
    readonly workflows?: readonly HarnessWorkflowDef[];
    /** Service definitions injected on `ctx.services` for dispatched
     *  subscriber handlers. */
    readonly services?: readonly AnyService[];
    /** Test-time service overrides — same shape as
     *  `SyncengineConfig.services.overrides` at production boot. */
    readonly serviceOverrides?: readonly AnyServiceOverride[];
}

export interface BusTestHarness {
    publishedOn<T>(bus: BusRef<T>): readonly T[];
    all(): readonly BusCaptureEntry[];
    clear(): void;
    dispose(): void;
    dispatchedFor(workflow: HarnessWorkflowDef | string): readonly SubscriberDispatchEntry[];
    capturePublishEffects(state: unknown): readonly BusCaptureEntry[];
    driveEffects(state: unknown): Promise<void>;
    ctx(): BusPublishCtx;
}

export function createBusTestHarness(opts: BusTestHarnessOptions = {}): BusTestHarness {
    const buffer: BusCaptureEntry[] = [];
    const driver = new InMemoryBusDriver({
        workflows: opts.workflows,
        services: opts.services,
        serviceOverrides: opts.serviceOverrides,
    });

    setBusPublisher(async (publishCtx, busName, payload) => {
        buffer.push({ bus: busName, payload, at: Date.now() });
        await driver.fanOut(busName, payload, publishCtx);
    });

    const harness: BusTestHarness = {
        publishedOn<T>(bus: BusRef<T>): readonly T[] {
            const out: T[] = [];
            for (const e of buffer) if (e.bus === bus.$name) out.push(e.payload as T);
            return out;
        },
        all: () => buffer.slice(),
        clear: () => {
            buffer.length = 0;
            driver.clearDispatched();
        },
        dispose: () => setBusPublisher(null),
        dispatchedFor: (wf) => driver.dispatchedFor(wf),
        capturePublishEffects: (state) => {
            const effects = extractPublishes(state as never) ?? [];
            const now = Date.now();
            return effects.map((e) => ({
                bus: e.bus.$name,
                payload: e.payload,
                at: now,
            }));
        },
        driveEffects: async (state) => {
            // Effects carry a minimal bus proxy (no .publish method). Route
            // directly through the harness buffer + driver fan-out instead;
            // payloads were already validated at `publish()` effect-declaration
            // time, so no re-check needed here.
            const effects = extractPublishes(state as never) ?? [];
            const ctx = harness.ctx();
            for (const e of effects) {
                buffer.push({ bus: e.bus.$name, payload: e.payload, at: Date.now() });
                await driver.fanOut(e.bus.$name, e.payload, ctx);
            }
        },
        ctx: () => ({
            async run<R>(_name: string, fn: () => Promise<R>): Promise<R> {
                return fn();
            },
        }),
    };

    return harness;
}
