// ── ID + Email value objects ────────────────────────────────────────────────
//
// Brand-only scalars (UserId, OrderId) and an email with shape
// invariant + normalisation factory. Shows that same underlying
// primitive (`text()`) can produce non-interchangeable types via
// distinct value-object names.

import { defineValue, text } from '@syncengine/core';

export const UserId = defineValue('userId', text());
export const OrderId = defineValue('orderId', text());

export const Email = defineValue('email', text(), {
    invariant: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v),
    create: {
        from: (raw: string) => raw.toLowerCase().trim(),
    },
    ops: {
        domain: (e) => e.split('@')[1],
    },
});
