// ── InMemoryBusDriver — in-process bus routing, shared across
// ──                    harness + production in-memory buses
//
// Originally lived inside `test/bus-harness.ts` as private helpers.
// Extracted so production code can route in-memory-mode buses through
// the same dispatch logic the vitest harness uses, without either
// side drifting.
//
// Responsibilities:
//   1. Register subscriber workflows keyed by bus name.
//   2. Dispatch a publish synchronously through every matching
//      subscriber, with `.where()` filter, resolved `ctx.services`,
//      and `TerminalError` → `<bus>.dlq` routing.
//
// What this driver deliberately skips:
//   - JetStream durability / redelivery (the test + in-memory cases
//     don't have a broker to begin with).
//   - Retry schedules. Every invocation is a single attempt; if the
//     subscriber throws a non-TerminalError, the caller sees it.
//   - Restate invocation journaling.
//
// The caller (harness wrapper or production bootstrap) supplies the
// `ctx` builder — that's where mock-ctx vs real-Restate-ctx semantics
// diverge. Keep this driver agnostic.

import { TerminalError } from '@restatedev/restate-sdk';
import type {
    AnyService,
    AnyServiceOverride,
    BusPublishCtx,
} from '@syncengine/core';
import type { WorkflowDef } from './workflow.js';
import { isBusSubscriberWorkflow } from './workflow.js';
import { ServiceContainer } from './service-container.js';

export interface DispatchEntry<T = unknown> {
    readonly workflow: string;
    readonly bus: string;
    readonly payload: T;
    readonly at: number;
    readonly outcome: 'ok' | 'terminal-error';
    readonly error?: { message: string; code?: string };
}

/** `WorkflowDef`'s `TInput` parameter is contravariant on `$handler`;
 *  same `any` widening as `HarnessWorkflowDef` for the same reason
 *  (the driver only ever calls the handler with its own captured
 *  input, so array-level payload precision doesn't matter). */
export type DriverWorkflowDef = WorkflowDef<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface InMemoryBusDriverOptions {
    readonly workflows?: readonly DriverWorkflowDef[];
    readonly services?: readonly AnyService[];
    readonly serviceOverrides?: readonly AnyServiceOverride[];
    /** Build the ctx handed to the subscriber handler. Default yields a
     *  test-shaped ctx (services + key + run + date); production callers
     *  override to inject a Restate-like ctx if they need it. The default
     *  suits both the test harness and an in-memory production bus — the
     *  production case just happens to use the same shape because the
     *  alternative (a full Restate ctx with no JetStream backing) would
     *  be a lie anyway. */
    readonly buildCtx?: (wf: DriverWorkflowDef) => Record<string, unknown>;
}

export class InMemoryBusDriver {
    private readonly subscribers: readonly DriverWorkflowDef[];
    private readonly servicesByWorkflow = new Map<string, Record<string, unknown>>();
    private readonly buildCtxFn: (wf: DriverWorkflowDef) => Record<string, unknown>;
    /** Appended to on every dispatch; callers may expose this (the test
     *  harness) or discard (production). The array is mutated in place. */
    readonly dispatched: DispatchEntry[] = [];

    constructor(opts: InMemoryBusDriverOptions = {}) {
        const container = new ServiceContainer(
            opts.services ?? [],
            opts.serviceOverrides ?? [],
        );
        this.subscribers = (opts.workflows ?? []).filter(isBusSubscriberWorkflow);
        for (const wf of this.subscribers) {
            this.servicesByWorkflow.set(
                wf.$name,
                container.resolveAll(wf.$services) as Record<string, unknown>,
            );
        }
        this.buildCtxFn = opts.buildCtx ?? ((wf) => this.defaultBuildCtx(wf));
    }

    /** Fan a single publish out to every matching subscriber. Runs
     *  synchronously; resolves when all subscribers have either
     *  completed, routed a DeadEvent, or (for non-terminal errors)
     *  re-thrown. `publishCtx` is the ctx the caller invoked
     *  `bus.publish(ctx, ...)` with — used for DLQ republishes so the
     *  chain stays inside the same logical transaction. */
    async fanOut(
        busName: string,
        payload: unknown,
        publishCtx: BusPublishCtx,
    ): Promise<void> {
        for (const wf of this.subscribers) {
            // `this.subscribers` is pre-filtered by `isBusSubscriberWorkflow`
            // in the constructor, so `$subscription` is always defined —
            // the cast here makes that explicit for TS's narrowing. Skip
            // cheaply if the contract ever drifts.
            const sub = wf.$subscription;
            if (!sub) continue;
            if (sub.bus.$name !== busName) continue;
            if (sub.predicate && !sub.predicate(payload as never)) continue;

            const at = Date.now();
            const ctx = this.buildCtxFn(wf);
            try {
                await wf.$handler(ctx as never, payload as never);
                this.dispatched.push({
                    workflow: wf.$name,
                    bus: busName,
                    payload,
                    at,
                    outcome: 'ok',
                });
            } catch (err) {
                if (err instanceof TerminalError) {
                    this.dispatched.push({
                        workflow: wf.$name,
                        bus: busName,
                        payload,
                        at,
                        outcome: 'terminal-error',
                        error: { message: err.message },
                    });
                    await sub.bus.dlq.publish(publishCtx, {
                        original: payload,
                        error: { message: err.message },
                        attempts: 1,
                        firstAttemptAt: at,
                        lastAttemptAt: at,
                        workflow: wf.$name,
                    });
                } else {
                    throw err;
                }
            }
        }
    }

    clearDispatched(): void {
        this.dispatched.length = 0;
    }

    /** Lookup helper — filters `dispatched` by workflow name (or ref). */
    dispatchedFor(workflow: DriverWorkflowDef | string): readonly DispatchEntry[] {
        const name = typeof workflow === 'string' ? workflow : workflow.$name;
        return this.dispatched.filter((e) => e.workflow === name);
    }

    private defaultBuildCtx(wf: DriverWorkflowDef): Record<string, unknown> {
        const services = this.servicesByWorkflow.get(wf.$name) ?? {};
        return {
            services,
            key: `in-memory/${wf.$name}`,
            run: async <R,>(_name: string, fn: () => Promise<R>) => fn(),
            date: { now: () => Date.now() },
            objectClient: (_opts: unknown, _key: string) => {
                throw new Error(
                    `in-memory bus: objectClient / entityRef isn't supported on in-memory-mode buses. ` +
                    `Either flip the bus to NATS mode, or use service overrides to stub entity calls.`,
                );
            },
        };
    }
}
