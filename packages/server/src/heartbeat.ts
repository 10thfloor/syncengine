// ── Heartbeat primitive ─────────────────────────────────────────────────────
//
// `heartbeat(name, config)` declares durable recurring server-side work.
// Compiles to a Restate workflow keyed on `(name, scopeKey)`; Restate owns
// the scheduling, leader election, and crash recovery. Framework layers a
// status entity on top for client-side observability and lifecycle control.
//
// See docs/superpowers/specs/2026-04-17-heartbeat-primitive.md for the full
// design, including the three-tier-store mental model and footgun analysis.

import * as restate from '@restatedev/restate-sdk';
import { errors, SchemaCode } from '@syncengine/core';

// ── Public types ────────────────────────────────────────────────────────────

export type HeartbeatScope = 'workspace' | 'global';
export type HeartbeatTrigger = 'boot' | 'manual';

/**
 * Deterministic timestamp helpers + the enclosing run metadata. Inherits
 * all Restate WorkflowContext primitives (ctx.sleep, ctx.run, ctx.date.now,
 * entityRef, etc.).
 */
export interface HeartbeatContext extends restate.WorkflowContext {
    readonly name: string;
    readonly scope: HeartbeatScope;
    readonly scopeKey: string;
    readonly runNumber: number;
    readonly trigger: HeartbeatTrigger;
}

export type HeartbeatHandler = (ctx: HeartbeatContext) => Promise<void>;

export interface HeartbeatConfig {
    trigger?: HeartbeatTrigger;
    scope?: HeartbeatScope;
    every: number | string;
    maxRuns?: number;
    runAtStart?: boolean;
    run: HeartbeatHandler;
}

/**
 * Normalized interval spec. Millisecond-based intervals and cron
 * expressions collapse to one of these two shapes so the scheduler loop
 * can dispatch without re-parsing on every tick.
 */
export type IntervalSpec =
    | { readonly kind: 'ms'; readonly ms: number }
    | { readonly kind: 'cron'; readonly expr: ParsedCron; readonly source: string };

/**
 * Parsed 5-field cron. Each field is either '*', a list of allowed values,
 * or a step expression (every N).
 */
export interface ParsedCron {
    readonly minute: CronField;
    readonly hour: CronField;
    readonly dayOfMonth: CronField;
    readonly month: CronField;
    readonly dayOfWeek: CronField;
}

export type CronField =
    | { readonly kind: 'any' }
    | { readonly kind: 'list'; readonly values: readonly number[] }
    | { readonly kind: 'step'; readonly step: number };

export interface HeartbeatDef<TName extends string = string> {
    readonly $tag: 'heartbeat';
    readonly $name: TName;
    readonly $scope: HeartbeatScope;
    readonly $trigger: HeartbeatTrigger;
    readonly $every: IntervalSpec;
    readonly $maxRuns: number;
    readonly $runAtStart: boolean;
    readonly $handler: HeartbeatHandler;
}

/** Restate workflow-name prefix. `heartbeat_pulse`, `heartbeat_digest`, etc. */
export const HEARTBEAT_WORKFLOW_PREFIX = 'heartbeat_';

// ── Factory ─────────────────────────────────────────────────────────────────

export function isHeartbeat(value: unknown): value is HeartbeatDef {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as Record<string, unknown>).$tag === 'heartbeat'
    );
}

export function heartbeat<const TName extends string>(
    name: TName,
    config: HeartbeatConfig,
): HeartbeatDef<TName> {
    validateName(name);
    const every = parseInterval(config.every, name);
    const maxRuns = validateMaxRuns(config.maxRuns ?? 0, name);
    const scope: HeartbeatScope = config.scope ?? 'workspace';
    const trigger: HeartbeatTrigger = config.trigger ?? 'boot';

    if (typeof config.run !== 'function') {
        throw errors.schema(SchemaCode.INVALID_HEARTBEAT_CONFIG, {
            message: `heartbeat('${name}'): 'run' must be an async function.`,
            hint: `Provide a handler: heartbeat('${name}', { every: '30s', run: async (ctx) => { ... } })`,
            context: { heartbeat: name },
        });
    }

    return {
        $tag: 'heartbeat',
        $name: name,
        $scope: scope,
        $trigger: trigger,
        $every: every,
        $maxRuns: maxRuns,
        $runAtStart: config.runAtStart ?? false,
        $handler: config.run,
    };
}

// ── Validation ──────────────────────────────────────────────────────────────

function validateName(name: string): void {
    if (!name || typeof name !== 'string') {
        throw errors.schema(SchemaCode.INVALID_HEARTBEAT_NAME, {
            message: `heartbeat: name must be a non-empty string.`,
            hint: `Pass a valid name: heartbeat('myHeartbeat', { ... })`,
        });
    }
    if (name.startsWith('_')) {
        throw errors.schema(SchemaCode.INVALID_HEARTBEAT_NAME, {
            message: `heartbeat('${name}'): names may not start with an underscore.`,
            hint: `The underscore prefix is reserved for framework-owned entities (e.g., _heartbeat_status).`,
            context: { heartbeat: name },
        });
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
        throw errors.schema(SchemaCode.INVALID_HEARTBEAT_NAME, {
            message: `heartbeat('${name}'): name must match /^[a-zA-Z][a-zA-Z0-9_]*$/.`,
            hint: `Use only letters, numbers, and underscores. Must start with a letter.`,
            context: { heartbeat: name },
        });
    }
}

function validateMaxRuns(n: number, name: string): number {
    if (!Number.isInteger(n) || n < 0) {
        throw errors.schema(SchemaCode.INVALID_HEARTBEAT_CONFIG, {
            message: `heartbeat('${name}'): maxRuns must be a non-negative integer (got ${n}).`,
            hint: `Pass a positive integer to bound the run count, or omit for unbounded.`,
            context: { heartbeat: name, maxRuns: n },
        });
    }
    return n;
}

// ── Interval parsing ────────────────────────────────────────────────────────

const DURATION_UNITS: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
};

const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/;
const STEP_RE = /^\*\/(\d+)$/;
const NUMBER_RE = /^(\d+)$/;

/**
 * Parse an `every` value into a normalized IntervalSpec.
 *
 * Supported forms (v1):
 *   - number: milliseconds, must be a positive integer.
 *   - single-unit duration: "500ms", "30s", "5m", "1h", "1d".
 *   - standard 5-field cron (UTC): "minute hour dayOfMonth month dayOfWeek".
 *
 * Combined durations ("1h30m"), timezones, and 6-field/seconds-first cron
 * are not supported; they throw with actionable messages.
 */
export function parseInterval(value: number | string, contextName: string): IntervalSpec {
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
            throw errors.schema(SchemaCode.INVALID_HEARTBEAT_INTERVAL, {
                message: `heartbeat('${contextName}'): every=${value} must be a positive integer (milliseconds).`,
                hint: `Use a number for ms (every: 5000) or a duration string (every: '5s').`,
                context: { heartbeat: contextName, every: value },
            });
        }
        return { kind: 'ms', ms: value };
    }

    if (typeof value !== 'string' || value.length === 0) {
        throw invalidIntervalError(value, contextName);
    }

    // Single-unit duration first. DURATION_RE guarantees at least one
    // digit, so parseInt always yields a non-negative integer; we only
    // need to reject a literal zero here.
    const dur = value.match(DURATION_RE);
    if (dur) {
        const n = parseInt(dur[1], 10);
        if (n <= 0) throw invalidIntervalError(value, contextName);
        return { kind: 'ms', ms: n * DURATION_UNITS[dur[2]] };
    }

    // Standard 5-field cron.
    const fields = value.trim().split(/\s+/);
    if (fields.length === 5) {
        return { kind: 'cron', expr: parseCron(fields, value, contextName), source: value };
    }

    throw invalidIntervalError(value, contextName);
}

function invalidIntervalError(value: unknown, name: string): Error {
    return errors.schema(SchemaCode.INVALID_HEARTBEAT_INTERVAL, {
        message: `heartbeat('${name}'): invalid interval ${JSON.stringify(value)}.`,
        hint:
            `Supported forms:\n` +
            `  - milliseconds as a number: 5000\n` +
            `  - single-unit duration: '500ms', '30s', '5m', '1h', '1d'\n` +
            `  - standard 5-field cron (UTC): '0 */5 * * *'\n\n` +
            `Combined durations ('1h30m'), timezones, and seconds-first cron are not supported in v1.`,
        context: { heartbeat: name, every: value },
    });
}

// ── Cron parsing ────────────────────────────────────────────────────────────

const CRON_RANGES: Record<keyof ParsedCron, readonly [number, number]> = {
    minute: [0, 59],
    hour: [0, 23],
    dayOfMonth: [1, 31],
    month: [1, 12],
    dayOfWeek: [0, 6],
};

function parseCron(fields: readonly string[], source: string, name: string): ParsedCron {
    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
    return {
        minute: parseCronField(minute, 'minute', source, name),
        hour: parseCronField(hour, 'hour', source, name),
        dayOfMonth: parseCronField(dayOfMonth, 'dayOfMonth', source, name),
        month: parseCronField(month, 'month', source, name),
        dayOfWeek: parseCronField(dayOfWeek, 'dayOfWeek', source, name),
    };
}

function parseCronField(
    field: string,
    fieldName: keyof ParsedCron,
    source: string,
    name: string,
): CronField {
    const [lo, hi] = CRON_RANGES[fieldName];

    if (field === '*') return { kind: 'any' };

    // STEP_RE and NUMBER_RE below both require `\d+`, so parseInt always
    // yields a non-negative integer — only the range checks matter.
    const stepMatch = field.match(STEP_RE);
    if (stepMatch) {
        const n = parseInt(stepMatch[1], 10);
        if (n <= 0 || n > hi - lo + 1) {
            throw cronFieldError(field, fieldName, source, name, `step must be in 1..${hi - lo + 1}`);
        }
        return { kind: 'step', step: n };
    }

    const values: number[] = [];
    for (const part of field.split(',')) {
        const single = part.match(NUMBER_RE);
        if (!single) {
            throw cronFieldError(field, fieldName, source, name,
                `unrecognized token '${part}' (supported: *, N, N,M,..., */N)`);
        }
        const n = parseInt(single[1], 10);
        if (n < lo || n > hi) {
            throw cronFieldError(field, fieldName, source, name, `${n} out of range ${lo}..${hi}`);
        }
        values.push(n);
    }
    if (values.length === 0) throw cronFieldError(field, fieldName, source, name, 'empty field');
    return { kind: 'list', values: Array.from(new Set(values)).sort((a, b) => a - b) };
}

function cronFieldError(
    field: string,
    fieldName: keyof ParsedCron,
    source: string,
    name: string,
    reason: string,
): Error {
    return errors.schema(SchemaCode.INVALID_HEARTBEAT_INTERVAL, {
        message: `heartbeat('${name}'): invalid cron ${fieldName} '${field}' (${reason}).`,
        hint:
            `Expression: ${source}\n` +
            `Supported per-field tokens: *, N, N,M,..., */N (all UTC).`,
        context: { heartbeat: name, every: source, field: fieldName },
    });
}

// ── Schedule computation ────────────────────────────────────────────────────

/**
 * Milliseconds until the next scheduled tick from `nowMs` (wall-clock ms).
 * For 'ms' intervals this is just the interval itself; for 'cron' it walks
 * forward minute-by-minute until every field matches.
 */
export function computeSleepMs(spec: IntervalSpec, nowMs: number): number {
    if (spec.kind === 'ms') return spec.ms;
    return nextCronFireAtMs(spec.expr, nowMs) - nowMs;
}

/**
 * Absolute timestamp (ms since epoch) of the next cron tick at or after
 * `nowMs + 60_000` (strictly in the future, by at least one minute, so we
 * don't refire on the same minute we just matched).
 */
function nextCronFireAtMs(expr: ParsedCron, nowMs: number): number {
    let t = Math.ceil((nowMs + 60_000) / 60_000) * 60_000;
    // Safety cap: walk at most ~400 days forward. Protects against pathological
    // expressions that never match (bug in the parser or an invariant drift).
    const cap = nowMs + 400 * 24 * 60 * 60 * 1000;
    while (t < cap) {
        const d = new Date(t);
        if (
            matchesField(d.getUTCMinutes(), expr.minute, [0, 59]) &&
            matchesField(d.getUTCHours(), expr.hour, [0, 23]) &&
            matchesField(d.getUTCDate(), expr.dayOfMonth, [1, 31]) &&
            matchesField(d.getUTCMonth() + 1, expr.month, [1, 12]) &&
            matchesField(d.getUTCDay(), expr.dayOfWeek, [0, 6])
        ) {
            return t;
        }
        t += 60_000;
    }
    // Unreachable for valid cron expressions within 400 days. Fall back to
    // "now + one minute" rather than throwing from a pure scheduling function.
    return nowMs + 60_000;
}

function matchesField(value: number, field: CronField, range: readonly [number, number]): boolean {
    if (field.kind === 'any') return true;
    if (field.kind === 'list') return field.values.includes(value);
    // step: every N starting from lo.
    const [lo] = range;
    return (value - lo) % field.step === 0;
}
