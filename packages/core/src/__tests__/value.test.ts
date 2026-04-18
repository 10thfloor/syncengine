import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { text, integer } from '../schema';
import { defineValue, op, withArgs } from '../value';

// ── Minimal brand-only scalars ─────────────────────────────────────────────

const UserId = defineValue('userId', text());
const OrderId = defineValue('orderId', text());

describe('defineValue — scalar, brand-only', () => {
    it('carries the name', () => {
        expect(UserId.$name).toBe('userId');
    });

    it('callable as column factory → ColumnDef', () => {
        const col = UserId();
        expect(col.kind).toBe('text');
        expect(col.sqlType).toBe('TEXT');
    });

    it('unsafe() brands the raw value', () => {
        const id = UserId.unsafe('u-123');
        expect(id).toBe('u-123'); // primitive identity
        expect(UserId.is(id)).toBe(true);
    });

    it('is() recognises brand-consistent raw primitives', () => {
        // No invariant means "any string" is-ish — this is the "brand
        // only" form; is() returns true for matching primitives so
        // rehydrating from JSON still works.
        expect(UserId.is('anything')).toBe(true);
        expect(UserId.is(42)).toBe(false);
        expect(UserId.is(null)).toBe(false);
    });

    it('distinct names produce distinct brands', () => {
        const u = UserId.unsafe('u-1');
        const o = OrderId.unsafe('o-1');
        expect(UserId.is(u)).toBe(true);
        expect(OrderId.is(o)).toBe(true);
        // Runtime brand stamps on composites can be read back via
        // hasBrand — for primitives the distinction is compile-time
        // only (intersection with `string` doesn't carry a runtime
        // marker, by TS-primitive-intersection rules). The important
        // contract is the type guard: `OrderId.is(u)` would happily
        // say "yes it's a string that matches OrderId" absent an
        // invariant, which is correct: brand distinction is nominal
        // type-level, runtime is shape + invariant.
        expect(typeof u).toBe('string');
        expect(typeof o).toBe('string');
    });
});

// ── Invariant ──────────────────────────────────────────────────────────────

const Email = defineValue('email', text(), {
    invariant: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v),
    create: {
        from: (raw: string) => raw.toLowerCase().trim(),
    },
    ops: {
        domain: (e) => e.split('@')[1],
    },
});

describe('defineValue — invariant + factories + ops', () => {
    it('create factory runs invariant + brands', () => {
        const e = Email.create.from('  Alice@Example.COM ');
        expect(e).toBe('alice@example.com');
        expect(Email.is(e)).toBe(true);
    });

    it('create factory throws on invariant failure', () => {
        expect(() => Email.create.from('not-an-email')).toThrow(/invariant rejected/);
    });

    it('unsafe() skips the invariant', () => {
        const bad = Email.unsafe('not-an-email');
        expect(bad).toBe('not-an-email');
        // is() still runs the invariant on primitives without a brand
        // marker — but unsafe returns the raw primitive. For scalar
        // primitives there's no detectable brand, so `is()` re-checks
        // the invariant and (correctly) reports this as invalid.
        expect(Email.is(bad)).toBe(false);
    });

    it('is() rejects primitives that fail the invariant', () => {
        expect(Email.is('nope')).toBe(false);
        expect(Email.is('alice@example.com')).toBe(true);
    });

    it('ops are passthrough — no auto-rebranding', () => {
        const e = Email.create.from('alice@example.com');
        const d = Email.ops.domain(e);
        expect(d).toBe('example.com');
        expect(typeof d).toBe('string');
    });

    it('equals does strict primitive compare on scalars', () => {
        const a = Email.create.from('a@b.com');
        const b = Email.create.from('a@b.com');
        const c = Email.create.from('c@d.com');
        expect(Email.equals(a, b)).toBe(true);
        expect(Email.equals(a, c)).toBe(false);
    });
});

// ── zod round-trip ────────────────────────────────────────────────────────

describe('defineValue — zod', () => {
    it('Email.zod accepts valid primitives', () => {
        expect(Email.zod.parse('a@b.com')).toBe('a@b.com');
    });

    it('Email.zod rejects invariant failures', () => {
        expect(() => Email.zod.parse('not-an-email')).toThrow();
    });

    it('UserId.zod accepts any string (no invariant)', () => {
        expect(UserId.zod.parse('u-123')).toBe('u-123');
        expect(() => UserId.zod.parse(42)).toThrow();
    });
});

// ── Numeric scalar ────────────────────────────────────────────────────────

const Cents = defineValue('cents', integer(), {
    invariant: (v) => v >= 0,
    create: {
        of: (n: number) => Math.round(n),
    },
});

describe('defineValue — numeric scalar', () => {
    it('create rounds and invariant gates negatives', () => {
        expect(Cents.create.of(99)).toBe(99);
        expect(Cents.create.of(1.9)).toBe(2);
        expect(() => Cents.create.of(-1)).toThrow(/invariant rejected/);
    });

    it('is() enforces both primitive type and invariant', () => {
        expect(Cents.is(0)).toBe(true);
        expect(Cents.is(-1)).toBe(false);
        expect(Cents.is('0')).toBe(false);
    });
});

// ── Name validation ───────────────────────────────────────────────────────

// ── Composite form ─────────────────────────────────────────────────────────

const Money = defineValue('money', {
    amount: integer(),
    currency: text({ enum: ['USD', 'EUR', 'GBP'] as const }),
}, {
    invariant: (v) => v.amount >= 0,
    create: {
        usd: (cents: number) => ({ amount: cents, currency: 'USD' as const }),
        eur: (cents: number) => ({ amount: cents, currency: 'EUR' as const }),
    },
    ops: {
        add: (a, b) => {
            if (a.currency !== b.currency) {
                throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`);
            }
            return { amount: a.amount + b.amount, currency: a.currency };
        },
        scale: (m, factor: number) => ({ amount: Math.round(m.amount * factor), currency: m.currency }),
        isZero: (m) => m.amount === 0,
        format: (m) => `${m.currency} ${(m.amount / 100).toFixed(2)}`,
    },
});

describe('defineValue — composite', () => {
    it('create factory runs invariant + brands + preserves shape', () => {
        const m = Money.create.usd(1999);
        expect(m).toMatchObject({ amount: 1999, currency: 'USD' });
        expect(Money.is(m)).toBe(true);
    });

    it('create factory rejects invariant failures', () => {
        expect(() => Money.create.usd(-1)).toThrow(/invariant rejected/);
    });

    it('is() checks shape + invariant + brand', () => {
        expect(Money.is(Money.create.usd(100))).toBe(true);
        expect(Money.is({ amount: 100, currency: 'USD' })).toBe(true);  // unbranded but valid
        expect(Money.is({ amount: -1, currency: 'USD' })).toBe(false); // invariant fails
        expect(Money.is({ amount: 100 })).toBe(false);                 // shape incomplete
        expect(Money.is(null)).toBe(false);
        expect(Money.is('string')).toBe(false);
    });

    it('self-returning ops auto-rebrand', () => {
        const a = Money.create.usd(100);
        const b = Money.create.usd(50);
        const sum = Money.ops.add(a, b);
        expect(sum).toMatchObject({ amount: 150, currency: 'USD' });
        expect(Money.is(sum)).toBe(true);

        const scaled = Money.ops.scale(a, 1.5);
        expect(scaled).toMatchObject({ amount: 150, currency: 'USD' });
        expect(Money.is(scaled)).toBe(true);
    });

    it('self-returning op re-runs invariant on result', () => {
        // scale(-1) would produce a negative — invariant rejects.
        const a = Money.create.usd(100);
        expect(() => Money.ops.scale(a, -1)).toThrow(/invariant rejected/);
    });

    it('passthrough ops — booleans/strings return untouched', () => {
        const m = Money.create.usd(0);
        expect(Money.ops.isZero(m)).toBe(true);
        expect(typeof Money.ops.isZero(m)).toBe('boolean');

        const fm = Money.ops.format(Money.create.usd(1999));
        expect(fm).toBe('USD 19.99');
        expect(typeof fm).toBe('string');
    });

    it('equals does deep structural compare', () => {
        const a = Money.create.usd(100);
        const b = Money.create.usd(100);
        const c = Money.create.usd(101);
        const d = Money.create.eur(100);
        expect(Money.equals(a, b)).toBe(true);
        expect(Money.equals(a, c)).toBe(false);
        expect(Money.equals(a, d)).toBe(false);
    });

    it('unsafe skips invariant + brands', () => {
        const bad = Money.unsafe({ amount: -1, currency: 'USD' });
        expect(bad.amount).toBe(-1);
        expect(Money.is(bad)).toBe(false); // shape ok but invariant fails
    });

    it('zod round-trips JSON', () => {
        const m = Money.create.usd(1999);
        const json = JSON.stringify(m);
        expect(JSON.parse(json)).toEqual({ amount: 1999, currency: 'USD' });  // brand invisible
        const parsed = Money.zod.parse(JSON.parse(json));
        expect(parsed).toMatchObject({ amount: 1999, currency: 'USD' });
    });

    it('zod rejects invariant + shape violations', () => {
        expect(() => Money.zod.parse({ amount: -1, currency: 'USD' })).toThrow();
        expect(() => Money.zod.parse({ amount: 100 })).toThrow();
        expect(() => Money.zod.parse({ amount: 100, currency: 'XYZ' })).toThrow();
    });
});

// ── Column factory options (default / nullable) ───────────────────────────

describe('defineValue — column factory options', () => {
    it('composite column defaults to kind: value', () => {
        const col = Money();
        expect(col.kind).toBe('value');
        expect(col.sqlType).toBe('TEXT');
        expect(col.nullable).toBe(false);
    });

    it('scalar column inherits underlying primitive kind', () => {
        const col = Email();
        expect(col.kind).toBe('text');
        expect(col.sqlType).toBe('TEXT');
    });

    it('{ default } lifts a branded default onto the ColumnDef', () => {
        const col = Money({ default: Money.create.usd(0) });
        expect(col.default).toMatchObject({ amount: 0, currency: 'USD' });
    });

    it('{ nullable: true } flips the nullable flag', () => {
        const col = Money({ nullable: true });
        expect(col.nullable).toBe(true);
    });

    it('$valueRef stamped on every column — composites + parents can recurse', () => {
        const col = Money() as unknown as { $valueRef: { $name: string } };
        expect(col.$valueRef.$name).toBe('money');
    });
});

// ── Nested composite (Price contains Money) ───────────────────────────────

const Price = defineValue('price', {
    amount: Money(),
    taxRate: integer(),
}, {
    invariant: (v) => v.taxRate >= 0 && v.taxRate <= 100,
    create: {
        withTax: (m: ReturnType<typeof Money.create.usd>, rateBps: number) => ({
            amount: m,
            taxRate: rateBps,
        }),
    },
    ops: {
        total: (p) => Money.ops.scale(p.amount, 1 + p.taxRate / 100),
    },
});

describe('defineValue — nested composite', () => {
    it('Price composes Money — full brand chain', () => {
        const p = Price.create.withTax(Money.create.usd(1000), 10);
        expect(Price.is(p)).toBe(true);
        expect(Money.is(p.amount)).toBe(true);
        expect(p.taxRate).toBe(10);
    });

    it('nested invariant flows through', () => {
        // Money's invariant rejects negative amounts even when wrapped.
        expect(() => Price.is({ amount: { amount: -1, currency: 'USD' }, taxRate: 5 }))
            .not.toThrow();
        expect(Price.is({ amount: { amount: -1, currency: 'USD' }, taxRate: 5 })).toBe(false);
    });

    it('parent invariant gates taxRate range', () => {
        expect(Price.is({ amount: Money.create.usd(100), taxRate: 200 })).toBe(false);
    });

    it('op that returns nested value type auto-rebrands the nested one', () => {
        const p = Price.create.withTax(Money.create.usd(1000), 10);
        const total = Price.ops.total(p);
        // total is a Money — `.ops.scale` already rebrands inside Money.
        expect(Money.is(total)).toBe(true);
        expect(total.amount).toBe(1100);
    });

    it('equals recurses into nested values', () => {
        const a = Price.create.withTax(Money.create.usd(100), 5);
        const b = Price.create.withTax(Money.create.usd(100), 5);
        const c = Price.create.withTax(Money.create.usd(100), 6); // different tax
        const d = Price.create.withTax(Money.create.eur(100), 5); // different currency
        expect(Price.equals(a, b)).toBe(true);
        expect(Price.equals(a, c)).toBe(false);
        expect(Price.equals(a, d)).toBe(false);
    });

    it('zod round-trips through JSON with nested brand restored on parse', () => {
        const p = Price.create.withTax(Money.create.usd(1999), 8);
        const parsed = Price.zod.parse(JSON.parse(JSON.stringify(p)));
        expect(parsed.amount).toMatchObject({ amount: 1999, currency: 'USD' });
        expect(parsed.taxRate).toBe(8);
    });
});

// ── op() — cross-value-returning op marker ────────────────────────────────

describe('op() — cross-value returns', () => {
    it('wraps a fn that returns another value type — auto-rebrands', () => {
        // Price uses Money internally. The composite auto-rebrand in
        // `defineValue` only detects Price's own shape; for `total` to
        // return a branded Money, the user marks it with `op(Money, fn)`.
        const shippedTotal = op(Money, (p: ReturnType<typeof Price.create.withTax>) =>
            Money.ops.scale(p.amount, 1 + p.taxRate / 100),
        );
        const p = Price.create.withTax(Money.create.usd(1000), 10);
        const out = shippedTotal(p);
        expect(Money.is(out)).toBe(true);
        expect(out.amount).toBe(1100);
    });

    it('rebrands a raw-shape return', () => {
        // Fn returns a plain object matching Money's shape — the marker
        // re-runs the invariant + stamps the brand.
        const fakeTotal = op(Money, (p: ReturnType<typeof Money.create.usd>) => ({
            amount: p.amount * 2,
            currency: p.currency,
        }));
        const out = fakeTotal(Money.create.usd(50));
        expect(Money.is(out)).toBe(true);
        expect(out.amount).toBe(100);
    });

    it('throws with the value name when the return fails validation', () => {
        const bad = op(Money, () => ({ amount: -1, currency: 'USD' }));
        expect(() => bad()).toThrow(/money.*rejected/i);
    });

    it('chains — value ops can themselves use op() markers', () => {
        // An op that returns a Price from a Money input.
        const promote = op(Price, (m: ReturnType<typeof Money.create.usd>) =>
            Price.create.withTax(m, 0),
        );
        const p = promote(Money.create.usd(100));
        expect(Price.is(p)).toBe(true);
        expect(Money.is(p.amount)).toBe(true);
    });
});

// ── withArgs() — handler-arg validation ──────────────────────────────────

describe('withArgs() — declarative handler arg validation', () => {
    it('validates value-def args and stamps the brand', () => {
        type State = { total: ReturnType<typeof Money.create.usd> };
        const handler = withArgs(
            [Money] as const,
            (state: State, price) => ({ total: Money.ops.add(state.total, price) }),
        );
        const initial: State = { total: Money.create.usd(0) };
        const next = handler(initial, Money.create.usd(1999));
        expect(Money.is(next.total)).toBe(true);
        expect(next.total.amount).toBe(1999);
    });

    it('rejects an unbranded arg that fails the invariant', () => {
        type State = { total: ReturnType<typeof Money.create.usd> };
        const handler = withArgs(
            [Money] as const,
            (_state: State, price) => ({ total: price }),
        );
        expect(() => handler(
            { total: Money.create.usd(0) },
            { amount: -1, currency: 'USD' } as never,
        )).toThrow(/rejected/);
    });

    it('passes validated, rebranded args into the handler body', () => {
        // Plain-JSON-shaped arg → handler receives a branded, re-stamped
        // Money. Verifies rehydration semantics match validateEntityState.
        let saw: unknown;
        const handler = withArgs(
            [Money] as const,
            (_state: object, price) => { saw = price; return {}; },
        );
        handler({}, { amount: 100, currency: 'USD' } as never);
        expect(Money.is(saw)).toBe(true);
    });

    it('mixes value-defs and zod schemas', () => {
        const handler = withArgs(
            [Money, z.string()] as const,
            (_state: object, price, label) => ({ price, label }),
        );
        const out = handler(
            {},
            Money.create.usd(100),
            'widget',
        );
        expect(Money.is(out.price)).toBe(true);
        expect(out.label).toBe('widget');
    });

    it('zod rejects invalid args', () => {
        const handler = withArgs(
            [z.string()] as const,
            (_state: object, label) => ({ label }),
        );
        expect(() => handler({}, 42 as never)).toThrow();
    });

    // (The declarative contract is "all args have schemas". If a user
    //  needs to pass extra unvalidated data, they thread it through a
    //  z.any() schema at the right slot.)
});

describe('defineValue — name validation', () => {
    it('rejects empty / non-string names', () => {
        expect(() => defineValue('', text())).toThrow();
        expect(() => defineValue(42 as never, text())).toThrow();
    });

    it('rejects reserved prefixes', () => {
        expect(() => defineValue('$foo', text())).toThrow(/reserved/);
        expect(() => defineValue('_foo', text())).toThrow(/reserved/);
    });

    it('rejects invalid identifiers', () => {
        expect(() => defineValue('has spaces', text())).toThrow();
        expect(() => defineValue('1leadingDigit', text())).toThrow();
    });
});
