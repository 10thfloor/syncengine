// ── edge() — @experimental ──────────────────────────────────────────────────
//
// A thin typed sugar over a synthesized table. Edges ARE tables with a
// `(from, to)` shape plus typed Gremlin-style traversal steps. Writes
// go through the normal three-verb CRUD on `edge.$table`; reads compose
// via `.out(id)` / `.in(id)` / `.has(col, val)` / `.values()`.
//
// Deliberately minimal:
//   - No runtime cardinality enforcement (`$cardinality` is a type-level hint).
//     Hard cardinality invariants belong on entities, not edges.
//   - No `link` / `unlink` effects — use `insert(edge.$table, ...)` /
//     `remove(edge.$table, id)` in emit, or `s.tables.<edgeName>.*` on
//     the client.
//   - No recursive / fixpoint traversal. `.out(edge)` hops one level; chain
//     for n hops. Transitive closure is out of scope — if you need it,
//     compose N hops explicitly or write your own fixpoint in a handler.
//   - No client hook (`useEdge`), no `edges:` block on entities. Use the
//     existing `useView` / `s.tables` / `s.useView` surface.
//
// Status: @experimental. API will iterate based on real usage; keep an
// eye on the CHANGELOG when upgrading.

import {
    table, id, integer, view,
    type Table, type AnyTable, type ColumnDef, type ColumnRef,
    type ViewBuilder,
} from './schema';

// ── Cardinality — type-level hint only ───────────────────────────────────────

/** Compile-time cardinality hint. Carried through `$cardinality` so
 *  downstream helpers could narrow neighbor types in the future — NOT
 *  enforced at write time. If you need runtime enforcement ("this user
 *  has exactly one manager"), model it as an entity state field with
 *  a handler that serializes the mutation. */
export const Cardinality = {
    OneToOne:   'OneToOne',
    OneToMany:  'OneToMany',
    ManyToOne:  'ManyToOne',
    ManyToMany: 'ManyToMany',
} as const;
export type Cardinality = typeof Cardinality[keyof typeof Cardinality];

// ── Helper types ─────────────────────────────────────────────────────────────

type InferType<C> = C extends ColumnDef<infer T> ? T : never;

/** The inner type of a table's primary-key column. */
type IdOf<T extends AnyTable> =
    T['$columns'][T['$idKey']] extends ColumnDef<infer U> ? U : never;

/** Columns synthesized into an edge's backing table. */
type EdgeColumns<
    TFrom extends AnyTable,
    TTo extends AnyTable,
    TProps extends Record<string, ColumnDef<unknown>>,
> = {
    id: ColumnDef<number>;
    from: ColumnDef<IdOf<TFrom>>;
    to: ColumnDef<IdOf<TTo>>;
} & TProps;

// ── EdgeDef ──────────────────────────────────────────────────────────────────

/** An edge between two tables. The synthesized backing table is at
 *  `$table`; user-defined edge props are hoisted as column refs directly
 *  on the edge (e.g. `tagged.weight`). The synthetic `from`/`to` columns
 *  are NOT hoisted — use `.out(id)` / `.in(id)` for directional traversal. */
export type EdgeDef<
    TName extends string,
    TFrom extends AnyTable,
    TTo extends AnyTable,
    TCard extends Cardinality,
    TProps extends Record<string, ColumnDef<unknown>>,
> = {
    readonly $tag: 'edge';
    readonly $name: TName;
    readonly $from: TFrom;
    readonly $to: TTo;
    readonly $cardinality: TCard;
    readonly $props: TProps;
    readonly $table: Table<TName, EdgeColumns<TFrom, TTo, TProps>>;

    /** Start a traversal from a source id — "edges out of `fromId`". */
    out(fromId: IdOf<TFrom>): EdgeStep<TFrom, TTo, TProps>;

    /** Start a traversal into a target id — "edges into `toId`". */
    in(toId: IdOf<TTo>): EdgeStep<TFrom, TTo, TProps>;
} & {
    // User-defined props only. Readers grab `tagged.weight`; they never
    // need `tagged.from` / `tagged.to` because traversal is via the
    // `.out` / `.in` methods above.
    readonly [K in keyof TProps & string]:
        ColumnRef<TName, K, InferType<TProps[K]>>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEdge = EdgeDef<string, AnyTable, AnyTable, Cardinality, any>;

// ── EdgeStep — Gremlin-style traversal ───────────────────────────────────────

/** A traversal step. Intermediate shape returned by `edge.out(id)` /
 *  `edge.in(id)` and by hops through `.out(nextEdge)` / `.in(nextEdge)`.
 *  Terminal via `.values()`. */
export interface EdgeStep<
    TFrom extends AnyTable,
    TTo extends AnyTable,
    TProps extends Record<string, ColumnDef<unknown>>,
> {
    /** Filter on an edge prop. @experimental — only `'eq'` today,
     *  inheriting the view DSL's current filter op set. */
    has<K extends keyof TProps & string>(
        col: ColumnRef<string, K, InferType<TProps[K]>>,
        op: 'eq',
        val: InferType<TProps[K]>,
    ): EdgeStep<TFrom, TTo, TProps>;

    /** Hop forward through another edge. The next edge's source must
     *  match the current step's target (compile-time enforced). */
    out<NE extends AnyEdge>(
        nextEdge: NE & { readonly $from: TTo },
    ): EdgeStep<TFrom, NE['$to'], NE['$props']>;

    /** Hop backward through another edge — next edge points *into* the
     *  current target. */
    in<NE extends AnyEdge>(
        nextEdge: NE & { readonly $to: TTo },
    ): EdgeStep<TFrom, NE['$from'], NE['$props']>;

    /** Terminal: a ViewBuilder of target records. Compose further with
     *  the view DSL (`.filter`, `.topN`, etc.) or pass to `s.useView`. */
    values(): ViewBuilder<TTo['$record']>;
}

// ── Runtime implementation ───────────────────────────────────────────────────

/**
 * EdgeStep is stateful: it accumulates a pipeline over the edge backing
 * table (and any hops) and produces a final ViewBuilder on `.values()`.
 *
 * Invariant: at all times `this.builder` is a ViewBuilder whose current
 * record shape has `to` referring to rows in `this.targetTable` by id.
 * Hops advance both `builder` (via `.join`) and `targetTable`.
 */
class EdgeStepImpl<
    TFrom extends AnyTable,
    TTo extends AnyTable,
    TProps extends Record<string, ColumnDef<unknown>>,
> implements EdgeStep<TFrom, TTo, TProps> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly builder: ViewBuilder<any>;
    private readonly targetTable: AnyTable;

    constructor(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        builder: ViewBuilder<any>,
        targetTable: AnyTable,
    ) {
        this.builder = builder;
        this.targetTable = targetTable;
    }

    has<K extends keyof TProps & string>(
        col: ColumnRef<string, K, InferType<TProps[K]>>,
        _op: 'eq',
        val: InferType<TProps[K]>,
    ): EdgeStep<TFrom, TTo, TProps> {
        // filter() today only supports 'eq'; if/when the view DSL gains
        // gt/lt, widen has()'s op union and thread through.
        return new EdgeStepImpl<TFrom, TTo, TProps>(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this.builder as any).filter(col, 'eq', val),
            this.targetTable,
        );
    }

    out<NE extends AnyEdge>(
        nextEdge: NE & { readonly $from: TTo },
    ): EdgeStep<TFrom, NE['$to'], NE['$props']> {
        // Join through the next edge's backing table: match the current
        // target's id against the next edge's `from`.
        const next = nextEdge.$table;
        return new EdgeStepImpl(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this.builder as any).join(next, 'to', 'from'),
            nextEdge.$to,
        );
    }

    in<NE extends AnyEdge>(
        nextEdge: NE & { readonly $to: TTo },
    ): EdgeStep<TFrom, NE['$from'], NE['$props']> {
        // Join: current target's id matches next edge's `to`.
        const next = nextEdge.$table;
        return new EdgeStepImpl(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this.builder as any).join(next, 'to', 'to'),
            nextEdge.$from,
        );
    }

    values(): ViewBuilder<TTo['$record']> {
        // Join the current step to the target table and present the
        // result as TTo['$record']. The underlying view may carry extra
        // columns from intermediate edges; the type narrows the contract,
        // callers see only the target record shape in autocomplete.
        return (
            this.builder
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                .join(this.targetTable, 'to', this.targetTable.$idKey as any) as unknown
        ) as ViewBuilder<TTo['$record']>;
    }
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Declare a typed edge between two tables. Compiles to a synthesized
 * CRDT table (`edge.$table`) with `id`, `from`, `to`, plus any props.
 * Writes go through the normal three-verb CRUD on the backing table;
 * reads compose via Gremlin-style `.out(id)` / `.in(id)` / `.has(col, val)` /
 * `.values()`.
 *
 * @experimental — API will iterate based on real usage.
 *
 * @example
 * ```ts
 * const follows = edge('follows', users, users);
 * const authored = edge('authored', users, posts, {
 *     cardinality: Cardinality.OneToMany,
 * });
 * const tagged = edge('tagged', posts, tags, {
 *     props: { weight: real({ merge: 'max' }) },
 * });
 *
 * // Write: direct on the backing table.
 * s.tables.follows.insert({ from: alice, to: bob });
 *
 * // Read: traversal steps terminated by `.values()`.
 * const following = follows.out(alice).values();
 * const fof = follows.out(alice).out(follows).values();
 * const hotTags = tagged.out(postId).has(tagged.weight, 'eq', 1).values();
 * ```
 */
export function edge<
    TName extends string,
    TFrom extends AnyTable,
    TTo extends AnyTable,
    TCard extends Cardinality = typeof Cardinality.ManyToMany,
    TProps extends Record<string, ColumnDef<unknown>> = Record<string, never>,
>(
    name: TName,
    fromTable: TFrom,
    toTable: TTo,
    options?: {
        cardinality?: TCard;
        props?: TProps;
    },
): EdgeDef<TName, TFrom, TTo, TCard, TProps> {
    const props = options?.props ?? ({} as TProps);
    const cardinality = (options?.cardinality ?? Cardinality.ManyToMany) as TCard;

    // Synthesize backing table. `from`/`to` are integer columns —
    // matches `id()`'s numeric shape. When/if text PKs land, widen here.
    const $table = table(name, {
        id: id(),
        from: integer(),
        to: integer(),
        ...props,
    } as EdgeColumns<TFrom, TTo, TProps>) as Table<TName, EdgeColumns<TFrom, TTo, TProps>>;

    const edgeDef: EdgeDef<TName, TFrom, TTo, TCard, TProps> = {
        $tag: 'edge' as const,
        $name: name,
        $from: fromTable,
        $to: toTable,
        $cardinality: cardinality,
        $props: props,
        $table,

        out(fromId) {
            return new EdgeStepImpl<TFrom, TTo, TProps>(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                view($table).filter('from' as any, 'eq', fromId as any),
                toTable,
            );
        },

        in(toId) {
            return new EdgeStepImpl<TFrom, TTo, TProps>(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                view($table).filter('to' as any, 'eq', toId as any),
                fromTable,
            );
        },

        // User-defined prop column refs, hoisted. Index into the
        // synthesized $table to get the same ColumnRef objects the table
        // already carries, keyed by prop name only (not `id`/`from`/`to`).
        ...Object.fromEntries(
            Object.keys(props).map((propName) => [
                propName,
                ($table as unknown as Record<string, unknown>)[propName],
            ]),
        ),
    } as EdgeDef<TName, TFrom, TTo, TCard, TProps>;

    return edgeDef;
}

export function isEdge(x: unknown): x is AnyEdge {
    return typeof x === 'object' && x !== null && (x as { $tag?: unknown }).$tag === 'edge';
}
