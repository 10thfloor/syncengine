// ── Polymorphic override() ─────────────────────────────────────────────────
//
// One name, two targets:
//
//   override(service, { methodA: ..., methodB: ... })   → ServiceOverride
//   override(service, partial, { partial: true })       → ServiceOverride
//   override(bus, { mode: BusMode.inMemory() })         → BusOverride
//
// Delegates to the existing service-override factory for service targets
// (no behaviour change) and builds a tagged `BusOverride` for bus targets.
// The user-facing export is this polymorphic function; the underlying
// service-override factory stays exposed under `serviceOverride` for
// callers that want the narrow form.

import {
    override as serviceOverride,
    type ServiceDef,
    type ServiceOverride,
} from './service';
import type { BusRef } from './bus';
import type { BusMode, BusOverride } from './bus-mode';

/** Override a bus's driver selection (primarily for tests). Pairs with
 *  the `SyncengineConfig.services.overrides` pathway so a `src/events/test/`
 *  file can flip production buses into `BusMode.inMemory()` without
 *  touching the production declaration. */
export function override<T>(
    target: BusRef<T>,
    opts: { mode: BusMode },
): BusOverride<T>;

/** Swap every method on a service. */
export function override<
    TName extends string,
    TMethods extends Record<string, (...args: any[]) => Promise<any>>,
>(
    target: ServiceDef<TName, TMethods>,
    methods: TMethods,
): ServiceOverride<TName, TMethods>;

/** Swap a subset of methods on a service; unspecified methods keep
 *  their production implementations. */
export function override<
    TName extends string,
    TMethods extends Record<string, (...args: any[]) => Promise<any>>,
>(
    target: ServiceDef<TName, TMethods>,
    methods: Partial<TMethods>,
    opts: { partial: true },
): ServiceOverride<TName, TMethods>;

export function override(
    target: unknown,
    arg2: unknown,
    arg3?: unknown,
): unknown {
    if (isBusRef(target)) {
        const opts = arg2 as { mode: BusMode };
        return {
            $tag: 'bus-override',
            $targetName: target.$name,
            ...(opts.mode ? { mode: opts.mode } : {}),
        } satisfies BusOverride;
    }
    if (isServiceDef(target)) {
        // Delegate to the existing service-override overloads. The cast
        // is safe — we just checked the tag.
        return (serviceOverride as unknown as (
            t: unknown,
            m: unknown,
            o?: unknown,
        ) => unknown)(target, arg2, arg3);
    }
    throw new Error(
        `override(): first argument must be a ServiceDef or BusRef ` +
        `(got ${summariseTarget(target)})`,
    );
}

function isBusRef(v: unknown): v is BusRef<unknown> {
    return (
        !!v &&
        typeof v === 'object' &&
        (v as { $tag?: unknown }).$tag === 'bus'
    );
}

function isServiceDef(v: unknown): v is ServiceDef {
    return (
        !!v &&
        typeof v === 'object' &&
        (v as { $tag?: unknown }).$tag === 'service'
    );
}

function summariseTarget(v: unknown): string {
    if (v && typeof v === 'object' && typeof (v as { $tag?: unknown }).$tag === 'string') {
        return `{ $tag: '${(v as { $tag: string }).$tag}' }`;
    }
    return typeof v === 'object' ? 'object' : typeof v;
}
