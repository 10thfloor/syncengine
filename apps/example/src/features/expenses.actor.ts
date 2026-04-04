// ── Expenses feature (PLAN Phase 6 — per-feature schema bundle) ────────────
//
// `.actor.ts` files act as feature files: they can export any mix of
// tables, views, channels, seed data, constants, and (optionally) entity
// definitions. The Vite plugin scans them for handler stripping on the
// client side, and the framework server dynamic-imports each file at
// startup to register any `defineEntity` exports with Restate. Tables,
// views, and other schema metadata pass through both paths unchanged —
// they're legitimately needed on both client and server.
//
// This file owns everything related to the "team expenses" feature:
// the two tables (expenses, budgets), four DBSP views, channel routing,
// initial seed data, and the category enum. `App.tsx` imports the
// handles back from here and passes them to `store({...})`. No entities
// are declared here — see `entities/budget-lock.actor.ts` for the
// actor-model companion to this feature.

import {
    table, id, real, text, view,
    sum, count, avg, max,
} from '@syncengine/client';

// ── Domain enum ────────────────────────────────────────────────────────────

export const CATEGORIES = ['Food', 'Travel', 'Software', 'Office', 'Entertainment'] as const;

export type Category = typeof CATEGORIES[number];

export const EMOJI: Record<Category, string> = {
    Food: '🍔',
    Travel: '✈️',
    Software: '💻',
    Office: '📦',
    Entertainment: '🎬',
};

export const BUDGET_LIMITS: Record<Category, number> = {
    Food: 2000,
    Travel: 5000,
    Software: 3000,
    Office: 4000,
    Entertainment: 1500,
};

// ── Tables ─────────────────────────────────────────────────────────────────

export const expenses = table('expenses', {
    id: id(),
    amount: real(),
    category: text({ enum: CATEGORIES }),
    description: text(),
    date: text(),
});

export const budgets = table('budgets', {
    id: id(),
    category: text({ enum: CATEGORIES }),
    budget: real(),
});

// ── Views ──────────────────────────────────────────────────────────────────

export const topExpenses = view(expenses).topN(expenses.amount, 5, 'desc');

export const byCategory = view(expenses).aggregate([expenses.category], {
    total: sum(expenses.amount),
    count: count(),
    avg: avg(expenses.amount),
});

export const totals = view(expenses).aggregate([], {
    total: sum(expenses.amount),
    count: count(),
    avg: avg(expenses.amount),
});

export const spendVsBudget = view(expenses)
    .join(budgets, expenses.category, budgets.category)
    .aggregate([expenses.category], {
        spent: sum(expenses.amount),
        budget: max(budgets.budget),
        count: count(),
    });

// ── Channels — by Table reference, not string ────────────────────────────

export const CHANNELS = [
    { name: 'config', tables: [budgets] },
    { name: 'team', tables: [expenses] },
] as const;

// ── Seed data ──────────────────────────────────────────────────────────────

export const BUDGET_SEED = CATEGORIES.map((cat, i) => ({
    id: i + 1,
    category: cat,
    budget: BUDGET_LIMITS[cat],
}));

