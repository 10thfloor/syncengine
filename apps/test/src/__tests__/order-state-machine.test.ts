import { describe, it, expect } from 'vitest';
import { createTestStore } from '@syncengine/test-utils';
import { SyncEngineError } from '@syncengine/core';
import { orderIndex, allOrders } from '../schema';
import { order } from '../entities/order.actor';

// Initial state for a fresh order entity.
const DRAFT = { status: 'draft', productSlug: '', userId: '', price: 0, total: 0, customerEmail: '', createdAt: 0 };

// Helpers to build intermediate states.
const placed = (base = DRAFT) => ({
  ...base, status: 'placed', productSlug: 'keyboard', userId: 'alice', price: 79, createdAt: 1000,
});
const packed = () => ({ ...placed(), status: 'packed' });
const shipped = () => ({ ...placed(), status: 'shipped' });
const delivered = () => ({ ...placed(), status: 'delivered' });
const cancelled = () => ({ ...placed(), status: 'cancelled' });

describe('Order State Machine', () => {
  // ── Valid transitions ──────────────────────────────────────────────
  describe('valid transitions', () => {
    it('draft -> placed (via place) emits to orderIndex', () => {
      const t = createTestStore({ tables: [orderIndex], views: { allOrders } });
      const result = t.applyHandler(order, 'place', { ...DRAFT }, ['alice', 'keyboard', 79, 1000]);
      expect(result.state.status).toBe('placed');
      expect(result.emits).toHaveLength(1);

      t.applyEmits(result.emits, 'ord-1');
      expect(t.view(allOrders)).toHaveLength(1);
      expect(t.view(allOrders)[0]).toMatchObject({ orderId: 'ord-1', productSlug: 'keyboard' });
    });

    it('placed -> packed (via pack)', () => {
      const t = createTestStore({ tables: [], views: {} });
      const result = t.applyHandler(order, 'pack', placed(), []);
      expect(result.state.status).toBe('packed');
    });

    it('packed -> shipped (via ship)', () => {
      const t = createTestStore({ tables: [], views: {} });
      const result = t.applyHandler(order, 'ship', packed(), []);
      expect(result.state.status).toBe('shipped');
    });

    it('shipped -> delivered (via deliver) — terminal', () => {
      const t = createTestStore({ tables: [], views: {} });
      const result = t.applyHandler(order, 'deliver', shipped(), []);
      expect(result.state.status).toBe('delivered');
    });

    it('draft -> cancelled (via cancel)', () => {
      const t = createTestStore({ tables: [], views: {} });
      const result = t.applyHandler(order, 'cancel', { ...DRAFT }, []);
      expect(result.state.status).toBe('cancelled');
    });

    it('placed -> cancelled (via cancel)', () => {
      const t = createTestStore({ tables: [], views: {} });
      const result = t.applyHandler(order, 'cancel', placed(), []);
      expect(result.state.status).toBe('cancelled');
    });
  });

  // ── Invalid transitions ────────────────────────────────────────────
  describe('invalid transitions', () => {
    const expectInvalidTransition = (
      handlerName: string,
      state: Record<string, unknown>,
    ) => {
      const t = createTestStore({ tables: [], views: {} });
      expect(() =>
        t.applyHandler(order, handlerName, state, handlerName === 'place' ? ['u', 'kb', 79, 1] : []),
      ).toThrow(SyncEngineError);
      try {
        t.applyHandler(order, handlerName, state, handlerName === 'place' ? ['u', 'kb', 79, 1] : []);
      } catch (err) {
        expect((err as SyncEngineError).code).toBe('INVALID_TRANSITION');
        expect((err as SyncEngineError).category).toBe('entity');
      }
    };

    it('draft -> packed: INVALID_TRANSITION', () => {
      expectInvalidTransition('pack', { ...DRAFT });
    });

    it('draft -> shipped: INVALID_TRANSITION', () => {
      expectInvalidTransition('ship', { ...DRAFT });
    });

    it('draft -> delivered: INVALID_TRANSITION', () => {
      expectInvalidTransition('deliver', { ...DRAFT });
    });

    it('placed -> shipped: INVALID_TRANSITION (must pack first)', () => {
      expectInvalidTransition('ship', placed());
    });

    it('placed -> delivered: INVALID_TRANSITION', () => {
      expectInvalidTransition('deliver', placed());
    });

    it('packed -> cancelled: INVALID_TRANSITION (too late)', () => {
      expectInvalidTransition('cancel', packed());
    });

    it('shipped -> cancelled: INVALID_TRANSITION', () => {
      expectInvalidTransition('cancel', shipped());
    });

    it('delivered -> place: INVALID_TRANSITION (terminal)', () => {
      expectInvalidTransition('place', delivered());
    });

    it('delivered -> pack: INVALID_TRANSITION (terminal)', () => {
      expectInvalidTransition('pack', delivered());
    });

    it('delivered -> ship: INVALID_TRANSITION (terminal)', () => {
      expectInvalidTransition('ship', delivered());
    });

    it('delivered -> deliver: INVALID_TRANSITION (terminal)', () => {
      expectInvalidTransition('deliver', delivered());
    });

    it('delivered -> cancel: INVALID_TRANSITION (terminal)', () => {
      expectInvalidTransition('cancel', delivered());
    });

    it('cancelled -> place: INVALID_TRANSITION (terminal)', () => {
      expectInvalidTransition('place', cancelled());
    });

    it('cancelled -> pack: INVALID_TRANSITION (terminal)', () => {
      expectInvalidTransition('pack', cancelled());
    });

    it('cancelled -> ship: INVALID_TRANSITION (terminal)', () => {
      expectInvalidTransition('ship', cancelled());
    });

    it('cancelled -> deliver: INVALID_TRANSITION (terminal)', () => {
      expectInvalidTransition('deliver', cancelled());
    });

    it('cancelled -> cancel: INVALID_TRANSITION (terminal)', () => {
      expectInvalidTransition('cancel', cancelled());
    });
  });

  // ── Full lifecycle ─────────────────────────────────────────────────
  describe('full lifecycle', () => {
    it('draft -> placed -> packed -> shipped -> delivered', () => {
      const t = createTestStore({ tables: [orderIndex], views: { allOrders } });

      // Step 1: draft -> placed
      const r1 = t.applyHandler(order, 'place', { ...DRAFT }, ['alice', 'keyboard', 79, 1000]);
      expect(r1.state.status).toBe('placed');
      t.applyEmits(r1.emits, 'ord-lifecycle');

      // Step 2: placed -> packed
      const r2 = t.applyHandler(order, 'pack', r1.state, []);
      expect(r2.state.status).toBe('packed');

      // Step 3: packed -> shipped
      const r3 = t.applyHandler(order, 'ship', r2.state, []);
      expect(r3.state.status).toBe('shipped');

      // Step 4: shipped -> delivered
      const r4 = t.applyHandler(order, 'deliver', r3.state, []);
      expect(r4.state.status).toBe('delivered');

      // Verify the order was emitted to the view
      expect(t.view(allOrders)).toHaveLength(1);
      expect(t.view(allOrders)[0]).toMatchObject({
        orderId: 'ord-lifecycle',
        productSlug: 'keyboard',
        userId: 'alice',
      });
    });
  });
});
