// ── Config overrides loader ────────────────────────────────────────────────
//
// `SyncengineConfig.services.overrides` is a lazy import that returns a
// module of override values. The shape is intentionally loose — users can
// `export default [override(a, ...), override(b, ...)]`, export a single
// `override(...)` as default, or use named exports. This loader walks
// whatever shape it gets and splits the overrides by $tag into
// service vs bus buckets, ready for the ServiceContainer and bus mode
// registry respectively.
//
// Same pattern as `loadDefinitions` — small, defensive, accepts anything
// a user might plausibly write and ignores what it can't recognise.

import {
    isServiceOverride,
    isBusOverride,
    type AnyServiceOverride,
    type AnyBusOverride,
} from '@syncengine/core';

export interface LoadedOverrides {
    readonly serviceOverrides: readonly AnyServiceOverride[];
    readonly busOverrides: readonly AnyBusOverride[];
}

/** Iterate an unknown overrides-module payload and extract every
 *  recognised override. Accepts:
 *    - a single override returned directly
 *    - an array (or readonly array) of overrides
 *    - an object whose own keys are overrides or arrays of overrides
 *  Anything unrecognised is silently skipped — keeps dev-time typos
 *  from crashing the server, and lets the module co-export helpers
 *  alongside the overrides themselves. */
export function extractOverrides(moduleValue: unknown): LoadedOverrides {
    const services: AnyServiceOverride[] = [];
    const buses: AnyBusOverride[] = [];

    const visit = (v: unknown): void => {
        if (v == null) return;
        if (isServiceOverride(v)) {
            services.push(v);
            return;
        }
        if (isBusOverride(v)) {
            buses.push(v);
            return;
        }
        if (Array.isArray(v)) {
            for (const item of v) visit(item);
            return;
        }
        if (typeof v === 'object') {
            for (const key of Object.keys(v as Record<string, unknown>)) {
                visit((v as Record<string, unknown>)[key]);
            }
        }
    };

    visit(moduleValue);
    return { serviceOverrides: services, busOverrides: buses };
}

/** Convenience — call `config.services.overrides?.()`, extract, return. */
export async function loadConfigOverrides(
    config: unknown,
): Promise<LoadedOverrides> {
    const overridesFn = (config as {
        services?: { overrides?: () => Promise<unknown> };
    })?.services?.overrides;
    if (!overridesFn) {
        return { serviceOverrides: [], busOverrides: [] };
    }
    const mod = await overridesFn();
    return extractOverrides(mod);
}

/** Build a `modeOf(busName)` resolver from a list of bus overrides.
 *  Falls back to the default (reading the bus's own `$mode.kind`) when
 *  no override matches — so an app can mix override-flipped buses with
 *  directly-declared ones without ceremony. */
export function busOverridesToModeOf(
    overrides: readonly AnyBusOverride[],
): ((busName: string) => 'nats' | 'inMemory' | null) {
    if (overrides.length === 0) return () => null;
    const map = new Map<string, 'nats' | 'inMemory'>();
    for (const o of overrides) {
        if (o.mode) map.set(o.$targetName, o.mode.kind);
    }
    return (busName: string) => map.get(busName) ?? null;
}
