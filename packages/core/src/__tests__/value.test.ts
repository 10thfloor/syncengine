import { describe, it, expect } from 'vitest';
import { text, integer } from '../schema';
import { defineValue, type ValueType } from '../value';

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

    it('distinct names produce distinct brands at compile time', () => {
        const u: ValueType<typeof UserId> = UserId.unsafe('u-1');
        const o: ValueType<typeof OrderId> = OrderId.unsafe('o-1');

        // @ts-expect-error — can't assign UserId to OrderId slot
        const _: ValueType<typeof OrderId> = u;
        void _;
        void o;
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

describe('defineValue — name validation', () => {
    it('rejects empty / non-string names', () => {
        // @ts-expect-error
        expect(() => defineValue('', text())).toThrow();
        // @ts-expect-error
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
