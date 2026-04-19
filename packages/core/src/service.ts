// ── Service DSL (hexagonal architecture — driven ports) ────────────────────
//
// `service()` declares a typed service interface — a "driven port" in hex
// architecture parlance. The definition captures the service's name and its
// method signatures so the framework can:
//
//   1. Auto-extract a `ServicePort<T>` type for consumers (workflows,
//      webhooks, heartbeats) without leaking vendor SDK internals.
//   2. Wire real implementations in production and test doubles in tests
//      via the service container (`override()`).
//
// Example:
//
//     const payments = service('payments', {
//         async charge(amount: number, currency: string) {
//             return stripe.charges.create({ amount, currency });
//         },
//     });
//
//     type PaymentsPort = ServicePort<typeof payments>;
//     // → { charge(amount: number, currency: string): Promise<{ id: string; ... }> }

import { errors, SchemaCode } from './errors';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ServiceDef<
    TName extends string = string,
    TMethods extends Record<string, (...args: any[]) => Promise<any>> = Record<string, (...args: any[]) => Promise<any>>,
> {
    readonly $tag: 'service';
    readonly $name: TName;
    readonly $methods: TMethods;
}

/** Extract the typed port interface from a service definition. */
export type ServicePort<S> =
    S extends ServiceDef<string, infer TMethods>
        ? { [K in keyof TMethods]: TMethods[K] }
        : never;

/** Extract the literal name from a service definition. */
export type ServiceName<S> = S extends ServiceDef<infer N, any> ? N : never;

/** Wildcard type for any service definition. */
export type AnyService = ServiceDef<string, Record<string, (...args: any[]) => Promise<any>>>;

// ── service() ──────────────────────────────────────────────────────────────

/**
 * Declare a service (driven port). Pass the service's `name` and an object
 * of async method implementations.
 *
 * The returned `ServiceDef` is a tagged definition object (`$tag: 'service'`)
 * that the framework inspects at boot time to wire the service container.
 */
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
    return { $tag: 'service', $name: name, $methods: methods };
}

// ── Runtime helpers ────────────────────────────────────────────────────────

/** Type guard for any service definition. */
export function isService(value: unknown): value is AnyService {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as { $tag?: string }).$tag === 'service'
    );
}

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
