# Error System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all plain `new Error()` throws with a structured error system — typed codes, category factories, console renderer with stack cleaning.

**Architecture:** A `SyncEngineError` base class with per-category factory functions (`errors.schema()`, `errors.entity()`, etc.) and const code registries. A `formatError()` console renderer produces colored, structured terminal output with stack trace cleaning. ~86 throw sites across 6 packages get converted.

**Tech Stack:** TypeScript, Vitest, Node.js ANSI escape codes for console coloring.

**Deferred:** Browser overlay renderer (spec §4) — the vite-plugin has no overlay infrastructure today. This is a separate piece of work that builds on top of the error system once it's in place.

---

## Execution Invariants

**Every commit must leave the build green.** The deprecated classes (`EntityError` in core, `StackNotRunningError` in cli) stay alive through Tasks 1–9 while call sites are migrated, and are deleted only in Task 10 once nothing references them. Do NOT delete either class inside Tasks 4–9 even if individual files look "done".

**Two orthogonal error systems.** The platform error system (`SyncEngineError`, `errors.*`, code registries, `formatError`) is a one-way conversation from the *framework* to the *developer*: "this is what broke, this is how to fix it." User handler code should NOT throw `SyncEngineError` — those are for framework failures. User domain errors (e.g., `'OUT_OF_STOCK'`, `'RESERVATION_EXPIRED'`) use the existing `EntityError(code, message)` class, modeled on Meteor's `Meteor.Error`. `EntityError` is a user-facing public API and **is not deleted** by this plan — it's orthogonal to the platform error system.

**`applyHandler` catch-site propagation:** typed errors (both `SyncEngineError` from framework code bubbling through, and `EntityError` from user domain code) propagate unchanged. Everything else gets wrapped in a `UserHandlerError` with the original as `cause`.

```ts
} catch (err) {
    if (err instanceof SyncEngineError) throw err;  // framework re-throw
    if (err instanceof EntityError) throw err;      // user domain error
    const message = err instanceof Error ? err.message : String(err);
    throw errors.handler(HandlerCode.USER_HANDLER_ERROR, {
        message: `entity '${entity.$name}' handler '${handlerName}' rejected: ${message}`,
        context: { entity: entity.$name, handler: handlerName },
        cause: err instanceof Error ? err : new Error(String(err)),
    });
}
```

**Restate boundary loses structure.** `restate.TerminalError` is a stringly-typed wire boundary. `SyncEngineError` encodes as `[CATEGORY::CODE] message`; `EntityError` encodes as `[CODE] message` (matching the pre-existing format so clients that already parse this format don't break). `hint`/`context` drop at the boundary. Re-hydrating structure on the client is out of scope for this plan.

**Design-spec code regrouping (deviation, intentional).** The design spec §2 keeps definition-time errors like `INVALID_ENTITY_NAME`, `HANDLER_NAME_*`, `STATE_FIELD_COLLISION`, `TRANSITION_*` under `EntityCode`. This plan moves them to `SchemaCode` so that the split is definition-time (schema) vs runtime-validation (entity). `EntityCode` becomes the narrow runtime-state set: `INVALID_TRANSITION`, `MISSING_REQUIRED_FIELD`, `TYPE_MISMATCH`, `ENUM_VIOLATION`. The design spec should be updated to match.

---

## File Map

```
packages/core/src/errors/
├── codes.ts        — const code registries per category (SchemaCode, EntityCode, etc.)
├── error.ts        — SyncEngineError and UserHandlerError classes
├── factory.ts      — errors.schema(), errors.entity(), etc.
├── format.ts       — formatError() console renderer + stack trace cleaning
└── index.ts        — barrel re-exports

packages/core/src/__tests__/
├── errors.test.ts  — tests for error classes, factory, codes, format

packages/core/src/index.ts          — add error exports (Task 4). EntityError export stays.
packages/core/src/entity.ts         — convert framework-internal throws, update catch-site propagation (Task 5). EntityError class stays (public user-domain API, Meteor-style).
packages/core/src/schema.ts         — convert throws
packages/core/src/sql-gen.ts        — convert throws
packages/core/src/topic.ts          — convert throws
packages/core/src/http.ts           — convert throws
packages/core/src/migrations.ts     — convert throws
packages/core/src/__tests__/entity.test.ts — update one test (framework-thrown INVALID_TRANSITION now comes as SyncEngineError). User-throw propagation tests stay.
packages/server/src/entity-runtime.ts  — convert throws, update Restate catch-site (handles both SyncEngineError and EntityError)
packages/server/src/entity-keys.ts     — convert throws
packages/server/src/workflow.ts        — convert throws
packages/server/src/workspace/workspace.ts — convert throws
packages/client/src/store.ts           — convert throws
packages/client/src/entity-client.ts   — convert throws
packages/client/src/react.tsx          — convert throws
packages/cli/src/client.ts            — convert throws (Task 8); delete StackNotRunningError class (Task 10)
packages/cli/src/workspace.ts         — update StackNotRunningError catch-site
packages/cli/src/dev.ts               — convert throws
packages/cli/src/build.ts             — convert throws
packages/cli/src/init.ts              — convert throws
packages/cli/src/start.ts             — convert throws
packages/cli/src/runner.ts            — convert throws
packages/vite-plugin/src/index.ts     — convert throws
packages/vite-plugin/src/workspaces.ts — convert throws
packages/vite-plugin/src/devtools/devtools-plugin.ts — convert throws
packages/test-utils/src/test-store.ts  — convert throws
packages/bin-utils/index.ts           — convert throws
packages/restate-bin/index.ts         — convert throws

Unchanged (user-facing code that uses EntityError as intended):
- apps/test/src/entities/*.ts
- apps/test/src/__tests__/*.ts
- packages/test-utils/src/__tests__/test-store.test.ts
```

---

### Task 1: Error Classes and Code Registries

**Files:**
- Create: `packages/core/src/errors/codes.ts`
- Create: `packages/core/src/errors/error.ts`
- Create: `packages/core/src/errors/index.ts`
- Test: `packages/core/src/__tests__/errors.test.ts`

- [ ] **Step 1: Write failing tests for SyncEngineError and UserHandlerError**

```ts
// packages/core/src/__tests__/errors.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && npx vitest run src/__tests__/errors.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement code registries**

```ts
// packages/core/src/errors/codes.ts

export const SchemaCode = Object.freeze({
    MISSING_PRIMARY_KEY: 'MISSING_PRIMARY_KEY',
    RESERVED_COLUMN_PREFIX: 'RESERVED_COLUMN_PREFIX',
    INVALID_TABLE_NAME: 'INVALID_TABLE_NAME',
    DUPLICATE_TABLE_NAME: 'DUPLICATE_TABLE_NAME',
    DUPLICATE_VIEW_ID: 'DUPLICATE_VIEW_ID',
    DUPLICATE_CHANNEL_NAME: 'DUPLICATE_CHANNEL_NAME',
    VIEW_TABLE_NOT_FOUND: 'VIEW_TABLE_NOT_FOUND',
    CHANNEL_TABLE_NOT_FOUND: 'CHANNEL_TABLE_NOT_FOUND',
    INVALID_COLUMN_NAME: 'INVALID_COLUMN_NAME',
    INVALID_SQL_IDENTIFIER: 'INVALID_SQL_IDENTIFIER',
    INVALID_ENTITY_NAME: 'INVALID_ENTITY_NAME',
    INVALID_TOPIC_NAME: 'INVALID_TOPIC_NAME',
    INVALID_WORKFLOW_NAME: 'INVALID_WORKFLOW_NAME',
    HANDLER_NAME_RESERVED: 'HANDLER_NAME_RESERVED',
    HANDLER_NAME_INVALID: 'HANDLER_NAME_INVALID',
    HANDLER_NOT_FUNCTION: 'HANDLER_NOT_FUNCTION',
    STATE_FIELD_COLLISION: 'STATE_FIELD_COLLISION',
    TRANSITION_NOT_EXHAUSTIVE: 'TRANSITION_NOT_EXHAUSTIVE',
    TRANSITION_AMBIGUOUS: 'TRANSITION_AMBIGUOUS',
    TRANSITION_NO_MATCH: 'TRANSITION_NO_MATCH',
    UNKNOWN_MIGRATION_OP: 'UNKNOWN_MIGRATION_OP',
    CONFIG_LOAD_FAILED: 'CONFIG_LOAD_FAILED',
    CONFIG_NO_DEFAULT_EXPORT: 'CONFIG_NO_DEFAULT_EXPORT',
    NOT_ENTITY_DEFINITION: 'NOT_ENTITY_DEFINITION',
} as const);

export type SchemaCodeValue = typeof SchemaCode[keyof typeof SchemaCode];

export const EntityCode = Object.freeze({
    INVALID_TRANSITION: 'INVALID_TRANSITION',
    MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
    TYPE_MISMATCH: 'TYPE_MISMATCH',
    ENUM_VIOLATION: 'ENUM_VIOLATION',
} as const);

export type EntityCodeValue = typeof EntityCode[keyof typeof EntityCode];

export const StoreCode = Object.freeze({
    INVALID_SEED_KEY: 'INVALID_SEED_KEY',
    INVALID_WORKSPACE_FORMAT: 'INVALID_WORKSPACE_FORMAT',
    INVALID_ENTITY_KEY: 'INVALID_ENTITY_KEY',
    WORKSPACE_NOT_ACTIVE: 'WORKSPACE_NOT_ACTIVE',
    RESET_DISABLED: 'RESET_DISABLED',
    TEST_STORE_ROW_NOT_FOUND: 'TEST_STORE_ROW_NOT_FOUND',
    TEST_STORE_UNKNOWN_TABLE: 'TEST_STORE_UNKNOWN_TABLE',
} as const);

export type StoreCodeValue = typeof StoreCode[keyof typeof StoreCode];

export const ConnectionCode = Object.freeze({
    NATS_UNREACHABLE: 'NATS_UNREACHABLE',
    RESTATE_UNREACHABLE: 'RESTATE_UNREACHABLE',
    AUTH_FAILED: 'AUTH_FAILED',
    WORKER_CRASHED: 'WORKER_CRASHED',
    HTTP_ERROR: 'HTTP_ERROR',
    MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
} as const);

export type ConnectionCodeValue = typeof ConnectionCode[keyof typeof ConnectionCode];

export const HandlerCode = Object.freeze({
    USER_HANDLER_ERROR: 'USER_HANDLER_ERROR',
    HANDLER_NOT_FOUND: 'HANDLER_NOT_FOUND',
    WORKFLOW_FAILED: 'WORKFLOW_FAILED',
} as const);

export type HandlerCodeValue = typeof HandlerCode[keyof typeof HandlerCode];

export const CliCode = Object.freeze({
    STACK_NOT_RUNNING: 'STACK_NOT_RUNNING',
    STACK_ALREADY_RUNNING: 'STACK_ALREADY_RUNNING',
    PORT_CONFLICT: 'PORT_CONFLICT',
    APP_DIR_NOT_FOUND: 'APP_DIR_NOT_FOUND',
    DEPENDENCY_NOT_FOUND: 'DEPENDENCY_NOT_FOUND',
    BUILD_OUTPUT_MISSING: 'BUILD_OUTPUT_MISSING',
    DIRECTORY_NOT_EMPTY: 'DIRECTORY_NOT_EMPTY',
    FRESH_REFUSED: 'FRESH_REFUSED',
    TIMEOUT: 'TIMEOUT',
    ENV_MISSING: 'ENV_MISSING',
    UNSUPPORTED_PLATFORM: 'UNSUPPORTED_PLATFORM',
    CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH',
    UNSUPPORTED_ARCHIVE: 'UNSUPPORTED_ARCHIVE',
    BINARY_NOT_FOUND: 'BINARY_NOT_FOUND',
    PROVIDER_MISSING: 'PROVIDER_MISSING',
} as const);

export type CliCodeValue = typeof CliCode[keyof typeof CliCode];
```

- [ ] **Step 4: Implement error classes**

```ts
// packages/core/src/errors/error.ts
import type {
    SchemaCodeValue, EntityCodeValue, StoreCodeValue,
    ConnectionCodeValue, HandlerCodeValue, CliCodeValue,
} from './codes.js';
import { HandlerCode } from './codes.js';

export type ErrorCategory = 'schema' | 'entity' | 'store' | 'connection' | 'handler' | 'cli';
export type ErrorSeverity = 'fatal' | 'warning' | 'info';

type AnyCode =
    | SchemaCodeValue | EntityCodeValue | StoreCodeValue
    | ConnectionCodeValue | HandlerCodeValue | CliCodeValue;

export interface SyncEngineErrorInit {
    code: AnyCode;
    category: ErrorCategory;
    severity: ErrorSeverity;
    message: string;
    hint?: string;
    context?: Record<string, unknown>;
    cause?: Error;
}

export class SyncEngineError extends Error {
    readonly code: AnyCode;
    readonly category: ErrorCategory;
    readonly severity: ErrorSeverity;
    readonly hint?: string;
    readonly context: Record<string, unknown>;

    constructor(init: SyncEngineErrorInit) {
        super(init.message, { cause: init.cause });
        this.name = 'SyncEngineError';
        this.code = init.code;
        this.category = init.category;
        this.severity = init.severity;
        this.hint = init.hint;
        this.context = init.context ?? {};
    }
}

export interface UserHandlerErrorInit {
    message: string;
    context?: Record<string, unknown>;
    cause: Error;
}

export class UserHandlerError extends SyncEngineError {
    constructor(init: UserHandlerErrorInit) {
        super({
            code: HandlerCode.USER_HANDLER_ERROR,
            category: 'handler',
            severity: 'fatal',
            message: init.message,
            context: init.context ?? {},
            cause: init.cause,
        });
        this.name = 'UserHandlerError';
    }
}
```

- [ ] **Step 5: Create barrel export**

```ts
// packages/core/src/errors/index.ts
export { SyncEngineError, UserHandlerError } from './error.js';
export type { ErrorCategory, ErrorSeverity, SyncEngineErrorInit } from './error.js';
export {
    SchemaCode, EntityCode, StoreCode,
    ConnectionCode, HandlerCode, CliCode,
} from './codes.js';
export type {
    SchemaCodeValue, EntityCodeValue, StoreCodeValue,
    ConnectionCodeValue, HandlerCodeValue, CliCodeValue,
} from './codes.js';
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run src/__tests__/errors.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/errors/ packages/core/src/__tests__/errors.test.ts
git commit -m "feat(errors): add SyncEngineError classes and code registries"
```

---

### Task 2: Factory API

**Files:**
- Create: `packages/core/src/errors/factory.ts`
- Modify: `packages/core/src/errors/index.ts`
- Test: `packages/core/src/__tests__/errors.test.ts` (append)

- [ ] **Step 1: Write failing tests for the factory**

Append to `packages/core/src/__tests__/errors.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && npx vitest run src/__tests__/errors.test.ts`
Expected: FAIL — `errors` not exported.

- [ ] **Step 3: Implement the factory**

```ts
// packages/core/src/errors/factory.ts
import { SyncEngineError, UserHandlerError } from './error.js';
import type { ErrorSeverity } from './error.js';
import type {
    SchemaCodeValue, EntityCodeValue, StoreCodeValue,
    ConnectionCodeValue, HandlerCodeValue, CliCodeValue,
} from './codes.js';
import { HandlerCode } from './codes.js';

export interface ErrorOpts {
    message: string;
    hint?: string;
    context?: Record<string, unknown>;
    cause?: Error;
    severity?: ErrorSeverity;
}

function make(
    code: string,
    category: SyncEngineError['category'],
    defaultSeverity: ErrorSeverity,
    opts: ErrorOpts,
): SyncEngineError {
    return new SyncEngineError({
        code: code as SyncEngineError['code'],
        category,
        severity: opts.severity ?? defaultSeverity,
        message: opts.message,
        hint: opts.hint,
        context: opts.context,
        cause: opts.cause,
    });
}

// USER_HANDLER_ERROR requires a `cause` — enforced via an overloaded signature so
// the factory can't silently downgrade to a non-UserHandlerError SyncEngineError.
interface HandlerFactory {
    (code: typeof HandlerCode.USER_HANDLER_ERROR, opts: ErrorOpts & { cause: Error }): UserHandlerError;
    (code: Exclude<HandlerCodeValue, typeof HandlerCode.USER_HANDLER_ERROR>, opts: ErrorOpts): SyncEngineError;
}

const handler: HandlerFactory = ((code: HandlerCodeValue, opts: ErrorOpts & { cause?: Error }) => {
    if (code === HandlerCode.USER_HANDLER_ERROR) {
        // Overload guarantees cause is present at the type level.
        return new UserHandlerError({
            message: opts.message,
            context: opts.context,
            cause: opts.cause as Error,
        });
    }
    return make(code, 'handler', 'fatal', opts);
}) as HandlerFactory;

export const errors = {
    schema(code: SchemaCodeValue, opts: ErrorOpts): SyncEngineError {
        return make(code, 'schema', 'fatal', opts);
    },
    entity(code: EntityCodeValue, opts: ErrorOpts): SyncEngineError {
        return make(code, 'entity', 'fatal', opts);
    },
    store(code: StoreCodeValue, opts: ErrorOpts): SyncEngineError {
        return make(code, 'store', 'fatal', opts);
    },
    connection(code: ConnectionCodeValue, opts: ErrorOpts): SyncEngineError {
        return make(code, 'connection', 'warning', opts);
    },
    handler,
    cli(code: CliCodeValue, opts: ErrorOpts): SyncEngineError {
        return make(code, 'cli', 'fatal', opts);
    },
};
```

- [ ] **Step 4: Add factory to barrel export**

Add to `packages/core/src/errors/index.ts`:
```ts
export { errors } from './factory.js';
export type { ErrorOpts } from './factory.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run src/__tests__/errors.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/errors/factory.ts packages/core/src/errors/index.ts packages/core/src/__tests__/errors.test.ts
git commit -m "feat(errors): add factory API — errors.schema(), errors.entity(), etc."
```

---

### Task 3: Console Renderer with Stack Trace Cleaning

**Files:**
- Create: `packages/core/src/errors/format.ts`
- Modify: `packages/core/src/errors/index.ts`
- Test: `packages/core/src/__tests__/errors.test.ts` (append)

- [ ] **Step 1: Write failing tests for formatError**

Append to `packages/core/src/__tests__/errors.test.ts`:

```ts
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
        // Manually set a fake stack to test cleaning
        err.stack = [
            'Error: test',
            '    at Object.<anonymous> (src/schema.ts:14:9)',
            '    at Module._compile (node_modules/@syncengine/core/dist/index.js:100:10)',
            '    at Module._compile (node_modules/@syncengine/core/dist/index.js:200:10)',
            '    at Object.<anonymous> (src/schema.ts:8:3)',
            '    at Module.load (node:internal/modules/cjs/loader:1200:32)',
        ].join('\n');

        const output = formatError(err, { color: false });

        // User frames shown
        expect(output).toContain('src/schema.ts:14:9');
        expect(output).toContain('src/schema.ts:8:3');
        // First user frame gets → prefix
        expect(output).toMatch(/→.*src\/schema\.ts:14:9/);
        // Internals collapsed
        expect(output).toMatch(/syncengine internals hidden/);
        // node: internals collapsed
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && npx vitest run src/__tests__/errors.test.ts`
Expected: FAIL — `formatError` not exported.

- [ ] **Step 3: Implement formatError**

```ts
// packages/core/src/errors/format.ts
import { SyncEngineError } from './error.js';

interface FormatOpts {
    color?: boolean;
}

const SEVERITY_ICONS = { fatal: '✘', warning: '⚠', info: 'ℹ' } as const;

// ANSI helpers
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function wrap(text: string, code: string, color: boolean): string {
    return color ? `${code}${text}${RESET}` : text;
}

function severityColor(severity: SyncEngineError['severity']): string {
    if (severity === 'fatal') return RED;
    if (severity === 'warning') return YELLOW;
    return DIM;
}

interface ParsedFrame {
    raw: string;
    path: string;
    isUserCode: boolean;
}

function parseStack(stack: string | undefined): ParsedFrame[] {
    if (!stack) return [];
    return stack
        .split('\n')
        .slice(1) // skip "Error: ..." line
        .map((line) => line.trim())
        .filter((line) => line.startsWith('at '))
        .map((raw) => {
            // Non-greedy + end-anchored so "at foo (bar) (path)" (rare) captures the
            // final parenthesized group, not everything between the first and last paren.
            const match = raw.match(/\(([^)]+)\)$/) ?? raw.match(/at (.+)$/);
            const path = match?.[1] ?? raw;
            const isUserCode =
                !path.includes('node_modules') && !path.startsWith('node:');
            return { raw, path, isUserCode };
        });
}

function formatStack(frames: ParsedFrame[], color: boolean): string[] {
    const lines: string[] = [];
    let collapsedSyncEngine = 0;
    let collapsedOther = 0;
    let firstUserFrame = true;

    function flushCollapsed() {
        if (collapsedSyncEngine > 0) {
            lines.push(
                `   ${wrap(`┄ (${collapsedSyncEngine} syncengine internals hidden)`, DIM, color)}`,
            );
            collapsedSyncEngine = 0;
        }
        if (collapsedOther > 0) {
            lines.push(
                `   ${wrap(`┄ (${collapsedOther} internals hidden)`, DIM, color)}`,
            );
            collapsedOther = 0;
        }
    }

    for (const frame of frames) {
        if (frame.isUserCode) {
            flushCollapsed();
            const prefix = firstUserFrame ? '→' : ' ';
            firstUserFrame = false;
            lines.push(`   ${prefix} ${frame.path}`);
        } else if (frame.path.includes('@syncengine')) {
            collapsedSyncEngine++;
        } else {
            collapsedOther++;
        }
    }

    flushCollapsed();
    return lines;
}

export function formatError(error: Error, opts: FormatOpts = {}): string {
    const color = opts.color ?? true;

    if (!(error instanceof SyncEngineError)) {
        return `${wrap('✘', RED, color)} ${error.message}`;
    }

    const icon = SEVERITY_ICONS[error.severity];
    const sColor = severityColor(error.severity);
    const lines: string[] = [];

    // Header
    lines.push(
        ` ${wrap(icon, sColor, color)} ${wrap(`SE::${error.category}`, BOLD, color)} ${wrap(error.code, sColor, color)}`,
    );
    lines.push('');

    // Message
    lines.push(`   ${error.message}`);

    // Hint
    if (error.hint) {
        lines.push('');
        lines.push(`   ${wrap('hint:', DIM, color)} ${error.hint.split('\n')[0]}`);
        for (const hintLine of error.hint.split('\n').slice(1)) {
            lines.push(`   ${hintLine ? '      ' + hintLine : ''}`);
        }
    }

    // Stack
    const frames = parseStack(error.stack);
    if (frames.length > 0) {
        lines.push('');
        lines.push(...formatStack(frames, color));
    }

    return lines.join('\n');
}
```

- [ ] **Step 4: Add formatError to barrel export**

Add to `packages/core/src/errors/index.ts`:
```ts
export { formatError } from './format.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run src/__tests__/errors.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/errors/format.ts packages/core/src/errors/index.ts packages/core/src/__tests__/errors.test.ts
git commit -m "feat(errors): add console renderer with stack trace cleaning"
```

---

### Task 4: Wire Exports from @syncengine/core (additive only)

**Files:**
- Modify: `packages/core/src/index.ts`

**Invariant:** `EntityError` remains exported and defined until Task 10. This task is purely additive.

- [ ] **Step 1: Add error exports to core barrel**

In `packages/core/src/index.ts`, add a new export block near the top of the file. Do NOT touch the existing `EntityError` export — it stays until Task 10.

```ts
export {
    SyncEngineError,
    UserHandlerError,
    errors,
    formatError,
    SchemaCode,
    EntityCode,
    StoreCode,
    ConnectionCode,
    HandlerCode,
    CliCode,
} from './errors/index.js';

export type {
    ErrorCategory,
    ErrorSeverity,
    ErrorOpts,
    SyncEngineErrorInit,
} from './errors/index.js';
```

- [ ] **Step 2: Run typecheck to verify build is clean**

Run: `cd packages/core && npx tsc --noEmit`
Expected: PASS. This task adds exports only; nothing existing changes.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(errors): export error system from @syncengine/core"
```

---

### Task 5: Convert packages/core Throw Sites

**Files:**
- Modify: `packages/core/src/entity.ts` (~16 throws)
- Modify: `packages/core/src/schema.ts` (~2 throws)
- Modify: `packages/core/src/sql-gen.ts` (~1 throw)
- Modify: `packages/core/src/topic.ts` (~3 throws)
- Modify: `packages/core/src/http.ts` (~1 throw)
- Modify: `packages/core/src/migrations.ts` (~1 throw)
- Test: `packages/core/src/__tests__/entity.test.ts` (update expects)
- Test: `packages/core/src/__tests__/schema.test.ts` (update expects)

- [ ] **Step 1: Convert entity.ts definition-time throws**

Add import at top of `packages/core/src/entity.ts`:
```ts
import { errors, SchemaCode, EntityCode } from './errors/index.js';
```

Convert each `throw new Error(...)` in the `defineEntity()` function to use `errors.schema()`. Example conversions:

Line 288 (`name must be a non-empty string`):
```ts
// Before:
throw new Error('defineEntity: name must be a non-empty string.');
// After:
throw errors.schema(SchemaCode.INVALID_ENTITY_NAME, {
    message: `defineEntity: name must be a non-empty string.`,
    hint: `Pass a valid name: defineEntity('myEntity', { ... })`,
});
```

Line 291 (`names may not start with '$'`):
```ts
throw errors.schema(SchemaCode.INVALID_ENTITY_NAME, {
    message: `defineEntity('${name}'): names may not start with '$' (reserved for framework metadata).`,
    hint: `Remove the '$' prefix from the entity name.`,
    context: { entity: name },
});
```

Line 297 (`name must match regex`):
```ts
throw errors.schema(SchemaCode.INVALID_ENTITY_NAME, {
    message: `defineEntity('${name}'): name must match /^[a-zA-Z][a-zA-Z0-9_]*$/ so it can be used as a Restate virtual-object name.`,
    hint: `Use only letters, numbers, and underscores. Must start with a letter.`,
    context: { entity: name },
});
```

Line 304 (`state field may not start with '$'`):
```ts
throw errors.schema(SchemaCode.RESERVED_COLUMN_PREFIX, {
    message: `defineEntity('${name}'): state field '${colName}' may not start with '$' (reserved for framework metadata).`,
    hint: `Rename the state field to remove the '$' prefix.`,
    context: { entity: name, field: colName },
});
```

Line 312 (`handler must be a function`):
```ts
throw errors.schema(SchemaCode.HANDLER_NOT_FUNCTION, {
    message: `defineEntity('${name}'): handler '${handlerName}' must be a function.`,
    hint: `Provide a function: handlers: { ${handlerName}(state, ...args) { return newState; } }`,
    context: { entity: name, handler: handlerName },
});
```

Line 321 (`handler name reserved`):
```ts
throw errors.schema(SchemaCode.HANDLER_NAME_RESERVED, {
    message: `defineEntity('${name}'): handler name '${handlerName}' is reserved (starts with '_' or '$').`,
    hint: `Choose a handler name that doesn't start with '_' or '$'.`,
    context: { entity: name, handler: handlerName },
});
```

Line 327 (`handler name must match regex`):
```ts
throw errors.schema(SchemaCode.HANDLER_NAME_INVALID, {
    message: `defineEntity('${name}'): handler name '${handlerName}' must match /^[a-zA-Z][a-zA-Z0-9_]*$/ (Restate requirement).`,
    hint: `Use only letters, numbers, and underscores. Must start with a letter.`,
    context: { entity: name, handler: handlerName },
});
```

Line 340 (`source projection collides with state field`):
```ts
throw errors.schema(SchemaCode.STATE_FIELD_COLLISION, {
    message: `defineEntity('${name}'): source projection '${projName}' collides with state field '${projName}'.`,
    hint: `Rename either the state field or the source projection to avoid the collision.`,
    context: { entity: name, field: projName },
});
```

Lines 369, 376, 388 (transition map errors):
```ts
// Line 369 — no match
throw errors.schema(SchemaCode.TRANSITION_NO_MATCH, {
    message: `defineEntity('${name}'): transitions values don't match any state field's enum. Provide a state field with a matching text({ enum: [...] }) column.`,
    context: { entity: name },
});

// Line 376 — ambiguous
throw errors.schema(SchemaCode.TRANSITION_AMBIGUOUS, {
    message: `defineEntity('${name}'): transitions map is ambiguous — matches state fields: ${candidates.join(', ')}.`,
    hint: `Ensure only one state field has an enum that matches the transition keys.`,
    context: { entity: name, candidates },
});

// Line 388 — not exhaustive
throw errors.schema(SchemaCode.TRANSITION_NOT_EXHAUSTIVE, {
    message: `defineEntity('${name}'): transitions map is missing state '${ev}'. All enum values must be covered.`,
    hint: `Add '${ev}' to your transitions map:\n\n  transitions: { ..., ${ev}: [...] }`,
    context: { entity: name, missing: ev },
});
```

- [ ] **Step 2: Convert entity.ts runtime throws and update catch-site propagation**

Line 767 (`no handler named`):
```ts
throw errors.handler(HandlerCode.HANDLER_NOT_FOUND, {
    message: `entity '${entity.$name}': no handler named '${handlerName}'.`,
    hint: `Available handlers: ${Object.keys(entity.$handlers).join(', ')}`,
    context: { entity: entity.$name, handler: handlerName },
});
```

**Catch block around line 788–796** (currently propagates `EntityError` via `instanceof`). Extend the propagation check so **both** `SyncEngineError` (framework errors re-thrown through user code) and `EntityError` (user domain errors) pass through unchanged. Everything else gets wrapped in `UserHandlerError` with the original as `cause`.

```ts
// Add to imports at top of file:
import { errors, SchemaCode, EntityCode, HandlerCode, SyncEngineError } from './errors/index.js';
// (EntityError is already referenced in this file — keep that reference.)

// Replace the existing catch block:
} catch (err) {
    // Typed errors propagate unchanged so callers can pattern-match on them.
    if (err instanceof SyncEngineError) throw err;   // framework re-throw
    if (err instanceof EntityError) throw err;       // user domain error
    const message = err instanceof Error ? err.message : String(err);
    throw errors.handler(HandlerCode.USER_HANDLER_ERROR, {
        message: `entity '${entity.$name}' handler '${handlerName}' rejected: ${message}`,
        context: { entity: entity.$name, handler: handlerName },
        cause: err instanceof Error ? err : new Error(String(err)),
    });
}
```

`EntityError` stays as a public user-facing domain-error class — it is **not** deleted by Task 10. See Execution Invariants for rationale.

Line 830 (framework-thrown INVALID_TRANSITION — this is the framework detecting an illegal transition, so it migrates to the platform error system):
```ts
throw errors.entity(EntityCode.INVALID_TRANSITION, {
    message: `Cannot transition '${field}' from '${oldStatus}' to '${newStatus}'.`,
    hint: `Valid transitions from '${oldStatus}': ${allowed.join(', ')}.`,
    context: { entity: entity.$name, field, from: oldStatus, to: newStatus },
});
```

Lines 177, 183, 189 (`validateEntityState` throws):
```ts
// Line 177 — required but missing
throw errors.entity(EntityCode.MISSING_REQUIRED_FIELD, {
    message: `Entity '${entityName}': column '${name}' is required but missing.`,
    hint: `Ensure your handler returns a value for '${name}'.`,
    context: { entity: entityName, field: name },
});

// Line 183 — type mismatch
throw errors.entity(EntityCode.TYPE_MISMATCH, {
    message: `Entity '${entityName}': column '${name}' expects ${expectedType}, got ${typeof value}.`,
    hint: `Return the correct type from your handler.`,
    context: { entity: entityName, field: name, expected: expectedType, got: typeof value },
});

// Line 189 — enum violation
throw errors.entity(EntityCode.ENUM_VIOLATION, {
    message: `Entity '${entityName}': column '${name}' must be one of ${JSON.stringify(col.enum)}, got ${JSON.stringify(value)}.`,
    hint: `Return one of the allowed enum values.`,
    context: { entity: entityName, field: name, allowed: col.enum, got: value },
});
```

- [ ] **Step 3: Convert schema.ts, sql-gen.ts, topic.ts, http.ts, migrations.ts**

`packages/core/src/schema.ts`:
```ts
import { errors, SchemaCode } from './errors/index.js';

// Line 216 — reserved column name
throw errors.schema(SchemaCode.INVALID_COLUMN_NAME, {
    message: `Invalid column name '${key}' in table '${name}': column names may not start with '$' (reserved for table metadata).`,
    hint: `Rename the column to remove the '$' prefix.`,
    context: { table: name, column: key },
});

// Line 226 — no primary key
throw errors.schema(SchemaCode.MISSING_PRIMARY_KEY, {
    message: `Table '${name}' has no primary key column.`,
    hint: `Add id() for an auto-generated integer PK:\n\n  const ${name} = table('${name}', { id: id(), ... })`,
    context: { table: name },
});
```

`packages/core/src/sql-gen.ts`:
```ts
import { errors, SchemaCode } from './errors/index.js';

// Line 17 — invalid SQL identifier
throw errors.schema(SchemaCode.INVALID_SQL_IDENTIFIER, {
    message: `Invalid SQL identifier: "${name}"`,
    hint: `Use only letters, numbers, and underscores.`,
    context: { identifier: name },
});
```

`packages/core/src/topic.ts`:
```ts
import { errors, SchemaCode } from './errors/index.js';

// Line 67 — empty name
throw errors.schema(SchemaCode.INVALID_TOPIC_NAME, {
    message: `topic: name must be a non-empty string.`,
    hint: `Pass a valid name: topic('myTopic', { ... })`,
});

// Line 70 — $ prefix
throw errors.schema(SchemaCode.INVALID_TOPIC_NAME, {
    message: `topic('${name}'): names may not start with '$' (reserved for framework metadata).`,
    hint: `Remove the '$' prefix.`,
    context: { topic: name },
});

// Line 76 — regex mismatch
throw errors.schema(SchemaCode.INVALID_TOPIC_NAME, {
    message: `topic('${name}'): name must match /^[a-zA-Z][a-zA-Z0-9_]*$/ so it can be used as a NATS subject token.`,
    hint: `Use only letters, numbers, and underscores. Must start with a letter.`,
    context: { topic: name },
});

// Line 83 — state field $ prefix
throw errors.schema(SchemaCode.RESERVED_COLUMN_PREFIX, {
    message: `topic('${name}'): state field '${fieldName}' may not start with '$' (reserved for framework metadata).`,
    hint: `Rename the field to remove the '$' prefix.`,
    context: { topic: name, field: fieldName },
});
```

`packages/core/src/http.ts`:
```ts
import { errors, ConnectionCode } from './errors/index.js';

// Line 49 — workspace provision HTTP error
throw errors.connection(ConnectionCode.HTTP_ERROR, {
    message: `workspace.provision(${wsKey}) → HTTP ${res.status}: ${text}`,
    context: { workspace: wsKey, status: res.status },
});
```

`packages/core/src/migrations.ts`:
```ts
import { errors, SchemaCode } from './errors/index.js';

// Line 48 — unknown migration op
throw errors.schema(SchemaCode.UNKNOWN_MIGRATION_OP, {
    message: `Unknown migration op: ${(step as any).op}`,
    hint: `Valid ops: addColumn, dropColumn, renameColumn.`,
    context: { op: (step as any).op },
});
```

- [ ] **Step 4: Update `entity.test.ts` for the framework-thrown INVALID_TRANSITION**

Two kinds of `EntityError` tests live in `packages/core/src/__tests__/entity.test.ts`:

1. **User-throw propagation** (~lines 306–324): a handler fixture does `throw new EntityError('INVALID_TRANSITION', 'already done')` and the test asserts the error propagates. This is the *user contract* and **stays unchanged** — `EntityError` remains public API and the catch block still propagates it.

2. **Framework-thrown INVALID_TRANSITION** (~lines 492–508): asserts that when the transition guard in `applyHandler` (line 830) rejects, the caller receives an `EntityError` with `code === 'INVALID_TRANSITION'`. After Task 5 Step 2, that throw migrates to `errors.entity(EntityCode.INVALID_TRANSITION, …)`, so the error is now a `SyncEngineError`. Rewrite this test only.

Add `SyncEngineError` and `EntityCode` to the import block at line 8 (keep the existing `EntityError` import — group (1) still uses it):
```ts
import {
    ..., EntityError, errors, EntityCode, SyncEngineError, ...
} from '../index';
```

Rewrite the test at ~line 492:
```ts
it('rejects invalid transitions with SyncEngineError INVALID_TRANSITION', () => {
    // ... existing setup ...
    try {
        applyHandler(e, 'finish', { status: 'idle' }, []);
    } catch (err) {
        expect(err).toBeInstanceOf(SyncEngineError);
        expect((err as SyncEngineError).code).toBe(EntityCode.INVALID_TRANSITION);
        expect((err as SyncEngineError).category).toBe('entity');
        expect((err as SyncEngineError).message).toContain("'idle'");
        expect((err as SyncEngineError).message).toContain("'done'");
        return;
    }
    throw new Error('expected throw');
});

// Line 508 equivalent:
expect(() => applyHandler(/* … */)).toThrow(SyncEngineError);
```

`packages/core/src/__tests__/schema.test.ts` — construction-guard tests use `.toThrow(/regex/)` to match message substrings. Messages are preserved verbatim, so these still pass without change. Verify by running tests.

- [ ] **Step 5: Run all core tests**

Run: `cd packages/core && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/
git commit -m "refactor(core): convert throw sites to errors.* factories, propagate SyncEngineError from handlers"
```

---

### Task 6: Convert packages/server Throw Sites

**Files:**
- Modify: `packages/server/src/entity-runtime.ts`
- Modify: `packages/server/src/entity-keys.ts`
- Modify: `packages/server/src/workflow.ts`
- Modify: `packages/server/src/workspace/workspace.ts`

- [ ] **Step 1: Convert entity-runtime.ts**

```ts
// Update imports — KEEP EntityError (user domain errors flow through here too)
// and add the SyncEngine types.
import { errors, HandlerCode, SchemaCode, SyncEngineError, EntityError } from '@syncengine/core';
```

**Catch block around line 83–92** (currently builds `[CODE] message` from `EntityError.code` and throws `restate.TerminalError`). Both typed shapes need to survive the wire boundary; `TerminalError` is stringly-typed so `hint`/`context` drop. `SyncEngineError` encodes `[CATEGORY::CODE] message`; `EntityError` keeps the existing `[CODE] message` format to stay backwards-compatible with any client already parsing it.

```ts
try {
    validated = applyHandler(entity, handlerName, merged, args);
} catch (err) {
    // Typed errors carry structured fields; encode them into the TerminalError
    // message so they survive the Restate wire boundary. hint/context drop here.
    if (err instanceof SyncEngineError) {
        throw new restate.TerminalError(`[${err.category}::${err.code}] ${err.message}`);
    }
    if (err instanceof EntityError) {
        throw new restate.TerminalError(`[${err.code}] ${err.message}`);
    }
    // applyHandler wraps everything else as UserHandlerError (a SyncEngineError),
    // so this fallback is defensive only.
    const message = err instanceof Error ? err.message : String(err);
    throw new restate.TerminalError(message);
}
```

Line 259 (`not an entity definition`):
```ts
throw errors.schema(SchemaCode.NOT_ENTITY_DEFINITION, {
    message: `buildEntityObject: not an entity definition`,
    hint: `Pass a value created by defineEntity().`,
});
```

- [ ] **Step 2: Convert entity-keys.ts**

```ts
import { errors, StoreCode } from '@syncengine/core';

// Line 9 — invalid entity key format
throw errors.store(StoreCode.INVALID_ENTITY_KEY, {
    message: `Entity key '${objKey}' must be of the form 'workspaceId/entityKey'.`,
    hint: `Format: 'workspace-id/entity-key'`,
    context: { key: objKey },
});
```

- [ ] **Step 3: Convert workflow.ts**

```ts
import { errors, SchemaCode } from '@syncengine/core';

// Line 24 — empty name
throw errors.schema(SchemaCode.INVALID_WORKFLOW_NAME, {
    message: `defineWorkflow: name must be a non-empty string.`,
    hint: `Pass a valid name: defineWorkflow('myWorkflow', { ... })`,
});

// Line 27 — regex mismatch
throw errors.schema(SchemaCode.INVALID_WORKFLOW_NAME, {
    message: `defineWorkflow('${name}'): name must match /^[a-zA-Z][a-zA-Z0-9_]*$/.`,
    hint: `Use only letters, numbers, and underscores. Must start with a letter.`,
    context: { workflow: name },
});
```

- [ ] **Step 4: Convert workspace.ts**

```ts
import { errors, StoreCode, ConnectionCode } from '@syncengine/core';

// Line 91 — workspace not active
throw errors.store(StoreCode.WORKSPACE_NOT_ACTIVE, {
    message: `Workspace not active`,
    context: { workspace: wsKey },
});

// Line 426 — reset disabled in production
throw errors.store(StoreCode.RESET_DISABLED, {
    message: `reset is disabled in production`,
    hint: `Set SYNCENGINE_ALLOW_RESET=1 to enable reset in production.`,
});

// Line 445 — Restate admin HTTP error
throw errors.connection(ConnectionCode.HTTP_ERROR, {
    message: `Restate admin query failed: HTTP ${qRes.status}`,
    context: { status: qRes.status },
});
```

Note: workspace.ts throws `restate.TerminalError` not plain `Error` — for lines 91 and 426, continue wrapping in `restate.TerminalError` but use the `SyncEngineError` message. The Restate runtime requires `TerminalError` for non-retryable failures.

- [ ] **Step 5: Run server typecheck**

Run: `cd packages/server && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/
git commit -m "refactor(server): convert throw sites to errors.* factories"
```

---

### Task 7: Convert packages/client Throw Sites

**Files:**
- Modify: `packages/client/src/store.ts` (~8 throws)
- Modify: `packages/client/src/entity-client.ts` (~2 throws)
- Modify: `packages/client/src/react.tsx` (~1 throw)

- [ ] **Step 1: Convert store.ts**

```ts
import {
    errors, SchemaCode, StoreCode, HandlerCode, SyncEngineError,
} from '@syncengine/core';

// Line 293 — no primary key
throw errors.schema(SchemaCode.MISSING_PRIMARY_KEY, {
    message: `Table '${t.$name}' has no primary key column.`,
    hint: `Add id() for an auto-generated integer PK.`,
    context: { table: t.$name },
});

// Line 304 — duplicate table name
throw errors.schema(SchemaCode.DUPLICATE_TABLE_NAME, {
    message: `Duplicate table name: '${t.$name}'.`,
    context: { table: t.$name },
});

// Line 317 — duplicate view id
throw errors.schema(SchemaCode.DUPLICATE_VIEW_ID, {
    message: `Duplicate view id: '${v.$id}' (internal bug, please report).`,
    context: { view: v.$id },
});

// Line 327 — view references unknown table
throw errors.schema(SchemaCode.VIEW_TABLE_NOT_FOUND, {
    message: `View '${v.$id}' references unknown table '${tableName}'.`,
    hint: `Add '${tableName}' to your store config tables array.`,
    context: { view: v.$id, table: tableName },
});

// Line 340 — duplicate channel name
throw errors.schema(SchemaCode.DUPLICATE_CHANNEL_NAME, {
    message: `Duplicate channel name: '${ch.name}'.`,
    context: { channel: ch.name },
});

// Line 346 — channel references unknown table
throw errors.schema(SchemaCode.CHANNEL_TABLE_NOT_FOUND, {
    message: `Channel '${ch.name}' references unknown table '${t.$name}'.`,
    hint: `Add '${t.$name}' to your store config tables array.`,
    context: { channel: ch.name, table: t.$name },
});

// Line 361 — invalid seed key
throw errors.store(StoreCode.INVALID_SEED_KEY, {
    message: `seed key '${seedKey}' does not correspond to any table in config.tables.`,
    hint: `Available tables: ${tableNames.join(', ')}`,
    context: { seedKey },
});

// Line 1184 — workflow failed
throw errors.handler(HandlerCode.WORKFLOW_FAILED, {
    message: `workflow '${workflow.$name}' failed: ${res.status} ${text}`,
    context: { workflow: workflow.$name, status: res.status },
});
```

- [ ] **Step 2: Convert entity-client.ts**

```ts
import { errors, ConnectionCode } from '@syncengine/core';

// Line 465 — handler HTTP error
throw errors.connection(ConnectionCode.HTTP_ERROR, {
    message: `entity '${entity.$name}'.${handlerName}('${key}') failed: ${res.status} ${text}`,
    context: { entity: entity.$name, handler: handlerName, key, status: res.status },
});

// Line 472 — malformed body
throw errors.connection(ConnectionCode.MALFORMED_RESPONSE, {
    message: `entity '${entity.$name}'.${handlerName}('${key}') returned malformed body.`,
    context: { entity: entity.$name, handler: handlerName, key },
});
```

- [ ] **Step 3: Convert react.tsx**

```ts
import { errors, CliCode } from '@syncengine/core';

// Line 46 — useStore outside provider
throw errors.cli(CliCode.PROVIDER_MISSING, {
    message: `useStore() must be called inside a <StoreProvider store={...}>.`,
    hint: `Wrap your app:\n\n  <StoreProvider store={store}>\n    <App />\n  </StoreProvider>`,
});
```

- [ ] **Step 4: Narrow useEntity error type**

In `packages/client/src/entity-client.ts`, change the `UseEntityResult` interface:

```ts
// Before:
readonly error: Error | null;
// After:
readonly error: SyncEngineError | null;
```

Import `SyncEngineError` from `@syncengine/core`.

- [ ] **Step 5: Run client typecheck**

Run: `cd packages/client && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/
git commit -m "refactor(client): convert throw sites to errors.* factories"
```

---

### Task 8: Convert packages/cli Throw Sites

**Files:**
- Modify: `packages/cli/src/client.ts` — convert throws; `StackNotRunningError` class stays until Task 10
- Modify: `packages/cli/src/workspace.ts` — update `StackNotRunningError` catch-site
- Modify: `packages/cli/src/dev.ts` (~6 throws)
- Modify: `packages/cli/src/build.ts` (~3 throws)
- Modify: `packages/cli/src/init.ts` (~1 throw)
- Modify: `packages/cli/src/start.ts` (~1 throw)
- Modify: `packages/cli/src/runner.ts` (~3 throws)

**Invariant:** Do NOT delete the `StackNotRunningError` class in this task. The class stays until Task 10. This task only changes the `throw` and `catch` sites so that no code path constructs or checks against the class — but the class definition remains so the file compiles.

- [ ] **Step 1: Convert client.ts throws**

Replace the `throw new StackNotRunningError(...)` site (line 48) with the `errors.cli(...)` factory. Do NOT delete the `StackNotRunningError` class definition (lines 35–44) — Task 10 removes it.

```ts
import { errors, CliCode, ConnectionCode } from '@syncengine/core';

// Line 48 — stack not running (was `throw new StackNotRunningError(...)`)
throw errors.cli(CliCode.STACK_NOT_RUNNING, {
    message: `No syncengine dev stack is running.`,
    hint: `Start one with: pnpm dev\n\n  Restate admin on :${ports.restateAdmin} is unreachable.`,
    context: { port: ports.restateAdmin },
});

// Line 84 — deployment registration
throw errors.connection(ConnectionCode.RESTATE_UNREACHABLE, {
    message: `restate deployment registration failed (HTTP ${res.status}): ${body}`,
    context: { status: res.status },
});

// Line 117 — workspace handler HTTP error
throw errors.connection(ConnectionCode.HTTP_ERROR, {
    message: `workspace.${handler}('${workspaceId}') → HTTP ${res.status}: ${text}`,
    context: { handler, workspace: workspaceId, status: res.status },
});

// Line 191 — NATS jsz error
throw errors.connection(ConnectionCode.NATS_UNREACHABLE, {
    message: `nats /jsz returned HTTP ${res.status}`,
    context: { status: res.status },
});
```

- [ ] **Step 1b: Update the `StackNotRunningError` catch-site in workspace.ts**

`packages/cli/src/workspace.ts:30` imports `StackNotRunningError` from `./client.js` and does `err instanceof StackNotRunningError` at line 66. Switch to checking `SyncEngineError` with `code === CliCode.STACK_NOT_RUNNING`:

```ts
// Replace the import:
import { SyncEngineError, CliCode } from '@syncengine/core';
// (drop the `StackNotRunningError` import from './client.js')

// Replace the catch block:
} catch (err) {
    if (err instanceof SyncEngineError && err.code === CliCode.STACK_NOT_RUNNING) {
        process.stderr.write(`\n\x1b[1;31m${err.message}\x1b[0m\n\n`);
        process.exit(1);
    }
    throw err;
}
```

After this change no code references `StackNotRunningError` except its own class definition in `client.ts`, which Task 10 removes.

- [ ] **Step 2: Convert dev.ts**

```ts
import { errors, CliCode } from '@syncengine/core';

// Line 74 — stack already running
throw errors.cli(CliCode.STACK_ALREADY_RUNNING, {
    message: `--fresh refused: a syncengine dev stack (pid ${existing.orchestrator}) is already running.`,
    hint: `Stop it first, or omit --fresh.`,
    context: { pid: existing.orchestrator },
});

// Line 85 — fresh refused: state dir outside expected
throw errors.cli(CliCode.FRESH_REFUSED, {
    message: `--fresh refused: state dir ${stateDir} is outside the expected locations.`,
    context: { stateDir },
});

// Line 207 — no app directory
throw errors.cli(CliCode.APP_DIR_NOT_FOUND, {
    message: `No app directory found. Run syncengine dev from a directory containing syncengine.config.ts.`,
    hint: `Create a syncengine.config.ts in your project root.`,
});

// Line 536 — @syncengine/server not found
throw errors.cli(CliCode.DEPENDENCY_NOT_FOUND, {
    message: `Cannot find @syncengine/server from ${appDir}.`,
    hint: `Run: pnpm add @syncengine/server`,
    context: { package: '@syncengine/server', appDir },
});

// Line 555 — tsx not found
throw errors.cli(CliCode.DEPENDENCY_NOT_FOUND, {
    message: `Cannot find ${name} binary. Install tsx as a devDependency.`,
    hint: `Run: pnpm add -D tsx`,
    context: { binary: name },
});
```

- [ ] **Step 3: Convert build.ts, init.ts, start.ts**

`packages/cli/src/build.ts`:
```ts
import { errors, CliCode } from '@syncengine/core';

// Line 31
throw errors.cli(CliCode.APP_DIR_NOT_FOUND, {
    message: `Could not find an app directory with vite.config.ts under ${repoRoot}`,
    context: { repoRoot },
});

// Line 58
throw errors.cli(CliCode.BUILD_OUTPUT_MISSING, {
    message: `Plugin did not write ${manifestPath} — is @syncengine/vite-plugin in your vite.config.ts?`,
    hint: `Add the syncengine plugin to your vite.config.ts.`,
    context: { manifestPath },
});

// Line 157
throw errors.cli(CliCode.DEPENDENCY_NOT_FOUND, {
    message: `esbuild not found — run pnpm install`,
    hint: `Run: pnpm install`,
});
```

`packages/cli/src/init.ts`:
```ts
import { errors, CliCode } from '@syncengine/core';

// Line 30
throw errors.cli(CliCode.DIRECTORY_NOT_EMPTY, {
    message: `Directory ${target} is not empty. Pick an empty directory or a new name.`,
    context: { directory: target },
});
```

`packages/cli/src/start.ts`:
```ts
import { errors, CliCode } from '@syncengine/core';

// Line 22
throw errors.cli(CliCode.BUILD_OUTPUT_MISSING, {
    message: `No dist/server/index.mjs found. Run \`syncengine build\` first.`,
    hint: `Run: syncengine build`,
});
```

- [ ] **Step 4: Convert runner.ts**

```ts
import { errors, CliCode } from '@syncengine/core';

// Line 243 — timeout waiting for URL
throw errors.cli(CliCode.TIMEOUT, {
    message: `timed out waiting for ${url}${tag}: ${String(lastErr)}`,
    context: { url },
});

// Line 298 — timeout waiting for TCP
throw errors.cli(CliCode.TIMEOUT, {
    message: `timed out waiting for tcp :${port}${tag} on [${hosts.join(', ')}]`,
    context: { port, hosts },
});

// Line 363 — port conflict
throw errors.cli(CliCode.PORT_CONFLICT, {
    message: `${taken.length} port${taken.length === 1 ? '' : 's'} already in use`,
    hint: `Free the ports or let syncengine pick random ones.`,
    context: { ports: taken },
});
```

- [ ] **Step 5: Run cli typecheck**

Run: `cd packages/cli && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/
git commit -m "refactor(cli): convert throw/catch sites to errors.* factories"
```

---

### Task 9: Convert Remaining Packages

**Files:**
- Modify: `packages/vite-plugin/src/index.ts`
- Modify: `packages/vite-plugin/src/workspaces.ts`
- Modify: `packages/vite-plugin/src/devtools/devtools-plugin.ts`
- Modify: `packages/test-utils/src/test-store.ts`
- Modify: `packages/bin-utils/index.ts`
- Modify: `packages/restate-bin/index.ts`

- [ ] **Step 1: Convert vite-plugin**

`packages/vite-plugin/src/index.ts`:
```ts
import { errors, CliCode } from '@syncengine/core';

// Line 225 — missing env vars in production
throw errors.cli(CliCode.ENV_MISSING, {
    message: `[syncengine] production build requires SYNCENGINE_NATS_URL and SYNCENGINE_RESTATE_URL environment variables.`,
    hint: `Set these in your deployment environment.`,
});
```

`packages/vite-plugin/src/workspaces.ts`:
```ts
import { errors, SchemaCode } from '@syncengine/core';

// Line 155 — no default export
throw errors.schema(SchemaCode.CONFIG_NO_DEFAULT_EXPORT, {
    message: `${path} has no default export`,
    hint: `Add: export default defineConfig({ ... })`,
    context: { path },
});

// Line 161 — failed to load config
throw errors.schema(SchemaCode.CONFIG_LOAD_FAILED, {
    message: `[syncengine] failed to load ${path}`,
    context: { path },
    cause: err instanceof Error ? err : new Error(String(err)),
});
```

`packages/vite-plugin/src/devtools/devtools-plugin.ts`:
```ts
import { errors, ConnectionCode } from '@syncengine/core';

// Line 117 — HTTP error
throw errors.connection(ConnectionCode.HTTP_ERROR, {
    message: `POST ${url} → HTTP ${res.status}: ${text}`,
    context: { url, status: res.status },
});
```

- [ ] **Step 2: Convert test-utils**

`packages/test-utils/src/test-store.ts`:
```ts
import { errors, StoreCode } from '@syncengine/core';

// Line 139 — row not found
throw errors.store(StoreCode.TEST_STORE_ROW_NOT_FOUND, {
    message: `TestStore.delete: no row with id=${id} in table '${tableName}'`,
    context: { table: tableName, id },
});

// Line 176 — unknown table
throw errors.store(StoreCode.TEST_STORE_UNKNOWN_TABLE, {
    message: `TestStore.applyEmits: unknown table '${tableName}'`,
    context: { table: tableName },
});
```

Note: `packages/test-utils/src/__tests__/test-store.test.ts` uses `EntityError` as the public user-domain API (throwing `new EntityError('OUT_OF_STOCK', 'No stock')` inside a handler fixture, then asserting `.toThrow(EntityError)`). That is the correct pattern and **stays unchanged**.

- [ ] **Step 3: Convert bin-utils and restate-bin**

`packages/bin-utils/index.ts`:
```ts
import { errors, CliCode, ConnectionCode } from '@syncengine/core';

// Line 42 — unsupported OS
throw errors.cli(CliCode.UNSUPPORTED_PLATFORM, {
    message: `Unsupported OS: ${rawOs}`,
    context: { os: rawOs },
});

// Line 47 — unsupported arch
throw errors.cli(CliCode.UNSUPPORTED_PLATFORM, {
    message: `Unsupported arch: ${rawArch}`,
    context: { arch: rawArch },
});

// Line 123 — checksum mismatch
throw errors.cli(CliCode.CHECKSUM_MISMATCH, {
    message: `${spec.tool}@${spec.version}: checksum mismatch for ${host.os}-${host.arch}`,
    context: { tool: spec.tool, version: spec.version, os: host.os, arch: host.arch },
});

// Line 134 — binary not found after extraction
throw errors.cli(CliCode.BINARY_NOT_FOUND, {
    message: `${spec.tool}@${spec.version}: expected binary at ${entry} after extraction`,
    context: { tool: spec.tool, entry },
});

// Line 154 — download failed
throw errors.connection(ConnectionCode.HTTP_ERROR, {
    message: `download failed: ${url} (HTTP ${res.status})`,
    context: { url, status: res.status },
});

// Line 188 — unsupported archive
throw errors.cli(CliCode.UNSUPPORTED_ARCHIVE, {
    message: `unsupported archive format: ${archivePath}`,
    context: { path: archivePath },
});
```

`packages/restate-bin/index.ts`:
```ts
import { errors, CliCode } from '@syncengine/core';

// Line 54 — binary not available for platform
throw errors.cli(CliCode.BINARY_NOT_FOUND, {
    message: `restate-server prebuilt binary not available for ${host.os}-${host.arch}`,
    hint: `Build from source or use a supported platform.`,
    context: { os: host.os, arch: host.arch },
});
```

- [ ] **Step 4: Run typecheck across all packages**

Run: `pnpm -r run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/vite-plugin/ packages/test-utils/ packages/bin-utils/ packages/restate-bin/
git commit -m "refactor: convert remaining packages to errors.* factories"
```

---

### Task 10: Delete StackNotRunningError

`EntityError` stays — it is a public user-domain error class (Meteor-style), orthogonal to the platform error system. This task deletes only `StackNotRunningError`, which was pure framework-internal infrastructure with no user-facing surface.

**Preconditions (verify before editing):** no non-definition references to `StackNotRunningError` remain in `packages/*/src/`:

```bash
grep -rn "StackNotRunningError" packages/*/src/ --include="*.ts" --include="*.tsx" | grep -v node_modules
```

Expected: the only match is the class definition itself in `packages/cli/src/client.ts`. If anything else matches, go back to Task 8 Step 1b and finish the catch-site migration.

**Files:**
- Modify: `packages/cli/src/client.ts` — delete the `StackNotRunningError` class (lines 35–44)

- [ ] **Step 1: Delete `StackNotRunningError` class**

Delete the class definition in `packages/cli/src/client.ts` (lines 35–44).

- [ ] **Step 2: Add a doc-comment to `EntityError`**

Add or update the comment banner above the `EntityError` class in `packages/core/src/entity.ts` (lines 32–38) so the distinction from the platform error system is explicit:

```ts
// ── EntityError ──────────────────────────────────────────────────────────────
// Public user-facing error class for DOMAIN errors thrown from entity handlers.
// Modeled on Meteor.Error: `throw new EntityError('OUT_OF_STOCK', 'No stock')`.
// Propagates through applyHandler unchanged so callers can pattern-match on .code.
//
// This is ORTHOGONAL to the platform error system (SyncEngineError, errors.*).
// The platform system is framework→developer ("this is what syncengine broke");
// EntityError is user→user ("this is what my app's domain rejected").
```

- [ ] **Step 3: Run typecheck across all packages**

Run: `pnpm -r run typecheck`
Expected: PASS.

- [ ] **Step 4: Run all tests**

Run: `pnpm -r test` (or the equivalent root command)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/client.ts packages/core/src/entity.ts
git commit -m "refactor(cli): delete StackNotRunningError (migrated to errors.cli); document EntityError as user-domain API"
```

---

### Task 11: Final Verification

**Files:**
- All packages

- [ ] **Step 1: Verify no plain `throw new Error` remains (except test files)**

Run: `grep -r "throw new Error" packages/*/src/ --include="*.ts" --include="*.tsx" | grep -v __tests__ | grep -v node_modules`
Expected: No results (all converted).

- [ ] **Step 2: Verify no `StackNotRunningError` references remain**

Run:
```bash
grep -rn "StackNotRunningError" packages --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v dist
```
Expected: No results.

- [ ] **Step 2b: Verify `EntityError` is still exported and used by user code**

Run:
```bash
grep -rn "EntityError" packages apps --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v dist
```
Expected: matches in `packages/core/src/entity.ts` (class + export), `packages/core/src/index.ts` (barrel re-export), `packages/core/src/__tests__/entity.test.ts` (user-throw propagation tests), `packages/test-utils/src/__tests__/test-store.test.ts` (domain-error fixtures), and `apps/test/` (entity files + tests). Zero matches in framework `src/` outside of the class definition and its export.

- [ ] **Step 3: Run all tests**

Run: `pnpm -r test`
Also: `cd packages/core && npx vitest run` (error system tests)
Expected: All PASS.

- [ ] **Step 4: Run full typecheck**

Run: `pnpm -r run typecheck`
Expected: PASS.

No final commit — if earlier tasks are clean, there's nothing to clean up.
