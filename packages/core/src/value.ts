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

/** Scalar `defineValue`. The second argument is a single `ColumnDef<T>` —
 *  `text()`, `integer()`, etc. Composite form (second arg a shape record)
 *  lands in Phase A2. */
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
    opts: ScalarValueOptions<TRaw, TCreate, TOps> = {},
): ScalarValueDef<TName, TRaw, TCreate, TOps> {
    validateName(name);

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

    // Callable column factory. Returns a ColumnDef whose `$type` is the
    // branded type so entity / table state inference picks it up. The
    // `as ColumnDef<Branded<TRaw, TName>>` cast crosses the brand
    // boundary — the underlying `ColumnDef` is inferred with the raw
    // `TRaw`, and we lift it once here so callers see the branded form
    // everywhere downstream.
    const factory = (): ColumnDef<Branded<TRaw, TName>> => (
        { ...column, $type: undefined as never } as unknown as ColumnDef<Branded<TRaw, TName>>
    );

    // Stitch everything into the final value-def object. The cast is
    // safe: we've mirrored the public shape piece by piece.
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
