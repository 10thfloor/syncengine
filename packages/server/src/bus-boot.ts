// ── bootBusRuntime — shared bus bootstrap for dev + build paths ────────────
//
// Both `syncengine dev` (direct execution of src/index.ts) and the
// generated `syncengine build` entry call this once at startup. It:
//
//   1. Splits subscriber workflows by their bus's mode — NATS
//      subscribers go to a `BusManager` / `BusDispatcher`, in-memory
//      subscribers go to an `InMemoryBusDriver`.
//   2. Opens a single NATS connection (when NATS buses exist).
//   3. Installs the publisher seam with `modeOf` routing so every
//      `bus.publish(ctx, payload)` reaches the right driver.
//   4. `manager.attachToNats(nc)` kicks stream-discovery + the
//      workspace-registry subscription so dispatchers spawn per
//      workspace.
//
// The bus-override pathway (2b-C3c) rides on top of this: at boot the
// loader applies `override(bus, { mode })` results to a mode registry,
// and the registry is what `modeOf` consults here.

import type { NatsConnection } from '@nats-io/transport-node';
import type { BusRef } from '@syncengine/core';
import type { WorkflowDef } from './workflow.js';
import type { BusManager as BusManagerType, BusManagerConfig } from './bus-manager.js';
import type { InMemoryBusDriver } from './in-memory-bus.js';

/** Resolver the boot helper uses to decide per-bus mode. Defaults to
 *  "whatever `bus.$mode.kind` says", but callers can override with a
 *  custom resolver to layer in `override(bus, { mode })` results. */
export type BusModeResolver = (busName: string) => 'nats' | 'inMemory';

export interface BootBusRuntimeOptions {
    readonly workflows: readonly WorkflowDef[];
    /** Every declared `bus()` in the app — needed to resolve per-bus
     *  mode for the publisher router. DLQ buses are derived from their
     *  parents automatically; callers can just pass the top-level list. */
    readonly buses: readonly BusRef<unknown>[];
    /** Optional resolver that wins over the default `bus.$mode.kind`
     *  lookup. Use this to apply `BusOverride` results from
     *  `config.services.overrides`. */
    readonly modeOf?: BusModeResolver;
    readonly natsUrl?: string;
    readonly restateUrl?: string;
    /** Defaults to true in process-owned contexts; pass `false` when
     *  the host (scale-out serve binary) already owns shutdown. */
    readonly installSignalHandlers?: boolean;
}

export interface BusRuntimeHandle {
    readonly manager: BusManagerType | null;
    readonly inMemoryDriver: InMemoryBusDriver | null;
    readonly nc: NatsConnection | null;
}

/** Boots the bus runtime (or returns null when the app has no
 *  subscribers and no buses). Always resolves — NATS connection failures
 *  become a warning log so the Restate endpoint + HTTP server remain
 *  usable even when the broker is misconfigured. */
export async function bootBusRuntime(
    opts: BootBusRuntimeOptions,
): Promise<BusRuntimeHandle | null> {
    const { isBusSubscriberWorkflow } = await import('./workflow.js');
    const hasSubscribers = opts.workflows.some(isBusSubscriberWorkflow);
    if (!hasSubscribers && opts.buses.length === 0) return null;

    // Default mode resolver — look up bus by name, read $mode.kind.
    // Users layer bus-overrides on top via opts.modeOf.
    const byName = new Map<string, BusRef<unknown>>();
    for (const b of opts.buses) {
        byName.set(b.$name, b);
        // DLQs inherit parent mode and are themselves publishable (e.g.
        // when alertOnShippingFailure chain-publishes); register by
        // dlq-name too so modeOf(busName) works for both.
        byName.set(b.dlq.$name, b.dlq as BusRef<unknown>);
    }
    const modeOf: BusModeResolver = opts.modeOf ?? ((busName) => {
        const b = byName.get(busName);
        return b?.$mode.kind === 'inMemory' ? 'inMemory' : 'nats';
    });

    // Split subscriber workflows by the mode of the bus they subscribe to.
    const natsWorkflows: WorkflowDef[] = [];
    const inMemoryWorkflows: WorkflowDef[] = [];
    for (const wf of opts.workflows) {
        if (!isBusSubscriberWorkflow(wf)) {
            natsWorkflows.push(wf);
            continue;
        }
        const busName = wf.$subscription.bus.$name;
        if (modeOf(busName) === 'inMemory') {
            inMemoryWorkflows.push(wf);
        } else {
            natsWorkflows.push(wf);
        }
    }

    // Build the in-memory driver eagerly if any subscriber wants it, OR
    // if any bus (after modeOf resolution) is in-memory — so a publish
    // to a subscriberless in-memory bus still has somewhere to route
    // through.
    const needInMemory =
        inMemoryWorkflows.length > 0 ||
        opts.buses.some((b) => modeOf(b.$name) === 'inMemory');
    const { InMemoryBusDriver } = needInMemory ? await import('./in-memory-bus.js') : { InMemoryBusDriver: null };
    const inMemoryDriver = needInMemory && InMemoryBusDriver
        ? new InMemoryBusDriver({ workflows: inMemoryWorkflows as never })
        : null;

    // BusManager only owns NATS-mode subscribers. If every subscriber is
    // in-memory and every bus (post-modeOf) is in-memory, skip the manager
    // entirely — no JetStream consumers, no connection attempt. Consult
    // `modeOf` for buses, not raw `.$mode.kind`, so an override can flip
    // a production-NATS bus fully into in-memory for tests.
    const hasNatsSubscribers = natsWorkflows.some(isBusSubscriberWorkflow);
    const hasNatsBuses = opts.buses.some((b) => modeOf(b.$name) === 'nats');
    const needManager = hasNatsSubscribers || hasNatsBuses;

    let manager: BusManagerType | null = null;
    let nc: NatsConnection | null = null;

    const natsUrl = opts.natsUrl ?? process.env.SYNCENGINE_NATS_URL ?? 'ws://localhost:9222';
    const restateUrl = opts.restateUrl ?? process.env.SYNCENGINE_RESTATE_URL ?? 'http://localhost:8080';
    const { installBusPublisher } = await import('./bus-context.js');

    if (needManager) {
        const { BusManager, realDispatcherFactory } = await import('./bus-manager.js');
        const { connectNats } = await import('@syncengine/gateway-core');

        const cfg: BusManagerConfig = {
            natsUrl,
            restateUrl,
            workflows: natsWorkflows,
            dispatcherFactory: realDispatcherFactory,
            installSignalHandlers:
                opts.installSignalHandlers ??
                (process.env.SYNCENGINE_NO_BUS_SIGNALS !== '1'),
        };
        manager = new BusManager(cfg);
        await manager.start();

        try {
            nc = await connectNats(natsUrl);
            installBusPublisher({ nc, inMemoryDriver: inMemoryDriver ?? undefined, modeOf });
            await manager.attachToNats(nc);
            console.log('[syncengine] bus runtime attached to ' + natsUrl);
        } catch (err) {
            console.warn(
                '[syncengine] bus runtime could not attach to NATS: ' +
                (err instanceof Error ? err.message : String(err)),
            );
        }
    } else if (inMemoryDriver) {
        // Pure in-memory case — no NATS connection, driver-only routing.
        installBusPublisher({ inMemoryDriver, modeOf });
        console.log('[syncengine] bus runtime: in-memory mode (no NATS)');
    }

    return { manager, inMemoryDriver, nc };
}
