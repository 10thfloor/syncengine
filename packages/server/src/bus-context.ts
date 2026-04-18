/**
 * `BusContext` — per-invocation state for the bus publish path.
 *
 * `@syncengine/core`'s `bus.publish(ctx, payload)` needs a NATS
 * connection and a workspace id to compose the outbound subject.
 * Neither value can live on the BusRef itself (it's declared
 * statically at app-load time), and passing them explicitly to
 * every `publish()` call would leak infrastructure into user code.
 *
 * `AsyncLocalStorage<BusContext>` solves this: the server's
 * handler runtime wraps each workflow / webhook / heartbeat
 * invocation in `runInBusContext({ workspaceId, nc, requestId },
 * () => handler(...))`, and `bus.publish` reads the current frame
 * lazily from inside its `ctx.run` callback. Per-invocation
 * isolation, no module globals, no parallel-test contamination.
 *
 * At server bootstrap the NATS connection the bus should use is
 * registered via `installBusPublisher(nc)` — this wires the
 * `setBusPublisher` seam in `@syncengine/core`'s bus module to an
 * implementation that reads from the ALS frame established by
 * `runInBusContext`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { MsgHdrs, NatsConnection } from '@nats-io/transport-node';
import { setBusPublisher, type BusPublishCtx } from '@syncengine/core';

export interface BusContext {
    readonly workspaceId: string;
    readonly nc: NatsConnection;
    /** Optional — propagated onto outbound NATS headers so a
     *  subscriber's workflow invocation carries the same x-request-id
     *  as the entity handler that published. */
    readonly requestId?: string;
}

export const busContextStorage = new AsyncLocalStorage<BusContext>();

/**
 * Establish a `BusContext` frame around `fn`. Must wrap every user
 * handler the server invokes (workflow, webhook, heartbeat). Nested
 * frames override outer ones.
 */
export function runInBusContext<R>(
    ctx: BusContext,
    fn: () => Promise<R>,
): Promise<R> {
    return busContextStorage.run(ctx, fn);
}

/** Module-level NATS handle established at boot by the generated
 *  server entry (`installBusPublisher(nc)`). Workflow / heartbeat /
 *  webhook wrappers read it to build the ALS frame before invoking
 *  the user handler — so `bus.publish(ctx, ...)` inside user code
 *  always sees a populated `BusContext` without the caller having
 *  to thread the nc themselves. */
let installedNc: NatsConnection | null = null;

export function getInstalledBusNc(): NatsConnection | null {
    return installedNc;
}

/**
 * Wire `@syncengine/core`'s bus publisher to NATS. Call once at
 * server boot. Subsequent calls replace the previous publisher.
 *
 * The NATS connection argument is optional — leaving it undefined
 * keeps the "ALS-only" behaviour (tests that manually wrap calls in
 * `runInBusContext({ workspaceId, nc }, ...)` don't need a module
 * handle). Production callers pass their shared `NatsConnection`
 * so subscriber workflows / heartbeats / webhooks can do imperative
 * `bus.publish(ctx, payload)` without per-handler boilerplate.
 */
export function installBusPublisher(nc?: NatsConnection): void {
    if (nc) installedNc = nc;
    setBusPublisher(async (_ctx: BusPublishCtx, busName: string, payload: unknown) => {
        const bc = busContextStorage.getStore();
        if (!bc) {
            throw new Error(
                `bus.publish(${busName}): called outside of a server handler — no BusContext frame active. ` +
                `Server runtime must wrap every handler invocation in runInBusContext({ workspaceId, nc, requestId }, ...).`,
            );
        }
        const subject = `ws.${bc.workspaceId}.bus.${busName}`;
        const body = JSON.stringify(payload);
        if (bc.requestId) {
            const h = buildHeaders(bc.requestId);
            bc.nc.publish(subject, body, { headers: h as MsgHdrs });
        } else {
            bc.nc.publish(subject, body);
        }
    });
}

export function uninstallBusPublisher(): void {
    installedNc = null;
    setBusPublisher(null);
}

// Lazily imported — nats.js exposes `headers()` from @nats-io/nats-core
// transitively, but the import path differs across package versions.
// We cache the factory so the publish hot path avoids repeat requires.
let headersFactory: ((init?: [string, string][]) => unknown) | null = null;
function buildHeaders(requestId: string): unknown {
    if (!headersFactory) {
        // @nats-io/transport-node re-exports core primitives.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('@nats-io/transport-node') as {
            headers?: (init?: [string, string][]) => unknown;
        };
        if (typeof mod.headers !== 'function') {
            throw new Error('[bus] @nats-io/transport-node.headers() not available');
        }
        headersFactory = mod.headers;
    }
    return headersFactory([['x-request-id', requestId]]);
}
