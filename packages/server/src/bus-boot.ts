// ── bootBusRuntime — shared bus bootstrap for dev + build paths ────────────
//
// Both `syncengine dev` (direct execution of src/index.ts) and the
// generated `syncengine build` entry need the same bus runtime wiring:
//
//   1. Spawn a `BusManager` over the app's subscriber workflows.
//   2. Open a single NATS connection.
//   3. `installBusPublisher(nc)` so imperative `bus.publish(ctx, ...)`
//      calls inside user handlers reach NATS via the ALS frame that
//      `wrapWorkflowHandler` / `wrapHeartbeatWorkflow` / etc. wrap
//      each invocation in.
//   4. `attachToNats(nc)` kicks the manager's stream-discovery + the
//      workspace-registry subscription so dispatchers spawn per
//      workspace.
//
// Before this helper existed the bootstrap lived twice: once as a
// string template in `packages/cli/src/build.ts` and once inline at the
// bottom of `packages/server/src/index.ts`. A mismatch caused the
// dev-mode bus subscribers to silently no-op for a session.

import type { NatsConnection } from '@nats-io/transport-node';
import type { WorkflowDef } from './workflow.js';
import type { BusManager as BusManagerType, BusManagerConfig } from './bus-manager.js';

export interface BootBusRuntimeOptions {
    readonly workflows: readonly WorkflowDef[];
    /** Included so callers can gate on "any declared buses?" without
     *  having to re-scan the workflows themselves. Also what triggers
     *  a spawn for buses that have no subscribers yet (rare — usually
     *  a short-lived state during incremental development). */
    readonly buseCount: number;
    readonly natsUrl?: string;
    readonly restateUrl?: string;
    /** Defaults to true in process-owned contexts; pass `false` when
     *  the host (scale-out serve binary) already owns shutdown. */
    readonly installSignalHandlers?: boolean;
}

export interface BusRuntimeHandle {
    readonly manager: BusManagerType;
    readonly nc: NatsConnection | null;
}

/** Boots the bus runtime (or returns a no-op handle when the app has
 *  no subscribers or buses). Always resolves — NATS connection failures
 *  become a warning log so the Restate endpoint + HTTP server remain
 *  usable even when the message broker is misconfigured. */
export async function bootBusRuntime(
    opts: BootBusRuntimeOptions,
): Promise<BusRuntimeHandle | null> {
    const { isBusSubscriberWorkflow } = await import('./workflow.js');
    const hasSubscribers = opts.workflows.some(isBusSubscriberWorkflow);
    if (!hasSubscribers && opts.buseCount === 0) return null;

    const natsUrl = opts.natsUrl ?? process.env.SYNCENGINE_NATS_URL ?? 'ws://localhost:9222';
    const restateUrl = opts.restateUrl ?? process.env.SYNCENGINE_RESTATE_URL ?? 'http://localhost:8080';

    const { BusManager, realDispatcherFactory } = await import('./bus-manager.js');
    const { installBusPublisher } = await import('./bus-context.js');
    const { connectNats } = await import('@syncengine/gateway-core');

    const cfg: BusManagerConfig = {
        natsUrl,
        restateUrl,
        workflows: opts.workflows,
        dispatcherFactory: realDispatcherFactory,
        installSignalHandlers:
            opts.installSignalHandlers ??
            (process.env.SYNCENGINE_NO_BUS_SIGNALS !== '1'),
    };

    const manager = new BusManager(cfg);
    await manager.start();

    try {
        const nc = await connectNats(natsUrl);
        installBusPublisher(nc);
        await manager.attachToNats(nc);
        console.log('[syncengine] bus runtime attached to ' + natsUrl);
        return { manager, nc };
    } catch (err) {
        console.warn(
            '[syncengine] bus runtime could not attach to NATS: ' +
            (err instanceof Error ? err.message : String(err)),
        );
        return { manager, nc: null };
    }
}
