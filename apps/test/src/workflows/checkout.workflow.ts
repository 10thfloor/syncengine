import { defineWorkflow, entityRef } from '@syncengine/server';
import { inventory } from '../entities/inventory.actor';
import { order } from '../entities/order.actor';

interface CheckoutInput {
    userId: string;
    orderId: string;
    productSlug: string;
    price: number;
    timestamp: number;  // passed from client — workflow body must be deterministic
}

export const checkout = defineWorkflow('checkout', async (ctx, input: CheckoutInput) => {
    const inv = entityRef(ctx, inventory, input.productSlug);
    const ord = entityRef(ctx, order, input.orderId);

    // Durable step 1: sell (consumes reservation, emits transaction)
    await inv.sell(input.userId, input.orderId, input.price, input.timestamp);

    // Durable step 2: place order (with compensation on failure)
    try {
        await ord.place(input.userId, input.productSlug, input.price, input.timestamp);
    } catch (err) {
        // Compensation: release the reservation
        await inv.releaseReservation(input.userId);
        throw err;
    }
});
