# Syncengine Error System Design

> Meteor-quality error messages across every layer: schema, entity, store, connection, handler, CLI.
> One structured error shape, multiple renderers, no magic strings.

## Goals

- Every error tells the developer **what happened**, **why**, and **how to fix it**
- Errors are structured data — renderers format them for each surface (terminal, browser overlay, React hooks)
- Error codes are typed const objects — autocomplete, exhaustive switches, no magic strings
- User handler errors are wrapped with framework context but not "explained" by the framework
- Stack traces are cleaned to highlight user code and hide framework internals

## Non-Goals

- i18n machinery (messages live in a lookup-ready structure but no translation system)
- Documentation links per error code (error messages should be self-contained)
- Error telemetry / reporting (future concern)

---

## 1. Error Shape

### SyncEngineError

Base class for all framework-originated errors. Extends `Error`.

```ts
type ErrorCategory = 'schema' | 'entity' | 'store' | 'connection' | 'handler' | 'cli';
type ErrorSeverity = 'fatal' | 'warning' | 'info';

class SyncEngineError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly severity: ErrorSeverity;
  readonly hint?: string;
  readonly context: Record<string, unknown>;
  override readonly cause?: Error;
}
```

Fields:

- **`code`** — typed per category via const objects (see §3). e.g. `SchemaCode.MISSING_PRIMARY_KEY`
- **`category`** — which layer originated the error
- **`severity`** — `fatal` (stops execution), `warning` (recoverable), `info` (diagnostic)
- **`message`** — what happened, concise and specific (inherited from `Error`)
- **`hint`** — how to fix it, may include code snippets with `\n` formatting
- **`context`** — structured data for programmatic consumers (table name, entity name, field, etc.)
- **`cause`** — original error when wrapping

### UserHandlerError

Subclass for wrapping errors thrown by developer code inside entity handlers.

```ts
class UserHandlerError extends SyncEngineError {
  readonly category = 'handler';
  readonly code = HandlerCode.USER_HANDLER_ERROR;
}
```

The framework adds context (entity name, handler name) but does not provide a `hint` — syncengine doesn't explain user domain logic. The developer's original error is always available as `cause`.

### Examples

Framework error:
```ts
SyncEngineError {
  code: 'INVALID_TRANSITION',
  category: 'entity',
  severity: 'fatal',
  message: "Cannot transition 'status' from 'draft' to 'shipped'.",
  hint: "Valid transitions from 'draft': placed, cancelled.\n\nCheck your transition map in the entity definition.",
  context: { entity: 'order', field: 'status', from: 'draft', to: 'shipped' },
}
```

Wrapped user error:
```ts
UserHandlerError {
  code: 'USER_HANDLER_ERROR',
  category: 'handler',
  severity: 'fatal',
  message: "Entity 'order' handler 'place' failed: insufficient inventory",
  context: { entity: 'order', handler: 'place' },
  cause: Error("insufficient inventory"),
}
```

---

## 2. Error Code Registry

Codes are const objects per category. The factory API (§3) enforces that `errors.schema()` only accepts `SchemaCode` values, etc.

```ts
export const SchemaCode = {
  MISSING_PRIMARY_KEY: 'MISSING_PRIMARY_KEY',
  RESERVED_COLUMN_PREFIX: 'RESERVED_COLUMN_PREFIX',
  INVALID_TABLE_NAME: 'INVALID_TABLE_NAME',
  DUPLICATE_TABLE_NAME: 'DUPLICATE_TABLE_NAME',
  DUPLICATE_VIEW_ID: 'DUPLICATE_VIEW_ID',
  DUPLICATE_CHANNEL_NAME: 'DUPLICATE_CHANNEL_NAME',
  VIEW_TABLE_NOT_FOUND: 'VIEW_TABLE_NOT_FOUND',
  CHANNEL_TABLE_NOT_FOUND: 'CHANNEL_TABLE_NOT_FOUND',
} as const;

export const EntityCode = {
  INVALID_ENTITY_NAME: 'INVALID_ENTITY_NAME',
  HANDLER_NAME_RESERVED: 'HANDLER_NAME_RESERVED',
  HANDLER_NAME_INVALID: 'HANDLER_NAME_INVALID',
  STATE_FIELD_COLLISION: 'STATE_FIELD_COLLISION',
  TRANSITION_NOT_EXHAUSTIVE: 'TRANSITION_NOT_EXHAUSTIVE',
  TRANSITION_AMBIGUOUS: 'TRANSITION_AMBIGUOUS',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
  TYPE_MISMATCH: 'TYPE_MISMATCH',
  ENUM_VIOLATION: 'ENUM_VIOLATION',
} as const;

export const StoreCode = {
  DUPLICATE_TABLE_NAME: 'DUPLICATE_TABLE_NAME',
  INVALID_SEED_KEY: 'INVALID_SEED_KEY',
  INVALID_WORKSPACE_FORMAT: 'INVALID_WORKSPACE_FORMAT',
} as const;

export const ConnectionCode = {
  NATS_UNREACHABLE: 'NATS_UNREACHABLE',
  RESTATE_UNREACHABLE: 'RESTATE_UNREACHABLE',
  AUTH_FAILED: 'AUTH_FAILED',
  WORKER_CRASHED: 'WORKER_CRASHED',
} as const;

export const HandlerCode = {
  USER_HANDLER_ERROR: 'USER_HANDLER_ERROR',
} as const;

export const CliCode = {
  STACK_NOT_RUNNING: 'STACK_NOT_RUNNING',
  PORT_CONFLICT: 'PORT_CONFLICT',
  ENTITY_LOAD_FAILED: 'ENTITY_LOAD_FAILED',
} as const;
```

New codes are added to the relevant const object. TypeScript enforces usage everywhere.

Note: `SchemaCode.DUPLICATE_TABLE_NAME` and `StoreCode.DUPLICATE_TABLE_NAME` share the same string value but are distinct types — schema catches it at `table()` definition time, store catches it at `validateStoreConfig()` initialization time. Different layers, different contexts.

This taxonomy is the initial set derived from existing throw sites. It will grow as the framework grows — the categories are stable, the codes within them are not.

---

## 3. Factory API

Namespaced factory functions that enforce code-to-category mapping:

```ts
// packages/core/src/errors/factory.ts

export const errors = {
  schema(code: SchemaCodeValue, opts: ErrorOpts): SyncEngineError;
  entity(code: EntityCodeValue, opts: ErrorOpts): SyncEngineError;
  store(code: StoreCodeValue, opts: ErrorOpts): SyncEngineError;
  connection(code: ConnectionCodeValue, opts: ErrorOpts): SyncEngineError;
  handler(code: HandlerCodeValue, opts: ErrorOpts & { cause: Error }): UserHandlerError;
  cli(code: CliCodeValue, opts: ErrorOpts): SyncEngineError;
};

interface ErrorOpts {
  message: string;
  hint?: string;
  context?: Record<string, unknown>;
  cause?: Error;
  severity?: ErrorSeverity; // defaults vary by category
}
```

Usage at throw sites:

```ts
import { errors, SchemaCode } from '@syncengine/core';

throw errors.schema(SchemaCode.MISSING_PRIMARY_KEY, {
  message: `Table '${name}' has no primary key column.`,
  hint: `Add id() to your table definition:\n\n  const ${name} = table('${name}', { id: id(), ... })`,
  context: { table: name },
});
```

Severity defaults by category:
- `schema`, `entity`, `store` → `fatal`
- `connection` → `warning`
- `handler` → `fatal`
- `cli` → `fatal`

Override per-call with `{ severity: 'warning' }` when needed.

---

## 4. Renderers

### Console Renderer (`@syncengine/core`)

Default renderer for terminal output. Used by CLI, server logs, and dev mode.

Output format:
```
 ✘ SE::schema MISSING_PRIMARY_KEY

   Table 'cart' has no primary key column.

   hint: Add id() to your table definition:

     const cart = table('cart', { id: id(), ... })

   → src/schema.ts:14:9
     src/schema.ts:8:3
   ┄ (6 syncengine internals hidden)
```

Formatting rules:
- Header: severity icon (`✘` fatal, `⚠` warning, `ℹ` info) + `SE::category` + code
- Color-coded by severity: red = fatal, yellow = warning, dim = info
- `hint` block is indented and visually distinct from the message
- Stack trace cleaning (see §5)
- `context` fields are not rendered — they're for programmatic consumers

API:
```ts
import { formatError } from '@syncengine/core';

const formatted: string = formatError(error); // ANSI-colored string
```

### Browser Overlay Renderer (`@syncengine/vite-plugin`)

Hooks into Vite's HMR error overlay during development. Shows the same content as console renderer but in a styled HTML panel. Definition-time errors (schema, store config) appear immediately on file save.

### Hook Signal Renderer (`@syncengine/client`)

Not a visual renderer. `useEntity()` already returns an `error: Error | null` field — this spec narrows its type to `SyncEngineError | null` so developers get structured data:

```ts
const { error } = useEntity(order, orderId);

if (error) {
  // error is SyncEngineError — switch on code, category, severity
  if (error.code === EntityCode.INVALID_TRANSITION) {
    // handle specifically
  }
}
```

`useStore()` already exposes `connectionError`, `workerHealth`, and `staleViews` signals (from the error-boundaries spec, already implemented). Those remain as-is — they're the right abstraction for store-level async errors. The error system doesn't replace them; it provides the structured error infrastructure they can adopt over time.

The framework does not render errors in the application UI — that's the developer's domain. The hook surface provides structured data for developers to build their own error handling.

**Principle: console and overlay are for development. Hook signals are for production.**

---

## 5. Stack Trace Cleaning

The console renderer filters stack traces to highlight user code:

Rules:
1. Frames inside `node_modules/@syncengine/*` are collapsed into `┄ (N syncengine internals hidden)`
2. Frames inside other `node_modules/*` are also collapsed into `┄ (N internals hidden)`
3. User code frames (anything outside `node_modules`) are shown in full with file path + line number
4. The first user code frame is visually emphasized with `→` prefix — it's usually the call site that matters
5. The full unfiltered stack remains on the `Error.stack` property for debugging

Example output:
```
   → src/entities/order.actor.ts:28
     src/entities/order.actor.ts:14
   ┄ (6 syncengine internals hidden)
```

---

## 6. Adoption Plan

No migration — rip and replace. No external users to preserve compatibility for.

1. Add `SyncEngineError`, `UserHandlerError`, code const objects, factory, and console renderer to `packages/core/src/errors/`
2. Delete `EntityError` class and `StackNotRunningError` class
3. Convert all ~80 throw sites across `core`, `server`, `client`, `cli`, `vite-plugin` to use `errors.*()` factories
4. Write `hint` strings for each error — most existing `message` strings are already good, hints are new
5. Wire console renderer as the default formatter in dev mode
6. Hook Vite overlay renderer into `vite-plugin` HMR error handling
7. Narrow `useEntity().error` from `Error | null` to `SyncEngineError | null` (field already exists). `useStore()` already exposes `connectionError` and `workerHealth` signals via the error-boundaries spec — no changes needed there

---

## 7. Package Placement

```
packages/core/src/errors/
├── codes.ts          # SchemaCode, EntityCode, StoreCode, ConnectionCode, HandlerCode, CliCode
├── error.ts          # SyncEngineError, UserHandlerError classes
├── factory.ts        # errors.schema(), errors.entity(), etc.
├── format.ts         # formatError() — console renderer with ANSI colors + stack cleaning
└── index.ts          # re-exports everything

packages/vite-plugin/src/
└── overlay.ts        # Browser overlay renderer (hooks into Vite HMR)

packages/client/src/
└── (existing hooks)  # useEntity().error, useStore().error typed as SyncEngineError | undefined
```

`@syncengine/core` exports everything from `errors/index.ts`. Other packages import from `@syncengine/core`.

---

## 8. Public API Surface

Exported from `@syncengine/core`:

```ts
// Classes
export { SyncEngineError, UserHandlerError } from './errors';

// Code registries
export { SchemaCode, EntityCode, StoreCode, ConnectionCode, HandlerCode, CliCode } from './errors';

// Factory
export { errors } from './errors';

// Console renderer
export { formatError } from './errors';

// Types
export type { ErrorCategory, ErrorSeverity, ErrorOpts } from './errors';
```

Developers can:
- Catch `SyncEngineError` with `instanceof`
- Switch on `error.code` using const object refs (no magic strings)
- Format any `SyncEngineError` for their own logging with `formatError()`
- Access the full structured error on hook return values
