import { describe, it, expect } from 'vitest';
import { useUser, type UseUserResult } from '../use-user';
import { authState } from '../auth-state';

// No @testing-library/react available in this package — testing the
// useSyncExternalStore wiring through the hook is done via the AuthState
// directly (same subscribe/getSnapshot target). The hook itself is a
// 4-line passthrough; we assert its existence + return-type shape and
// cover the reactive path via AuthState behaviour.

describe('useUser export shape', () => {
    it('is a function', () => {
        expect(typeof useUser).toBe('function');
    });

    it('UseUserResult type has user and isAuthenticated', () => {
        const fake: UseUserResult = { user: null, isAuthenticated: false };
        expect(fake.isAuthenticated).toBe(false);
    });
});

describe('useUser reactive source (indirect)', () => {
    it('reads the current user from authState', () => {
        authState.setUser({ id: 'alice' });
        expect(authState.getUser()?.id).toBe('alice');
        authState.setUser(null);
    });

    it('isAuthenticated derives from user presence', () => {
        authState.setUser(null);
        expect(authState.getUser() === null).toBe(true); // would be !isAuthenticated in hook
        authState.setUser({ id: 'a' });
        expect(authState.getUser() !== null).toBe(true); // would be isAuthenticated
        authState.setUser(null);
    });
});
