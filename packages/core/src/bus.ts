/**
 * `bus()` — declarative event bus primitive.
 *
 * Returns a typed `BusRef<T>` that carries the schema, resolved
 * JetStream config, and an auto-generated `.dlq` accessor. The
 * framework enforces that `.dlq` and `.dead` suffixes belong to
 * auto-generated DLQ buses — the name regex disallows `.`, so
 * user-declared names can never collide.
 *
 * `BusRef.publish(ctx, payload)` is attached here as a stub that
 * throws until `@syncengine/server`'s `bus-context` bootstrap hooks
 * up the real implementation. The stub keeps core self-contained
 * (no dependency on `@syncengine/server`) while still letting tests
 * observe the shape of the method.
 */

import { z, type ZodType } from 'zod';
import type { Duration } from './duration';
import { days, minutes } from './duration';
import {
    Retention, Delivery, Storage,
    type RetentionConfig, type DeliveryConfig, type StorageConfig,
} from './bus-config';

// ── Naming rules ───────────────────────────────────────────────────────────

const BUS_NAME_REGEX = /^[a-z][a-z0-9_-]*$/i;
const RESERVED_SUFFIXES: readonly string[] = ['.dlq', '.dead'];

function validateBusName(name: string): void {
    if (typeof name !== 'string' || name.length === 0) {
        throw new Error(`bus(): name must be a non-empty string`);
    }
    if (name.startsWith('$') || name.startsWith('_')) {
        throw new Error(`bus('${name}'): names starting with $ or _ are reserved`);
    }
    if (!BUS_NAME_REGEX.test(name)) {
        throw new Error(
            `bus('${name}'): name must match ${BUS_NAME_REGEX} — ` +
            `dots are reserved for framework-generated .dlq/.dead suffixes`,
        );
    }
    for (const suffix of RESERVED_SUFFIXES) {
        if (name.endsWith(suffix)) {
            throw new Error(
                `bus('${name}'): ${suffix} is a framework-reserved suffix for auto-generated DLQ buses`,
            );
        }
    }
}

// ── DeadEvent + schema ─────────────────────────────────────────────────────

export interface DeadEvent<T> {
    readonly original: T;
    readonly error: {
        message: string;
        code?: string;
        stack?: string;
    };
    readonly attempts: number;
    readonly firstAttemptAt: number;
    readonly lastAttemptAt: number;
    /** Name of the subscriber workflow that gave up. */
    readonly workflow: string;
}

export function deadEventSchema<T>(inner: ZodType<T>): ZodType<DeadEvent<T>> {
    return z.object({
        original: inner,
        error: z.object({
            message: z.string(),
            code: z.string().optional(),
            stack: z.string().optional(),
        }),
        attempts: z.number(),
        firstAttemptAt: z.number(),
        lastAttemptAt: z.number(),
        workflow: z.string(),
    }) as unknown as ZodType<DeadEvent<T>>;
}

// ── Config + BusRef types ──────────────────────────────────────────────────

export interface BusConfig {
    readonly retention: RetentionConfig;
    readonly delivery: DeliveryConfig;
    readonly storage: StorageConfig;
    readonly dedupWindow: Duration;
}

/** Minimal Restate-like context shape; the `bus.publish` method only
 *  uses `ctx.run`. Avoids depending on the Restate SDK from core. */
export interface BusPublishCtx {
    run<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export interface BusRef<T> {
    readonly $tag: 'bus';
    readonly $name: string;
    readonly $schema: ZodType<T>;
    readonly $config: BusConfig;
    /** Auto-generated DLQ bus sharing this bus's lifecycle. Its schema
     *  wraps the parent's in `DeadEvent<T>`. The DLQ's own `.dlq` is
     *  itself — terminates the recursion without breaking the API. */
    readonly dlq: BusRef<DeadEvent<T>>;
    /** Imperative publish from a workflow / webhook / heartbeat.
     *  Validates payload against the bus schema; wraps the NATS publish
     *  in `ctx.run` so Restate's replay is deterministic. */
    publish(ctx: BusPublishCtx, payload: T): Promise<void>;
}

export interface BusOptions<T> {
    readonly schema: ZodType<T>;
    readonly retention?: RetentionConfig;
    readonly delivery?: DeliveryConfig;
    readonly storage?: StorageConfig;
    readonly dedupWindow?: Duration;
}

// ── Publisher wiring seam (@syncengine/server hooks in via T5) ─────────────

export type BusPublisher = (
    ctx: BusPublishCtx,
    busName: string,
    payload: unknown,
) => Promise<void>;

let activePublisher: BusPublisher | null = null;

/** Wired at server boot by `@syncengine/server`'s bus-context bootstrap.
 *  Unit tests can inject stubs directly. Reset with `setBusPublisher(null)`. */
export function setBusPublisher(p: BusPublisher | null): void {
    activePublisher = p;
}

async function dispatchPublish<T>(
    ref: BusRef<T>,
    ctx: BusPublishCtx,
    payload: T,
): Promise<void> {
    const parsed = ref.$schema.safeParse(payload);
    if (!parsed.success) {
        throw new Error(
            `bus.publish(${ref.$name}): invalid bus payload — ${parsed.error.message}`,
        );
    }
    await ctx.run(`bus:${ref.$name}:publish`, async () => {
        if (!activePublisher) {
            throw new Error(
                `bus.publish(${ref.$name}): called before the server runtime wired the publisher. ` +
                `This means the caller ran outside any registered workflow / webhook / heartbeat handler.`,
            );
        }
        await activePublisher(ctx, ref.$name, parsed.data);
    });
}

// ── Construction ───────────────────────────────────────────────────────────

function applyDefaults<T>(opts: BusOptions<T>): BusConfig {
    return {
        retention: opts.retention ?? Retention.durableFor(days(7)).maxMessages(1_000_000),
        delivery: opts.delivery ?? Delivery.fanout(),
        storage: opts.storage ?? Storage.file(),
        dedupWindow: opts.dedupWindow ?? minutes(1),
    };
}

function attachPublish<T>(ref: Omit<BusRef<T>, 'publish'>): BusRef<T> {
    const full = ref as BusRef<T>;
    (full as { publish: BusRef<T>['publish'] }).publish = (ctx, payload) =>
        dispatchPublish(full, ctx, payload);
    return full;
}

function buildDlqRef<T>(parentName: string, parentSchema: ZodType<T>): BusRef<DeadEvent<T>> {
    const dlqName = `${parentName}.dlq`;
    const dlqSchema = deadEventSchema(parentSchema);
    const dlqConfig = applyDefaults({
        schema: dlqSchema,
        retention: Retention.durableFor(days(30)),
    });

    // Build the object first, then make its own .dlq point at itself.
    const self = {
        $tag: 'bus' as const,
        $name: dlqName,
        $schema: dlqSchema,
        $config: dlqConfig,
    } as unknown as BusRef<DeadEvent<T>>;
    (self as unknown as { dlq: BusRef<DeadEvent<T>> }).dlq = self;
    return attachPublish(self);
}

export function bus<T>(name: string, opts: BusOptions<T>): BusRef<T> {
    validateBusName(name);
    const config = applyDefaults(opts);
    const dlq = buildDlqRef(name, opts.schema);
    return attachPublish({
        $tag: 'bus',
        $name: name,
        $schema: opts.schema,
        $config: config,
        dlq,
    });
}

export function isBus(value: unknown): value is BusRef<unknown> {
    return (
        !!value &&
        typeof value === 'object' &&
        (value as { $tag?: unknown }).$tag === 'bus'
    );
}
