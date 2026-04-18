import { describe, it, expect } from 'vitest';
import { Access, USER_PLACEHOLDER } from '../index';
import type { AuthUser, AccessPolicy } from '../index';

describe('public auth API', () => {
    it('Access is importable from the package root', () => {
        expect(typeof Access.public).toBe('object');
        expect(typeof Access.role).toBe('function');
    });

    it('USER_PLACEHOLDER is exported as "$user"', () => {
        expect(USER_PLACEHOLDER).toBe('$user');
    });

    it('AuthUser and AccessPolicy types are importable', () => {
        const u: AuthUser = { id: 'a' };
        const p: AccessPolicy = Access.public;
        expect(u.id).toBe('a');
        expect(p.$kind).toBe('access');
    });
});
