# Hexagonal Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `service()`, redesigned `emit()`, and opinionated hex directory conventions to syncengine so user apps get type-enforced separation between domain logic and external integrations.

**Architecture:** Three new core primitives (`service`, `override`, redesigned `emit`) in `@syncengine/core`, a service container + injection in `@syncengine/server`, Vite plugin auto-discovery of `services/*.ts`, and CLI scaffolding updates. Entity handlers stay pure; workflows/webhooks/heartbeats receive services via `ctx.services`.

**Tech Stack:** TypeScript, Vitest, Restate SDK, Vite plugin API, existing syncengine DSL patterns.

**Spec:** `docs/superpowers/specs/2026-04-19-hexagonal-framework-design.md`

---

### Task 1: `service()` primitive and `ServicePort<T>` type

**Files:**
- Create: `packages/core/src/service.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/service.test.ts`

- [ ] **Step 1: Write the failing test for `service()` construction**

```ts
// packages/core/src/__tests__/service.test.ts
import { describe, it, expect } from 'vitest';
import { service, isService, type ServiceDef, type ServicePort } from '../service';

describe('service()', () => {
    it('creates a ServiceDef with $tag and $name', () => {
        const payments = service('payments', {
            async charge(amount: number, currency: string) {
                return { id: 'ch_1', status: 'succeeded' };
            },
        });

        expect(payments.$tag).toBe('service');
        expect(payments.$name).toBe('payments');
        expect(typeof payments.$methods.charge).toBe('function');
    });

    it('isService returns true for service defs', () => {
        const s = service('test', {
            async ping() { return 'pong'; },
        });
        expect(isService(s)).toBe(true);
        expect(isService({ $tag: 'entity' })).toBe(false);
        expect(isService(null)).toBe(false);
    });

    it('rejects empty name', () => {
        expect(() => service('', { async ping() { return 'pong'; } }))
            .toThrow(/name must be a non-empty string/);
    });

    it('rejects invalid name characters', () => {
        expect(() => service('my-service', { async ping() { return 'pong'; } }))
            .toThrow(/must match/);
    });

    it('rejects names starting with $ or _', () => {
        expect(() => service('$internal', { async ping() { return 'pong'; } }))
            .toThrow(/reserved/);
        expect(() => service('_private', { async ping() { return 'pong'; } }))
            .toThrow(/reserved/);
    });

    it('rejects non-function methods', () => {
        expect(() => service('bad', { notAFunction: 42 } as any))
            .toThrow(/must be a function/);
    });
});

describe('ServicePort type extraction', () => {
    it('infers port type from service def (compile-time check)', () => {
        const payments = service('payments', {
            async charge(amount: number, currency: string) {
                return { id: 'ch_1', status: 'succeeded' };
            },
            async refund(chargeId: string) {
                return { id: 're_1', status: 'succeeded' };
            },
        });

        // Type-level test: this assignment should compile.
        // If ServicePort doesn't extract the interface correctly, TS errors here.
        const port: ServicePort<typeof payments> = {
            charge: async (amount: number, currency: string) => ({ id: 'x', status: 'y' }),
            refund: async (chargeId: string) => ({ id: 'x', status: 'y' }),
        };
        expect(port).toBeDefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/__tests__/service.test.ts`
Expected: FAIL — module `../service` not found.

- [ ] **Step 3: Implement `service()`, `isService`, `ServiceDef`, `ServicePort`**

```ts
// packages/core/src/service.ts
import { errors, SchemaCode } from './errors';

// ── Service definition ─────────────────────────────────────────────────────

export interface ServiceDef<
    TName extends string = string,
    TMethods extends Record<string, (...args: any[]) => Promise<any>> = Record<string, (...args: any[]) => Promise<any>>,
> {
    readonly $tag: 'service';
    readonly $name: TName;
    readonly $methods: TMethods;
}

/** Extract the port type (method signatures only) from a ServiceDef. */
export type ServicePort<S> =
    S extends ServiceDef<string, infer TMethods>
        ? { [K in keyof TMethods]: TMethods[K] }
        : never;

/** Type-level helper: extract the name from a ServiceDef. */
export type ServiceName<S> = S extends ServiceDef<infer N, any> ? N : never;

/** Wildcard type for function signatures accepting any service. */
export type AnyService = ServiceDef<string, Record<string, (...args: any[]) => Promise<any>>>;

// ── Factory ────────────────────────────────────────────────────────────────

export function service<
    const TName extends string,
    TMethods extends Record<string, (...args: any[]) => Promise<any>>,
>(
    name: TName,
    methods: TMethods,
): ServiceDef<TName, TMethods> {
    if (!name || typeof name !== 'string') {
        throw errors.schema(SchemaCode.INVALID_SERVICE_NAME, {
            message: `service: name must be a non-empty string.`,
            hint: `Pass a valid name: service('payments', { ... })`,
        });
    }
    if (name.startsWith('$') || name.startsWith('_')) {
        throw errors.schema(SchemaCode.INVALID_SERVICE_NAME, {
            message: `service('${name}'): names starting with '$' or '_' are reserved.`,
            hint: `Remove the prefix from the service name.`,
            context: { service: name },
        });
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
        throw errors.schema(SchemaCode.INVALID_SERVICE_NAME, {
            message: `service('${name}'): name must match /^[a-zA-Z][a-zA-Z0-9_]*$/.`,
            hint: `Use only letters, numbers, and underscores. Must start with a letter.`,
            context: { service: name },
        });
    }
    for (const [key, fn] of Object.entries(methods)) {
        if (typeof fn !== 'function') {
            throw errors.schema(SchemaCode.INVALID_SERVICE_CONFIG, {
                message: `service('${name}'): method '${key}' must be a function.`,
                hint: `All service methods must be async functions.`,
                context: { service: name, method: key },
            });
        }
    }

    return {
        $tag: 'service',
        $name: name,
        $methods: methods,
    };
}

// ── Type guard ─────────────────────────────────────────────────────────────

export function isService(value: unknown): value is AnyService {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as { $tag?: string }).$tag === 'service'
    );
}
```

- [ ] **Step 4: Add error codes for services**

Add to `packages/core/src/errors.ts` in the `SchemaCode` object:

```ts
INVALID_SERVICE_NAME: 'SE4100',
INVALID_SERVICE_CONFIG: 'SE4101',
DUPLICATE_SERVICE_NAME: 'SE4102',
```

- [ ] **Step 5: Export from core barrel**

Add to `packages/core/src/index.ts`:

```ts
// ── Service DSL (hex architecture — driven ports) ────────────────────────
export { service, isService } from './service';
export type { ServiceDef, ServicePort, ServiceName, AnyService } from './service';
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/src/__tests__/service.test.ts`
Expected: All PASS.

- [ ] **Step 7: Run existing tests to verify no regressions**

Run: `pnpm vitest run packages/core/`
Expected: All existing tests still pass.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/service.ts packages/core/src/__tests__/service.test.ts packages/core/src/index.ts packages/core/src/errors.ts
git commit -m "feat(core): add service() primitive and ServicePort<T> type

Introduces the service DSL for declaring typed driven ports (external
integrations). ServicePort<T> auto-extracts the interface from the
implementation so workflows see port types, not vendor SDK internals."
```

---

### Task 2: `override()` for test/staging service swaps

**Files:**
- Modify: `packages/core/src/service.ts`
- Test: `packages/core/src/__tests__/service.test.ts`

- [ ] **Step 1: Write the failing test for `override()`**

Append to `packages/core/src/__tests__/service.test.ts`:

```ts
import { override, type ServiceOverride } from '../service';

describe('override()', () => {
    const payments = service('payments', {
        async charge(amount: number, currency: string) {
            return { id: 'ch_real', status: 'succeeded' };
        },
        async refund(chargeId: string) {
            return { id: 're_real', status: 'succeeded' };
        },
    });

    it('creates a total override (all methods required)', () => {
        const testPayments = override(payments, {
            async charge(amount, currency) {
                return { id: 'ch_test', status: 'succeeded' };
            },
            async refund(chargeId) {
                return { id: 're_test', status: 'succeeded' };
            },
        });

        expect(testPayments.$tag).toBe('service-override');
        expect(testPayments.$targetName).toBe('payments');
        expect(typeof testPayments.$methods.charge).toBe('function');
        expect(typeof testPayments.$methods.refund).toBe('function');
    });

    it('creates a partial override when opt-in', () => {
        const partialOverride = override(payments, {
            async charge(amount, currency) {
                return { id: 'ch_test', status: 'succeeded' };
            },
        }, { partial: true });

        expect(partialOverride.$partial).toBe(true);
        expect(typeof partialOverride.$methods.charge).toBe('function');
        // refund is NOT in $methods — framework merges with original at runtime
        expect(partialOverride.$methods.refund).toBeUndefined();
    });

    it('rejects non-function override methods', () => {
        expect(() => override(payments, { charge: 42 } as any))
            .toThrow(/must be a function/);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/__tests__/service.test.ts`
Expected: FAIL — `override` not exported.

- [ ] **Step 3: Implement `override()` and `ServiceOverride`**

Append to `packages/core/src/service.ts`:

```ts
// ── Service override (test/staging adapter swaps) ──────────────────────────

export interface ServiceOverride<
    TName extends string = string,
    TMethods extends Record<string, (...args: any[]) => Promise<any>> = Record<string, (...args: any[]) => Promise<any>>,
> {
    readonly $tag: 'service-override';
    readonly $targetName: TName;
    readonly $methods: Partial<TMethods>;
    readonly $partial: boolean;
}

export type AnyServiceOverride = ServiceOverride<string, Record<string, (...args: any[]) => Promise<any>>>;

/**
 * Declare an override for a service. Total by default (must implement
 * every method). Pass `{ partial: true }` to override only specific
 * methods; the rest use the original implementation at runtime.
 */
export function override<
    TName extends string,
    TMethods extends Record<string, (...args: any[]) => Promise<any>>,
>(
    target: ServiceDef<TName, TMethods>,
    methods: TMethods,
): ServiceOverride<TName, TMethods>;
export function override<
    TName extends string,
    TMethods extends Record<string, (...args: any[]) => Promise<any>>,
>(
    target: ServiceDef<TName, TMethods>,
    methods: Partial<TMethods>,
    opts: { partial: true },
): ServiceOverride<TName, TMethods>;
export function override<
    TName extends string,
    TMethods extends Record<string, (...args: any[]) => Promise<any>>,
>(
    target: ServiceDef<TName, TMethods>,
    methods: Partial<TMethods>,
    opts?: { partial?: boolean },
): ServiceOverride<TName, TMethods> {
    for (const [key, fn] of Object.entries(methods)) {
        if (typeof fn !== 'function') {
            throw errors.schema(SchemaCode.INVALID_SERVICE_CONFIG, {
                message: `override('${target.$name}'): method '${key}' must be a function.`,
                hint: `All override methods must be async functions.`,
                context: { service: target.$name, method: key },
            });
        }
    }

    return {
        $tag: 'service-override',
        $targetName: target.$name,
        $methods: methods,
        $partial: opts?.partial ?? false,
    };
}

export function isServiceOverride(value: unknown): value is AnyServiceOverride {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as { $tag?: string }).$tag === 'service-override'
    );
}
```

- [ ] **Step 4: Export override from core barrel**

Add to the service section in `packages/core/src/index.ts`:

```ts
export { service, isService, override, isServiceOverride } from './service';
export type { ServiceDef, ServicePort, ServiceName, AnyService, ServiceOverride, AnyServiceOverride } from './service';
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/core/src/__tests__/service.test.ts`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/service.ts packages/core/src/__tests__/service.test.ts packages/core/src/index.ts
git commit -m "feat(core): add override() for test/staging service swaps

Total override requires all methods (TypeScript enforces). Partial
override opt-in for stubbing individual methods while keeping the
rest of the real implementation."
```

---

### Task 3: Redesign `emit()` with `{ state, effects }` API

**Files:**
- Modify: `packages/core/src/entity.ts`
- Test: `packages/core/src/__tests__/entity.test.ts`

This task adds the new `emit({ state, effects })` form alongside `insert()` and `trigger()` helpers. The old variadic `emit(state, ...inserts)` stays as a deprecated overload for backwards compat.

- [ ] **Step 1: Write the failing test for new `emit()` and helpers**

Append to `packages/core/src/__tests__/entity.test.ts`:

```ts
import { emit, insert, trigger, extractEmits, extractTriggers, TRIGGER_KEY } from '../entity';
import { table, id, text, integer } from '../schema';

describe('emit() redesign — { state, effects } form', () => {
    const notes = table('notes', {
        id: id(),
        body: text(),
        author: text(),
    });

    it('accepts { state, effects } with insert()', () => {
        const result = emit({
            state: { count: 1 },
            effects: [
                insert(notes, { body: 'hello', author: 'alice' }),
            ],
        });

        expect(result.count).toBe(1);
        const emits = extractEmits(result);
        expect(emits).toHaveLength(1);
        expect(emits![0].table).toBe('notes');
        expect(emits![0].record).toEqual({ body: 'hello', author: 'alice' });
    });

    it('accepts { state, effects } with trigger()', () => {
        const fakeWorkflow = { $tag: 'workflow' as const, $name: 'processPayment', $handler: async () => {} };

        const result = emit({
            state: { status: 'pending' },
            effects: [
                trigger(fakeWorkflow, { total: 100 }),
            ],
        });

        expect(result.status).toBe('pending');
        const triggers = extractTriggers(result);
        expect(triggers).toHaveLength(1);
        expect(triggers![0].workflow).toBe('processPayment');
        expect(triggers![0].input).toEqual({ total: 100 });
    });

    it('accepts mixed insert and trigger effects', () => {
        const fakeWorkflow = { $tag: 'workflow' as const, $name: 'notify', $handler: async () => {} };

        const result = emit({
            state: { count: 2 },
            effects: [
                insert(notes, { body: 'test' }),
                trigger(fakeWorkflow, { msg: 'hi' }),
            ],
        });

        expect(extractEmits(result)).toHaveLength(1);
        expect(extractTriggers(result)).toHaveLength(1);
    });

    it('returns state when effects is empty', () => {
        const result = emit({
            state: { count: 5 },
            effects: [],
        });

        expect(result.count).toBe(5);
        expect(extractEmits(result)).toBeUndefined();
        expect(extractTriggers(result)).toBeUndefined();
    });

    it('legacy emit(state, ...inserts) still works', () => {
        const result = emit(
            { count: 1 },
            { table: notes, record: { body: 'legacy' } },
        );

        expect(result.count).toBe(1);
        expect(extractEmits(result)).toHaveLength(1);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/__tests__/entity.test.ts`
Expected: FAIL — `insert`, `trigger`, `extractTriggers`, `TRIGGER_KEY` not found.

- [ ] **Step 3: Implement `insert()`, `trigger()`, new `emit()` overload, `extractTriggers()`**

Add to `packages/core/src/entity.ts`:

```ts
// New symbol for workflow triggers
export const TRIGGER_KEY: unique symbol = Symbol.for("syncengine.trigger");

/** A workflow trigger effect from an entity handler. */
export interface EmitTrigger {
    readonly workflow: string;
    readonly input: unknown;
}

/** Typed insert helper for the new emit() API. */
export function insert<T extends AnyTable>(
    table: T,
    record: EmitRecord<T['$columns']>,
): { readonly $effect: 'insert'; readonly table: T; readonly record: EmitRecord<T['$columns']> } {
    return { $effect: 'insert', table, record };
}

/** Typed trigger helper for the new emit() API. */
export function trigger<TInput>(
    workflow: { readonly $tag: 'workflow'; readonly $name: string },
    input: TInput,
): { readonly $effect: 'trigger'; readonly workflow: { readonly $tag: 'workflow'; readonly $name: string }; readonly input: TInput } {
    return { $effect: 'trigger', workflow, input };
}

type Effect = ReturnType<typeof insert<any>> | ReturnType<typeof trigger<any>>;

interface EmitConfig<S extends Record<string, unknown>> {
    readonly state: S;
    readonly effects: readonly Effect[];
}
```

Then modify the `emit()` function to add a new overload:

```ts
// New overload: emit({ state, effects })
export function emit<S extends Record<string, unknown>>(config: EmitConfig<S>): S;
// Legacy overloads stay as-is...
```

In the implementation body, detect the new form by checking for `state` and `effects` keys on the first argument:

```ts
export function emit<S extends Record<string, unknown>>(
    stateOrConfig: S | EmitConfig<S>,
    ...inserts: (TypedEmitInsert<AnyTable> | LegacyEmitInsert)[]
): S {
    // New form: emit({ state, effects })
    if ('state' in stateOrConfig && 'effects' in stateOrConfig) {
        const config = stateOrConfig as EmitConfig<S>;
        const wrapped = { ...config.state };

        const insertEffects: EmitInsert[] = [];
        const triggerEffects: EmitTrigger[] = [];

        for (const effect of config.effects) {
            if (effect.$effect === 'insert') {
                insertEffects.push(normalizeInsert(effect as TypedEmitInsert<AnyTable>));
            } else if (effect.$effect === 'trigger') {
                triggerEffects.push({
                    workflow: effect.workflow.$name,
                    input: effect.input,
                });
            }
        }

        if (insertEffects.length > 0) {
            Object.defineProperty(wrapped, EMIT_KEY, {
                value: insertEffects,
                enumerable: false,
                configurable: true,
            });
        }
        if (triggerEffects.length > 0) {
            Object.defineProperty(wrapped, TRIGGER_KEY, {
                value: triggerEffects,
                enumerable: false,
                configurable: true,
            });
        }

        return wrapped as S;
    }

    // Legacy form: emit(state, ...inserts)
    const wrapped = { ...stateOrConfig };
    const normalized = inserts.map(normalizeInsert);
    Object.defineProperty(wrapped, EMIT_KEY, {
        value: normalized,
        enumerable: false,
        configurable: true,
    });
    return wrapped as S;
}
```

Add the extractor:

```ts
/** Extract triggered workflows from a handler return value, if any. */
export function extractTriggers(
    state: Record<string, unknown>,
): EmitTrigger[] | undefined {
    return (state as Record<symbol, unknown>)[TRIGGER_KEY] as
        | EmitTrigger[]
        | undefined;
}
```

- [ ] **Step 4: Export new symbols from core barrel**

Add to the entity section of `packages/core/src/index.ts`:

```ts
export { insert, trigger, extractTriggers, TRIGGER_KEY } from './entity';
export type { EmitTrigger } from './entity';
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/core/src/__tests__/entity.test.ts`
Expected: All PASS (both old and new tests).

- [ ] **Step 6: Run full core test suite**

Run: `pnpm vitest run packages/core/`
Expected: All pass — legacy `emit()` callers unaffected.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/entity.ts packages/core/src/__tests__/entity.test.ts packages/core/src/index.ts
git commit -m "feat(core): redesign emit() with { state, effects } API

New emit({ state, effects }) form with insert() and trigger() helpers.
Effects are an unordered bag — no sequential implication. Legacy
emit(state, ...inserts) still works for backwards compat. Workflow
triggers carried on a Symbol key (TRIGGER_KEY) extracted by the
entity runtime."
```

---

### Task 4: Extend `SyncengineConfig` with `services.overrides`

**Files:**
- Modify: `packages/core/src/config.ts`
- Test: `packages/core/src/__tests__/service.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/__tests__/service.test.ts`:

```ts
import { defineConfig } from '../config';

describe('SyncengineConfig.services', () => {
    it('accepts services.overrides as a lazy import', () => {
        const config = defineConfig({
            workspaces: { resolve: () => 'default' },
            services: {
                overrides: () => import('./fixtures/test-overrides'),
            },
        });

        expect(config.services).toBeDefined();
        expect(typeof config.services!.overrides).toBe('function');
    });

    it('works without services (backwards compat)', () => {
        const config = defineConfig({
            workspaces: { resolve: () => 'default' },
        });

        expect(config.services).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/__tests__/service.test.ts`
Expected: FAIL — `services` not a valid key on `SyncengineConfig`.

- [ ] **Step 3: Add `services` to `SyncengineConfig`**

In `packages/core/src/config.ts`, add the interface:

```ts
export interface ServicesConfig {
    /**
     * Lazy import that returns a module of ServiceOverride exports.
     * Used to swap service adapters for test/staging environments.
     * The framework matches overrides to services by name.
     */
    readonly overrides?: () => Promise<Record<string, unknown>>;
}

export interface SyncengineConfig {
    readonly workspaces: WorkspacesConfig;
    readonly auth?: AuthConfig;
    readonly services?: ServicesConfig;
}
```

- [ ] **Step 4: Export `ServicesConfig` from core barrel**

Add to `packages/core/src/index.ts`:

```ts
export type { ServicesConfig } from './config';
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/core/`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/config.ts packages/core/src/__tests__/service.test.ts packages/core/src/index.ts
git commit -m "feat(core): extend SyncengineConfig with services.overrides

Config now accepts an optional services.overrides lazy import for
swapping service adapters per environment (test, staging, etc.)."
```

---

### Task 5: Service container in `@syncengine/server`

**Files:**
- Create: `packages/server/src/service-container.ts`
- Test: `packages/server/src/__tests__/service-container.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/__tests__/service-container.test.ts
import { describe, it, expect } from 'vitest';
import { service, override } from '@syncengine/core';
import { ServiceContainer } from '../service-container';

describe('ServiceContainer', () => {
    const payments = service('payments', {
        async charge(amount: number) { return { id: 'ch_real', amount }; },
        async refund(id: string) { return { id, status: 'refunded' }; },
    });

    const notifications = service('notifications', {
        async send(to: string, msg: string) { return { sent: true }; },
    });

    it('registers services and resolves them by def', () => {
        const container = new ServiceContainer([payments, notifications]);
        const resolved = container.resolve(payments);

        expect(typeof resolved.charge).toBe('function');
        expect(typeof resolved.refund).toBe('function');
    });

    it('calls through to the real implementation', async () => {
        const container = new ServiceContainer([payments]);
        const resolved = container.resolve(payments);
        const result = await resolved.charge(100);
        expect(result).toEqual({ id: 'ch_real', amount: 100 });
    });

    it('applies total override', async () => {
        const testPayments = override(payments, {
            async charge(amount: number) { return { id: 'ch_test', amount }; },
            async refund(id: string) { return { id, status: 'test_refunded' }; },
        });

        const container = new ServiceContainer([payments], [testPayments]);
        const resolved = container.resolve(payments);
        const result = await resolved.charge(100);
        expect(result).toEqual({ id: 'ch_test', amount: 100 });
    });

    it('applies partial override (unoverridden methods use real impl)', async () => {
        const partialOverride = override(payments, {
            async charge(amount: number) { return { id: 'ch_partial', amount }; },
        }, { partial: true });

        const container = new ServiceContainer([payments], [partialOverride]);
        const resolved = container.resolve(payments);

        const chargeResult = await resolved.charge(50);
        expect(chargeResult).toEqual({ id: 'ch_partial', amount: 50 });

        const refundResult = await resolved.refund('ch_1');
        expect(refundResult).toEqual({ id: 'ch_1', status: 'refunded' });
    });

    it('throws on resolving unregistered service', () => {
        const container = new ServiceContainer([]);
        expect(() => container.resolve(payments)).toThrow(/not registered/);
    });

    it('resolves multiple services for a dependency list', () => {
        const container = new ServiceContainer([payments, notifications]);
        const resolved = container.resolveAll([payments, notifications]);

        expect(resolved.payments).toBeDefined();
        expect(resolved.notifications).toBeDefined();
        expect(typeof resolved.payments.charge).toBe('function');
        expect(typeof resolved.notifications.send).toBe('function');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/server/src/__tests__/service-container.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ServiceContainer`**

```ts
// packages/server/src/service-container.ts
import type { AnyService, AnyServiceOverride, ServiceDef, ServicePort } from '@syncengine/core';

export class ServiceContainer {
    private readonly services = new Map<string, AnyService>();
    private readonly overrides = new Map<string, AnyServiceOverride>();

    constructor(
        services: readonly AnyService[],
        overrides: readonly AnyServiceOverride[] = [],
    ) {
        for (const svc of services) {
            this.services.set(svc.$name, svc);
        }
        for (const ovr of overrides) {
            this.overrides.set(ovr.$targetName, ovr);
        }
    }

    /** Resolve a service to its port-typed implementation (or override). */
    resolve<TName extends string, TMethods extends Record<string, (...args: any[]) => Promise<any>>>(
        def: ServiceDef<TName, TMethods>,
    ): ServicePort<ServiceDef<TName, TMethods>> {
        const svc = this.services.get(def.$name);
        if (!svc) {
            throw new Error(
                `Service '${def.$name}' not registered. Available: ${[...this.services.keys()].join(', ') || '(none)'}`,
            );
        }

        const ovr = this.overrides.get(def.$name);
        if (!ovr) {
            return { ...svc.$methods } as ServicePort<ServiceDef<TName, TMethods>>;
        }

        if (ovr.$partial) {
            // Merge: override methods take precedence, rest from original
            return { ...svc.$methods, ...ovr.$methods } as ServicePort<ServiceDef<TName, TMethods>>;
        }

        // Total override
        return { ...ovr.$methods } as ServicePort<ServiceDef<TName, TMethods>>;
    }

    /** Resolve a list of service defs into a name-keyed object for ctx.services. */
    resolveAll(defs: readonly AnyService[]): Record<string, Record<string, (...args: any[]) => Promise<any>>> {
        const out: Record<string, Record<string, (...args: any[]) => Promise<any>>> = {};
        for (const def of defs) {
            out[def.$name] = this.resolve(def);
        }
        return out;
    }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/server/src/__tests__/service-container.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/service-container.ts packages/server/src/__tests__/service-container.test.ts
git commit -m "feat(server): add ServiceContainer for service resolution and override merging

Resolves services by name, applies total or partial overrides,
and provides resolveAll() to build the ctx.services object for
workflow/webhook/heartbeat injection."
```

---

### Task 6: Workflow service injection

**Files:**
- Modify: `packages/server/src/workflow.ts`
- Test: `packages/server/src/__tests__/workflow-services.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/__tests__/workflow-services.test.ts
import { describe, it, expect, vi } from 'vitest';
import { service } from '@syncengine/core';
import { defineWorkflow, type WorkflowDef } from '../workflow';

describe('defineWorkflow with services', () => {
    const payments = service('payments', {
        async charge(amount: number) { return { id: 'ch_1', amount }; },
    });

    it('accepts a services option', () => {
        const wf = defineWorkflow('testWf', { services: [payments] }, async (ctx, input: { n: number }) => {
            // ctx.services.payments should be typed
        });

        expect(wf.$tag).toBe('workflow');
        expect(wf.$name).toBe('testWf');
        expect(wf.$services).toEqual([payments]);
    });

    it('still works without services (backwards compat)', () => {
        const wf = defineWorkflow('simpleWf', async (ctx, input: string) => {
            // no services
        });

        expect(wf.$tag).toBe('workflow');
        expect(wf.$services).toEqual([]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/server/src/__tests__/workflow-services.test.ts`
Expected: FAIL — `$services` doesn't exist on WorkflowDef, new overload signature doesn't exist.

- [ ] **Step 3: Update `defineWorkflow` to accept services option**

Modify `packages/server/src/workflow.ts`:

```ts
import type { AnyService } from '@syncengine/core';

export interface WorkflowDef<TName extends string = string, TInput = unknown> {
    readonly $tag: 'workflow';
    readonly $name: TName;
    readonly $handler: (ctx: restate.WorkflowContext, input: TInput) => Promise<void>;
    readonly $services: readonly AnyService[];
}

export interface WorkflowOptions {
    readonly services?: readonly AnyService[];
}

// New overload: defineWorkflow(name, options, handler)
export function defineWorkflow<const TName extends string, TInput>(
    name: TName,
    options: WorkflowOptions,
    handler: (ctx: restate.WorkflowContext, input: TInput) => Promise<void>,
): WorkflowDef<TName, TInput>;
// Legacy overload: defineWorkflow(name, handler)
export function defineWorkflow<const TName extends string, TInput>(
    name: TName,
    handler: (ctx: restate.WorkflowContext, input: TInput) => Promise<void>,
): WorkflowDef<TName, TInput>;
export function defineWorkflow<const TName extends string, TInput>(
    name: TName,
    optionsOrHandler: WorkflowOptions | ((ctx: restate.WorkflowContext, input: TInput) => Promise<void>),
    maybeHandler?: (ctx: restate.WorkflowContext, input: TInput) => Promise<void>,
): WorkflowDef<TName, TInput> {
    // Validation (unchanged)
    if (!name || typeof name !== 'string') {
        throw errors.schema(SchemaCode.INVALID_WORKFLOW_NAME, {
            message: `defineWorkflow: name must be a non-empty string.`,
            hint: `Pass a valid name: defineWorkflow('myWorkflow', { ... })`,
        });
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
        throw errors.schema(SchemaCode.INVALID_WORKFLOW_NAME, {
            message: `defineWorkflow('${name}'): name must match /^[a-zA-Z][a-zA-Z0-9_]*$/.`,
            hint: `Use only letters, numbers, and underscores. Must start with a letter.`,
            context: { workflow: name },
        });
    }

    let handler: (ctx: restate.WorkflowContext, input: TInput) => Promise<void>;
    let services: readonly AnyService[] = [];

    if (typeof optionsOrHandler === 'function') {
        handler = optionsOrHandler;
    } else {
        services = optionsOrHandler.services ?? [];
        handler = maybeHandler!;
    }

    return { $tag: 'workflow', $name: name, $handler: handler, $services: services };
}
```

Also update `buildWorkflowObject` to inject services into ctx (the actual injection uses the ServiceContainer — the runtime binds services when building the Restate workflow). For now, `$services` is carried on the def for the runtime to use.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/server/src/__tests__/workflow-services.test.ts`
Expected: All PASS.

- [ ] **Step 5: Run existing workflow tests**

Run: `pnpm vitest run packages/server/`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/workflow.ts packages/server/src/__tests__/workflow-services.test.ts
git commit -m "feat(server): add services option to defineWorkflow

defineWorkflow now accepts an optional { services: [...] } options
object. Services are carried on the WorkflowDef for the runtime to
inject into ctx. Legacy two-arg form still works."
```

---

### Task 7: Webhook and heartbeat service injection

**Files:**
- Modify: `packages/server/src/webhook.ts`
- Modify: `packages/server/src/heartbeat.ts`

- [ ] **Step 1: Add `$services` to `WebhookDef` and `HeartbeatDef`**

In `packages/server/src/webhook.ts`, add to `WebhookConfig`:

```ts
import type { AnyService } from '@syncengine/core';

// Add to WebhookConfig interface:
readonly services?: readonly AnyService[];

// Add to WebhookDef interface:
readonly $services: readonly AnyService[];

// In webhook() factory, add to return:
$services: config.services ?? [],
```

In `packages/server/src/heartbeat.ts`, same pattern:

```ts
import type { AnyService } from '@syncengine/core';

// Add to HeartbeatConfig interface:
services?: readonly AnyService[];

// Add to HeartbeatDef interface:
readonly $services: readonly AnyService[];

// In heartbeat() factory, add to return:
$services: config.services ?? [],
```

- [ ] **Step 2: Run full server test suite**

Run: `pnpm vitest run packages/server/`
Expected: All PASS — additive change, no existing behavior affected.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/webhook.ts packages/server/src/heartbeat.ts
git commit -m "feat(server): add services option to webhook() and heartbeat()

Both primitives now carry $services on their definition for the
runtime to resolve and inject into ctx.services at invocation time."
```

---

### Task 8: Entity runtime — trigger workflow effects from `emit()`

**Files:**
- Modify: `packages/server/src/entity-runtime.ts`

- [ ] **Step 1: Import `extractTriggers` and dispatch workflow triggers**

In `packages/server/src/entity-runtime.ts`, after the existing `publishTableDeltas` call in `runHandler`:

```ts
import { extractTriggers, type EmitTrigger } from '@syncengine/core';
import { WORKFLOW_OBJECT_PREFIX } from './workflow.js';

// In runHandler, after publishTableDeltas:
const triggers = extractTriggers(validated);
if (triggers && triggers.length > 0) {
    await dispatchWorkflowTriggers(ctx, triggers);
}
```

Add the dispatch function:

```ts
async function dispatchWorkflowTriggers(
    ctx: restate.ObjectContext,
    triggers: readonly EmitTrigger[],
): Promise<void> {
    for (const t of triggers) {
        const workflowName = `${WORKFLOW_OBJECT_PREFIX}${t.workflow}`;
        const workflowKey = `${ctx.key}-${ctx.rand.uuidv4()}`;
        ctx.workflowSendClient({ name: workflowName }, workflowKey).run(t.input);
    }
}
```

Also handle trigger extraction in `applyHandler` — preserve the TRIGGER_KEY the same way EMIT_KEY is preserved:

In `applyHandler()` in `entity.ts`, after extracting emits and before validation:

```ts
import { TRIGGER_KEY, extractTriggers } from './entity';

// In applyHandler, alongside emits extraction:
const triggers = extractTriggers(rawResult);

// After the validated object is built, re-attach triggers:
if (triggers) {
    Object.defineProperty(validated, TRIGGER_KEY, {
        value: triggers,
        enumerable: false,
        configurable: true,
    });
}
```

- [ ] **Step 2: Run full test suite**

Run: `pnpm vitest run`
Expected: All PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/entity.ts packages/server/src/entity-runtime.ts
git commit -m "feat(server): dispatch workflow triggers from emit() effects

Entity runtime now extracts TRIGGER_KEY from handler results and
dispatches Restate workflow invocations after state is persisted.
This bridges pure entity handlers to async workflow orchestration."
```

---

### Task 9: Vite plugin service discovery

**Files:**
- Create: `packages/vite-plugin/src/services.ts`
- Modify: `packages/vite-plugin/src/index.ts`

- [ ] **Step 1: Create the services discovery sub-plugin**

```ts
// packages/vite-plugin/src/services.ts
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Vite sub-plugin that discovers `services/*.ts` files under the app's
 * `src/` directory and reports them in the dev server startup log.
 *
 * Files in `services/test/` and `services/staging/` are excluded from
 * production builds via Vite's define/replace mechanism.
 */
export function servicesPlugin(): Plugin {
    let appRoot = '';
    const discoveredServices: string[] = [];

    return {
        name: 'syncengine:services',

        configResolved(config) {
            appRoot = config.root;
        },

        buildStart() {
            discoveredServices.length = 0;
            const servicesDir = join(appRoot, 'src', 'services');
            if (!existsSync(servicesDir)) return;

            let entries: string[];
            try {
                entries = readdirSync(servicesDir);
            } catch {
                return;
            }

            for (const entry of entries) {
                const full = join(servicesDir, entry);
                // Skip subdirectories (test/, staging/) and non-TS files
                try {
                    if (statSync(full).isDirectory()) continue;
                } catch {
                    continue;
                }
                if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue;
                if (entry.startsWith('.')) continue;

                const name = basename(entry, entry.endsWith('.tsx') ? '.tsx' : '.ts');
                discoveredServices.push(name);
            }

            if (discoveredServices.length > 0) {
                console.log(
                    `[syncengine] services: ${discoveredServices.join(', ')}`,
                );
            }
        },
    };
}
```

- [ ] **Step 2: Compose into the plugin array**

In `packages/vite-plugin/src/index.ts`, import and add:

```ts
import { servicesPlugin } from './services.ts';

// In the returned array:
export default function syncengine(opts: SyncenginePluginOptions = {}) {
    return [
        wasmPlugin(),
        wasm(),
        topLevelAwait(),
        runtimeConfigPlugin(opts),
        schemaReloadPlugin(),
        actorsPlugin(opts.actors ?? {}),
        workspacesPlugin(opts.workspaces ?? {}),
        servicesPlugin(),
        devtoolsPlugin(),
    ];
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/vite-plugin/src/services.ts packages/vite-plugin/src/index.ts
git commit -m "feat(vite-plugin): add services discovery sub-plugin

Discovers services/*.ts files at build start, logs them in the dev
server output. Override directories (test/, staging/) are skipped."
```

---

### Task 10: Server `loadDefinitions` discovers services

**Files:**
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Add service discovery to `loadDefinitions`**

Extend `walkSourceFiles` to also match files in a `services/` directory, and update `loadDefinitions` to collect `ServiceDef`s:

```ts
import { isService, type AnyService } from '@syncengine/core';

// Add to the return type:
export async function loadDefinitions(appDir: string): Promise<{
    entities: AnyEntity[];
    workflows: WorkflowDef[];
    heartbeats: HeartbeatDef[];
    webhooks: WebhookDef[];
    services: AnyService[];
}> {
    // ... existing code ...
    const services: AnyService[] = [];
    const serviceNameSources = new Map<string, string>();

    // In the file loop, add after webhook handling:
    } else if (isService(value)) {
        const existing = serviceNameSources.get(value.$name);
        if (existing) {
            throw errors.schema(SchemaCode.DUPLICATE_SERVICE_NAME, {
                message: `Duplicate service name '${value.$name}':\n    ${existing}\n    ${file}`,
                hint: `Service names must be unique across the src/ tree.`,
                context: { service: value.$name, files: [existing, file] },
            });
        }
        serviceNameSources.set(value.$name, file);
        services.push(value);
    }

    // Update return:
    return { entities, workflows, heartbeats, webhooks, services };
}
```

Also update `walkSourceFiles` to include files under `services/`:

In the file extension check, add a condition for files in any directory (services aren't named with a special extension — they're discovered by `isService` type guard on their exports).

Actually, the simplest approach: extend `walkSourceFiles` to also pick up `.ts` files inside `src/services/` (excluding `test/` and `staging/` subdirs):

```ts
// In walkSourceFiles, add alongside the existing extension check:
} else if (st.isFile() && name.endsWith('.ts') && dir.includes('/services') && !dir.includes('/services/test') && !dir.includes('/services/staging')) {
    out.push(full);
}
```

- [ ] **Step 2: Update `startRestateEndpoint` to accept and log services**

```ts
export async function startRestateEndpoint(
    entities: AnyEntity[],
    workflows: WorkflowDef[],
    port: number,
    heartbeats: HeartbeatDef[] = [],
    webhooks: WebhookDef[] = [],
    services: AnyService[] = [],
): Promise<void> {
    // ... existing code ...

    // Update the log line to include services:
    console.log(
        `[workspace-service] listening on :${port}` +
        ` (entities: ${allEntities.map((e) => e.$name).join(", ")})` +
        // ... existing ...
        (services.length > 0
            ? ` (services: ${services.map((s) => s.$name).join(", ")})`
            : ""),
    );
}
```

- [ ] **Step 3: Update call sites**

Update the direct execution block at the bottom of `index.ts`:

```ts
if (appDir) {
    void (async () => {
        const PORT = parseInt(process.env.PORT ?? "9080", 10);
        const { entities, workflows, heartbeats, webhooks, services } = await loadDefinitions(appDir);
        await startRestateEndpoint(entities, workflows, PORT, heartbeats, webhooks, services);
    })();
}
```

- [ ] **Step 4: Run existing tests**

Run: `pnpm vitest run packages/server/`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/index.ts
git commit -m "feat(server): discover and register services in loadDefinitions

Services in src/services/*.ts are auto-discovered alongside entities,
workflows, webhooks, and heartbeats. Duplicate names are rejected.
Override directories (test/, staging/) are excluded."
```

---

### Task 11: CLI scaffolding — hex directory structure

**Files:**
- Modify: `packages/cli/src/init.ts`

- [ ] **Step 1: Add `.gitkeep` files for hex directories**

In the `scaffoldProject` function in `packages/cli/src/init.ts`, add after the existing file writes (after the `.gitignore` write):

```ts
    // ── Hex directory placeholders
    write(target, 'src/services/.gitkeep', '');
    write(target, 'src/workflows/.gitkeep', '');

    // Move existing entities, workflows, webhooks, heartbeats, topics into dirs
    // (they already go into subdirs — this just ensures the dir exists for
    // apps that start without those primitives)
```

Wait — looking at the existing init code, entities already go into `src/entities/`, workflows into `src/workflows/`, etc. The only missing directory is `src/services/`. But the existing scaffold already creates files in each of those dirs, so they exist. We just need to add `src/services/.gitkeep`.

Actually, the simplest change: just add the `.gitkeep` for `services/` since all other dirs already get created by the scaffold files.

```ts
    // ── Hex: services directory (empty placeholder)
    write(target, 'src/services/.gitkeep', '');
```

- [ ] **Step 2: Run existing CLI tests (if any) or test manually**

Run: `pnpm vitest run packages/cli/ 2>/dev/null || echo "No CLI tests"`

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/init.ts
git commit -m "feat(cli): scaffold src/services/ in syncengine init

Adds an empty services directory to the hex structure so new apps
have the right layout from the start."
```

---

### Task 12: CLI `syncengine add service` command

**Files:**
- Create: `packages/cli/src/add.ts`
- Modify: `packages/cli/src/cli.ts` (or wherever the CLI dispatch lives)

- [ ] **Step 1: Find the CLI entry point**

Read the CLI's main dispatch to understand how commands are routed, then add `add` as a new subcommand.

- [ ] **Step 2: Create `add.ts` with the service generator**

```ts
// packages/cli/src/add.ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { errors, CliCode } from '@syncengine/core';

export async function addCommand(args: string[]): Promise<void> {
    const [kind, name] = args;

    if (kind !== 'service') {
        throw errors.cli(CliCode.UNKNOWN_SUBCOMMAND, {
            message: `syncengine add: unknown kind '${kind}'.`,
            hint: `Supported: syncengine add service <name>`,
        });
    }

    if (!name || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
        throw errors.cli(CliCode.INVALID_ARGUMENT, {
            message: `syncengine add service: invalid name '${name}'.`,
            hint: `Use only letters, numbers, and underscores. Must start with a letter.`,
        });
    }

    const servicesDir = join(resolve('.'), 'src', 'services');
    mkdirSync(servicesDir, { recursive: true });

    const filePath = join(servicesDir, `${name}.ts`);
    if (existsSync(filePath)) {
        throw errors.cli(CliCode.FILE_EXISTS, {
            message: `Service file already exists: ${filePath}`,
            hint: `Delete it first or choose a different name.`,
        });
    }

    const content = `\
import { service } from '@syncengine/core';

export const ${name} = service('${name}', {
  // Add your methods here. Each must be async and return serializable data.
  // Example:
  //   async fetch(id: string) {
  //     const res = await externalApi.get(id);
  //     return { id: res.id, name: res.name };
  //   },
});
`;

    writeFileSync(filePath, content);
    console.log(`Created: src/services/${name}.ts`);
}
```

- [ ] **Step 3: Wire into CLI dispatch**

Add the error codes to `packages/core/src/errors.ts` if not already present:

```ts
UNKNOWN_SUBCOMMAND: 'SE5100',
INVALID_ARGUMENT: 'SE5101',
FILE_EXISTS: 'SE5102',
```

Wire `add` into the CLI's command routing (the exact location depends on the CLI entry point — likely `packages/cli/src/cli.ts` or the bin entry).

- [ ] **Step 4: Test manually**

```bash
cd /tmp && mkdir test-add && cd test-add && mkdir -p src/services
node ./packages/cli/src/add.ts service payments
cat src/services/payments.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/add.ts packages/core/src/errors.ts
git commit -m "feat(cli): add 'syncengine add service' generator

Scaffolds a service stub at src/services/<name>.ts with the service()
import and an empty methods object ready to fill in."
```

---

## Verification Checklist

After all tasks are complete:

- [ ] `pnpm vitest run` — all tests pass across all packages
- [ ] `pnpm tsc --noEmit -p packages/core/tsconfig.json` — no type errors
- [ ] `pnpm tsc --noEmit -p packages/server/tsconfig.json` — no type errors
- [ ] Boot `syncengine dev` in the notepad app — services appear in startup log (even if empty)
- [ ] Existing notepad app functionality (notes, thumbs, entities, workflows, webhooks, heartbeats) is unaffected
- [ ] Legacy `emit(state, ...inserts)` form still works in existing entity handlers
