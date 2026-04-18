import { describe, it, expect } from 'vitest';
import { createTestStore } from '@syncengine/test-utils';
import { transactions, orderIndex, salesByProduct, recentActivity, totalSales, allOrders } from '../schema';

describe('View Pipelines (edge cases)', () => {
  // ── recentActivity (dedup aggregate + topN pipeline) ────────────────
  //
  // The recentActivity view pipeline is: aggregate (dedup) -> topN.
  // The dedup aggregate collapses identical content rows (Restate replays).
  // The topN is configured for limit=10 desc by timestamp.
  //
  // The DBSP WASM engine's record_id() now supports composite keys
  // (pipe-delimited) so topN eviction works correctly with multi-column
  // aggregates.
  describe('recentActivity', () => {
    it('dedup aggregate collapses identical content rows', () => {
      const t = createTestStore({ tables: [transactions], views: { recentActivity } });
      // Insert two identical rows (simulating Restate replay)
      t.insert(transactions, { productSlug: 'keyboard', userId: 'alice', amount: 79, type: 'sale', timestamp: 1000 });
      t.insert(transactions, { productSlug: 'keyboard', userId: 'alice', amount: 79, type: 'sale', timestamp: 1000 });

      const rows = t.view(recentActivity);
      // The dedup aggregate collapses identical (productSlug, userId, type, amount, timestamp)
      expect(rows).toHaveLength(1);
    });

    it('all types (sale, refund, restock) appear — no filter', () => {
      const t = createTestStore({ tables: [transactions], views: { recentActivity } });
      t.insert(transactions, { productSlug: 'keyboard', userId: 'alice', amount: 79, type: 'sale', timestamp: 1 });
      t.insert(transactions, { productSlug: 'keyboard', userId: 'alice', amount: -79, type: 'refund', timestamp: 2 });
      t.insert(transactions, { productSlug: 'keyboard', userId: 'alice', amount: 5, type: 'restock', timestamp: 3 });

      const rows = t.view(recentActivity);
      expect(rows).toHaveLength(3);
      const types = rows.map((r) => r.type).sort();
      expect(types).toEqual(['refund', 'restock', 'sale']);
    });

    it('distinct content rows are preserved', () => {
      const t = createTestStore({ tables: [transactions], views: { recentActivity } });
      // 5 distinct rows
      t.insert(transactions, { productSlug: 'keyboard', userId: 'alice', amount: 79, type: 'sale', timestamp: 1 });
      t.insert(transactions, { productSlug: 'usb-hub', userId: 'bob', amount: 29, type: 'sale', timestamp: 2 });
      t.insert(transactions, { productSlug: 'webcam', userId: 'carol', amount: 65, type: 'sale', timestamp: 3 });
      t.insert(transactions, { productSlug: 'keyboard', userId: 'alice', amount: -79, type: 'refund', timestamp: 4 });
      t.insert(transactions, { productSlug: 'keyboard', userId: 'system', amount: 5, type: 'restock', timestamp: 5 });

      const rows = t.view(recentActivity);
      expect(rows).toHaveLength(5);
    });

    it('each deduped row has _n count field', () => {
      const t = createTestStore({ tables: [transactions], views: { recentActivity } });
      // Insert 3 copies of the same content
      for (let i = 0; i < 3; i++) {
        t.insert(transactions, { productSlug: 'keyboard', userId: 'alice', amount: 79, type: 'sale', timestamp: 1000 });
      }

      const rows = t.view(recentActivity);
      expect(rows).toHaveLength(1);
      // The _n aggregate counts how many duplicates were collapsed
      expect(Number(rows[0]!._n)).toBe(3);
    });

    it('topN limits to 10 rows with composite keys', () => {
      const t = createTestStore({ tables: [transactions], views: { recentActivity } });
      // Insert 15 distinct transactions
      for (let i = 0; i < 15; i++) {
        t.insert(transactions, {
          productSlug: 'keyboard',
          userId: `user-${i}`,
          amount: 10 + i,
          type: 'sale',
          timestamp: 1000 + i,
        });
      }

      const rows = t.view(recentActivity);
      expect(rows.length).toBeLessThanOrEqual(10);
    });

    it('topN returns most recent (highest timestamp) entries', () => {
      const t = createTestStore({ tables: [transactions], views: { recentActivity } });
      // Insert 12 distinct transactions
      for (let i = 0; i < 12; i++) {
        t.insert(transactions, {
          productSlug: 'keyboard',
          userId: `user-${i}`,
          amount: 10,
          type: 'sale',
          timestamp: 100 + i,
        });
      }

      const rows = t.view(recentActivity);
      // All returned rows should have timestamp >= 102 (the oldest two evicted)
      for (const row of rows) {
        expect(Number(row.timestamp)).toBeGreaterThanOrEqual(102);
      }
    });
  });

  // ── salesByProduct edge cases ──────────────────────────────────────
  describe('salesByProduct', () => {
    it('refund transactions are excluded', () => {
      const t = createTestStore({ tables: [transactions], views: { salesByProduct } });
      t.insert(transactions, { productSlug: 'keyboard', userId: 'alice', amount: 79, type: 'sale', timestamp: 1 });
      t.insert(transactions, { productSlug: 'keyboard', userId: 'alice', amount: -79, type: 'refund', timestamp: 2 });

      const rows = t.view(salesByProduct);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ productSlug: 'keyboard', total: 79 });
    });

    it('restock transactions are excluded', () => {
      const t = createTestStore({ tables: [transactions], views: { salesByProduct } });
      t.insert(transactions, { productSlug: 'keyboard', userId: 'alice', amount: 79, type: 'sale', timestamp: 1 });
      t.insert(transactions, { productSlug: 'keyboard', userId: 'system', amount: 5, type: 'restock', timestamp: 2 });

      const rows = t.view(salesByProduct);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ total: 79 });
    });

    it('empty when only refunds inserted', () => {
      const t = createTestStore({ tables: [transactions], views: { salesByProduct } });
      t.insert(transactions, { productSlug: 'keyboard', userId: 'alice', amount: -79, type: 'refund', timestamp: 1 });
      t.insert(transactions, { productSlug: 'usb-hub', userId: 'bob', amount: -29, type: 'refund', timestamp: 2 });

      const rows = t.view(salesByProduct);
      expect(rows).toHaveLength(0);
    });
  });

  // ── totalSales edge cases ──────────────────────────────────────────
  describe('totalSales', () => {
    it('single sale: revenue = amount', () => {
      const t = createTestStore({ tables: [transactions], views: { totalSales } });
      t.insert(transactions, { productSlug: 'keyboard', userId: 'alice', amount: 79, type: 'sale', timestamp: 1 });

      const totals = t.view(totalSales);
      expect(totals).toHaveLength(1);
      expect(totals[0]).toMatchObject({ revenue: 79, count: 1 });
    });

    it('multiple refunds make revenue negative', () => {
      const t = createTestStore({ tables: [transactions], views: { totalSales } });
      t.insert(transactions, { productSlug: 'keyboard', userId: 'alice', amount: -79, type: 'refund', timestamp: 1 });
      t.insert(transactions, { productSlug: 'usb-hub', userId: 'bob', amount: -29, type: 'refund', timestamp: 2 });

      const totals = t.view(totalSales);
      expect(totals).toHaveLength(1);
      expect(totals[0]).toMatchObject({ revenue: -108, count: 2 });
    });

    it('empty table returns empty array', () => {
      const t = createTestStore({ tables: [transactions], views: { totalSales } });
      const totals = t.view(totalSales);
      expect(totals).toHaveLength(0);
    });
  });

  // ── allOrders edge cases ───────────────────────────────────────────
  describe('allOrders', () => {
    it('duplicate orderId rows collapse (Restate replay simulation)', () => {
      const t = createTestStore({ tables: [orderIndex], views: { allOrders } });
      // Insert same orderId twice with different auto-IDs
      t.insert(orderIndex, { orderId: 'ord-1', productSlug: 'keyboard', userId: 'alice', price: 79, createdAt: 1000 });
      t.insert(orderIndex, { orderId: 'ord-1', productSlug: 'keyboard', userId: 'alice', price: 79, createdAt: 1000 });

      const orders = t.view(allOrders);
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({ orderId: 'ord-1' });
    });

    it('max(price) picks highest when duplicates differ', () => {
      const t = createTestStore({ tables: [orderIndex], views: { allOrders } });
      t.insert(orderIndex, { orderId: 'ord-1', productSlug: 'keyboard', userId: 'alice', price: 50, createdAt: 1000 });
      t.insert(orderIndex, { orderId: 'ord-1', productSlug: 'keyboard', userId: 'alice', price: 100, createdAt: 1000 });

      const orders = t.view(allOrders);
      expect(orders).toHaveLength(1);
      expect(orders[0]!.price).toBe(100);
    });

    it('max(createdAt) picks latest', () => {
      const t = createTestStore({ tables: [orderIndex], views: { allOrders } });
      t.insert(orderIndex, { orderId: 'ord-1', productSlug: 'keyboard', userId: 'alice', price: 79, createdAt: 1000 });
      t.insert(orderIndex, { orderId: 'ord-1', productSlug: 'keyboard', userId: 'alice', price: 79, createdAt: 2000 });

      const orders = t.view(allOrders);
      expect(orders).toHaveLength(1);
      expect(orders[0]!.createdAt).toBe(2000);
    });
  });

  // ── Cross-view consistency ─────────────────────────────────────────
  describe('cross-view consistency', () => {
    it('3 sales + 1 refund + 1 restock: all views consistent', () => {
      const t = createTestStore({
        tables: [transactions],
        views: { salesByProduct, totalSales, recentActivity },
      });

      // 3 sales
      t.insert(transactions, { productSlug: 'keyboard', userId: 'alice', amount: 79, type: 'sale', timestamp: 1 });
      t.insert(transactions, { productSlug: 'usb-hub', userId: 'bob', amount: 29, type: 'sale', timestamp: 2 });
      t.insert(transactions, { productSlug: 'webcam', userId: 'carol', amount: 65, type: 'sale', timestamp: 3 });

      // 1 refund
      t.insert(transactions, { productSlug: 'keyboard', userId: 'alice', amount: -79, type: 'refund', timestamp: 4 });

      // 1 restock
      t.insert(transactions, { productSlug: 'keyboard', userId: 'system', amount: 5, type: 'restock', timestamp: 5 });

      // salesByProduct: only sales (refund/restock excluded)
      const sales = t.view(salesByProduct);
      expect(sales).toHaveLength(3); // keyboard, mouse, webcam (each 1 sale)

      // totalSales: includes ALL transaction types (no filter).
      // revenue = 79 + 29 + 65 + (-79) + 5 = 99
      const totals = t.view(totalSales);
      expect(totals).toHaveLength(1);
      expect(totals[0]).toMatchObject({ revenue: 99, count: 5 });

      // recentActivity: 5 rows (all types, deduped)
      const activity = t.view(recentActivity);
      expect(activity).toHaveLength(5);
      // Verify all timestamps present (use Number() since WASM may return bigint)
      const timestamps = activity.map((r) => Number(r.timestamp)).sort((a, b) => a - b);
      expect(timestamps).toEqual([1, 2, 3, 4, 5]);
    });
  });
});
