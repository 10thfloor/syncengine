// ── budgetLock entity (PLAN Phase 4 demo) ──────────────────────────────────
//
// Per-category budget editing lock. Demonstrates the actor model's
// single-writer guarantee: while the CRDT `budgets` table replicates
// freely across every client, this lock is a Restate-backed virtual
// object with serialized `acquire`/`release` handlers. Two tabs racing
// to claim the same category see a deterministic winner; the loser
// gets a clear error from the server.
//
// ── File discovery (PLAN Phase 4) ──────────────────────────────────────────
//
// This file lives at `src/**/*.actor.ts` so the Vite plugin's file
// walker picks it up during `buildStart`. The framework's server
// (`@syncengine/server`, run under tsx) uses its own glob + dynamic
// import to register the entity with Restate.
//
// ── Client/server split (PLAN Phase 4) ─────────────────────────────────────
//
// The handler bag is wrapped in `server({...})` so the Vite plugin's
// `transform` hook can strip handler bodies from the client bundle
// while preserving handler names for the typed action proxy. On the
// server, `server()` is the identity function — the original handlers
// run as Restate virtual-object methods.

import { entity, integer, text } from '@syncengine/core';

const CATEGORIES = ['Food', 'Travel', 'Software', 'Office', 'Entertainment'] as const;

export const budgetLock = entity('budgetLock', {
    state: {
        category: text({ enum: CATEGORIES }),
        holder: text(),       // empty string == unlocked
        acquiredAt: integer(),
        version: integer(),
    },
    handlers: {
        /** Try to claim the lock. Throws if held by someone else and the
         *  hold isn't stale (older than 30s). */
        acquire(state, holder: string, category: typeof CATEGORIES[number], now: number) {
            const STALE_MS = 30_000;
            const isStale = state.acquiredAt > 0 && now - state.acquiredAt > STALE_MS;
            if (state.holder && state.holder !== holder && !isStale) {
                throw new Error(
                    `Locked by '${state.holder}' since ${new Date(state.acquiredAt).toISOString()}`,
                );
            }
            return {
                category,
                holder,
                acquiredAt: now,
                version: state.version + 1,
            };
        },
        /** Release the lock. Only the current holder may release. */
        release(state, holder: string) {
            if (state.holder !== holder) {
                throw new Error(`Not the lock holder (held by '${state.holder}')`);
            }
            return { holder: '', acquiredAt: 0, version: state.version + 1 };
        },
        /** Force-clear the lock — used by the UI's emergency unlock button. */
        forceRelease(state) {
            return { holder: '', acquiredAt: 0, version: state.version + 1 };
        },
    },
});
