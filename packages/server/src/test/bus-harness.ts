// ── BusTestHarness — in-process bus capture + subscriber dispatch ─────────
//
// Slice 2b-C2: layers synchronous subscriber dispatch on top of the
// 2b-C1 capturing publisher. The harness now acts as a miniature bus
// runtime:
//
//   1. Imperative `bus.publish(ctx, payload)` goes through the core
//      publisher seam into an in-process buffer.
//   2. If the caller passed subscriber workflows to the harness,
//      matching subscribers (by bus name + `.where()` predicate) fire
//      inline with a mock ctx that carries a resolved `services` bag.
//   3. A subscriber that throws `TerminalError` produces a `DeadEvent`
//      on `<bus>.dlq`, which itself fires any DLQ subscribers — same
//      contract as the production BusDispatcher + classifier.
//
// The harness deliberately skips:
//   - JetStream durability / redelivery
//   - Retry schedules (every call is one attempt)
//   - Restate invocation journaling
//
// For tests, those give false confidence: you end up asserting on
// framework internals rather than your domain logic. Treat the harness
// as the driven side of the hex boundary — it's the test adapter.

import { TerminalError } from '@restatedev/restate-sdk';
import {
    setBusPublisher,
    extractPublishes,
    type BusRef,
    type BusPublishCtx,
    type AnyService,
    type AnyServiceOverride,
} from '@syncengine/core';
import type { WorkflowDef } from '../workflow.js';
import { isBusSubscriberWorkflow } from '../workflow.js';
import { ServiceContainer } from '../service-container.js';

export interface BusCaptureEntry<T = unknown> {
    readonly bus: string;
    readonly payload: T;
    readonly at: number;
}

export interface SubscriberDispatchEntry<T = unknown> {
    readonly workflow: string;
    readonly bus: string;
    readonly payload: T;
    readonly at: number;
    readonly outcome: 'ok' | 'terminal-error';
    readonly error?: { message: string; code?: string };
}

/** `WorkflowDef`'s `TInput` parameter is contravariant on `$handler`,
 *  so `WorkflowDef<'a', A>` isn't assignable to `WorkflowDef<string, unknown>`
 *  — the production code paths that accept workflow arrays use `any` for
 *  the payload too. Mirror that here; the harness only ever invokes the
 *  handler with its own captured input, so payload precision at the
 *  array level doesn't matter. */
export type HarnessWorkflowDef = WorkflowDef<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface BusTestHarnessOptions {
    /** Subscriber workflows eligible for inline dispatch. The harness
     *  filters by `$subscription.bus.$name` and runs `.where()` server-
     *  side, same as the production dispatcher. Non-subscriber workflows
     *  in the list are ignored without error (so users can pass the
     *  unified `workflows` array from their app). */
    readonly workflows?: readonly HarnessWorkflowDef[];
    /** Service definitions injected on `ctx.services` for the dispatched
     *  subscriber handler. Missing services throw the same error the
     *  production `ServiceContainer` would. */
    readonly services?: readonly AnyService[];
    /** Test-time overrides for services. Same shape as
     *  `SyncengineConfig.services.overrides` at production boot. */
    readonly serviceOverrides?: readonly AnyServiceOverride[];
}

export interface BusTestHarness {
    // ── Capture ────────────────────────────────────────────────────
    publishedOn<T>(bus: BusRef<T>): readonly T[];
    all(): readonly BusCaptureEntry[];
    clear(): void;
    dispose(): void;

    // ── Subscriber dispatch (2b-C2) ─────────────────────────────────
    /** Events the named subscriber workflow received, in arrival order.
     *  Includes both successful and TerminalError invocations; inspect
     *  `.outcome` to distinguish. */
    dispatchedFor(workflow: HarnessWorkflowDef | string): readonly SubscriberDispatchEntry[];

    // ── Declarative effect path (2b-C1) ─────────────────────────────
    capturePublishEffects(state: unknown): readonly BusCaptureEntry[];
    /** Drain the `publish()` effects off an entity handler's return and
     *  dispatch each through the publisher seam — so subscribers fire
     *  exactly as they would in production after entity-runtime
     *  resolves the handler. */
    driveEffects(state: unknown): Promise<void>;

    // ── Mock ctx helpers ────────────────────────────────────────────
    ctx(): BusPublishCtx;
}

export function createBusTestHarness(opts: BusTestHarnessOptions = {}): BusTestHarness {
    const buffer: BusCaptureEntry[] = [];
    const dispatched: SubscriberDispatchEntry[] = [];

    // Pre-resolve service bags once per subscriber. Matches the
    // production contract: services are bound at server boot, not per
    // invocation, so a replayed handler sees the same implementations.
    const container = new ServiceContainer(
        opts.services ?? [],
        opts.serviceOverrides ?? [],
    );

    const subscribers = (opts.workflows ?? []).filter(isBusSubscriberWorkflow);
    const resolvedServicesByWorkflow = new Map<string, Record<string, unknown>>();
    for (const wf of subscribers) {
        resolvedServicesByWorkflow.set(
            wf.$name,
            container.resolveAll(wf.$services) as Record<string, unknown>,
        );
    }

    // The publisher seam. Called synchronously from `bus.publish(ctx)`'s
    // ctx.run. We capture + fan-out to subscribers before returning, so
    // the awaiter sees a fully-settled world.
    setBusPublisher(async (publishCtx, busName, payload) => {
        buffer.push({ bus: busName, payload, at: Date.now() });
        await fanOutToSubscribers(busName, payload, publishCtx);
    });

    async function fanOutToSubscribers(
        busName: string,
        payload: unknown,
        publishCtx: BusPublishCtx,
    ): Promise<void> {
        for (const wf of subscribers) {
            const sub = wf.$subscription;
            if (sub.bus.$name !== busName) continue;
            if (sub.predicate && !sub.predicate(payload as never)) continue;

            const at = Date.now();
            const ctx = buildMockCtx(wf, payload, publishCtx);
            try {
                await wf.$handler(ctx as never, payload as never);
                dispatched.push({
                    workflow: wf.$name,
                    bus: busName,
                    payload,
                    at,
                    outcome: 'ok',
                });
            } catch (err) {
                if (err instanceof TerminalError) {
                    dispatched.push({
                        workflow: wf.$name,
                        bus: busName,
                        payload,
                        at,
                        outcome: 'terminal-error',
                        error: { message: err.message },
                    });
                    // Mirror the production DLQ contract: publish a
                    // DeadEvent on `<bus>.dlq`. That subject reaches
                    // any DLQ-subscribed workflow through the same
                    // publisher seam, so alertOnShippingFailure etc.
                    // fire in-harness too.
                    await sub.bus.dlq.publish(publishCtx, {
                        original: payload,
                        error: { message: err.message },
                        attempts: 1,
                        firstAttemptAt: at,
                        lastAttemptAt: at,
                        workflow: wf.$name,
                    });
                } else {
                    // Non-terminal error: surface to the test author.
                    // The production path would retry; the harness
                    // would swallow too much if it did the same.
                    throw err;
                }
            }
        }
    }

    function buildMockCtx(
        wf: WorkflowDef,
        _payload: unknown,
        _publishCtx: BusPublishCtx,
    ): Record<string, unknown> {
        const services = resolvedServicesByWorkflow.get(wf.$name) ?? {};
        return {
            services,
            key: `harness/${wf.$name}`,
            // `ctx.run(name, fn)` on Restate journals fn for replay —
            // in-harness we just invoke it. That matches the "one
            // attempt" mental model from the file header; replay
            // semantics are out of scope.
            run: async <R,>(_name: string, fn: () => Promise<R>) => fn(),
            // `ctx.date.now()` is the one non-trivial helper subscribers
            // sometimes touch (e.g. for timestamping republishes). Give
            // them a deterministic clock keyed on the harness wall time.
            date: { now: () => Date.now() },
            objectClient: (_opts: unknown, _key: string) => {
                throw new Error(
                    `bus-harness: objectClient / entityRef isn't modelled in this slice (2b-C2). ` +
                    `Write the subscriber test in isolation or stub entity calls via service overrides.`,
                );
            },
        };
    }

    const harness: BusTestHarness = {
        publishedOn<T>(bus: BusRef<T>): readonly T[] {
            const out: T[] = [];
            for (const e of buffer) if (e.bus === bus.$name) out.push(e.payload as T);
            return out;
        },
        all: () => buffer.slice(),
        clear: () => {
            buffer.length = 0;
            dispatched.length = 0;
        },
        dispose: () => setBusPublisher(null),

        dispatchedFor(wf) {
            const name = typeof wf === 'string' ? wf : wf.$name;
            return dispatched.filter((e) => e.workflow === name);
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
        driveEffects: async (state) => {
            // Effects carry a minimal bus proxy (no .publish method).
            // Route directly through the harness buffer + fan-out
            // instead; payloads were already validated at `publish()`
            // effect-declaration time, so no re-check needed here.
            const effects = extractPublishes(state as never) ?? [];
            const ctx = harness.ctx();
            for (const e of effects) {
                buffer.push({ bus: e.bus.$name, payload: e.payload, at: Date.now() });
                await fanOutToSubscribers(e.bus.$name, e.payload, ctx);
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
