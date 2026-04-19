import { describe, it, expect } from 'vitest';
import {
    edge, isEdge, Cardinality,
    table, id, text, real, integer,
} from '../index';

const users = table('users', {
    id: id(),
    name: text(),
});

const posts = table('posts', {
    id: id(),
    body: text(),
});

const tags = table('tags', {
    id: id(),
    label: text(),
});

describe('edge() — shape', () => {
    it('returns a typed edge with default ManyToMany cardinality', () => {
        const follows = edge('follows', users, users);
        expect(follows.$tag).toBe('edge');
        expect(follows.$name).toBe('follows');
        expect(follows.$from).toBe(users);
        expect(follows.$to).toBe(users);
        expect(follows.$cardinality).toBe(Cardinality.ManyToMany);
        expect(follows.$props).toEqual({});
    });

    it('respects an explicit cardinality hint', () => {
        const authored = edge('authored', users, posts, {
            cardinality: Cardinality.OneToMany,
        });
        expect(authored.$cardinality).toBe(Cardinality.OneToMany);
    });

    it('synthesizes a backing table with id/from/to and any props', () => {
        const tagged = edge('tagged', posts, tags, {
            props: {
                weight: real({ merge: 'max' }),
                addedAt: integer(),
            },
        });
        expect(tagged.$table.$tag).toBe('table');
        expect(tagged.$table.$name).toBe('tagged');
        const colNames = Object.keys(tagged.$table.$columns).sort();
        expect(colNames).toEqual(['addedAt', 'from', 'id', 'to', 'weight']);
    });

    it('hoists user-defined prop column refs onto the edge', () => {
        const tagged = edge('tagged', posts, tags, {
            props: { weight: real(), addedAt: integer() },
        });
        // `tagged.weight` and `tagged.addedAt` read as column refs,
        // same objects as on the backing table.
        expect((tagged as unknown as { weight: unknown }).weight)
            .toBe((tagged.$table as unknown as { weight: unknown }).weight);
        expect((tagged as unknown as { addedAt: unknown }).addedAt)
            .toBe((tagged.$table as unknown as { addedAt: unknown }).addedAt);
    });

    it('does NOT hoist the synthetic from/to/id columns onto the edge surface', () => {
        const follows = edge('follows', users, users);
        // These MUST only exist on `$table`, not directly on the edge,
        // so users reach them via typed traversal (`.out(id)`/`.in(id)`)
        // rather than typing the synthetic column names.
        expect((follows as unknown as Record<string, unknown>).from).toBeUndefined();
        expect((follows as unknown as Record<string, unknown>).to).toBeUndefined();
        expect((follows as unknown as Record<string, unknown>).id).toBeUndefined();
    });

    it('isEdge discriminator', () => {
        const follows = edge('follows', users, users);
        expect(isEdge(follows)).toBe(true);
        expect(isEdge(users)).toBe(false);
        expect(isEdge(null)).toBe(false);
        expect(isEdge({})).toBe(false);
    });
});

describe('edge() — traversal steps', () => {
    it('.out(id) produces a ViewBuilder pipeline via .values()', () => {
        const follows = edge('follows', users, users);
        const view = follows.out(1).values();
        expect(view.$tag).toBe('view');
        // The pipeline includes a filter on `from` and a join to users.
        const pipelineOps = view.$pipeline.map((o) => o.op);
        expect(pipelineOps).toContain('filter');
        expect(pipelineOps).toContain('join');
    });

    it('.in(id) produces a ViewBuilder pipeline via .values()', () => {
        const follows = edge('follows', users, users);
        const view = follows.in(1).values();
        expect(view.$tag).toBe('view');
        const pipelineOps = view.$pipeline.map((o) => o.op);
        expect(pipelineOps).toContain('filter');
        expect(pipelineOps).toContain('join');
    });

    it('.has(col, "eq", val) adds a filter on an edge prop', () => {
        const tagged = edge('tagged', posts, tags, {
            props: { weight: real() },
        });
        const view = tagged.out(10).has(tagged.weight, 'eq', 1).values();
        const filters = view.$pipeline.filter((o) => o.op === 'filter');
        expect(filters.length).toBe(2); // one for `from=10`, one for `weight=1`
    });

    it('.out(nextEdge) hops through another edge', () => {
        const follows = edge('follows', users, users);
        // Friends-of-friends traversal — two hops.
        const view = follows.out(1).out(follows).values();
        const pipelineOps = view.$pipeline.map((o) => o.op);
        // Two joins (one per hop to the next edge, one final to target table).
        expect(pipelineOps.filter((op) => op === 'join').length).toBeGreaterThanOrEqual(2);
    });

    it('.out(edge).out(differentEdge) composes across edge types', () => {
        const follows = edge('follows', users, users);
        const authored = edge('authored', users, posts, {
            cardinality: Cardinality.OneToMany,
        });
        // Posts by people alice follows.
        const view = follows.out(1).out(authored).values();
        expect(view.$tag).toBe('view');
    });
});
