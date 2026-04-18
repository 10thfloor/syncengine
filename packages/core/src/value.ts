// ── Value Objects (Phase A — scalar form, brand + invariant + ops + surface)
//
// `defineValue()` is the sixth primitive: branded domain types with
// invariants, named factories, and pure-function ops. Two shapes
// land across the phase:
//
//   - Scalar:     `defineValue('email', text(), { ... })`
//                 wraps a single ColumnDef; native storage;
//                 invariant checks the raw primitive.
//
//   - Composite:  `defineValue('money', { amount: int(), currency: text() }, { ... })`
//                 groups several columns into an atomic unit;
//                 JSON-encoded TEXT storage; invariant checks the shape.
//                 [Lands in Phase A2.]
//
// Branding is a compile-time concept: every `defineValue(name, ...)`
// produces a distinct `Brand<name>` type parameter, so `UserId.T` and
// `OrderId.T` are non-interchangeable even when both wrap `text()`.
// The runtime carries the brand via the phantom `.T` property (always
// undefined at runtime) and via the `Symbol.for('syncengine.value')`-keyed
// brand tag — present on every branded object, invisible to JSON.

import { z, type ZodType } from 'zod';
import { errors, SchemaCode } from './errors';
import type { ColumnDef } from './schema';

// ── Brand machinery ───────────────────────────────────────────────────────
//
// Type-level: a unique declared-but-unused symbol serves as the brand
// property name. Template-literal `TName` parameterises it, so two
// branded types with different names don't unify.
//
// Runtime: a module-level Map<string, symbol> returns the same brand
// symbol for a given name across every import in a process. We stamp
// it onto branded objects (non-enumerable, Symbol-keyed) so JSON.stringify
// strips it transparently but `.is()` can still detect it.

declare const VALUE_BRAND: unique symbol;
export type Brand<TName extends string> = {
    readonly [VALUE_BRAND]: TName;
};

/** The branded shape: `T` intersected with the type-level brand. Users
 *  never instantiate this directly — `create` factories do that. */
export type Branded<T, TName extends string> = T & Brand<TName>;

const BRAND_KEY = Symbol.for('syncengine.value.brand');
const NAME_BRANDS = new Map<string, symbol>();

function stampBrand<T>(value: T, name: string): T {
    // Allocate once per name, re-attach on every construction. The
    // symbol is the same across imports (Map is module-singleton),
    // so Email.from('a') === Email.from('b') brand-wise — `.is()` can
    // detect either. Use defineProperty so the symbol is non-enumerable
    // (invisible to JSON.stringify + Object.keys).
    let sym = NAME_BRANDS.get(name);
    if (!sym) {
        sym = Symbol(`syncengine.value.${name}`);
        NAME_BRANDS.set(name, sym);
    }
    if (typeof value === 'object' && value !== null) {
        Object.defineProperty(value, BRAND_KEY, {
            value: name,
            enumerable: false,
            configurable: true,
            writable: false,
        });
    }
    // For scalar primitives (string, number, boolean) we can't attach a
    // property. The type system still enforces non-interchangeability;
    // `.is()` falls back to invariant-based detection on unbranded scalars.
    return value;
}

function hasBrand(v: unknown, name: string): boolean {
    if (v === null || typeof v !== 'object') return false;
    const stored = (v as Record<symbol, unknown>)[BRAND_KEY];
    return stored === name;
}

// ── Types ─────────────────────────────────────────────────────────────────

/** User-supplied options for a scalar value object. All fields are
 *  optional. */
export interface ScalarValueOptions<
    TRaw,
    TCreate extends Record<string, (...args: any[]) => TRaw> = Record<string, never>,
    TOps extends Record<string, (v: TRaw, ...args: any[]) => unknown> = Record<string, never>,
> {
    /** Returns true when `v` is a valid instance. Throws are caught and
     *  converted to a schema-code error. */
    readonly invariant?: (v: TRaw) => boolean;
    /** Factory methods: `Money.usd(100)` produces a branded value. Each
     *  function receives user args and returns a raw value; the framework
     *  validates + brands before returning to the caller. */
    readonly create?: TCreate;
    /** Pure-function ops. `(value, ...args) => whatever`. Scalar ops are
     *  passthrough — no auto-rebranding; the user is responsible for
     *  calling `Money.from(...)` explicitly when an op wants to return
     *  a new branded value. */
    readonly ops?: TOps;
}

/** The shape `defineValue` returns for a scalar form. Callable as a
 *  column factory; exposes `.T` for type extraction, named factories,
 *  ops, and the standard surface. */
export interface ScalarValueDef<
    TName extends string,
    TRaw,
    TCreate extends Record<string, (...args: any[]) => TRaw>,
    TOps extends Record<string, (v: TRaw, ...args: any[]) => unknown>,
> {
    /** Callable as a column factory. No options yet — defaults +
     *  nullability are Phase B surface. */
    (): ColumnDef<Branded<TRaw, TName>>;

    /** Phantom type slot — use `typeof Money.T` or the
     *  `ValueType<typeof Money>` helper to pull out the branded shape. */
    readonly T: Branded<TRaw, TName>;

    /** Value object's declared name — primary identity for branding. */
    readonly $name: TName;

    /** Zod schema — round-trips through NATS / HTTP boundaries. */
    readonly zod: ZodType<Branded<TRaw, TName>>;

    /** Deep structural equality. Scalars: strict primitive compare. */
    equals(a: Branded<TRaw, TName>, b: Branded<TRaw, TName>): boolean;

    /** Runtime guard — returns `x is Branded<TRaw, TName>`. For scalars,
     *  checks primitive type + invariant (the brand symbol isn't
     *  attachable to primitives). */
    is(x: unknown): x is Branded<TRaw, TName>;

    /** Test-only escape hatch — brands the raw value without running
     *  the invariant. Loud naming is deliberate; production code
     *  should never reach for this. */
    unsafe(raw: TRaw): Branded<TRaw, TName>;

    /** User-defined factories, re-typed to return branded values. */
    readonly create: {
        readonly [K in keyof TCreate]: TCreate[K] extends (...args: infer A) => TRaw
            ? (...args: A) => Branded<TRaw, TName>
            : never;
    };

    /** User-defined ops. Returns flow through untouched — scalar ops
     *  don't auto-rebrand. The first arg is implicitly typed as the
     *  branded value. */
    readonly ops: {
        readonly [K in keyof TOps]: TOps[K] extends (v: TRaw, ...args: infer A) => infer R
            ? (v: Branded<TRaw, TName>, ...args: A) => R
            : never;
    };
}

/** Extract the branded type from a value-def. Usage:
 *    type M = ValueType<typeof Money>;
 *  Equivalent to `typeof Money.T` but works in contexts where the
 *  phantom `.T` access would be awkward (e.g. function-param positions
 *  with heavy generic context). */
export type ValueType<V> = V extends { readonly T: infer T } ? T : never;

// ── Composite form types ──────────────────────────────────────────────────

/** The raw shape a composite value wraps — a record of typed columns
 *  where each column's `$type` becomes the field type. Nested values
 *  are ColumnDefs returned by their own `defineValue` call, so they
 *  naturally unfold into the parent's shape with their branded types
 *  intact. */
export type CompositeShape = Record<string, ColumnDef<unknown>>;

/** Flatten a composite shape into its raw object type. For a shape
 *  `{ amount: integer(), currency: text({ enum: [...] }) }` this yields
 *  `{ amount: number, currency: 'USD' | 'EUR' | ... }`. Nested value
 *  columns contribute their already-branded types. */
export type ShapeOf<S extends CompositeShape> = {
    readonly [K in keyof S]: S[K] extends ColumnDef<infer T> ? T : never;
};

export interface CompositeValueOptions<
    S extends CompositeShape,
    TCreate extends Record<string, (...args: any[]) => ShapeOf<S>> = Record<
        string,
        (...args: any[]) => ShapeOf<S>
    >,
    TOps extends Record<string, (v: ShapeOf<S>, ...args: any[]) => unknown> = Record<
        string,
        (v: ShapeOf<S>, ...args: any[]) => unknown
    >,
> {
    /** Shape + cross-field invariants. Runs at construction, op return
     *  (when the op looks self-returning), and `.is()` — see header for
     *  the auto-rebrand rules. */
    readonly invariant?: (v: ShapeOf<S>) => boolean;
    /** Named factories — `Money.usd(100)` etc. Each factory returns the
     *  raw shape (no brand); the framework validates + stamps. */
    readonly create?: TCreate;
    /** Pure ops. If the return's shape matches the composite (plain
     *  object with the same keys), it's auto-revalidated and stamped —
     *  so `Money.add(a, b)` returns a branded Money without the user
     *  doing anything. Other-shaped returns (`boolean`, `string`,
     *  `number`, nested objects that don't match) pass through. */
    readonly ops?: TOps;
}

export interface CompositeValueDef<
    TName extends string,
    S extends CompositeShape,
    TCreate extends Record<string, (...args: any[]) => ShapeOf<S>>,
    TOps extends Record<string, (v: ShapeOf<S>, ...args: any[]) => unknown>,
> {
    /** Callable as a column factory. Composite columns store as
     *  JSON-encoded TEXT — the shape is atomic on the wire (LWW on the
     *  whole object). */
    (): ColumnDef<Branded<ShapeOf<S>, TName>>;

    readonly T: Branded<ShapeOf<S>, TName>;
    readonly $name: TName;
    /** The declared shape. Exposed for introspection (column runtime
     *  validation, zod derivation, nested composite traversal). */
    readonly $shape: S;
    readonly zod: ZodType<Branded<ShapeOf<S>, TName>>;

    equals(a: Branded<ShapeOf<S>, TName>, b: Branded<ShapeOf<S>, TName>): boolean;
    is(x: unknown): x is Branded<ShapeOf<S>, TName>;
    unsafe(raw: ShapeOf<S>): Branded<ShapeOf<S>, TName>;

    readonly create: {
        readonly [K in keyof TCreate]: TCreate[K] extends (...args: infer A) => ShapeOf<S>
            ? (...args: A) => Branded<ShapeOf<S>, TName>
            : never;
    };

    readonly ops: {
        readonly [K in keyof TOps]: TOps[K] extends (v: ShapeOf<S>, ...args: infer A) => infer R
            // If the op return-type matches the raw shape, it's auto-
            // rebranded at runtime — reflect that in the type by
            // mapping `R` → `Branded<R, TName>` when R is assignable
            // to the shape.
            ? (v: Branded<ShapeOf<S>, TName>, ...args: A) => R extends ShapeOf<S>
                ? Branded<ShapeOf<S>, TName>
                : R
            : never;
    };
}

/** Shared brand between scalar and composite value defs — lets callers
 *  accept either form without caring which. */
export interface AnyValueDef {
    readonly $name: string;
    readonly zod: ZodType<unknown>;
    readonly is: (x: unknown) => boolean;
    readonly equals: (a: never, b: never) => boolean;
    readonly unsafe: (raw: never) => unknown;
}

// ── defineValue — scalar form ──────────────────────────────────────────────

/** Internal: run an invariant, converting `false` / `throw` into the
 *  framework's canonical schema error so callers see a consistent shape
 *  whether the invariant returned `false` or threw. */
function runInvariant<TRaw>(
    name: string,
    invariant: ((v: TRaw) => boolean) | undefined,
    value: TRaw,
): void {
    if (!invariant) return;
    let ok: boolean;
    try {
        ok = invariant(value);
    } catch (err) {
        throw errors.schema(SchemaCode.INVALID_VALUE, {
            message: `${name}: invariant threw — ${err instanceof Error ? err.message : String(err)}`,
            context: { value: name, raw: value as unknown },
        });
    }
    if (!ok) {
        throw errors.schema(SchemaCode.INVALID_VALUE, {
            message: `${name}: invariant rejected value`,
            context: { value: name, raw: value as unknown },
        });
    }
}

/** Build the zod schema for a scalar value. Uses `.refine()` to thread
 *  the invariant through so `Money.zod.parse(raw)` rejects the same
 *  shapes as `Money.is(raw)`. */
function buildScalarZod<TRaw>(
    name: string,
    column: ColumnDef<TRaw>,
    invariant: ((v: TRaw) => boolean) | undefined,
): ZodType<TRaw> {
    let base: ZodType<unknown>;
    switch (column.kind) {
        case 'text': case 'id': base = z.string(); break;
        case 'integer': case 'real': base = z.number(); break;
        case 'boolean': base = z.boolean(); break;
        default:
            throw new Error(`defineValue(${name}): unsupported column kind ${column.kind}`);
    }
    if (column.enum && column.enum.length > 0) {
        // Narrow to enum members. zod's `z.enum` wants string-only
        // arrays, but `ColumnDef.enum` may hold numeric enums too —
        // fall back to `refine` in that case.
        const allowed = new Set(column.enum as readonly unknown[]);
        if (column.kind === 'text' || column.kind === 'id') {
            base = z.enum(column.enum as unknown as readonly [string, ...string[]]);
        } else {
            base = base.refine((v) => allowed.has(v as never), { message: 'enum mismatch' });
        }
    }
    if (invariant) {
        base = base.refine(
            (v) => {
                try { return invariant(v as TRaw); } catch { return false; }
            },
            { message: `${name}: invariant rejected value` },
        );
    }
    return base as unknown as ZodType<TRaw>;
}

/** Overloads — TS picks the scalar form when arg 2 is a ColumnDef (has
 *  `kind` and `sqlType`) and the composite form when it's a plain
 *  shape record. */
export function defineValue<
    const TName extends string,
    S extends CompositeShape,
    TCreate extends Record<string, (...args: any[]) => ShapeOf<S>> = Record<
        string,
        (...args: any[]) => ShapeOf<S>
    >,
    TOps extends Record<string, (v: ShapeOf<S>, ...args: any[]) => unknown> = Record<
        string,
        (v: ShapeOf<S>, ...args: any[]) => unknown
    >,
>(
    name: TName,
    shape: S,
    opts?: CompositeValueOptions<S, TCreate, TOps>,
): CompositeValueDef<TName, S, TCreate, TOps>;

export function defineValue<
    const TName extends string,
    TRaw,
    TCreate extends Record<string, (...args: any[]) => TRaw> = Record<
        string,
        (...args: any[]) => TRaw
    >,
    TOps extends Record<string, (v: TRaw, ...args: any[]) => unknown> = Record<
        string,
        (v: TRaw, ...args: any[]) => unknown
    >,
>(
    name: TName,
    column: ColumnDef<TRaw>,
    opts?: ScalarValueOptions<TRaw, TCreate, TOps>,
): ScalarValueDef<TName, TRaw, TCreate, TOps>;

export function defineValue(
    name: string,
    shapeOrColumn: ColumnDef<unknown> | CompositeShape,
    opts: ScalarValueOptions<unknown> | CompositeValueOptions<CompositeShape> = {},
): unknown {
    // Implementation signature returns `unknown` to satisfy both
    // overloads — the type-level narrowing happens at the call site via
    // overload resolution.
    validateName(name);
    if (isColumnDef(shapeOrColumn)) {
        return defineScalar(
            name,
            shapeOrColumn as ColumnDef<unknown>,
            opts as ScalarValueOptions<unknown>,
        );
    }
    return defineComposite(
        name,
        shapeOrColumn as CompositeShape,
        opts as CompositeValueOptions<CompositeShape>,
    );
}

function isColumnDef(v: unknown): v is ColumnDef<unknown> {
    return (
        !!v &&
        typeof v === 'object' &&
        typeof (v as ColumnDef<unknown>).kind === 'string' &&
        typeof (v as ColumnDef<unknown>).sqlType === 'string'
    );
}

// ── Scalar implementation ────────────────────────────────────────────────

function defineScalar<
    TName extends string,
    TRaw,
    TCreate extends Record<string, (...args: any[]) => TRaw> = Record<string, (...args: any[]) => TRaw>,
    TOps extends Record<string, (v: TRaw, ...args: any[]) => unknown> = Record<string, (v: TRaw, ...args: any[]) => unknown>,
>(
    name: TName,
    column: ColumnDef<TRaw>,
    opts: ScalarValueOptions<TRaw, TCreate, TOps>,
): ScalarValueDef<TName, TRaw, TCreate, TOps> {
    const invariant = opts.invariant;
    const zodSchema = buildScalarZod(name, column, invariant);

    function isRawMatch(x: unknown): x is TRaw {
        // Shape check only — no invariant. `is()` runs the invariant
        // after this. Separates "is this even the right primitive?"
        // from "does it satisfy the value object's rules?" so error
        // messages stay crisp.
        switch (column.kind) {
            case 'text': case 'id': return typeof x === 'string';
            case 'integer': case 'real': return typeof x === 'number';
            case 'boolean': return typeof x === 'boolean';
            default: return false;
        }
    }

    function is(x: unknown): x is Branded<TRaw, TName> {
        if (hasBrand(x, name)) return true;
        if (!isRawMatch(x)) return false;
        if (!invariant) return true;
        try { return invariant(x as TRaw); } catch { return false; }
    }

    function equals(a: Branded<TRaw, TName>, b: Branded<TRaw, TName>): boolean {
        return a === b;
    }

    function unsafe(raw: TRaw): Branded<TRaw, TName> {
        // Skips invariant. Production code should never reach for this —
        // the name is loud on purpose. Still stamps the brand so
        // downstream `.is()` calls recognise it.
        return stampBrand(raw, name) as Branded<TRaw, TName>;
    }

    // Wrap user create-fns with invariant + brand.
    const wrappedCreate: Record<string, (...args: unknown[]) => unknown> = {};
    if (opts.create) {
        for (const [key, fn] of Object.entries(opts.create)) {
            wrappedCreate[key] = (...args: unknown[]) => {
                const raw = (fn as (...a: unknown[]) => TRaw)(...args);
                runInvariant(name, invariant, raw);
                return stampBrand(raw, name);
            };
        }
    }

    // Ops are passthrough for scalar — no auto-rebranding. See header
    // comment; composite auto-rebrand lands in A2.
    const wrappedOps: Record<string, (...args: unknown[]) => unknown> = {};
    if (opts.ops) {
        for (const [key, fn] of Object.entries(opts.ops)) {
            wrappedOps[key] = (...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args);
        }
    }

    // Closure slot populated after the def is built so the returned
    // column factory can stamp `$valueRef` pointing at it — lets
    // composites recurse into nested scalar value columns during shape
    // validation / rehydration.
    let selfRef: AnyValueDef | null = null;

    const factory = (): ColumnDef<Branded<TRaw, TName>> => {
        const col = {
            ...column,
            $type: undefined as never,
            $valueRef: selfRef,
        } as unknown as ColumnDef<Branded<TRaw, TName>>;
        return col;
    };

    const def = Object.assign(factory, {
        $name: name,
        T: undefined as unknown as Branded<TRaw, TName>,
        zod: zodSchema as ZodType<Branded<TRaw, TName>>,
        is,
        equals,
        unsafe,
        create: wrappedCreate as never,
        ops: wrappedOps as never,
    }) as unknown as ScalarValueDef<TName, TRaw, TCreate, TOps>;
    selfRef = def as unknown as AnyValueDef;
    return def;
}

// ── Composite implementation ─────────────────────────────────────────────

/** For each composite shape field, decide how to validate + rehydrate.
 *  If the column was produced by `SomeValueDef()`, its `$valueRef`
 *  points at the nested def so we can recurse. Primitive columns get
 *  a direct type-of check. */
interface FieldValidator {
    readonly key: string;
    readonly isValid: (v: unknown) => boolean;
    readonly rehydrate: (v: unknown) => unknown;
}

function buildFieldValidators<S extends CompositeShape>(shape: S): FieldValidator[] {
    const out: FieldValidator[] = [];
    for (const key of Object.keys(shape)) {
        const col = shape[key] as ColumnDef<unknown> & { $valueRef?: AnyValueDef };
        const nested = col.$valueRef;
        if (nested) {
            out.push({
                key,
                isValid: (v) => nested.is(v),
                rehydrate: (v) => {
                    // Unsafe-brand on rehydration — the NATS path has
                    // already validated, and re-validating on every
                    // subscribe hammers the hot path. `.is()` above
                    // decides admissibility; this just restamps.
                    return (nested.unsafe as (x: unknown) => unknown)(v);
                },
            });
            continue;
        }
        const prim: (v: unknown) => boolean = (() => {
            switch (col.kind) {
                case 'text': case 'id': return (v: unknown) => typeof v === 'string';
                case 'integer': case 'real': return (v: unknown) => typeof v === 'number';
                case 'boolean': return (v: unknown) => typeof v === 'boolean';
                default: return () => false;
            }
        })();
        out.push({ key, isValid: prim, rehydrate: (v) => v });
    }
    return out;
}

function buildCompositeZod<S extends CompositeShape>(
    name: string,
    shape: S,
    invariant: ((v: ShapeOf<S>) => boolean) | undefined,
): ZodType<ShapeOf<S>> {
    const shapeZod: Record<string, ZodType<unknown>> = {};
    for (const key of Object.keys(shape)) {
        const col = shape[key] as ColumnDef<unknown> & { $valueRef?: AnyValueDef };
        // Nested value columns use their own `.zod` — already includes
        // their enum + invariant handling. Primitive columns use the
        // scalar zod builder (no invariant, nothing user-level to run)
        // so enum narrowing, numeric refinement etc. stay consistent
        // with `defineValue('x', text({ enum }))` scalars.
        shapeZod[key] = col.$valueRef
            ? (col.$valueRef.zod as ZodType<unknown>)
            : (buildScalarZod(name, col, undefined) as ZodType<unknown>);
    }
    let base = z.object(shapeZod) as unknown as ZodType<ShapeOf<S>>;
    if (invariant) {
        base = (base as unknown as { refine: (fn: (v: ShapeOf<S>) => boolean, msg: unknown) => ZodType<ShapeOf<S>> })
            .refine(
                (v) => { try { return invariant(v); } catch { return false; } },
                { message: `${name}: invariant rejected value` },
            ) as unknown as ZodType<ShapeOf<S>>;
    }
    return base;
}

function defineComposite<
    TName extends string,
    S extends CompositeShape,
    TCreate extends Record<string, (...args: any[]) => ShapeOf<S>> = Record<string, (...args: any[]) => ShapeOf<S>>,
    TOps extends Record<string, (v: ShapeOf<S>, ...args: any[]) => unknown> = Record<string, (v: ShapeOf<S>, ...args: any[]) => unknown>,
>(
    name: TName,
    shape: S,
    opts: CompositeValueOptions<S, TCreate, TOps>,
): CompositeValueDef<TName, S, TCreate, TOps> {
    const invariant = opts.invariant;
    const validators = buildFieldValidators(shape);
    const zodSchema = buildCompositeZod(name, shape, invariant);

    function shapeMatches(x: unknown): boolean {
        if (x === null || typeof x !== 'object') return false;
        for (const v of validators) {
            const field = (x as Record<string, unknown>)[v.key];
            if (field === undefined) return false;
            if (!v.isValid(field)) return false;
        }
        return true;
    }

    function is(x: unknown): x is Branded<ShapeOf<S>, TName> {
        // Always runs the invariant, even for branded values — `unsafe`
        // bypasses invariant at construction, so a branded value can
        // still be invalid. Matches the spec: `.is()` answers "is this
        // a valid instance?", not "was this ever branded?".
        if (!shapeMatches(x)) return false;
        if (!invariant) return true;
        try { return invariant(x as ShapeOf<S>); } catch { return false; }
    }

    function equals(a: Branded<ShapeOf<S>, TName>, b: Branded<ShapeOf<S>, TName>): boolean {
        if (a === b) return true;
        if (!a || !b) return false;
        for (const v of validators) {
            const av = (a as Record<string, unknown>)[v.key];
            const bv = (b as Record<string, unknown>)[v.key];
            const col = shape[v.key] as ColumnDef<unknown> & { $valueRef?: AnyValueDef };
            if (col.$valueRef) {
                if (!(col.$valueRef.equals as (x: unknown, y: unknown) => boolean)(av, bv)) {
                    return false;
                }
            } else {
                if (av !== bv) return false;
            }
        }
        return true;
    }

    function unsafe(raw: ShapeOf<S>): Branded<ShapeOf<S>, TName> {
        // Rehydrate nested value fields so the brand chain is preserved
        // after JSON.parse. Pure primitives pass through.
        const rehydrated: Record<string, unknown> = {};
        for (const v of validators) {
            rehydrated[v.key] = v.rehydrate((raw as Record<string, unknown>)[v.key]);
        }
        return stampBrand(rehydrated as ShapeOf<S>, name) as Branded<ShapeOf<S>, TName>;
    }

    // Wrap user create-fns: run invariant + stamp brand.
    const wrappedCreate: Record<string, (...args: unknown[]) => unknown> = {};
    if (opts.create) {
        for (const [key, fn] of Object.entries(opts.create)) {
            wrappedCreate[key] = (...args: unknown[]) => {
                const raw = (fn as (...a: unknown[]) => ShapeOf<S>)(...args);
                runInvariant(name, invariant, raw);
                return unsafe(raw);
            };
        }
    }

    // Ops auto-rebrand when the return matches the composite shape.
    // Other-shaped returns pass through untouched — see header block.
    const wrappedOps: Record<string, (...args: unknown[]) => unknown> = {};
    if (opts.ops) {
        for (const [key, fn] of Object.entries(opts.ops)) {
            wrappedOps[key] = (...args: unknown[]) => {
                const result = (fn as (...a: unknown[]) => unknown)(...args);
                if (hasBrand(result, name)) return result;
                if (shapeMatches(result)) {
                    runInvariant(name, invariant, result as ShapeOf<S>);
                    return unsafe(result as ShapeOf<S>);
                }
                return result;
            };
        }
    }

    let selfRef: AnyValueDef | null = null;

    const factory = (): ColumnDef<Branded<ShapeOf<S>, TName>> => {
        const col = {
            $type: undefined as never,
            kind: 'text' as const,    // JSON-in-TEXT; Phase B1 adds 'value' kind
            sqlType: 'TEXT',
            nullable: false,
            primaryKey: false,
            merge: 'lww' as const,
            $valueRef: selfRef,
        } as unknown as ColumnDef<Branded<ShapeOf<S>, TName>>;
        return col;
    };

    const def = Object.assign(factory, {
        $name: name,
        $shape: shape,
        T: undefined as unknown as Branded<ShapeOf<S>, TName>,
        zod: zodSchema as ZodType<Branded<ShapeOf<S>, TName>>,
        is,
        equals,
        unsafe,
        create: wrappedCreate as never,
        ops: wrappedOps as never,
    }) as unknown as CompositeValueDef<TName, S, TCreate, TOps>;
    selfRef = def as unknown as AnyValueDef;
    return def;
}

function validateName(name: string): void {
    if (!name || typeof name !== 'string') {
        throw errors.schema(SchemaCode.INVALID_VALUE_NAME, {
            message: `defineValue: name must be a non-empty string.`,
            hint: `Pass a valid name: defineValue('email', text(), ...)`,
        });
    }
    if (name.startsWith('$') || name.startsWith('_')) {
        throw errors.schema(SchemaCode.INVALID_VALUE_NAME, {
            message: `defineValue('${name}'): names starting with '$' or '_' are reserved.`,
            context: { value: name },
        });
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
        throw errors.schema(SchemaCode.INVALID_VALUE_NAME, {
            message: `defineValue('${name}'): name must match /^[a-zA-Z][a-zA-Z0-9_]*$/.`,
            context: { value: name },
        });
    }
}
