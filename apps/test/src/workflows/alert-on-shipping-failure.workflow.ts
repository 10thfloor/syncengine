// ── alertOnShippingFailure Workflow ─────────────────────────────────────────
//
// Subscribes to `orderEvents.dlq` — the auto-generated dead-letter bus
// that every subscriber workflow's `TerminalError` lands on. The `dlq`
// accessor is framework-generated on every `bus()` call, so subscribing
// to it looks identical to subscribing to any other bus.
//
// Each `DeadEvent<OrderEventPayload>` carries the original event, the
// error that terminated it, the attempt count, and the name of the
// workflow that gave up. We just forward that to Slack via the
// `notifications` service.

import { defineWorkflow, on } from '@syncengine/server';
import type { DeadEvent, ServicePort } from '@syncengine/core';
import { orderEvents, type OrderEventPayload } from '../events/orders.bus';
import { notifications } from '../services/notifications';

interface AlertServices {
    readonly notifications: ServicePort<typeof notifications>;
}

export const alertOnShippingFailure = defineWorkflow(
    'alertOnShippingFailure',
    {
        on: on(orderEvents.dlq),
        services: [notifications],
    },
    async (ctx, dead: DeadEvent<OrderEventPayload>) => {
        const services = (ctx as unknown as { services: AlertServices }).services;
        await services.notifications.sendSlack({
            channel: '#alerts',
            text:
                `${dead.workflow} failed ${dead.attempts}× on order ` +
                `${dead.original.orderId}: ${dead.error.message}`,
        });
    },
);
