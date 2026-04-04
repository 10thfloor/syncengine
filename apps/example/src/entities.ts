// ── User entity definitions (Phase 4 demo) ──────────────────────────────────
//
// Entities live in `src/entities.ts` by convention. Both the React client
// and the framework's server import this file:
//
//   - Client: `useEntity(budgetLock, 'Food')` — typed React hook over the
//     entity's state and handler proxies.
//   - Server: at startup, `@syncengine/server` dynamic-imports this file
//     (path passed via SYNCENGINE_ENTITIES_PATH from the dev orchestrator)
//     and registers each exported `defineEntity` result as a Restate
//     virtual object.
//
// Stay SSR-safe: no React, no DOM, no browser-only APIs. Just pure
// state shape + pure-functional handlers.

import { defineEntity, integer, text } from '@syncengine/core';

const CATEGORIES = ['Food', 'Travel', 'Software', 'Office', 'Entertainment'] as const;

/**
 * Per-category budget editing lock.
 *
 * Demonstrates the actor model's single-writer guarantee. The CRDT
 * `budgets` table can't model "only one tab can edit Food's budget at a
 * time" because every replica is allowed to write. By making the lock a
 * Restate-backed entity, every `acquire` call is serialized — concurrent
 * tabs see a deterministic winner and the loser gets a clear error.
 *
 * Each category gets its own instance: `useEntity(budgetLock, 'Food')`,
 * `useEntity(budgetLock, 'Travel')`, etc. Lock holders are identified
 * by a string passed in by the caller (the demo uses a per-tab uuid).
 * Locks auto-expire after 30s so a crashed tab doesn't hold a category
 * hostage forever.
 */
export const budgetLock = defineEntity('budgetLock', {
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
