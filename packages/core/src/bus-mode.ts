// ── BusMode + BusOverride ──────────────────────────────────────────────────
//
// `BusMode` selects the driver the framework wires behind a `BusRef<T>`.
// Default is `nats` — the production path goes through NATS JetStream
// with a `BusDispatcher` per subscriber. `inMemory` is a test-mode driver
// that captures publishes into an in-process buffer and (optionally)
// invokes subscriber workflows synchronously. See
// `docs/superpowers/specs/2026-04-20-event-bus-design.md` §4.
//
// Users opt into `inMemory` either by declaring the bus with it:
//
//     bus('orderEvents', { schema, mode: BusMode.inMemory() })
//
// or by overriding an existing declaration in a test-specific file:
//
//     // src/events/test/orders.ts
//     export default override(orderEvents, { mode: BusMode.inMemory() })
//
// The override route preserves the production-mode declaration and
// flips driver selection only in the test environment (wired via
// `SyncengineConfig.services.overrides`).

export type BusMode =
    | { readonly kind: 'nats' }
    | { readonly kind: 'inMemory' };

/** Typed factory namespace for bus driver selection. */
export const BusMode = {
    nats: (): BusMode => ({ kind: 'nats' }),
    inMemory: (): BusMode => ({ kind: 'inMemory' }),
};

export interface BusOverride<T = unknown> {
    readonly $tag: 'bus-override';
    readonly $targetName: string;
    readonly mode?: BusMode;
    /** Phantom brand — TS uses this to keep the payload type T linked
     *  to the override even though we don't read it at runtime. Lets
     *  future options (e.g., a capture hook) stay type-checked against
     *  the original bus's payload. */
    readonly _payload?: T;
}

export type AnyBusOverride = BusOverride<unknown>;

export function isBusOverride(value: unknown): value is AnyBusOverride {
    return (
        !!value &&
        typeof value === 'object' &&
        (value as { $tag?: unknown }).$tag === 'bus-override'
    );
}
