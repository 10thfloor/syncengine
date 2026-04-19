/**
 * Branded `Bytes` values — forbid plain numbers for dimensional
 * sizes. Paired with `Duration` for all JetStream config values the
 * bus DSL accepts, so `maxBytes: bytes.gib(50)` can't be silently
 * passed as `maxBytes: 50` (bytes? kib? mib?) in Layer 3.
 */

const BYTES_BRAND: unique symbol = Symbol.for('syncengine.bytes');

export interface Bytes {
    readonly [BYTES_BRAND]: true;
    readonly bytes: number;
}

function build(n: number, multiplier: number, source: string): Bytes {
    if (!Number.isInteger(n)) {
        throw new Error(`${source}: count must be an integer`);
    }
    if (n < 0) {
        throw new Error(`${source}: count must be non-negative`);
    }
    return { [BYTES_BRAND]: true, bytes: n * multiplier } as Bytes;
}

export const bytes = {
    b: (n: number): Bytes => build(n, 1, 'bytes.b'),
    kib: (n: number): Bytes => build(n, 1024, 'bytes.kib'),
    mib: (n: number): Bytes => build(n, 1024 * 1024, 'bytes.mib'),
    gib: (n: number): Bytes => build(n, 1024 * 1024 * 1024, 'bytes.gib'),
};
