import type { LogLevel, LogFormat } from './flags.ts';

export interface LoggerOptions {
    readonly level: LogLevel;
    readonly format: LogFormat;
    /** Write sink. Defaults to writing to stdout. */
    readonly write?: (line: string) => void;
}

export type LogFields = Record<string, unknown>;

export interface Logger {
    debug(fields: LogFields): void;
    info(fields: LogFields): void;
    warn(fields: LogFields): void;
    error(fields: LogFields): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
};

/**
 * Minimal structured logger.
 *   - JSON format: one `JSON.stringify`d object per line.
 *   - Pretty format: a human row (timestamp · level · event · key=val).
 *
 * Respects the configured level floor — lines below the threshold are
 * dropped without the work of formatting them.
 *
 * No external deps (pino, winston, etc). The serve binary is a single
 * compiled file; pulling in a logging framework would add megabytes of
 * binary size for functionality we don't need.
 */
export function createLogger(opts: LoggerOptions): Logger {
    const threshold = LEVEL_ORDER[opts.level];
    const write = opts.write ?? ((line: string) => process.stdout.write(line + '\n'));
    const emit = opts.format === 'pretty' ? emitPretty : emitJson;

    function at(level: LogLevel, fields: LogFields): void {
        if (LEVEL_ORDER[level] > threshold) return;
        write(emit(level, fields));
    }

    return {
        debug(fields) { at('debug', fields); },
        info(fields) { at('info', fields); },
        warn(fields) { at('warn', fields); },
        error(fields) { at('error', fields); },
    };
}

function emitJson(level: LogLevel, fields: LogFields): string {
    return JSON.stringify({
        ts: new Date().toISOString(),
        level,
        ...fields,
    });
}

// ── Pretty formatter ───────────────────────────────────────────────────────

const LEVEL_COLOR: Record<LogLevel, string> = {
    error: '\x1b[31m',
    warn: '\x1b[33m',
    info: '\x1b[36m',
    debug: '\x1b[2m',
};
const RESET = '\x1b[0m';

function emitPretty(level: LogLevel, fields: LogFields): string {
    const { event, ...rest } = fields;
    const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    const parts: string[] = [];
    for (const [k, v] of Object.entries(rest)) {
        if (v === undefined) continue;
        parts.push(`${k}=${formatValue(v)}`);
    }
    const body = parts.length > 0 ? ' ' + parts.join(' ') : '';
    return `${ts} ${LEVEL_COLOR[level]}${level}${RESET} ${event ?? ''}${body}`;
}

function formatValue(v: unknown): string {
    if (typeof v === 'string') {
        return /\s/.test(v) ? JSON.stringify(v) : v;
    }
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}
