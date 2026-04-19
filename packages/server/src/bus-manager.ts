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

import type { NatsConnection, Subscription } from '@nats-io/transport-node';
import { jetstream } from '@nats-io/jetstream';
import { BusDispatcher, type BusDispatcherConfig } from '@syncengine/gateway-core';

/** Minimal JSM slice the manager reads. Accepts a full
 *  `JetStreamManager` or a stub with just the `streams.list()` bit. */
interface JsmLike {
    readonly streams: {
        list(subject?: string): AsyncIterable<{ config: { name: string } }>;
    };
}
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
    private registrySub: Subscription | null = null;

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

    /**
     * Wire the manager to a live NATS connection. Performs an initial
     * JetStream `streams.list()` scan to seed dispatchers for every
     * existing `WS_*` stream, then subscribes to the
     * `syncengine.workspaces` topic to react to future workspace
     * provisions.
     *
     * Call after `start()` (so explicit `initialWorkspaceIds` seed
     * ahead) and after the server's Restate endpoint is listening (so
     * new dispatchers have a live POST target).
     *
     * `jsm` is injectable so unit tests can substitute a stub without
     * having to monkey-patch the `jetstream()` factory; prod callers
     * pass `undefined` and let the manager build it from the NC.
     */
    async attachToNats(
        nc: NatsConnection,
        jsm?: JsmLike,
    ): Promise<void> {
        // 1. Initial discovery from existing JetStream streams. The
        // stream-name convention is `WS_<wsKey>` (see
        // @syncengine/gateway-core workspace-bridge streamName()).
        const resolvedJsm: JsmLike =
            jsm ?? (await jetstream(nc).jetstreamManager() as unknown as JsmLike);
        const discovered: string[] = [];
        for await (const info of resolvedJsm.streams.list()) {
            if (info.config.name.startsWith('WS_')) {
                discovered.push(info.config.name.slice(3));
            }
        }
        await Promise.all(discovered.map((wsId) => this.spawnFor(wsId)));

        // 2. Live subscription. The workspace virtual object's
        // `provision` handler publishes into `syncengine.workspaces`
        // with a `{ type: 'WORKSPACE_PROVISIONED', workspaceId }`
        // payload; we spawn dispatchers for the new workspace on each
        // such message. Decode errors are swallowed — the server's
        // gateway also subscribes here for its own reasons, so
        // malformed payloads shouldn't take us down.
        this.registrySub = nc.subscribe('syncengine.workspaces');
        void this.consumeRegistry();
    }

    private async consumeRegistry(): Promise<void> {
        if (!this.registrySub) return;
        try {
            for await (const msg of this.registrySub) {
                if (this.stopping) break;
                try {
                    const data = msg.json<{ type?: string; workspaceId?: string }>();
                    if (
                        data.type === 'WORKSPACE_PROVISIONED' &&
                        typeof data.workspaceId === 'string'
                    ) {
                        await this.onWorkspaceProvisioned(data.workspaceId);
                    }
                } catch {
                    // Decode error — not our problem.
                }
            }
        } catch {
            // Subscription closed — expected on stop().
        }
    }

    async onWorkspaceProvisioned(workspaceId: string): Promise<void> {
        await this.spawnFor(workspaceId);
    }

    async stop(): Promise<void> {
        this.stopping = true;
        if (this.registrySub) {
            try { this.registrySub.unsubscribe(); } catch { /* best effort */ }
            this.registrySub = null;
        }
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
            retry: sub.$retry ?? this.config.defaultRetry ?? DEFAULT_RETRY,
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

/**
 * Production dispatcher factory — constructs a real
 * `@syncengine/gateway-core` `BusDispatcher` from a shared
 * `BusDispatcherConfig`. Drop-in for `dispatcherFactory` in
 * production wiring (the CLI's generated server entry).
 *
 * Tests keep using a stub factory so they don't need NATS. Config
 * shape is identical because `BusManager` and `BusDispatcher` both
 * consume `BusDispatcherConfig` directly.
 */
export const realDispatcherFactory: DispatcherFactory = (cfg) =>
    new BusDispatcher(cfg);
