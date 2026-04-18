// ── Money value object ──────────────────────────────────────────────────────
//
// Composite value with a non-negative invariant, named-currency factories,
// and arithmetic ops. Used by the kitchen-sink entity/table/bus demos
// to show that a single domain type reaches every layer with its brand
// and invariant intact.

import { defineValue, integer, text } from '@syncengine/core';

export const Money = defineValue('money', {
    amount: integer(),
    currency: text({ enum: ['USD', 'EUR', 'GBP'] as const }),
}, {
    invariant: (v) => v.amount >= 0,
    create: {
        usd: (cents: number) => ({ amount: cents, currency: 'USD' as const }),
        eur: (cents: number) => ({ amount: cents, currency: 'EUR' as const }),
        gbp: (cents: number) => ({ amount: cents, currency: 'GBP' as const }),
    },
    ops: {
        add: (a, b) => {
            if (a.currency !== b.currency) {
                throw new Error(`Money.add: currency mismatch (${a.currency} vs ${b.currency})`);
            }
            return { amount: a.amount + b.amount, currency: a.currency };
        },
        scale: (m, factor: number) => ({
            amount: Math.round(m.amount * factor),
            currency: m.currency,
        }),
        isZero: (m) => m.amount === 0,
        format: (m) => `${m.currency} ${(m.amount / 100).toFixed(2)}`,
    },
});
