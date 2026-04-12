import {
    applyHandler,
    extractEmits,
} from '@syncengine/core';
import type {
    EntityDef,
    EntityState,
    EntityStateShape,
    EntityHandlerMap,
    SourceState,
} from '@syncengine/core';

export interface EmittedRecord {
    table: string;
    record: Record<string, unknown>;
}

export interface TestEntity<TState> {
    /** Current entity state. Updated after each call(). */
    readonly state: TState;
    /** All emitted table inserts from all calls, in order. */
    readonly emits: readonly EmittedRecord[];
    /** Call a handler by name. Mutates state and collects emits. Throws if the handler throws. */
    call(handlerName: string, ...args: unknown[]): void;
    /** Reset emits array (useful between test phases). */
    clearEmits(): void;
}

/**
 * Create a lightweight test harness for an entity definition.
 *
 * Runs handlers purely via `applyHandler` and collects `emit()` inserts
 * via `extractEmits` — no NATS, no Restate, no I/O.
 *
 * ```ts
 * const t = testEntity(counter, { value: 5 });
 * t.call('increment');
 * expect(t.state.value).toBe(6);
 * ```
 */
export function testEntity<
    TName extends string,
    TShape extends EntityStateShape,
    THandlers extends EntityHandlerMap<any>,
    TSourceKeys extends string = never,
>(
    entityDef: EntityDef<TName, TShape, THandlers, TSourceKeys>,
    initialState?: Partial<EntityState<TShape> & SourceState<TSourceKeys>>,
): TestEntity<EntityState<TShape> & SourceState<TSourceKeys>> {
    type FullState = EntityState<TShape> & SourceState<TSourceKeys>;

    // Merge the entity's default initial state with any overrides.
    // Source projection initials (e.g., totalSold: 0) come from $sourceInitial.
    let currentState: FullState = {
        ...entityDef.$initialState,
        ...entityDef.$sourceInitial,
        ...initialState,
    } as FullState;

    const allEmits: EmittedRecord[] = [];

    return {
        get state() { return currentState; },
        get emits() { return allEmits; },

        call(handlerName: string, ...args: unknown[]): void {
            // applyHandler runs the handler as a pure function:
            // (currentState, ...args) => newState
            const result = applyHandler(
                entityDef as any,
                handlerName,
                currentState as any,
                args,
            );

            // Extract any emitted table inserts (from emit() calls in the handler)
            const emits = extractEmits(result as Record<string, unknown>);
            if (emits) {
                for (const e of emits) {
                    allEmits.push({
                        table: e.table,
                        record: { ...e.record },
                    });
                }
            }

            currentState = result as FullState;
        },

        clearEmits(): void {
            allEmits.length = 0;
        },
    };
}
