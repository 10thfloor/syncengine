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

import { entity, integer, real, text, emit, publish, Access } from '@syncengine/core';
import { orderIndex } from '../schema';
import { orderEvents, OrderEvent } from '../events/orders.bus';

const STATUSES = ['draft', 'placed', 'paid', 'packed', 'shipped', 'delivered', 'cancelled'] as const;

export const order = entity('order', {
  state: {
    status: text({ enum: STATUSES }),
    productSlug: text(),
    userId: text(),
    price: real(),
    // `total` and `customerEmail` support the event-bus demo (T13):
    // `pay()` publishes an OrderPaid event carrying `total`, and the
    // subscriber workflow (`shipOnPay`) reads `orderId` + `total` off
    // the bus payload. Defaulted to 0 / '' so existing handlers that
    // don't set them still pass validateEntityState.
    total: real(),
    customerEmail: text(),
    createdAt: integer(),
  },
  transitions: {
    draft:     ['placed', 'cancelled'],
    // 'paid' added as a new branch off 'placed' for the event-bus demo.
    // The existing checkout saga still flows placed → packed → shipped;
    // the bus demo uses placed → paid → shipped (via markShipped).
    placed:    ['packed', 'paid', 'cancelled'],
    paid:      ['shipped', 'cancelled'],
    packed:    ['shipped'],
    shipped:   ['delivered'],
    delivered: [],
    cancelled: [],
  },

  // Auth — place + cancel must be called by an authenticated user;
  // fulfillment transitions (pack/ship/deliver) can also be driven by
  // workflows (e.g. shipOnPay → markShipped), so they accept any
  // authenticated caller. `$system` identity from workflow-initiated
  // calls is handled separately once gap 2 lands.
  access: {
    '*': Access.authenticated,
  },

  handlers: {
    // ── place: called via RPC from CheckoutTab (saga step 2) ────────
    // Emits a row into `orderIndex` so the order appears in the
    // allOrders view. '$key' resolves to the entity key (order UUID).
    place(state, userId: string, productSlug: string, price: number, now: number) {
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
          table: orderIndex,
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
      return { ...state, status: 'packed' as const };
    },

    ship(state) {
      return { ...state, status: 'shipped' as const };
    },

    deliver(state) {
      return { ...state, status: 'delivered' as const };
    },

    // ── Event-bus demo handlers (T13) ───────────────────────────────
    //
    // `pay()` is the canonical declarative publisher: it transitions
    // the state machine (placed → paid) AND declares a bus publish in
    // the same atomic emit. Entity handlers are pure — they can't read
    // Date.now() or ctx.key — so the caller supplies `orderId` and
    // `at` via the request argument. `publish()` validates the payload
    // against `orderEvents` schema at call time.
    pay(state, req: { orderId: string; at: number }) {
      return emit({
        state: { ...state, status: 'paid' as const },
        effects: [
          publish(orderEvents, {
            orderId: req.orderId,
            event: OrderEvent.enum.paid,
            total: state.total,
            at: req.at,
          }),
        ],
      });
    },

    // Parallel branch: after the subscriber workflow successfully ships,
    // the framework calls this to advance the state machine.
    markShipped(state) {
      return { ...state, status: 'shipped' as const };
    },

    cancel(state) {
      return { ...state, status: 'cancelled' as const };
    },
  },
});

/** Map a status to its next valid action for the "advance" button in OrdersTab. */
export const NEXT_ACTION: Record<string, string | null> = {
  draft: null,
  placed: 'pack',
  paid: 'markShipped',
  packed: 'ship',
  shipped: 'deliver',
  delivered: null,
  cancelled: null,
};

/** Status badge colors used by OrdersTab. */
export const STATUS_COLORS: Record<string, string> = {
  draft: '#525252',
  placed: '#3b82f6',
  paid: '#14b8a6',
  packed: '#eab308',
  shipped: '#a855f7',
  delivered: '#22c55e',
  cancelled: '#ef4444',
};
