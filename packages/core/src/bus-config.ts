/**
 * Typed factory namespaces for the bus DSL's Layer 2 config. Every
 * value that would otherwise be a magic string (`"limits"`,
 * `"fanout"`, `"exponential"`, `"old"`) is a typed accessor or
 * factory here. Users never write raw strings; TypeScript rejects
 * typos at compile time.
 */

import type { Duration } from './duration';

// ── Retention ──────────────────────────────────────────────────────────────

export type RetentionConfig = {
    readonly kind: 'limits';
    readonly maxAge: Duration;
    readonly maxMsgs?: number;
    readonly discard: 'old' | 'new';
    maxMessages(n: number): RetentionConfig;
    discardOldest(): RetentionConfig;
    discardNewest(): RetentionConfig;
};

interface RetentionState {
    readonly maxAge: Duration;
    readonly maxMsgs?: number;
    readonly discard: 'old' | 'new';
}

function buildRetention(state: RetentionState): RetentionConfig {
    return {
        kind: 'limits',
        maxAge: state.maxAge,
        ...(state.maxMsgs !== undefined ? { maxMsgs: state.maxMsgs } : {}),
        discard: state.discard,
        maxMessages: (n) => buildRetention({ ...state, maxMsgs: n }),
        discardOldest: () => buildRetention({ ...state, discard: 'old' }),
        discardNewest: () => buildRetention({ ...state, discard: 'new' }),
    };
}

export const Retention = {
    durableFor: (maxAge: Duration): RetentionConfig =>
        buildRetention({ maxAge, discard: 'old' }),
};

// ── Delivery ───────────────────────────────────────────────────────────────

export type DeliveryMode = 'fanout' | 'queue' | 'interest';

export interface DeliveryConfig {
    readonly mode: DeliveryMode;
}

export const Delivery = {
    fanout: (): DeliveryConfig => ({ mode: 'fanout' }),
    queue: (): DeliveryConfig => ({ mode: 'queue' }),
    interest: (): DeliveryConfig => ({ mode: 'interest' }),
};

// ── Storage ────────────────────────────────────────────────────────────────

export type StorageKind = 'file' | 'memory';

export interface StorageConfig {
    readonly kind: StorageKind;
    readonly replicas: number;
}

export const Storage = {
    file: (): StorageConfig => ({ kind: 'file', replicas: 1 }),
    memory: (): StorageConfig => ({ kind: 'memory', replicas: 1 }),
    replicatedFile: (opts: { replicas: number }): StorageConfig => {
        if (!Number.isInteger(opts.replicas) || opts.replicas < 1) {
            throw new Error(`Storage.replicatedFile: replicas must be a positive integer (got ${opts.replicas})`);
        }
        return { kind: 'file', replicas: opts.replicas };
    },
};

// ── Backoff ────────────────────────────────────────────────────────────────

export type BackoffConfig =
    | { readonly kind: 'exponential'; readonly initial: Duration; readonly max: Duration }
    | { readonly kind: 'fixed'; readonly interval: Duration };

export const Backoff = {
    exponential: (opts: { initial: Duration; max: Duration }): BackoffConfig => ({
        kind: 'exponential',
        initial: opts.initial,
        max: opts.max,
    }),
    fixed: (opts: { interval: Duration }): BackoffConfig => ({
        kind: 'fixed',
        interval: opts.interval,
    }),
};

// ── Retry ──────────────────────────────────────────────────────────────────

export type RetryConfig =
    | { readonly kind: 'exponential'; readonly attempts: number; readonly initial: Duration; readonly max: Duration }
    | { readonly kind: 'fixed'; readonly attempts: number; readonly interval: Duration }
    | { readonly kind: 'none' };

function validateAttempts(attempts: number): void {
    if (!Number.isInteger(attempts) || attempts < 0) {
        throw new Error(`Retry: attempts must be a non-negative integer (got ${attempts})`);
    }
}

export const Retry = {
    exponential: (opts: { attempts: number; initial: Duration; max: Duration }): RetryConfig => {
        validateAttempts(opts.attempts);
        return { kind: 'exponential', ...opts };
    },
    fixed: (opts: { attempts: number; interval: Duration }): RetryConfig => {
        validateAttempts(opts.attempts);
        return { kind: 'fixed', ...opts };
    },
    none: (): RetryConfig => ({ kind: 'none' }),
};

// ── Concurrency ────────────────────────────────────────────────────────────
//
// Caps the number of in-flight invocations for a subscriber. See spec §6.
//
//   Concurrency.global(n)  — at most n invocations across the whole subscriber
//   Concurrency.perKey(n)  — at most n invocations per `.orderedBy(fn)` key
//
// `global` maps cleanly to JetStream's `max_ack_pending` on the durable
// consumer; `perKey` requires in-process tracking inside the dispatcher
// (one counter per `.orderedBy` key, NAK when the counter hits the cap).

export type ConcurrencyConfig =
    | { readonly kind: 'global'; readonly limit: number }
    | { readonly kind: 'perKey'; readonly limit: number };

function validateLimit(limit: number, label: string): void {
    if (!Number.isInteger(limit) || limit < 1) {
        throw new Error(`${label}: limit must be a positive integer (got ${limit})`);
    }
}

export const Concurrency = {
    global: (limit: number): ConcurrencyConfig => {
        validateLimit(limit, 'Concurrency.global');
        return { kind: 'global', limit };
    },
    perKey: (limit: number): ConcurrencyConfig => {
        validateLimit(limit, 'Concurrency.perKey');
        return { kind: 'perKey', limit };
    },
};

// ── Rate ───────────────────────────────────────────────────────────────────
//
// Token-bucket throttle on the dispatcher. The three factories differ only
// in the window they compile to; the dispatcher converts each to a steady
// `tokens / second` refill rate.

export type RateConfig = {
    readonly kind: 'tokenBucket';
    /** Allowed invocations per second (floating-point ok — the dispatcher
     *  refills fractionally). */
    readonly perSecond: number;
};

function validateRate(n: number, label: string): void {
    if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`${label}: rate must be a positive finite number (got ${n})`);
    }
}

export const Rate = {
    perSecond: (n: number): RateConfig => {
        validateRate(n, 'Rate.perSecond');
        return { kind: 'tokenBucket', perSecond: n };
    },
    perMinute: (n: number): RateConfig => {
        validateRate(n, 'Rate.perMinute');
        return { kind: 'tokenBucket', perSecond: n / 60 };
    },
    perHour: (n: number): RateConfig => {
        validateRate(n, 'Rate.perHour');
        return { kind: 'tokenBucket', perSecond: n / 3600 };
    },
};
