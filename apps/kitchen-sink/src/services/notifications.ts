// ── Notifications Service ──────────────────────────────────────────────────
//
// Driven port (hex architecture) for the outbound-notifications adapter.
// Called from DLQ-subscriber workflows like `alertOnShippingFailure` when
// a downstream workflow gives up on an event.
//
// Phase 1 event-bus demo: the `sendSlack` method is a console-log stub.
// A production implementation would POST to Slack's Incoming Webhook API.

import { service } from '@syncengine/core';

export const notifications = service('notifications', {
    async sendSlack(payload: { channel: string; text: string }): Promise<void> {
        console.log(`[notifications] slack ${payload.channel}: ${payload.text}`);
    },
});
