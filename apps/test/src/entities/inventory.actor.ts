import { entity, integer, text, emit, sourceCount } from '@syncengine/core';
import { transactions } from '../schema';

const STALE_MS = 30_000;

export const inventory = entity('inventory', {
  state: {
    stock: integer(),
    reserved: integer(),
    reservedBy: text(),
    reservedAt: integer(),
  },
  source: {
    totalSold: sourceCount(transactions, transactions.productSlug),
  },
  handlers: {
    restock(state, amount: number) {
      if (amount <= 0) throw new Error('restock amount must be positive');
      return { ...state, stock: state.stock + amount };
    },

    reserve(state, userId: string, now: number) {
      let current = state;
      if (current.reservedBy && current.reservedAt > 0 && now - current.reservedAt > STALE_MS) {
        current = { ...current, reserved: current.reserved - 1, reservedBy: '', reservedAt: 0 };
      }

      if (current.reservedBy && current.reservedBy !== userId) {
        throw new Error(`Already reserved by ${current.reservedBy}`);
      }
      if (current.stock - current.reserved <= 0) {
        throw new Error('No stock available to reserve');
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
        throw new Error('You do not hold the reservation');
      }
      return {
        ...state,
        reserved: state.reserved - 1,
        reservedBy: '',
        reservedAt: 0,
      };
    },

    sell(state, userId: string, _orderId: string, price: number, now: number) {
      if (state.reservedBy !== userId) {
        throw new Error('You must hold a reservation to purchase');
      }
      if (state.reservedAt > 0 && now - state.reservedAt > STALE_MS) {
        throw new Error('Reservation has expired');
      }

      const s = state as Record<string, unknown>;
      return emit(
        {
          ...state,
          stock: state.stock - 1,
          reserved: state.reserved - 1,
          reservedBy: '',
          reservedAt: 0,
          totalSold: ((s.totalSold as number) ?? 0) + 1,
        },
        {
          table: 'transactions',
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
  },
});
