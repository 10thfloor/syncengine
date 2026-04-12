import { entity, boolean, emit, sourceSum, sourceCount } from '@syncengine/core';
import { clicks } from '../schema';

/**
 * Account entity with source projections (Variation D).
 *
 * `balance` and `txnCount` are NOT stored as entity state — they're
 * derived from the `clicks` table via source projections, maintained
 * incrementally in Restate state every time `emit()` fires.
 *
 * The handler can validate against derived data (`state.balance < amount`)
 * because projections are merged into the state object before the
 * handler runs.
 */
export const account = entity('account', {
    state: {
        frozen: boolean(),
    },
    source: {
        balance: sourceSum(clicks, clicks.amount, clicks.label),
        txnCount: sourceCount(clicks, clicks.label),
    },
    handlers: {
        deposit: (state, amount: number) => {
            const s = state as Record<string, unknown>;
            return emit(
                { ...state, balance: (s.balance as number ?? 0) + amount, txnCount: (s.txnCount as number ?? 0) + 1 },
                { table: 'clicks', record: { label: '$key', amount } },
            );
        },
        withdraw: (state, amount: number) => {
            const s = state as Record<string, unknown>;
            if (s.frozen) {
                throw new Error('account is frozen');
            }
            if ((s.balance as number) < amount) {
                throw new Error('insufficient funds');
            }
            return emit(
                { ...state, balance: (s.balance as number) - amount, txnCount: (s.txnCount as number ?? 0) + 1 },
                { table: 'clicks', record: { label: '$key', amount: -amount } },
            );
        },
        freeze: (state) => ({ ...state, frozen: true }),
        unfreeze: (state) => ({ ...state, frozen: false }),
    },
});
