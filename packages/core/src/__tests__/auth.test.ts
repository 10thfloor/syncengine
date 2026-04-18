import { describe, it, expect } from 'vitest';
import type { AuthUser, AccessContext, AccessPolicy } from '../auth';
import { Access } from '../auth';

describe('AuthUser', () => {
    it('can be constructed with id only', () => {
        const u: AuthUser = { id: 'alice' };
        expect(u.id).toBe('alice');
    });
});

describe('AccessContext', () => {
    it('carries user, key, and optional state', () => {
        const ctx: AccessContext<{ stock: number }> = {
            user: { id: 'alice' },
            key: 'keyboard',
            state: { stock: 10 },
        };
        expect(ctx.state?.stock).toBe(10);
    });
});

describe('AccessPolicy', () => {
    it('brand is the literal $kind: "access"', () => {
        const policy: AccessPolicy = {
            $kind: 'access',
            check: () => true,
        };
        expect(policy.$kind).toBe('access');
    });
});

describe('Access.public', () => {
    it('allows anyone, including unauthenticated', () => {
        expect(Access.public.check({ user: null, key: 'x' })).toBe(true);
        expect(Access.public.check({ user: { id: 'a' }, key: 'x' })).toBe(true);
    });

    it('is branded as an access policy', () => {
        expect(Access.public.$kind).toBe('access');
    });
});

describe('Access.authenticated', () => {
    it('allows authenticated users', () => {
        expect(Access.authenticated.check({ user: { id: 'a' }, key: 'x' })).toBe(true);
    });

    it('rejects unauthenticated requests', () => {
        expect(Access.authenticated.check({ user: null, key: 'x' })).toBe(false);
    });
});

describe('Access.deny', () => {
    it('rejects everyone, even authenticated users', () => {
        expect(Access.deny.check({ user: null, key: 'x' })).toBe(false);
        expect(Access.deny.check({ user: { id: 'a' }, key: 'x' })).toBe(false);
    });
});
