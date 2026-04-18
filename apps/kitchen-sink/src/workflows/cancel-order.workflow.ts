import { defineWorkflow, entityRef } from '@syncengine/server';
import { inventory } from '../entities/inventory.actor';
import { order } from '../entities/order.actor';

interface CancelInput {
    userId: string;
    orderId: string;
    productSlug: string;
    price: number;
    timestamp: number;
}

export const cancelOrder = defineWorkflow('cancelOrder', async (ctx, input: CancelInput) => {
    const ord = entityRef(ctx, order, input.orderId);
    const inv = entityRef(ctx, inventory, input.productSlug);

    // Step 1: transition order state machine to cancelled
    await ord.cancel();

    // Step 2: refund — compensating transaction + restock
    await inv.refund(input.userId, input.price, input.timestamp);
});
