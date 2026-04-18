import { describe, it, expect } from 'vitest';
import type { AuthUser, AccessContext, AccessPolicy } from '../auth';

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
