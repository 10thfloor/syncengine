import { describe, it, expect } from 'vitest';
import { createTestStore } from '@syncengine/test-utils';
import { EntityError } from '@syncengine/core';
import { transactions, salesByProduct, totalSales } from '../schema';
import { inventory } from '../entities/inventory.actor';

// Initial state for a fresh inventory entity instance.
const INITIAL = { stock: 0, reserved: 0, reservedBy: '', reservedAt: 0 };

describe('Inventory Entity', () => {
  // ── restock ─────────────────────────────────────────────────────────
  describe('restock', () => {
    it('restocks from zero', () => {
      const t = createTestStore({ tables: [transactions], views: {} });
      const result = t.applyHandler(inventory, 'restock', { ...INITIAL, stock: 0 }, [5]);
      expect(result.state.stock).toBe(5);
    });

    it('throws INVALID_AMOUNT when amount is 0', () => {
      const t = createTestStore({ tables: [transactions], views: {} });
      expect(() =>
        t.applyHandler(inventory, 'restock', { ...INITIAL, stock: 10 }, [0]),
      ).toThrow(EntityError);
      try {
        t.applyHandler(inventory, 'restock', { ...INITIAL, stock: 10 }, [0]);
      } catch (err) {
        expect((err as EntityError).code).toBe('INVALID_AMOUNT');
      }
    });

    it('throws INVALID_AMOUNT when amount is negative', () => {
      const t = createTestStore({ tables: [transactions], views: {} });
      expect(() =>
        t.applyHandler(inventory, 'restock', { ...INITIAL, stock: 10 }, [-1]),
      ).toThrow(EntityError);
      try {
        t.applyHandler(inventory, 'restock', { ...INITIAL, stock: 10 }, [-1]);
      } catch (err) {
        expect((err as EntityError).code).toBe('INVALID_AMOUNT');
      }
    });
  });

  // ── reserve ─────────────────────────────────────────────────────────
  describe('reserve', () => {
    it('fresh reservation succeeds', () => {
      const t = createTestStore({ tables: [transactions], views: {} });
      const state = { ...INITIAL, stock: 5, reservedBy: '', reservedAt: 0 };
      const result = t.applyHandler(inventory, 'reserve', state, ['alice', 1000]);
      expect(result.state.reserved).toBe(1);
      expect(result.state.reservedBy).toBe('alice');
      expect(result.state.reservedAt).toBe(1000);
    });

    it('same user reserves again (idempotent)', () => {
      const t = createTestStore({ tables: [transactions], views: {} });
      const state = { ...INITIAL, stock: 5, reserved: 1, reservedBy: 'alice', reservedAt: 1000 };
      const result = t.applyHandler(inventory, 'reserve', state, ['alice', 2000]);
      expect(result.state.reserved).toBe(2);
      expect(result.state.reservedBy).toBe('alice');
    });

    it('different user with active reservation throws ALREADY_RESERVED', () => {
      const t = createTestStore({ tables: [transactions], views: {} });
      const state = { ...INITIAL, stock: 5, reserved: 1, reservedBy: 'alice', reservedAt: 1000 };
      expect(() =>
        t.applyHandler(inventory, 'reserve', state, ['bob', 2000]),
      ).toThrow(EntityError);
      try {
        t.applyHandler(inventory, 'reserve', state, ['bob', 2000]);
      } catch (err) {
        expect((err as EntityError).code).toBe('ALREADY_RESERVED');
      }
    });

    it('different user succeeds when TTL expired (auto-release)', () => {
      const t = createTestStore({ tables: [transactions], views: {} });
      // reservedAt=1000, now=1000+30001 => stale (>30_000)
      const state = { ...INITIAL, stock: 5, reserved: 1, reservedBy: 'alice', reservedAt: 1000 };
      const result = t.applyHandler(inventory, 'reserve', state, ['bob', 31001]);
      expect(result.state.reservedBy).toBe('bob');
      // reserved was 1, auto-release decremented to 0, then new reserve incremented to 1
      expect(result.state.reserved).toBe(1);
    });

    it('stock exhausted throws OUT_OF_STOCK', () => {
      const t = createTestStore({ tables: [transactions], views: {} });
      const state = { ...INITIAL, stock: 1, reserved: 1, reservedBy: '', reservedAt: 0 };
      expect(() =>
        t.applyHandler(inventory, 'reserve', state, ['alice', 1000]),
      ).toThrow(EntityError);
      try {
        t.applyHandler(inventory, 'reserve', state, ['alice', 1000]);
      } catch (err) {
        expect((err as EntityError).code).toBe('OUT_OF_STOCK');
      }
    });
  });

  // ── releaseReservation ─────────────────────────────────────────────
  describe('releaseReservation', () => {
    it('valid release by holder', () => {
      const t = createTestStore({ tables: [transactions], views: {} });
      const state = { ...INITIAL, stock: 5, reserved: 1, reservedBy: 'alice', reservedAt: 1000 };
      const result = t.applyHandler(inventory, 'releaseReservation', state, ['alice']);
      expect(result.state.reserved).toBe(0);
      expect(result.state.reservedBy).toBe('');
    });

    it('wrong userId throws NOT_RESERVED', () => {
      const t = createTestStore({ tables: [transactions], views: {} });
      const state = { ...INITIAL, stock: 5, reserved: 1, reservedBy: 'alice', reservedAt: 1000 };
      expect(() =>
        t.applyHandler(inventory, 'releaseReservation', state, ['bob']),
      ).toThrow(EntityError);
      try {
        t.applyHandler(inventory, 'releaseReservation', state, ['bob']);
      } catch (err) {
        expect((err as EntityError).code).toBe('NOT_RESERVED');
      }
    });

    it('no reservation throws NOT_RESERVED', () => {
      const t = createTestStore({ tables: [transactions], views: {} });
      const state = { ...INITIAL, stock: 5, reserved: 0, reservedBy: '', reservedAt: 0 };
      expect(() =>
        t.applyHandler(inventory, 'releaseReservation', state, ['alice']),
      ).toThrow(EntityError);
      try {
        t.applyHandler(inventory, 'releaseReservation', state, ['alice']);
      } catch (err) {
        expect((err as EntityError).code).toBe('NOT_RESERVED');
      }
    });
  });

  // ── sell ────────────────────────────────────────────────────────────
  describe('sell', () => {
    it('valid sell decrements stock and emits sale transaction', () => {
      const t = createTestStore({ tables: [transactions], views: { salesByProduct } });
      const state = { ...INITIAL, stock: 10, reserved: 1, reservedBy: 'alice', reservedAt: 1 };
      const result = t.applyHandler(inventory, 'sell', state, ['alice', 'ord-1', 79, 100]);
      expect(result.state.stock).toBe(9);
      expect(result.state.reserved).toBe(0);
      expect(result.state.reservedBy).toBe('');
      expect(result.emits).toHaveLength(1);

      // Verify emitted record fields
      const emitted = result.emits[0]!;
      expect(emitted.record.productSlug).toBe('$key');
      expect(emitted.record.type).toBe('sale');
      expect(emitted.record.amount).toBe(79);
      expect(emitted.record.userId).toBe('alice');
      expect(emitted.record.timestamp).toBe(100);
    });

    it('emitted transaction resolves $key and feeds views', () => {
      const t = createTestStore({ tables: [transactions], views: { salesByProduct } });
      const state = { ...INITIAL, stock: 10, reserved: 1, reservedBy: 'alice', reservedAt: 1 };
      const result = t.applyHandler(inventory, 'sell', state, ['alice', 'ord-1', 79, 100]);
      t.applyEmits(result.emits, 'keyboard');
      const rows = t.view(salesByProduct);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ productSlug: 'keyboard', total: 79 });
    });

    it('throws NOT_RESERVED when not reserved', () => {
      const t = createTestStore({ tables: [transactions], views: {} });
      expect(() =>
        t.applyHandler(inventory, 'sell',
          { ...INITIAL, stock: 10, reserved: 0, reservedBy: '', reservedAt: 0 },
          ['alice', 'ord-1', 79, 100]),
      ).toThrow(EntityError);
      try {
        t.applyHandler(inventory, 'sell',
          { ...INITIAL, stock: 10, reserved: 0, reservedBy: '', reservedAt: 0 },
          ['alice', 'ord-1', 79, 100]);
      } catch (err) {
        expect((err as EntityError).code).toBe('NOT_RESERVED');
      }
    });

    it('throws RESERVATION_EXPIRED when TTL exceeded', () => {
      const t = createTestStore({ tables: [transactions], views: {} });
      // reservedAt=1000, now=1000+30001 => expired
      const state = { ...INITIAL, stock: 10, reserved: 1, reservedBy: 'alice', reservedAt: 1000 };
      expect(() =>
        t.applyHandler(inventory, 'sell', state, ['alice', 'ord-1', 79, 31001]),
      ).toThrow(EntityError);
      try {
        t.applyHandler(inventory, 'sell', state, ['alice', 'ord-1', 79, 31001]);
      } catch (err) {
        expect((err as EntityError).code).toBe('RESERVATION_EXPIRED');
      }
    });

    it('totalSold is incremented', () => {
      const t = createTestStore({ tables: [transactions], views: {} });
      const state = { ...INITIAL, stock: 10, reserved: 1, reservedBy: 'alice', reservedAt: 1, totalSold: 0 };
      const result = t.applyHandler(inventory, 'sell', state, ['alice', 'ord-1', 79, 100]);
      expect(result.state.totalSold).toBe(1);
    });
  });

  // ── refund ─────────────────────────────────────────────────────────
  describe('refund', () => {
    it('valid refund restocks and emits refund transaction', () => {
      const t = createTestStore({ tables: [transactions], views: { totalSales } });
      const state = { ...INITIAL, stock: 9 };
      const result = t.applyHandler(inventory, 'refund', state, ['alice', 79, 2000]);
      expect(result.state.stock).toBe(10);
      expect(result.emits).toHaveLength(1);
    });

    it('emitted amount is negative', () => {
      const t = createTestStore({ tables: [transactions], views: {} });
      const state = { ...INITIAL, stock: 9 };
      const result = t.applyHandler(inventory, 'refund', state, ['alice', 79, 2000]);
      expect(result.emits[0]!.record.amount).toBe(-79);
    });

    it('emitted type is refund', () => {
      const t = createTestStore({ tables: [transactions], views: {} });
      const state = { ...INITIAL, stock: 9 };
      const result = t.applyHandler(inventory, 'refund', state, ['alice', 79, 2000]);
      expect(result.emits[0]!.record.type).toBe('refund');
    });

    it('refund feeds totalSales view with negative amount', () => {
      const t = createTestStore({ tables: [transactions], views: { totalSales } });
      // Insert a sale first
      t.insert(transactions, { productSlug: 'keyboard', userId: 'alice', amount: 79, type: 'sale', timestamp: 1 });
      // Now apply refund and emit
      const state = { ...INITIAL, stock: 9 };
      const result = t.applyHandler(inventory, 'refund', state, ['alice', 79, 2000]);
      t.applyEmits(result.emits, 'keyboard');
      const totals = t.view(totalSales);
      expect(totals[0]).toMatchObject({ revenue: 0 }); // 79 + (-79) = 0
    });
  });
});
