// ── Column type definitions ─────────────────────────────────────────────────

export type MergeStrategy = 'lww' | 'set_union' | 'max' | 'min' | 'add';

interface ColumnDef<T> {
    readonly _type: T;
    readonly sqlType: string;
    readonly nullable: boolean;
    readonly primaryKey: boolean;
    readonly merge?: MergeStrategy;
}

// Column constructors — each carries its TS type via the phantom _type field
export function id(): ColumnDef<number> {
    return { _type: 0 as never, sqlType: 'INTEGER PRIMARY KEY', nullable: false, primaryKey: true };
}

export function integer(opts?: { merge?: MergeStrategy }): ColumnDef<number> {
    return { _type: 0 as never, sqlType: 'INTEGER', nullable: false, primaryKey: false, merge: opts?.merge };
}

export function real(opts?: { merge?: MergeStrategy }): ColumnDef<number> {
    return { _type: 0 as never, sqlType: 'REAL', nullable: false, primaryKey: false, merge: opts?.merge };
}

export function text(opts?: { merge?: MergeStrategy }): ColumnDef<string> {
    return { _type: '' as never, sqlType: 'TEXT', nullable: false, primaryKey: false, merge: opts?.merge };
}

export function boolean(opts?: { merge?: MergeStrategy }): ColumnDef<boolean> {
    return { _type: false as never, sqlType: 'INTEGER', nullable: false, primaryKey: false, merge: opts?.merge };
}

// ── Table definition ────────────────────────────────────────────────────────

// Infer the record type from a columns object
type InferRecord<C extends Record<string, ColumnDef<unknown>>> = {
    [K in keyof C]: C[K] extends ColumnDef<infer T> ? T : never;
};

export interface TableDef<
    TName extends string = string,
    TCols extends Record<string, ColumnDef<unknown>> = Record<string, ColumnDef<unknown>>,
> {
    readonly _tag: 'table';
    readonly name: TName;
    readonly columns: TCols;
    readonly _record: InferRecord<TCols>;
}

export function table<
    TName extends string,
    TCols extends Record<string, ColumnDef<unknown>>,
>(name: TName, columns: TCols): TableDef<TName, TCols> {
    return {
        _tag: 'table',
        name,
        columns,
        _record: undefined as never,
    };
}

// ── Aggregate helpers ───────────────────────────────────────────────────────

interface AggDef {
    readonly fn: string;
    readonly field: string;
}

export function sum(field: string): AggDef {
    return { fn: 'sum', field };
}

export function count(): AggDef {
    return { fn: 'count', field: '*' };
}

export function avg(field: string): AggDef {
    return { fn: 'avg', field };
}

export function min(field: string): AggDef {
    return { fn: 'min', field };
}

export function max(field: string): AggDef {
    return { fn: 'max', field };
}

// ── Operator types (matches Rust engine) ────────────────────────────────────

type Operator =
    | { op: 'filter'; field: string; eq: unknown }
    | { op: 'project'; fields: string[] }
    | { op: 'topN'; sort_by: string; limit: number; order: string }
    | { op: 'aggregate'; group_by: string[]; aggregates: Record<string, AggDef> }
    | { op: 'distinct'; key: string }
    | { op: 'join'; right_table: string; left_key: string; right_key: string };

// ── Monotonicity classification ─────────────────────────────────────────────

export type Monotonicity = 'monotonic' | 'non_monotonic' | 'unknown';

function classifyPipeline(pipeline: Operator[]): Monotonicity {
    // monotonic ops: filter, project, aggregate (sum/count/avg/min/max are all monotonic in DBSP's Z-set algebra)
    // non-monotonic ops: topN, distinct, join (join is monotonic in theory but our impl needs coordination for consistency)
    for (const op of pipeline) {
        if (op.op === 'topN' || op.op === 'distinct') return 'non_monotonic';
        if (op.op === 'join') return 'non_monotonic';
    }
    return pipeline.length === 0 ? 'unknown' : 'monotonic';
}

// ── View builder ────────────────────────────────────────────────────────────

export interface ViewDef<TRecord = unknown> {
    readonly _tag: 'view';
    readonly name: string;
    readonly tableName: string;
    readonly idKey: string;
    readonly pipeline: Operator[];
    readonly sourceTables: string[];
    readonly monotonicity: Monotonicity;
    readonly _record: TRecord;
    filter<K extends string & keyof TRecord>(
        field: K,
        op: 'eq',
        value: TRecord[K],
    ): ViewDef<TRecord>;
    project<K extends string & keyof TRecord>(
        ...fields: K[]
    ): ViewDef<Pick<TRecord, K>>;
    topN(
        sortBy: string & keyof TRecord,
        limit: number,
        order?: 'asc' | 'desc',
    ): ViewDef<TRecord>;
    aggregate<
        GK extends string & keyof TRecord,
        Aggs extends Record<string, AggDef>,
    >(
        groupBy: GK[],
        aggregates: Aggs,
    ): ViewDef<Pick<TRecord, GK> & { [K in keyof Aggs]: number }>;
    distinct(): ViewDef<TRecord>;
    join<RTable extends TableDef>(
        rightTable: RTable,
        leftKey: string & keyof TRecord,
        rightKey: string & keyof RTable['_record'],
    ): ViewDef<TRecord & RTable['_record']>;
}

function createViewBuilder<TRecord>(
    name: string,
    tableName: string,
    idKey: string,
    pipeline: Operator[],
    sourceTables?: string[],
): ViewDef<TRecord> {
    const tables = sourceTables ?? [tableName];
    return {
        _tag: 'view',
        name,
        tableName,
        idKey,
        pipeline,
        sourceTables: tables,
        monotonicity: classifyPipeline(pipeline),
        _record: undefined as never,

        filter(field, _op, value) {
            return createViewBuilder(name, tableName, idKey, [
                ...pipeline,
                { op: 'filter', field, eq: value },
            ], tables);
        },

        project(...fields) {
            return createViewBuilder(name, tableName, idKey, [
                ...pipeline,
                { op: 'project', fields },
            ], tables) as never;
        },

        topN(sortBy, limit, order = 'desc') {
            return createViewBuilder(name, tableName, idKey, [
                ...pipeline,
                { op: 'topN', sort_by: sortBy, limit, order },
            ], tables);
        },

        aggregate(groupBy, aggregates) {
            const aggIdKey = groupBy.length === 1 ? groupBy[0] : idKey;
            return createViewBuilder(name, tableName, aggIdKey, [
                ...pipeline,
                { op: 'aggregate', group_by: groupBy, aggregates },
            ], tables) as never;
        },

        distinct() {
            return createViewBuilder(name, tableName, idKey, [
                ...pipeline,
                { op: 'distinct', key: idKey },
            ], tables);
        },

        join(rightTable, leftKey, rightKey) {
            return createViewBuilder(name, tableName, idKey, [
                ...pipeline,
                { op: 'join', right_table: rightTable.name, left_key: leftKey as string, right_key: rightKey as string },
            ], [...tables, rightTable.name]) as never;
        },
    };
}

export function view<TTable extends TableDef>(
    name: string,
    sourceTable: TTable,
): ViewDef<TTable['_record']> {
    // Find the primary key column
    const idKey = Object.entries(sourceTable.columns)
        .find(([, col]) => col.primaryKey)?.[0] ?? 'id';

    return createViewBuilder(name, sourceTable.name, idKey, []);
}

// ── Merge config extraction ─────────────────────────────────────────────────

export function extractMergeConfig(t: TableDef): { table: string; fields: Record<string, string> } | null {
    const fields: Record<string, string> = {};
    for (const [name, col] of Object.entries(t.columns)) {
        if (col.merge) {
            fields[name] = col.merge;
        }
    }
    if (Object.keys(fields).length === 0) return null;
    return { table: t.name, fields };
}
