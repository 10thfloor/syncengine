// ── Shipping Service ───────────────────────────────────────────────────────
//
// Driven port (hex architecture) for the shipping adapter. Called from the
// `shipOnPay` workflow after an order reaches the `paid` state.
//
// Phase 1 event-bus demo: this is a console-log stub. Orders whose id
// starts with `fail-` deliberately throw to exercise the terminal-error
// → DLQ path that `alertOnShippingFailure` subscribes to.

import { service } from '@syncengine/core';

export const shipping = service('shipping', {
    async create(orderId: string): Promise<{ trackingId: string; status: string }> {
        console.log(`[shipping] create(${orderId})`);
        if (orderId.startsWith('fail-')) {
            throw new Error(`shipping failed for ${orderId} (demo failure path)`);
        }
        return {
            trackingId: `trk_${orderId}`,
            status: 'in_transit',
        };
    },
});
