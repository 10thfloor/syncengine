/**
 * `publishDeadEvent` — JSON-encode a `DeadEvent<T>` and publish it to
 * the workspace's DLQ bus subject.
 *
 * The dispatcher invokes this from its terminal-error branch: when
 * Restate reports that the workflow threw `TerminalError`, the
 * event is wrapped in `DeadEvent` metadata and posted to
 * `ws.<workspaceId>.bus.<dlqBusName>`. A DLQ subscriber (or the
 * Devtools panel in Phase 2) tails this subject to see what the
 * subscriber couldn't process.
 *
 * `x-request-id` is forwarded if the original event carried one —
 * a DLQ tail that preserves the request correlation is the whole
 * point of threading the id through the bus path in the first place.
 */

import { headers as natsHeaders, type MsgHdrs, type NatsConnection } from '@nats-io/transport-node';
import type { DeadEvent } from '@syncengine/core';

export async function publishDeadEvent<T>(
    nc: NatsConnection,
    workspaceId: string,
    dlqBusName: string,
    dead: DeadEvent<T>,
    requestId?: string,
): Promise<void> {
    const subject = `ws.${workspaceId}.bus.${dlqBusName}`;
    const body = JSON.stringify(dead);
    if (requestId) {
        const h = natsHeaders();
        h.set('x-request-id', requestId);
        nc.publish(subject, body, { headers: h as MsgHdrs });
        return;
    }
    nc.publish(subject, body);
}
