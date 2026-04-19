/**
 * `BusManager` — owns the lifecycle of every `BusDispatcher` across
 * every `(workspace × subscriber)` pair.
 *
 * The dispatcher class itself lives in `@syncengine/gateway-core` and
 * is transport-agnostic; this manager is the `@syncengine/server`
 * piece that knows which workflows are subscribers and when
 * workspaces exist.
 *
 * Spawn triggers:
 *   1. At boot — seed from `initialWorkspaceIds` (test helper) or
 *      from an attached NATS connection's JetStream stream list.
 *   2. On workspace provision — `onWorkspaceProvisioned(wsId)` is
 *      called from the NATS `syncengine.workspaces` subscription the
 *      server already publishes into from the workspace virtual
 *      object's provision handler.
 *
 * Failure isolation:
 *   `spawnFor(ws)` runs every dispatcher's `start()` in parallel via
 *   `Promise.allSettled`. One failed start is logged and the handle
 *   is dropped; remaining subscribers come up normally. A later
 *   `spawnFor` call retries just the dropped pairs.
 *
 * Shutdown:
 *   `installSignalHandlers: true` (default) registers SIGTERM/SIGINT
 *   → `stop()` for single-process `syncengine start`. The scale-out
 *   serve binary passes `false` because its shared shutdown
 *   controller owns the signals; it invokes `stop()` itself.
 */

import type { BusDispatcherConfig } from '@syncengine/gateway-core';
import {
    Retry, seconds, minutes,
    type RetryConfig,
} from '@syncengine/core';
import { isBusSubscriberWorkflow, type WorkflowDef } from './workflow.js';

/** Handle produced by the dispatcher factory. Matches the contract
 *  `@syncengine/gateway-core`'s `BusDispatcher` implements. */
export interface DispatcherHandle {
    start(): Promise<void>;
    stop(): Promise<void>;
}

/** Factory plugs a concrete dispatcher (real `BusDispatcher` in prod,
 *  a stub in unit tests). Config shape is imported from gateway-core —
 *  single source of truth, no drift. */
export type DispatcherFactory = (cfg: BusDispatcherConfig) => DispatcherHandle;

export interface BusManagerConfig {
    readonly natsUrl: string;
    readonly restateUrl: string;
    readonly workflows: readonly WorkflowDef[];
    readonly dispatcherFactory: DispatcherFactory;
    readonly initialWorkspaceIds?: readonly string[];
    /** Fallback retry when a subscriber didn't declare one on its
     *  `WorkflowDef`. See `WorkflowOptions.retry`. */
    readonly defaultRetry?: RetryConfig;
    /** Install process-level SIGTERM/SIGINT hooks that drain via
     *  `stop()`. `true` for single-process `syncengine start`;
     *  `false` when the caller owns shutdown already (scale-out
     *  serve binary uses the shared shutdown controller). */
    readonly installSignalHandlers?: boolean;
}

const DEFAULT_RETRY: RetryConfig = Retry.exponential({
    attempts: 3,
    initial: seconds(1),
    max: minutes(1),
});

type SubscriberWorkflow = WorkflowDef & {
    $subscription: NonNullable<WorkflowDef['$subscription']>;
};

export class BusManager {
    private readonly handles = new Map<string, DispatcherHandle>();
    private readonly config: BusManagerConfig;
    private readonly subscribers: readonly SubscriberWorkflow[];
    private signalHandlersInstalled = false;
    private stopping = false;

    constructor(config: BusManagerConfig) {
        this.config = config;
        this.subscribers = config.workflows.filter(
            isBusSubscriberWorkflow,
        ) as SubscriberWorkflow[];
        if (config.installSignalHandlers ?? true) this.installSignalHandlers();
    }

    async start(): Promise<void> {
        const seed = this.config.initialWorkspaceIds ?? [];
        await Promise.all(seed.map((wsId) => this.spawnFor(wsId)));
    }

    async onWorkspaceProvisioned(workspaceId: string): Promise<void> {
        await this.spawnFor(workspaceId);
    }

    async stop(): Promise<void> {
        this.stopping = true;
        const pending = Array.from(this.handles.values()).map((h) =>
            h.stop().catch(() => {
                /* best effort drain — a dispatcher that can't stop
                 * cleanly shouldn't block the others. */
            }),
        );
        this.handles.clear();
        await Promise.all(pending);
    }

    /** Test seam — observe currently-live dispatcher keys. */
    get activeDispatcherKeys(): readonly string[] {
        return Array.from(this.handles.keys());
    }

    /** Spawn every missing (workspace × subscriber) dispatcher for
     *  the given workspace. Spawns run in parallel; one failure does
     *  not block others. Already-active pairs are skipped. */
    private async spawnFor(workspaceId: string): Promise<void> {
        if (this.stopping) return;
        const pending: Promise<void>[] = [];
        for (const sub of this.subscribers) {
            const key = dispatcherKey(workspaceId, sub.$name);
            if (this.handles.has(key)) continue;
            pending.push(this.spawnOne(workspaceId, sub, key));
        }
        await Promise.allSettled(pending);
    }

    private async spawnOne(
        workspaceId: string,
        sub: SubscriberWorkflow,
        key: string,
    ): Promise<void> {
        const busName = sub.$subscription.bus.$name;
        const cfg: BusDispatcherConfig = {
            natsUrl: this.config.natsUrl,
            restateUrl: this.config.restateUrl,
            workspaceId,
            subscriberName: sub.$name,
            busName,
            dlqBusName: `${busName}.dlq`,
            ...(sub.$subscription.predicate
                ? { filterPredicate: sub.$subscription.predicate as (event: unknown) => boolean }
                : {}),
            cursor: sub.$subscription.cursor ?? { kind: 'latest' },
            // `$retry` lands on WorkflowDef in Task A4; until then, the
            // cast keeps A1 compile-clean without forcing a schema
            // change into the wrong task.
            retry: (sub as SubscriberWorkflow & { $retry?: RetryConfig }).$retry
                ?? this.config.defaultRetry
                ?? DEFAULT_RETRY,
        };
        const handle = this.config.dispatcherFactory(cfg);
        this.handles.set(key, handle);
        try {
            await handle.start();
        } catch (err) {
            this.handles.delete(key);
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(
                `[bus-manager] dispatcher for ${sub.$name} on workspace ${workspaceId} failed to start: ${msg}. ` +
                `Other subscribers remain active; the pair will retry on next spawnFor().`,
            );
        }
    }

    private installSignalHandlers(): void {
        if (this.signalHandlersInstalled) return;
        this.signalHandlersInstalled = true;
        const handler = async (signal: NodeJS.Signals) => {
            console.log(`[bus-manager] ${signal} received; draining dispatchers`);
            await this.stop();
        };
        process.once('SIGTERM', handler);
        process.once('SIGINT', handler);
    }
}

function dispatcherKey(workspaceId: string, subscriberName: string): string {
    return `${workspaceId}::${subscriberName}`;
}
