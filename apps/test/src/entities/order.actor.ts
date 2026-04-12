import { entity, integer, real, text, emit } from '@syncengine/core';

const STATUSES = ['draft', 'placed', 'packed', 'shipped', 'delivered', 'cancelled'] as const;

const TRANSITIONS: Record<string, string[]> = {
  draft:     ['placed', 'cancelled'],
  placed:    ['packed', 'cancelled'],
  packed:    ['shipped'],
  shipped:   ['delivered'],
  delivered: [],
  cancelled: [],
};

function guardTransition(current: string, next: string): void {
  const allowed = TRANSITIONS[current];
  if (!allowed || !allowed.includes(next)) {
    throw new Error(`Cannot transition from '${current}' to '${next}'`);
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

/** Map a status to its next valid action for the "advance" button. */
export const NEXT_ACTION: Record<string, string | null> = {
  draft: null,
  placed: 'pack',
  packed: 'ship',
  shipped: 'deliver',
  delivered: null,
  cancelled: null,
};

/** Status badge colors. */
export const STATUS_COLORS: Record<string, string> = {
  draft: '#525252',
  placed: '#3b82f6',
  packed: '#eab308',
  shipped: '#a855f7',
  delivered: '#22c55e',
  cancelled: '#ef4444',
};
