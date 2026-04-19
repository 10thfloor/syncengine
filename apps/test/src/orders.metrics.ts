// Declared metrics for the checkout / order flow.
//
// `*.metrics.ts` files are auto-loaded by the vite plugin at dev-server
// boot so module-level declarations (these handles) register with the
// global meter provider before the first user action. Import anywhere
// and call `.add()` / `.observe()` / `.record()` — each call ships to
// the OTLP endpoint configured in `syncengine.config.ts`.
//
// Auto-tagging: metric calls that fire inside a framework-invoked
// handler (bus subscriber, entity effect, webhook run, heartbeat tick)
// automatically attach `syncengine.workspace` + `syncengine.primitive`
// + `syncengine.name` to the reading via the ALS scope the framework
// installs. See `auditOrder.workflow.ts` for a live example.

import { metric } from '@syncengine/observe';

/** Count of checkout invocations — one increment per workflow call. */
export const checkoutsStarted = metric.counter('orders.checkouts.started', {
    description: 'Total checkout workflow invocations',
});

/** Compensation path taken — the order placement failed and we released
 *  the inventory reservation. High values here mean the checkout/order
 *  race condition is firing more than expected. */
export const checkoutCompensated = metric.counter(
    'orders.checkouts.compensated',
    {
        description: 'Checkouts that hit the compensation branch',
    },
);

/** End-to-end checkout latency — from entry to either success or
 *  compensation. Tag `outcome={placed,compensated}` on observation so
 *  the APM can break the histogram down by success path. */
export const checkoutLatency = metric.histogram('orders.checkouts.latency', {
    unit: 'ms',
    description: 'Checkout workflow wall-clock duration',
});

/** One-bump-per-audited-event — fan-out counter so the APM shows
 *  per-order activity volume at a glance. Auto-tagged with the workspace
 *  because it's called inside a bus-subscribed workflow (busConsume
 *  establishes the scope). */
export const ordersAudited = metric.counter('orders.audited', {
    description: 'Order events processed by the audit workflow',
});
