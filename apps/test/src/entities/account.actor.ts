import { defineEntity, boolean, emit, sourceSum, sourceCount } from '@syncengine/core';
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
export const account = defineEntity('account', {
    state: {
        frozen: boolean(),
    },
    source: {
        balance: sourceSum(clicks, clicks.amount, clicks.label),
        txnCount: sourceCount(clicks, clicks.label),
    },
    handlers: {
        deposit: (state, amount: number) => emit(
            state,
            { table: 'clicks', record: { label: '$key', amount } },
        ),
        withdraw: (state, amount: number) => {
            if ((state as Record<string, unknown>).frozen) {
                throw new Error('account is frozen');
            }
            if (((state as Record<string, unknown>).balance as number) < amount) {
                throw new Error('insufficient funds');
            }
            return emit(
                state,
                { table: 'clicks', record: { label: '$key', amount: -amount } },
            );
        },
        freeze: (state) => ({ ...state, frozen: true }),
        unfreeze: (state) => ({ ...state, frozen: false }),
    },
});
