import { describe, it, expect } from 'vitest';
import {
    emit, insert, remove, publish, trigger,
    extractEmits, extractRemoves, extractPublishes, extractTriggers,
    REMOVE_KEY,
    defineEntity,
} from '../entity';
import { bus } from '../bus';
import { table, text, integer, id } from '../schema';
import { z } from 'zod';

const notes = table('notes', { id: id(), body: text() });
const thumbs = table('thumbs', { id: id(), noteId: integer(), userId: text() });

describe('remove() effect', () => {
    it('returns a typed effect declaration', () => {
        const eff = remove(thumbs, 42);
        expect(eff.$effect).toBe('remove');
        expect(eff.table).toBe(thumbs);
        expect(eff.id).toBe(42);
    });

    it('rejects an id whose runtime type disagrees with the primary-key column', () => {
        // notes.id is an integer primary key — string should be caught by validateRemoveId.
        expect(() =>
            emit({ state: { n: 1 }, effects: [remove(notes, 'not-a-number' as unknown as number)] }),
        ).toThrow(/remove\(notes\).*primary-key column 'id'.*rejected id value/);
    });

    it('accepts NaN as a number but still rejects it — Number.isFinite gate', () => {
        expect(() =>
            emit({ state: { n: 1 }, effects: [remove(notes, Number.NaN)] }),
        ).toThrow(/primary-key column 'id'/);
    });
});

describe('emit({ state, effects }) with remove()', () => {
    it('attaches removes via REMOVE_KEY symbol', () => {
        const result = emit({
            state: { n: 1 },
            effects: [remove(thumbs, 7)],
        });
        const removes = extractRemoves(result);
        expect(removes).toBeDefined();
        expect(removes).toHaveLength(1);
        expect(removes![0]).toEqual({ table: 'thumbs', id: 7 });
    });

    it('normalizes the typed table ref to a string table name on the wire', () => {
        const result = emit({
            state: { n: 1 },
            effects: [remove(thumbs, 1), remove(thumbs, 2)],
        });
        const removes = extractRemoves(result)!;
        expect(removes.map((r) => r.table)).toEqual(['thumbs', 'thumbs']);
        expect(removes.map((r) => r.id)).toEqual([1, 2]);
    });

    it('keeps REMOVE_KEY non-enumerable so spreads drop it', () => {
        const result = emit({
            state: { n: 1 },
            effects: [remove(thumbs, 7)],
        });
        const spread = { ...result };
        expect(extractRemoves(spread as Record<string, unknown>)).toBeUndefined();
        expect(extractRemoves(result as Record<string, unknown>)).toHaveLength(1);
    });

    it('JSON.stringify does not serialize the remove effect payload', () => {
        const result = emit({
            state: { n: 1 },
            effects: [remove(thumbs, 7)],
        });
        expect(JSON.parse(JSON.stringify(result))).toEqual({ n: 1 });
    });

    it('coexists with insert, publish, and trigger in the same emit call', () => {
        const events = bus('events', { schema: z.object({ at: z.number() }) });
        const wf = { $tag: 'workflow' as const, $name: 'doThing' };
        const result = emit({
            state: { n: 1 },
            effects: [
                insert(notes, { id: 1, body: 'hi' }),
                remove(thumbs, 7),
                publish(events, { at: 0 }),
                trigger(wf, { x: 1 }),
            ],
        });
        expect(extractEmits(result)).toHaveLength(1);
        expect(extractRemoves(result)).toHaveLength(1);
        expect(extractPublishes(result)).toHaveLength(1);
        expect(extractTriggers(result)).toHaveLength(1);
    });

    it('preserves order within the remove array', () => {
        const result = emit({
            state: { n: 0 },
            effects: [remove(thumbs, 1), remove(thumbs, 2), remove(thumbs, 3)],
        });
        expect(extractRemoves(result)!.map((r) => r.id)).toEqual([1, 2, 3]);
    });

    it('returns undefined from extractRemoves when no removes emitted', () => {
        const result = emit({
            state: { n: 1 },
            effects: [insert(notes, { id: 1, body: 'hi' })],
        });
        expect(extractRemoves(result)).toBeUndefined();
    });
});

describe('remove() via defineEntity', () => {
    it('entity handler can emit an insert + remove pair (toggle pattern)', () => {
        const thumbEntity = defineEntity('thumb', {
            state: { thumbId: integer({ merge: false }) },
            handlers: {
                toggle(state, thumbIdArg: number, noteId: number, userId: string) {
                    // If we know the row id, remove it; otherwise insert.
                    if (state.thumbId !== 0) {
                        return emit({
                            state: { thumbId: 0 },
                            effects: [remove(thumbs, state.thumbId)],
                        }) as unknown as typeof state;
                    }
                    return emit({
                        state: { thumbId: thumbIdArg },
                        effects: [insert(thumbs, { id: thumbIdArg, noteId, userId })],
                    }) as unknown as typeof state;
                },
            },
        });

        // First call: no existing row → emit insert.
        const afterInsert = thumbEntity.$handlers.toggle({ thumbId: 0 }, 99, 5, 'alice');
        expect(afterInsert.thumbId).toBe(99);
        expect(extractEmits(afterInsert as unknown as Record<string, unknown>)).toHaveLength(1);
        expect(extractRemoves(afterInsert as unknown as Record<string, unknown>)).toBeUndefined();

        // Second call: row exists → emit remove.
        const afterRemove = thumbEntity.$handlers.toggle({ thumbId: 99 }, 99, 5, 'alice');
        expect(afterRemove.thumbId).toBe(0);
        expect(extractRemoves(afterRemove as unknown as Record<string, unknown>)).toHaveLength(1);
        expect(extractRemoves(afterRemove as unknown as Record<string, unknown>)![0]).toEqual({
            table: 'thumbs',
            id: 99,
        });
        expect(extractEmits(afterRemove as unknown as Record<string, unknown>)).toBeUndefined();
    });
});

describe('REMOVE_KEY', () => {
    it('is a process-wide registered symbol (survives module reload)', () => {
        expect(REMOVE_KEY).toBe(Symbol.for('syncengine.remove'));
    });
});
