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

describe('Access.role', () => {
    it('bare-string form: passes when user has any of the listed roles', () => {
        const policy = Access.role('admin', 'member');
        expect(policy.check({ user: { id: 'a', roles: ['member'] }, key: 'x' })).toBe(true);
        expect(policy.check({ user: { id: 'a', roles: ['admin'] }, key: 'x' })).toBe(true);
    });

    it('bare-string form: rejects when user lacks every listed role', () => {
        const policy = Access.role('admin');
        expect(policy.check({ user: { id: 'a', roles: ['viewer'] }, key: 'x' })).toBe(false);
    });

    it('rejects unauthenticated users', () => {
        const policy = Access.role('admin');
        expect(policy.check({ user: null, key: 'x' })).toBe(false);
    });

    it('rejects users with no roles set', () => {
        const policy = Access.role('admin');
        expect(policy.check({ user: { id: 'a' }, key: 'x' })).toBe(false);
    });

    it('value-def form: accepts a def with $enum plus role strings from the enum', () => {
        const RoleDef = { $enum: ['owner', 'admin', 'member', 'viewer'] as const };
        const policy = Access.role(RoleDef, 'admin');
        expect(policy.check({ user: { id: 'a', roles: ['admin'] }, key: 'x' })).toBe(true);
        expect(policy.check({ user: { id: 'a', roles: ['viewer'] }, key: 'x' })).toBe(false);
    });
});

describe('Access.owner', () => {
    it('passes when state.userId equals user.id (default field)', () => {
        const policy = Access.owner();
        const ctx: AccessContext<{ userId: string }> = {
            user: { id: 'alice' },
            key: 'order-1',
            state: { userId: 'alice' },
        };
        expect(policy.check(ctx)).toBe(true);
    });

    it('rejects when state.userId differs from user.id', () => {
        const policy = Access.owner();
        const ctx: AccessContext<{ userId: string }> = {
            user: { id: 'alice' },
            key: 'order-1',
            state: { userId: 'bob' },
        };
        expect(policy.check(ctx)).toBe(false);
    });

    it('uses the configured field name when provided', () => {
        const policy = Access.owner('createdBy');
        const ctx: AccessContext<{ createdBy: string }> = {
            user: { id: 'alice' },
            key: 'doc-1',
            state: { createdBy: 'alice' },
        };
        expect(policy.check(ctx)).toBe(true);
    });

    it('rejects unauthenticated users', () => {
        const policy = Access.owner();
        const ctx: AccessContext<{ userId: string }> = {
            user: null,
            key: 'order-1',
            state: { userId: 'alice' },
        };
        expect(policy.check(ctx)).toBe(false);
    });

    it('rejects when state is missing', () => {
        const policy = Access.owner();
        expect(policy.check({ user: { id: 'alice' }, key: 'order-1' })).toBe(false);
    });
});

describe('Access.any', () => {
    it('passes when at least one policy passes', () => {
        const policy = Access.any(Access.deny, Access.authenticated);
        expect(policy.check({ user: { id: 'a' }, key: 'x' })).toBe(true);
    });

    it('rejects when every policy rejects', () => {
        const policy = Access.any(Access.deny, Access.deny);
        expect(policy.check({ user: { id: 'a' }, key: 'x' })).toBe(false);
    });

    it('short-circuits on first pass', () => {
        let evaluated = 0;
        const countingPolicy: AccessPolicy = {
            $kind: 'access',
            check: () => { evaluated++; return true; },
        };
        const policy = Access.any(countingPolicy, countingPolicy);
        policy.check({ user: null, key: 'x' });
        expect(evaluated).toBe(1);
    });

    it('empty list rejects (vacuous any)', () => {
        const policy = Access.any();
        expect(policy.check({ user: { id: 'a' }, key: 'x' })).toBe(false);
    });
});

describe('Access.all', () => {
    it('passes when every policy passes', () => {
        const policy = Access.all(Access.public, Access.authenticated);
        expect(policy.check({ user: { id: 'a' }, key: 'x' })).toBe(true);
    });

    it('rejects when any policy rejects', () => {
        const policy = Access.all(Access.authenticated, Access.deny);
        expect(policy.check({ user: { id: 'a' }, key: 'x' })).toBe(false);
    });

    it('short-circuits on first reject', () => {
        let evaluated = 0;
        const countingPolicy: AccessPolicy = {
            $kind: 'access',
            check: () => { evaluated++; return false; },
        };
        const policy = Access.all(countingPolicy, countingPolicy);
        policy.check({ user: null, key: 'x' });
        expect(evaluated).toBe(1);
    });

    it('empty list passes (vacuous all)', () => {
        const policy = Access.all();
        expect(policy.check({ user: null, key: 'x' })).toBe(true);
    });
});
