import { defineWorkflow, entityRef } from '@syncengine/server';
import { inventory } from '../entities/inventory.actor';
import { order } from '../entities/order.actor';
import {
    checkoutCompensated,
    checkoutLatency,
    checkoutsStarted,
} from '../orders.metrics';

interface CheckoutInput {
    userId: string;
    orderId: string;
    productSlug: string;
    price: number;
    timestamp: number;  // passed from client — workflow body must be deterministic
}

export const checkout = defineWorkflow('checkout', async (ctx, input: CheckoutInput) => {
    const startedAt = Date.now();
    // Directly-invoked workflows (via RPC) don't get an ALS scope frame
    // today, so workspace/user don't auto-tag. Passing `outcome` here
    // lets the APM filter histograms by success / compensation path.
    checkoutsStarted.add(1);

    const inv = entityRef(ctx, inventory, input.productSlug);
    const ord = entityRef(ctx, order, input.orderId);

    // Durable step 1: sell (consumes reservation, emits transaction)
    await inv.sell(input.userId, input.orderId, input.price, input.timestamp);

    // Durable step 2: place order (with compensation on failure)
    try {
        await ord.place(input.userId, input.productSlug, input.price, input.timestamp);
        checkoutLatency.observe(Date.now() - startedAt, { outcome: 'placed' });
    } catch (err) {
        // Compensation: release the reservation
        checkoutCompensated.add(1);
        await inv.releaseReservation(input.userId);
        checkoutLatency.observe(Date.now() - startedAt, { outcome: 'compensated' });
        throw err;
    }
});
