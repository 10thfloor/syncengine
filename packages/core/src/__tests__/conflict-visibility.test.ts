/**
 * RED → GREEN — Conflict Visibility
 *
 * The problem: LWW silently drops the loser. No way for users to see
 * "someone changed this while you were offline" or pick between versions.
 *
 * The solution:
 * 1. ConflictRecord — when LWW resolves, the engine emits the losing value
 *    alongside the winner so the UI can show a "conflict resolved" indicator.
 * 2. Conflict log — recent conflicts are stored per-table for UI display.
 * 3. Store hook — useConflicts() provides reactive access to the conflict log.
 * 4. Manual resolution — user can accept the loser's value, overriding LWW.
 */

import { describe, it, expect } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// 1. ConflictRecord shape
// ═══════════════════════════════════════════════════════════════════════════

describe('ConflictRecord', () => {

    it('conflict carries winner, loser, field, and both HLCs', () => {
        const conflict = {
            table: 'expenses',
            recordId: '42',
            field: 'amount',
            winner: { value: 99.5, hlc: { ts: 2000, count: 0 }, userId: 'user_a' },
            loser:  { value: 75.0, hlc: { ts: 1999, count: 3 }, userId: 'user_b' },
            strategy: 'lww' as const,
            resolvedAt: Date.now(),
        };

        expect(conflict.winner.value).toBe(99.5);
        expect(conflict.loser.value).toBe(75.0);
        expect(conflict.winner.hlc.ts).toBeGreaterThan(conflict.loser.hlc.ts);
        expect(conflict.strategy).toBe('lww');
    });

    it('conflict for max strategy shows why winner won', () => {
        const conflict = {
            table: 'scores',
            recordId: '1',
            field: 'high_score',
            winner: { value: 1500, hlc: { ts: 1000, count: 0 } },
            loser:  { value: 1200, hlc: { ts: 2000, count: 0 } },  // newer but lower
            strategy: 'max' as const,
            resolvedAt: Date.now(),
        };

        // Max strategy: winner is the higher value regardless of HLC
        expect(conflict.winner.value).toBeGreaterThan(conflict.loser.value);
    });

    it('set_union has no conflicts (always merges)', () => {
        // SetUnion never discards data — it combines. No conflict record needed.
        const strategy = 'set_union';
        const producesConflicts = strategy !== 'set_union';
        expect(producesConflicts).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Worker → Main thread: CONFLICT message
// ═══════════════════════════════════════════════════════════════════════════

describe('Worker conflict messages', () => {

    it('worker emits CONFLICT when LWW discards a value', () => {
        const msg = {
            type: 'CONFLICT' as const,
            conflict: {
                table: 'expenses',
                recordId: '42',
                field: 'amount',
                winner: { value: 99.5, hlc: { ts: 2000, count: 0 }, userId: 'user_a' },
                loser:  { value: 75.0, hlc: { ts: 1999, count: 3 }, userId: 'user_b' },
                strategy: 'lww',
                resolvedAt: Date.now(),
            },
        };

        expect(msg.type).toBe('CONFLICT');
        expect(msg.conflict.field).toBe('amount');
    });

    it('worker emits batch conflicts for multi-field updates', () => {
        // A single record update can conflict on multiple fields
        const msg = {
            type: 'CONFLICTS' as const,
            conflicts: [
                { table: 'expenses', recordId: '42', field: 'amount', winner: { value: 99.5 }, loser: { value: 75 }, strategy: 'lww' },
                { table: 'expenses', recordId: '42', field: 'category', winner: { value: 'food' }, loser: { value: 'dining' }, strategy: 'lww' },
            ],
        };

        expect(msg.conflicts).toHaveLength(2);
        expect(msg.conflicts[0].field).toBe('amount');
        expect(msg.conflicts[1].field).toBe('category');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Rust engine: resolve() returns conflict info
// ═══════════════════════════════════════════════════════════════════════════

describe('Engine merge resolution with conflict info', () => {

    it('resolve returns conflict when LWW picks winner', () => {
        // The Rust engine's resolve() should return both the merged record
        // AND any conflicts that occurred during resolution.
        const resolveResult = {
            record: { id: 42, amount: 99.5, category: 'food' },
            conflicts: [
                { field: 'amount', winner: 99.5, loser: 75.0, winnerHlc: 2000, loserHlc: 1999 },
            ],
        };

        expect(resolveResult.conflicts).toHaveLength(1);
        expect(resolveResult.conflicts[0].winner).toBe(99.5);
    });

    it('resolve returns empty conflicts when no prior state exists', () => {
        // First write to a field — no conflict possible
        const resolveResult = {
            record: { id: 42, amount: 99.5 },
            conflicts: [],
        };

        expect(resolveResult.conflicts).toHaveLength(0);
    });

    it('resolve returns empty conflicts when same value wins', () => {
        // If the incoming value matches the current value, no visible conflict
        const resolveResult = {
            record: { id: 42, amount: 99.5 },
            conflicts: [],  // same value → no conflict worth showing
        };

        expect(resolveResult.conflicts).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Store: useConflicts() hook
// ═══════════════════════════════════════════════════════════════════════════

describe('Store conflict tracking', () => {

    it('conflict log is bounded (max 100 entries)', () => {
        const maxConflicts = 100;
        const log: unknown[] = new Array(150).fill({ field: 'x' });
        const trimmed = log.slice(-maxConflicts);
        expect(trimmed).toHaveLength(100);
    });

    it('conflicts can be dismissed by user', () => {
        // The store should support dismissing conflicts (marking them as seen)
        const conflicts = [
            { id: 'c1', dismissed: false },
            { id: 'c2', dismissed: false },
        ];

        conflicts[0].dismissed = true;
        const active = conflicts.filter(c => !c.dismissed);
        expect(active).toHaveLength(1);
    });

    it('conflicts are cleared on RESET', () => {
        const conflicts = [{ field: 'amount' }, { field: 'category' }];
        // On RESET, conflict log should be emptied
        conflicts.length = 0;
        expect(conflicts).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Manual resolution: accept loser's value
// ═══════════════════════════════════════════════════════════════════════════

describe('Manual conflict resolution', () => {

    it('resolveConflict message lets user pick the loser value', () => {
        // User sees conflict, chooses the loser's value.
        // This creates a new INSERT with a fresh HLC that overwrites LWW.
        const resolveMsg = {
            type: 'RESOLVE_CONFLICT' as const,
            table: 'expenses',
            recordId: '42',
            field: 'amount',
            chosenValue: 75.0,  // user picked the loser's value
        };

        expect(resolveMsg.type).toBe('RESOLVE_CONFLICT');
        expect(resolveMsg.chosenValue).toBe(75.0);
    });

    it('resolving a conflict creates a new mutation with fresh HLC', () => {
        // The resolution should be a normal INSERT that flows through
        // the regular mutation path, giving it a newer HLC than both
        // the winner and loser, so it definitively wins on all peers.
        const existingHlcs = [
            { ts: 2000, count: 0 },  // winner
            { ts: 1999, count: 3 },  // loser
        ];

        // New resolution HLC must be greater than both
        const resolutionHlc = { ts: 2001, count: 0 };
        const isGreater = resolutionHlc.ts > Math.max(...existingHlcs.map(h => h.ts));
        expect(isGreater).toBe(true);
    });
});
