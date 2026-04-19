import { describe, it, expect } from 'vitest';
import { AuthState, authState } from '../auth-state';

describe('AuthState', () => {
    it('starts with null user and null token', () => {
        const state = new AuthState();
        expect(state.getUser()).toBeNull();
        expect(state.getToken()).toBeNull();
    });

    it('setUser replaces the current user', () => {
        const state = new AuthState();
        state.setUser({ id: 'alice', roles: ['admin'] });
        expect(state.getUser()?.id).toBe('alice');
    });

    it('subscribers fire on setUser', () => {
        const state = new AuthState();
        let count = 0;
        state.subscribe(() => { count++; });
        state.setUser({ id: 'a' });
        state.setUser({ id: 'b' });
        expect(count).toBe(2);
    });

    it('subscribers do NOT fire when setUser is called with the same reference', () => {
        const state = new AuthState();
        const u = { id: 'a' };
        state.setUser(u);
        let count = 0;
        state.subscribe(() => { count++; });
        state.setUser(u);  // same reference
        expect(count).toBe(0);
    });

    it('subscribe returns an unsubscribe function', () => {
        const state = new AuthState();
        let count = 0;
        const unsub = state.subscribe(() => { count++; });
        state.setUser({ id: 'a' });
        unsub();
        state.setUser({ id: 'b' });
        expect(count).toBe(1);
    });

    it('setToken replaces the bearer token without changing user', () => {
        const state = new AuthState();
        state.setUser({ id: 'a' });
        state.setToken('new-token');
        expect(state.getToken()).toBe('new-token');
        expect(state.getUser()?.id).toBe('a');
    });

    it('setUser(null) resets to unauthenticated', () => {
        const state = new AuthState();
        state.setUser({ id: 'a' });
        state.setUser(null);
        expect(state.getUser()).toBeNull();
    });

    it('exports a shared process-level instance', () => {
        expect(authState).toBeInstanceOf(AuthState);
    });
});
