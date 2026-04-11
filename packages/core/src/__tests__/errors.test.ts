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

import { errors } from '../errors';

describe('errors factory', () => {
    it('errors.schema() creates a schema-category SyncEngineError', () => {
        const err = errors.schema(SchemaCode.MISSING_PRIMARY_KEY, {
            message: "Table 'cart' has no primary key.",
            hint: 'Add id().',
            context: { table: 'cart' },
        });

        expect(err).toBeInstanceOf(SyncEngineError);
        expect(err.code).toBe('MISSING_PRIMARY_KEY');
        expect(err.category).toBe('schema');
        expect(err.severity).toBe('fatal');
        expect(err.hint).toBe('Add id().');
    });

    it('errors.entity() creates an entity-category SyncEngineError', () => {
        const err = errors.entity(EntityCode.INVALID_TRANSITION, {
            message: "Cannot transition 'status' from 'draft' to 'shipped'.",
        });
        expect(err.category).toBe('entity');
        expect(err.severity).toBe('fatal');
    });

    it('errors.connection() defaults to warning severity', () => {
        const err = errors.connection(ConnectionCode.NATS_UNREACHABLE, {
            message: 'Cannot connect.',
        });
        expect(err.severity).toBe('warning');
    });

    it('severity can be overridden', () => {
        const err = errors.connection(ConnectionCode.NATS_UNREACHABLE, {
            message: 'Cannot connect.',
            severity: 'fatal',
        });
        expect(err.severity).toBe('fatal');
    });

    it('errors.handler() creates a UserHandlerError with cause', () => {
        const original = new Error('boom');
        const err = errors.handler(HandlerCode.USER_HANDLER_ERROR, {
            message: "Entity 'order' handler 'place' failed: boom",
            context: { entity: 'order', handler: 'place' },
            cause: original,
        });

        expect(err).toBeInstanceOf(UserHandlerError);
        expect(err.code).toBe('USER_HANDLER_ERROR');
        expect(err.cause).toBe(original);
    });

    it('errors.handler() also works with HANDLER_NOT_FOUND', () => {
        const err = errors.handler(HandlerCode.HANDLER_NOT_FOUND, {
            message: "entity 'cart': no handler named 'foo'.",
            context: { entity: 'cart', handler: 'foo' },
        });
        expect(err).toBeInstanceOf(SyncEngineError);
        expect(err.code).toBe('HANDLER_NOT_FOUND');
        expect(err.category).toBe('handler');
    });

    it('errors.store() creates a store-category error', () => {
        const err = errors.store(StoreCode.INVALID_SEED_KEY, {
            message: "seed key 'foo' does not match any table.",
        });
        expect(err.category).toBe('store');
        expect(err.severity).toBe('fatal');
    });

    it('errors.cli() creates a cli-category error', () => {
        const err = errors.cli(CliCode.STACK_NOT_RUNNING, {
            message: 'No syncengine dev stack is running.',
            hint: 'Start one with: pnpm dev',
        });
        expect(err.category).toBe('cli');
        expect(err.severity).toBe('fatal');
        expect(err.hint).toBe('Start one with: pnpm dev');
    });
});

import { formatError } from '../errors';

describe('formatError', () => {
    it('formats a fatal error with hint', () => {
        const err = errors.schema(SchemaCode.MISSING_PRIMARY_KEY, {
            message: "Table 'cart' has no primary key column.",
            hint: "Add id() to your table definition:\n\n  const cart = table('cart', { id: id(), ... })",
            context: { table: 'cart' },
        });

        const output = formatError(err, { color: false });

        expect(output).toContain('SE::schema MISSING_PRIMARY_KEY');
        expect(output).toContain("Table 'cart' has no primary key column.");
        expect(output).toContain('hint:');
        expect(output).toContain('Add id() to your table definition:');
    });

    it('formats a warning with warning icon', () => {
        const err = errors.connection(ConnectionCode.NATS_UNREACHABLE, {
            message: 'Could not connect to NATS at localhost:4222.',
        });

        const output = formatError(err, { color: false });
        expect(output).toMatch(/⚠/);
        expect(output).toContain('SE::connection NATS_UNREACHABLE');
    });

    it('omits hint section when hint is undefined', () => {
        const err = errors.entity(EntityCode.INVALID_TRANSITION, {
            message: "Cannot transition 'status'.",
        });

        const output = formatError(err, { color: false });
        expect(output).not.toContain('hint:');
    });

    it('cleans stack traces — collapses syncengine internals', () => {
        const err = errors.schema(SchemaCode.MISSING_PRIMARY_KEY, {
            message: 'test',
        });
        err.stack = [
            'Error: test',
            '    at Object.<anonymous> (src/schema.ts:14:9)',
            '    at Module._compile (node_modules/@syncengine/core/dist/index.js:100:10)',
            '    at Module._compile (node_modules/@syncengine/core/dist/index.js:200:10)',
            '    at Object.<anonymous> (src/schema.ts:8:3)',
            '    at Module.load (node:internal/modules/cjs/loader:1200:32)',
        ].join('\n');

        const output = formatError(err, { color: false });

        expect(output).toContain('src/schema.ts:14:9');
        expect(output).toContain('src/schema.ts:8:3');
        expect(output).toMatch(/→.*src\/schema\.ts:14:9/);
        expect(output).toMatch(/syncengine internals hidden/);
        expect(output).not.toContain('node:internal');
    });

    it('handles errors with no stack gracefully', () => {
        const err = errors.schema(SchemaCode.MISSING_PRIMARY_KEY, {
            message: 'test',
        });
        err.stack = undefined;

        const output = formatError(err, { color: false });
        expect(output).toContain('MISSING_PRIMARY_KEY');
        expect(output).toContain('test');
    });

    it('formats plain Error with basic output', () => {
        const err = new Error('plain error');
        const output = formatError(err, { color: false });
        expect(output).toContain('plain error');
    });
});
