// ── Inventory Actor ─────────────────────────────────────────────────────────
//
// Demonstrates three syncengine patterns:
//
//   1. Entity as a keyed singleton — each product slug ("headphones",
//      "keyboard", …) maps to exactly one Restate virtual-object instance.
//      `useEntity(inventory, slug)` in CatalogTab and CheckoutTab binds a
//      React component to that instance with optimistic state, latency
//      compensation, and real-time NATS broadcasts across tabs/users.
//
//   2. emit() — side-effect channel from actor to relational pipeline.
//      `sell()` returns `emit(newState, { table, record })`: the state
//      update is applied to the Restate object AND the emitted row is
//      inserted into the `transactions` table, which feeds every DBSP
//      view in schema.ts (salesByProduct, recentActivity, totalSales).
//      The UI never issues a separate write — the actor is the single
//      source of truth and the pipeline reacts automatically.
//
//   3. sourceCount() — reverse projection from table back into entity
//      state. `totalSold` is not stored by the handlers; it is maintained
//      incrementally by the framework from `count(transactions)` where
//      `productSlug = entityKey`. The catalog card reads it as a normal
//      state field to show "N sold" without a separate query.
//
// ── How it fits into the demo ───────────────────────────────────────────────
//
//   CatalogTab  → useEntity(inventory, slug)  → restock button
//   CheckoutTab → useEntity(inventory, slug)  → reserve / sell saga
//     └─ sell() emits a `transactions` row  ──→ DBSP views update live
//     └─ CheckoutTab then calls order.place() via RPC (saga step 2)
//   ActivityTab → useView({ salesByProduct, recentActivity, totalSales })
//     └─ reads the rows emitted by sell(), rendered as a live dashboard

import { entity, integer, text, emit, sourceCount, EntityError, Access } from '@syncengine/core';
import { transactions } from '../schema';

// Reservation TTL — if a client disappears, the lock auto-expires so
// another user can purchase. Matches RESERVATION_TTL_MS in CheckoutTab.
const STALE_MS = 30_000;

export const inventory = entity('inventory', {
  state: {
    stock: integer(),
    reserved: integer(),
    reservedBy: text(),  // userId holding the current reservation (or '')
    reservedAt: integer(), // epoch-ms when the reservation was acquired
  },

  // Reverse projection: the framework keeps `totalSold` in sync with
  // count(*) from the `transactions` table where productSlug = this key.
  // Handlers don't need to manage it — it appears as a read-only state field.
  source: {
    totalSold: sourceCount(transactions, transactions.productSlug),
  },

  // Auth — every mutation requires an authenticated user. `unverified()`
  // in syncengine.config.ts trusts the `?user=<id>` query string as the
  // bearer token, so the enforcement layer sees a real user id without
  // any login UI. Swap for jwt({ jwksUri, ... }) in production.
  access: {
    '*': Access.authenticated,
  },

  handlers: {
    // ── Simple state mutation (CatalogTab "Restock +5" button) ──────
    restock(state, amount: number) {
      if (amount <= 0) throw new EntityError('INVALID_AMOUNT', 'restock amount must be positive');
      return { ...state, stock: state.stock + amount };
    },

    // ── Reservation with TTL-based lease (CheckoutTab) ──────────────
    // Only one user can hold a reservation at a time. If the holder's
    // TTL expires, the next caller transparently reclaims it.
    reserve(state, userId: string, now: number) {
      let current = state;
      if (current.reservedBy && current.reservedAt > 0 && now - current.reservedAt > STALE_MS) {
        current = { ...current, reserved: current.reserved - 1, reservedBy: '', reservedAt: 0 };
      }

      if (current.reservedBy && current.reservedBy !== userId) {
        throw new EntityError('ALREADY_RESERVED', `Already reserved by ${current.reservedBy}`);
      }
      if (current.stock - current.reserved <= 0) {
        throw new EntityError('OUT_OF_STOCK', 'No stock available to reserve');
      }

      return {
        ...current,
        reserved: current.reserved + 1,
        reservedBy: userId,
        reservedAt: now,
      };
    },

    releaseReservation(state, userId: string) {
      if (state.reservedBy !== userId) {
        throw new EntityError('NOT_RESERVED', 'You do not hold the reservation');
      }
      return {
        ...state,
        reserved: state.reserved - 1,
        reservedBy: '',
        reservedAt: 0,
      };
    },

    // ── Sell: the first half of the checkout saga (CheckoutTab) ─────
    // Consumes the reservation, decrements stock, and emits a row into
    // the `transactions` table. The emitted row flows through the DBSP
    // pipeline — salesByProduct, recentActivity, and totalSales views
    // all update incrementally and push changes to every connected
    // client via NATS. '$key' is a framework placeholder that resolves
    // to this entity's key (the product slug) at insert time.
    //
    // After sell() succeeds, CheckoutTab fires saga step 2: an RPC to
    // order.place() which creates the order entity and emits into the
    // orderIndex table — a two-actor saga coordinated from the client.
    sell(state, userId: string, _orderId: string, price: number, now: number) {
      if (state.reservedBy !== userId) {
        throw new EntityError('NOT_RESERVED', 'You must hold a reservation to purchase');
      }
      if (state.reservedAt > 0 && now - state.reservedAt > STALE_MS) {
        throw new EntityError('RESERVATION_EXPIRED', 'Reservation has expired');
      }

      return emit(
        {
          ...state,
          stock: state.stock - 1,
          reserved: state.reserved - 1,
          reservedBy: '',
          reservedAt: 0,
          totalSold: (state.totalSold ?? 0) + 1,
        },
        {
          table: transactions,
          record: {
            productSlug: '$key',
            userId,
            amount: price,
            type: 'sale',
            timestamp: now,
          },
        },
      );
    },

    // ── Refund: compensating transaction for order cancellation ────
    // Restocks the item and emits a negative-amount refund transaction.
    // Called by the cancellation workflow, not directly by the UI.
    refund(state, userId: string, price: number, now: number) {
      return emit(
        {
          ...state,
          stock: state.stock + 1,
        },
        {
          table: transactions,
          record: {
            productSlug: '$key',
            userId,
            amount: -price,
            type: 'refund',
            timestamp: now,
          },
        },
      );
    },
  },
});
