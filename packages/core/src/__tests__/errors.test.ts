import { describe, it, expect } from 'vitest';
import {
    SyncEngineError,
    UserHandlerError,
    SchemaCode,
    EntityCode,
    StoreCode,
    ConnectionCode,
    HandlerCode,
    CliCode,
} from '../errors';

describe('SyncEngineError', () => {
    it('extends Error with structured fields', () => {
        const err = new SyncEngineError({
            code: SchemaCode.MISSING_PRIMARY_KEY,
            category: 'schema',
            severity: 'fatal',
            message: "Table 'cart' has no primary key column.",
            hint: 'Add id() to your table definition.',
            context: { table: 'cart' },
        });

        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(SyncEngineError);
        expect(err.code).toBe('MISSING_PRIMARY_KEY');
        expect(err.category).toBe('schema');
        expect(err.severity).toBe('fatal');
        expect(err.message).toBe("Table 'cart' has no primary key column.");
        expect(err.hint).toBe('Add id() to your table definition.');
        expect(err.context).toEqual({ table: 'cart' });
        expect(err.name).toBe('SyncEngineError');
        expect(err.stack).toBeDefined();
    });

    it('defaults context to empty object', () => {
        const err = new SyncEngineError({
            code: SchemaCode.MISSING_PRIMARY_KEY,
            category: 'schema',
            severity: 'fatal',
            message: 'test',
        });
        expect(err.context).toEqual({});
    });

    it('preserves cause', () => {
        const original = new Error('original');
        const err = new SyncEngineError({
            code: ConnectionCode.NATS_UNREACHABLE,
            category: 'connection',
            severity: 'warning',
            message: 'wrapped',
            cause: original,
        });
        expect(err.cause).toBe(original);
    });
});

describe('UserHandlerError', () => {
    it('extends SyncEngineError with handler category', () => {
        const original = new Error('insufficient inventory');
        const err = new UserHandlerError({
            message: "Entity 'order' handler 'place' failed: insufficient inventory",
            context: { entity: 'order', handler: 'place' },
            cause: original,
        });

        expect(err).toBeInstanceOf(SyncEngineError);
        expect(err).toBeInstanceOf(UserHandlerError);
        expect(err.code).toBe('USER_HANDLER_ERROR');
        expect(err.category).toBe('handler');
        expect(err.severity).toBe('fatal');
        expect(err.cause).toBe(original);
        expect(err.name).toBe('UserHandlerError');
    });
});

describe('code registries', () => {
    it('SchemaCode values are string literals', () => {
        expect(SchemaCode.MISSING_PRIMARY_KEY).toBe('MISSING_PRIMARY_KEY');
        expect(SchemaCode.RESERVED_COLUMN_PREFIX).toBe('RESERVED_COLUMN_PREFIX');
    });

    it('EntityCode values are string literals', () => {
        expect(EntityCode.INVALID_TRANSITION).toBe('INVALID_TRANSITION');
        expect(EntityCode.TYPE_MISMATCH).toBe('TYPE_MISMATCH');
    });

    it('all registries are frozen', () => {
        expect(Object.isFrozen(SchemaCode)).toBe(true);
        expect(Object.isFrozen(EntityCode)).toBe(true);
        expect(Object.isFrozen(StoreCode)).toBe(true);
        expect(Object.isFrozen(ConnectionCode)).toBe(true);
        expect(Object.isFrozen(HandlerCode)).toBe(true);
        expect(Object.isFrozen(CliCode)).toBe(true);
    });
});
