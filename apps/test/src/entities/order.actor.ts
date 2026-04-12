// ── Order Actor ─────────────────────────────────────────────────────────────
//
// Demonstrates two syncengine patterns:
//
//   1. Entity as a state machine — each order (keyed by UUID) has a status
//      that can only advance through a guarded transition graph:
//
//          draft → placed → packed → shipped → delivered
//                    ↓                                  (terminal)
//                cancelled                              (terminal)
//
//      Invalid transitions throw, which the Restate runtime catches and
//      returns as a 4xx to the caller. Because handlers are pure functions,
//      the same guard logic runs both on the client (optimistic UI in
//      OrdersTab) and on the server (authoritative Restate execution).
//
//   2. emit() in place() — when an order is placed, a row is inserted
//      into the `orderIndex` table. That table feeds the `allOrders` DBSP
//      view in schema.ts, which the OrdersTab reads via `useView`. The
//      view deduplicates by orderId (collapsing Restate replay duplicates)
//      and pushes incremental diffs to every connected client over NATS.
//
// ── How it fits into the demo ───────────────────────────────────────────────
//
//   CheckoutTab → saga step 2: after inventory.sell() succeeds, an RPC
//     call to `/__syncengine/rpc/order/{uuid}/place` creates the order.
//     This is the second half of the two-actor checkout saga — inventory
//     handles stock + payment, order handles fulfillment state.
//
//   OrdersTab → useEntity(order, orderId)  → status badge + advance/cancel
//     Each row binds to its own entity instance. Clicking "pack", "ship",
//     "deliver" calls the corresponding handler through the same
//     optimistic-update / NATS-broadcast path as every other actor.
//
//   allOrders view (schema.ts) → populated by the emit() in place().
//     OrdersTab uses `useView({ allOrders })` to list orders, then each
//     row opens its own `useEntity` subscription for live status updates.

import { entity, integer, real, text, emit, EntityError } from '@syncengine/core';

const STATUSES = ['draft', 'placed', 'packed', 'shipped', 'delivered', 'cancelled'] as const;

// Allowed transitions — the adjacency list for the state machine.
// Terminal states (delivered, cancelled) have empty arrays.
const TRANSITIONS: Record<string, string[]> = {
  draft:     ['placed', 'cancelled'],
  placed:    ['packed', 'cancelled'],
  packed:    ['shipped'],
  shipped:   ['delivered'],
  delivered: [],
  cancelled: [],
};

// Guard function shared by every handler. Throws on illegal transitions,
// which surfaces as an error both locally (optimistic throw) and on the
// server (Restate handler rejection).
function guardTransition(current: string, next: string): void {
  const allowed = TRANSITIONS[current];
  if (!allowed || !allowed.includes(next)) {
    throw new EntityError('INVALID_TRANSITION', `Cannot transition from '${current}' to '${next}'`);
  }
}

export const order = entity('order', {
  state: {
    status: text({ enum: STATUSES }),
    productSlug: text(),
    userId: text(),
    price: real(),
    createdAt: integer(),
  },
  handlers: {
    // ── place: called via RPC from CheckoutTab (saga step 2) ────────
    // Emits a row into `orderIndex` so the order appears in the
    // allOrders view. '$key' resolves to the entity key (order UUID).
    place(state, userId: string, productSlug: string, price: number, now: number) {
      guardTransition(state.status, 'placed');
      return emit(
        {
          ...state,
          status: 'placed' as const,
          userId,
          productSlug,
          price,
          createdAt: now,
        },
        {
          table: 'orderIndex',
          record: {
            orderId: '$key',
            productSlug,
            userId,
            price,
            createdAt: now,
          },
        },
      );
    },

    // ── Fulfillment transitions (OrdersTab advance button) ──────────
    // Pure state mutations — no side-effects, no emits. Each one just
    // guards and advances the status. The UI maps the current status
    // to the next available action via NEXT_ACTION below.

    pack(state) {
      guardTransition(state.status, 'packed');
      return { ...state, status: 'packed' as const };
    },

    ship(state) {
      guardTransition(state.status, 'shipped');
      return { ...state, status: 'shipped' as const };
    },

    deliver(state) {
      guardTransition(state.status, 'delivered');
      return { ...state, status: 'delivered' as const };
    },

    cancel(state) {
      guardTransition(state.status, 'cancelled');
      return { ...state, status: 'cancelled' as const };
    },
  },
});

/** Map a status to its next valid action for the "advance" button in OrdersTab. */
export const NEXT_ACTION: Record<string, string | null> = {
  draft: null,
  placed: 'pack',
  packed: 'ship',
  shipped: 'deliver',
  delivered: null,
  cancelled: null,
};

/** Status badge colors used by OrdersTab. */
export const STATUS_COLORS: Record<string, string> = {
  draft: '#525252',
  placed: '#3b82f6',
  packed: '#eab308',
  shipped: '#a855f7',
  delivered: '#22c55e',
  cancelled: '#ef4444',
};
