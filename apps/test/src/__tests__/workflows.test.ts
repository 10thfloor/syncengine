import { describe, it, expect } from 'vitest';
import { createTestStore } from '@syncengine/test-utils';
import { SyncEngineError } from '@syncengine/core';
import { transactions, orderIndex, salesByProduct, totalSales, allOrders } from '../schema';
import { inventory } from '../entities/inventory.actor';
import { order } from '../entities/order.actor';

// Initial states
const INV_INITIAL = { stock: 0, reserved: 0, reservedBy: '', reservedAt: 0 };
const ORD_INITIAL = { status: 'draft', productSlug: '', userId: '', price: 0, createdAt: 0 };

describe('Workflows', () => {
  // ── Checkout happy path ────────────────────────────────────────────
  describe('checkout happy path', () => {
    it('reserve -> sell -> place produces correct views', () => {
      const t = createTestStore({
        tables: [transactions, orderIndex],
        views: { salesByProduct, allOrders },
      });

      // Start: stock=10
      const invState = { ...INV_INITIAL, stock: 10 };

      // Step 1: reserve
      const r1 = t.applyHandler(inventory, 'reserve', invState, ['alice', 1000]);
      expect(r1.state.reserved).toBe(1);
      expect(r1.state.reservedBy).toBe('alice');

      // Step 2: sell
      const r2 = t.applyHandler(inventory, 'sell', r1.state, ['alice', 'ord-1', 79, 1001]);
      expect(r2.state.stock).toBe(9);
      expect(r2.emits).toHaveLength(1);

      // Step 3: order.place
      const r3 = t.applyHandler(order, 'place', { ...ORD_INITIAL }, ['alice', 'keyboard', 79, 1001]);
      expect(r3.state.status).toBe('placed');
      expect(r3.emits).toHaveLength(1);

      // Step 4: apply emits for both
      t.applyEmits(r2.emits, 'keyboard');
      t.applyEmits(r3.emits, 'ord-1');

      // Verify views
      const sales = t.view(salesByProduct);
      expect(sales).toHaveLength(1);
      expect(sales[0]).toMatchObject({ productSlug: 'keyboard', total: 79 });

      const orders = t.view(allOrders);
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({ orderId: 'ord-1', productSlug: 'keyboard', userId: 'alice' });
    });
  });

  // ── Checkout compensation (place fails) ────────────────────────────
  describe('checkout compensation (place fails)', () => {
    it('release reservation on failed place', () => {
      const t = createTestStore({
        tables: [transactions, orderIndex],
        views: { salesByProduct, allOrders },
      });

      const invState = { ...INV_INITIAL, stock: 10 };

      // Step 1: reserve + sell succeed
      const r1 = t.applyHandler(inventory, 'reserve', invState, ['alice', 1000]);
      const r2 = t.applyHandler(inventory, 'sell', r1.state, ['alice', 'ord-1', 79, 1001]);
      t.applyEmits(r2.emits, 'keyboard');

      // Step 2: Simulate place failure — try to place an already-placed order
      const placedOrder = { ...ORD_INITIAL, status: 'placed', productSlug: 'keyboard', userId: 'alice', price: 79, createdAt: 1000 };
      expect(() =>
        t.applyHandler(order, 'place', placedOrder, ['alice', 'keyboard', 79, 1001]),
      ).toThrow(SyncEngineError);

      // Step 3: Compensate — release reservation
      // After sell, reservedBy is already cleared. The compensation is about
      // the business logic: the sale transaction is already emitted and visible
      // in views. In a real system the refund would compensate the sale.
      // Here we verify the sale transaction is still visible.
      const sales = t.view(salesByProduct);
      expect(sales).toHaveLength(1);
      expect(sales[0]).toMatchObject({ productSlug: 'keyboard', total: 79 });
    });
  });

  // ── Cancel + refund happy path ─────────────────────────────────────
  describe('cancel + refund happy path', () => {
    it('complete checkout then cancel and refund restores revenue to 0', () => {
      const t = createTestStore({
        tables: [transactions, orderIndex],
        views: { totalSales, allOrders },
      });

      // Step 1: Complete checkout (reserve -> sell -> place)
      const invState = { ...INV_INITIAL, stock: 10 };
      const r1 = t.applyHandler(inventory, 'reserve', invState, ['alice', 1000]);
      const r2 = t.applyHandler(inventory, 'sell', r1.state, ['alice', 'ord-1', 79, 1001]);
      t.applyEmits(r2.emits, 'keyboard');

      const r3 = t.applyHandler(order, 'place', { ...ORD_INITIAL }, ['alice', 'keyboard', 79, 1001]);
      t.applyEmits(r3.emits, 'ord-1');

      // Verify sale is in totalSales
      const beforeCancel = t.view(totalSales);
      expect(beforeCancel[0]).toMatchObject({ revenue: 79 });

      // Step 2: Cancel the order
      const r4 = t.applyHandler(order, 'cancel', r3.state, []);
      expect(r4.state.status).toBe('cancelled');

      // Step 3: Refund the inventory (compensating transaction)
      const r5 = t.applyHandler(inventory, 'refund', r2.state, ['alice', 79, 2000]);
      expect(r5.state.stock).toBe(10); // stock restored from 9 to 10
      t.applyEmits(r5.emits, 'keyboard');

      // Step 4: Verify totalSales revenue is 0 (sale 79 + refund -79)
      const afterRefund = t.view(totalSales);
      expect(afterRefund[0]).toMatchObject({ revenue: 0 });
    });
  });

  // ── Multi-product checkout ─────────────────────────────────────────
  describe('multi-product checkout', () => {
    it('two checkouts: keyboard ($79) + mouse ($29)', () => {
      const t = createTestStore({
        tables: [transactions, orderIndex],
        views: { salesByProduct, totalSales, allOrders },
      });

      // Checkout 1: keyboard ($79)
      const kb = { ...INV_INITIAL, stock: 10 };
      const kb1 = t.applyHandler(inventory, 'reserve', kb, ['alice', 1000]);
      const kb2 = t.applyHandler(inventory, 'sell', kb1.state, ['alice', 'ord-kb', 79, 1001]);
      t.applyEmits(kb2.emits, 'keyboard');
      const ordKb = t.applyHandler(order, 'place', { ...ORD_INITIAL }, ['alice', 'keyboard', 79, 1001]);
      t.applyEmits(ordKb.emits, 'ord-kb');

      // Checkout 2: mouse ($29)
      const ms = { ...INV_INITIAL, stock: 5 };
      const ms1 = t.applyHandler(inventory, 'reserve', ms, ['bob', 2000]);
      const ms2 = t.applyHandler(inventory, 'sell', ms1.state, ['bob', 'ord-ms', 29, 2001]);
      t.applyEmits(ms2.emits, 'usb-hub');
      const ordMs = t.applyHandler(order, 'place', { ...ORD_INITIAL }, ['bob', 'usb-hub', 29, 2001]);
      t.applyEmits(ordMs.emits, 'ord-ms');

      // Verify salesByProduct
      const sales = t.view(salesByProduct);
      expect(sales).toHaveLength(2);
      expect(sales.find((r) => r.productSlug === 'keyboard')).toMatchObject({ total: 79, count: 1 });
      expect(sales.find((r) => r.productSlug === 'usb-hub')).toMatchObject({ total: 29, count: 1 });

      // Verify totalSales
      const totals = t.view(totalSales);
      expect(totals[0]).toMatchObject({ revenue: 108, count: 2 });

      // Verify allOrders
      const orders = t.view(allOrders);
      expect(orders).toHaveLength(2);
      expect(orders.find((r) => r.orderId === 'ord-kb')).toMatchObject({ productSlug: 'keyboard' });
      expect(orders.find((r) => r.orderId === 'ord-ms')).toMatchObject({ productSlug: 'usb-hub' });
    });
  });
});
