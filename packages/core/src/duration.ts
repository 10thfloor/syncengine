/**
 * Branded `Duration` values — forbid plain numbers for dimensional
 * time. The bus DSL takes retention, timeout, and backoff values that
 * would otherwise need a unit comment; the type system now carries
 * the unit instead.
 *
 *   retention: days(30)          // clear
 *   retention: 30                // rejected at the type level
 */

const DURATION_BRAND: unique symbol = Symbol.for('syncengine.duration');

export interface Duration {
    readonly [DURATION_BRAND]: true;
    readonly ms: number;
}

function build(n: number, multiplier: number, source: string): Duration {
    if (!Number.isInteger(n)) {
        throw new Error(`${source}: count must be an integer`);
    }
    if (n < 0) {
        throw new Error(`${source}: count must be non-negative`);
    }
    return { [DURATION_BRAND]: true, ms: n * multiplier } as Duration;
}

export const milliseconds = (n: number): Duration => build(n, 1, 'milliseconds');
export const seconds = (n: number): Duration => build(n, 1_000, 'seconds');
export const minutes = (n: number): Duration => build(n, 60_000, 'minutes');
export const hours = (n: number): Duration => build(n, 3_600_000, 'hours');
export const days = (n: number): Duration => build(n, 86_400_000, 'days');
