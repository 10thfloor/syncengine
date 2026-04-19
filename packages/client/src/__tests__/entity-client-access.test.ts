import { describe, it, expect } from 'vitest';
import { AccessDeniedError, SyncEngineError, errors, ConnectionCode } from '@syncengine/core';
import { classifyActionError, setCurrentUserGetter } from '../entity-client';

describe('classifyActionError', () => {
    it('returns a SyncEngineError unchanged', () => {
        const input = errors.connection(ConnectionCode.HTTP_ERROR, { message: 'timeout' });
        const result = classifyActionError(input);
        expect(result).toBe(input);
    });

    it('parses [ACCESS_DENIED] prefix into AccessDeniedError', () => {
        const serverErr = new Error('[ACCESS_DENIED] access denied for handler \'sell\' on entity \'inventory\'');
        const result = classifyActionError(serverErr);
        expect(result).toBeInstanceOf(AccessDeniedError);
        expect(result.message).toMatch(/access denied for handler 'sell'/);
        expect(result.message).not.toMatch(/\[ACCESS_DENIED\]/);
    });

    it('strips the prefix from the message', () => {
        const serverErr = new Error('[ACCESS_DENIED] nope');
        const result = classifyActionError(serverErr);
        expect(result.message).toBe('nope');
    });

    it('falls back to HTTP_ERROR for un-prefixed errors', () => {
        const input = new Error('network timeout');
        const result = classifyActionError(input);
        expect(result).toBeInstanceOf(SyncEngineError);
        expect(result).not.toBeInstanceOf(AccessDeniedError);
        expect(result.code).toBe('HTTP_ERROR');
    });

    it('handles non-Error throws by stringifying', () => {
        const result = classifyActionError('raw string error');
        expect(result.message).toBe('raw string error');
    });

    it('does not misclassify error messages that merely contain ACCESS_DENIED elsewhere', () => {
        const input = new Error('some message mentioning ACCESS_DENIED in the middle');
        const result = classifyActionError(input);
        expect(result).not.toBeInstanceOf(AccessDeniedError);
    });
});

describe('setCurrentUserGetter', () => {
    it('replaces the default user getter', () => {
        // Install a custom getter, then reset to default for isolation
        const original = { id: 'alice', roles: ['admin'] };
        setCurrentUserGetter(() => original);
        // We have no direct accessor exported; this test mainly confirms
        // the setter doesn't throw and can be invoked.
        expect(() => setCurrentUserGetter(() => null)).not.toThrow();
    });
});
