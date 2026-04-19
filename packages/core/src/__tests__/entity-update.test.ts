import { describe, it, expect } from 'vitest';
import {
    emit, insert, remove, update, publish,
    extractEmits, extractRemoves, extractUpdates, extractPublishes,
    UPDATE_KEY,
    defineEntity,
} from '../entity';
import { bus } from '../bus';
import { table, text, integer, id } from '../schema';
import { z } from 'zod';

const notes = table('notes', {
    id: id(),
    body: text(),
    author: text(),
    createdAt: integer(),
});

// Counter column with add-merge — the classic CRDT increment case.
const counters = table('counters', {
    id: id(),
    clicks: integer({ merge: 'add' }),
    label: text(),
});

// Table with an immutable column (merge: false) — update must reject
// patches that touch it.
const audit = table('audit', {
    id: id(),
    kind: text({ merge: false }),
    who: text(),
});

describe('update() effect', () => {
    it('returns a typed effect declaration', () => {
        const eff = update(notes, 42, { body: 'edited' });
        expect(eff.$effect).toBe('update');
        expect(eff.table).toBe(notes);
        expect(eff.id).toBe(42);
        expect(eff.patch).toEqual({ body: 'edited' });
    });

    it('rejects a patch containing the primary-key column at runtime', () => {
        // TS's Omit on EmitRecord here is best-effort due to generic
        // inference + optional-property semantics — runtime validation
        // is the authoritative guard and the one we test.
        expect(() =>
            emit({ state: { n: 1 }, effects: [update(notes, 42, { id: 99, body: 'x' })] }),
        ).toThrow(/primary-key column 'id'.*remove\(\) \+ insert\(\)/);
    });

    it('rejects a patch touching an immutable (merge: false) column', () => {
        expect(() =>
            emit({ state: { n: 1 }, effects: [update(audit, 1, { kind: 'tampered' })] }),
        ).toThrow(/column 'kind' is immutable.*merge: false/);
    });

    it('allows patching other columns on a table that has immutable columns', () => {
        // `who` is mutable; only `kind` is immutable.
        const result = emit({ state: { n: 1 }, effects: [update(audit, 1, { who: 'alice' })] });
        expect(extractUpdates(result)).toHaveLength(1);
        expect(extractUpdates(result)![0].patch).toEqual({ who: 'alice' });
    });

    it('rejects an id whose runtime kind disagrees with the primary-key column', () => {
        expect(() =>
            emit({
                state: { n: 1 },
                effects: [update(notes, 'not-a-number' as unknown as number, { body: 'x' })],
            }),
        ).toThrow(/primary-key column 'id'.*rejected id value/);
    });

    it('accepts an empty patch (handler emitted no changes) — no-op on the wire', () => {
        // Unusual but not illegal. Downstream data-worker sees an empty
        // patch and skips the row.
        const result = emit({ state: { n: 1 }, effects: [update(notes, 42, {})] });
        expect(extractUpdates(result)).toHaveLength(1);
        expect(extractUpdates(result)![0].patch).toEqual({});
    });
});

describe('emit({ state, effects }) with update()', () => {
    it('attaches updates via UPDATE_KEY symbol', () => {
        const result = emit({
            state: { n: 1 },
            effects: [update(notes, 7, { body: 'hi' })],
        });
        const updates = extractUpdates(result);
        expect(updates).toBeDefined();
        expect(updates).toHaveLength(1);
        expect(updates![0]).toEqual({ table: 'notes', id: 7, patch: { body: 'hi' } });
    });

    it('keeps UPDATE_KEY non-enumerable so spreads drop it', () => {
        const result = emit({
            state: { n: 1 },
            effects: [update(notes, 7, { body: 'hi' })],
        });
        const spread = { ...result };
        expect(extractUpdates(spread as Record<string, unknown>)).toBeUndefined();
        expect(extractUpdates(result as Record<string, unknown>)).toHaveLength(1);
    });

    it('JSON.stringify does not serialize the update effect payload', () => {
        const result = emit({
            state: { n: 1 },
            effects: [update(notes, 7, { body: 'hi' })],
        });
        expect(JSON.parse(JSON.stringify(result))).toEqual({ n: 1 });
    });

    it('coexists with insert, remove, and publish in one emit call', () => {
        const events = bus('events', { schema: z.object({ at: z.number() }) });
        const result = emit({
            state: { n: 1 },
            effects: [
                insert(notes, { id: 1, body: 'hi', author: 'alice', createdAt: 0 }),
                update(notes, 2, { body: 'edited' }),
                remove(notes, 3),
                publish(events, { at: 0 }),
            ],
        });
        expect(extractEmits(result)).toHaveLength(1);
        expect(extractUpdates(result)).toHaveLength(1);
        expect(extractRemoves(result)).toHaveLength(1);
        expect(extractPublishes(result)).toHaveLength(1);
    });

    it('preserves order within the update array', () => {
        const result = emit({
            state: { n: 0 },
            effects: [
                update(notes, 1, { body: 'a' }),
                update(notes, 2, { body: 'b' }),
                update(notes, 3, { body: 'c' }),
            ],
        });
        expect(extractUpdates(result)!.map((u) => u.id)).toEqual([1, 2, 3]);
    });

    it('returns undefined from extractUpdates when no updates emitted', () => {
        const result = emit({
            state: { n: 1 },
            effects: [insert(notes, { id: 1, body: 'hi', author: 'a', createdAt: 0 })],
        });
        expect(extractUpdates(result)).toBeUndefined();
    });
});

describe('update() via defineEntity', () => {
    it('entity handler can emit an update effect and it survives applyHandler', () => {
        const editor = defineEntity('editor', {
            state: { lastEditedId: integer() },
            handlers: {
                editBody(_state, noteId: number, body: string) {
                    return emit({
                        state: { lastEditedId: noteId },
                        effects: [update(notes, noteId, { body })],
                    }) as unknown as { lastEditedId: number };
                },
            },
        });

        const result = editor.$handlers.editBody({ lastEditedId: 0 }, 42, 'new body');
        expect(result.lastEditedId).toBe(42);
        const updates = extractUpdates(result as unknown as Record<string, unknown>);
        expect(updates).toHaveLength(1);
        expect(updates![0]).toEqual({ table: 'notes', id: 42, patch: { body: 'new body' } });
    });

    it('increment-style update on an add-merge counter column', () => {
        // Handler emits an update contributing +1 to clicks. With the
        // column's merge: 'add', this becomes a counter increment at the
        // CRDT layer — different replicas' +1 contributions accumulate.
        const incrementer = defineEntity('incrementer', {
            state: { bumps: integer() },
            handlers: {
                bump(state, counterId: number) {
                    return emit({
                        state: { bumps: state.bumps + 1 },
                        effects: [update(counters, counterId, { clicks: 1 })],
                    }) as unknown as typeof state;
                },
            },
        });

        const r = incrementer.$handlers.bump({ bumps: 0 }, 99);
        expect(r.bumps).toBe(1);
        const updates = extractUpdates(r as unknown as Record<string, unknown>);
        expect(updates).toHaveLength(1);
        expect(updates![0].patch).toEqual({ clicks: 1 });
    });
});

describe('UPDATE_KEY', () => {
    it('is a process-wide registered symbol (survives module reload)', () => {
        expect(UPDATE_KEY).toBe(Symbol.for('syncengine.update'));
    });
});
