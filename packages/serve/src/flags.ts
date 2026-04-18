export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
export type LogFormat = 'json' | 'pretty';

export interface Flags {
    readonly distDir: string;
    readonly port: number;
    readonly host: string;
    readonly logLevel: LogLevel;
    readonly logFormat: LogFormat;
    readonly resolveTimeoutMs: number;
    readonly shutdownDrainMs: number;
    readonly assetsPrefix: string;
    readonly maxBodyBytes: number;
    /** Tri-state: true forces dev-style error bodies, false forces
     *  production "see logs" bodies, null means "inherit from NODE_ENV". */
    readonly devErrors: boolean | null;
}

export const DEFAULT_FLAGS: Flags = Object.freeze({
    distDir: './dist',
    port: 3000,
    host: '0.0.0.0',
    logLevel: 'info',
    logFormat: 'json',
    resolveTimeoutMs: 5000,
    shutdownDrainMs: 15000,
    assetsPrefix: '/assets/',
    maxBodyBytes: 1_048_576,
    devErrors: null,
});

const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'];
const LOG_FORMATS: readonly LogFormat[] = ['json', 'pretty'];

/**
 * Parse argv (excluding node + script) into a validated Flags object.
 *
 * Supports both `--flag value` and `--flag=value` forms. Unknown flags
 * and malformed values throw — no silent fallbacks, the binary should
 * refuse to boot with a misconfigured command line.
 */
export function parseFlags(argv: readonly string[]): Flags {
    let distDir: string | null = null;
    let port = DEFAULT_FLAGS.port;
    let host = DEFAULT_FLAGS.host;
    let logLevel: LogLevel = DEFAULT_FLAGS.logLevel;
    let logFormat: LogFormat = DEFAULT_FLAGS.logFormat;
    let resolveTimeoutMs = DEFAULT_FLAGS.resolveTimeoutMs;
    let shutdownDrainMs = DEFAULT_FLAGS.shutdownDrainMs;
    let assetsPrefix = DEFAULT_FLAGS.assetsPrefix;
    let maxBodyBytes = DEFAULT_FLAGS.maxBodyBytes;
    let devErrors: boolean | null = DEFAULT_FLAGS.devErrors;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (!arg.startsWith('--')) {
            if (distDir !== null) {
                throw new Error(
                    `unexpected positional argument '${arg}' — only one positional (distDir) is allowed`,
                );
            }
            distDir = arg;
            continue;
        }

        const [name, inlineValue] = splitFlag(arg);
        const getValue = (): string => {
            if (inlineValue !== undefined) return inlineValue;
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) {
                throw new Error(`flag ${name} requires a value`);
            }
            i++;
            return next;
        };

        switch (name) {
            case '--port':
                port = parsePort(getValue());
                break;
            case '--host':
                host = getValue();
                break;
            case '--log-level': {
                const v = getValue();
                if (!LOG_LEVELS.includes(v as LogLevel)) {
                    throw new Error(
                        `invalid --log-level '${v}' — must be one of ${LOG_LEVELS.join(', ')}`,
                    );
                }
                logLevel = v as LogLevel;
                break;
            }
            case '--log-format': {
                const v = getValue();
                if (!LOG_FORMATS.includes(v as LogFormat)) {
                    throw new Error(
                        `invalid --log-format '${v}' — must be one of ${LOG_FORMATS.join(', ')}`,
                    );
                }
                logFormat = v as LogFormat;
                break;
            }
            case '--resolve-timeout-ms':
                resolveTimeoutMs = parseNonNegativeInt(getValue(), '--resolve-timeout-ms');
                break;
            case '--shutdown-drain-ms':
                shutdownDrainMs = parseNonNegativeInt(getValue(), '--shutdown-drain-ms');
                break;
            case '--assets-prefix':
                assetsPrefix = getValue();
                break;
            case '--max-body-bytes':
                maxBodyBytes = parseNonNegativeInt(getValue(), '--max-body-bytes');
                break;
            case '--dev-errors':
                // Boolean toggles; no value expected even in --flag=value
                // form (we reject --dev-errors=foo to stay strict).
                if (inlineValue !== undefined) {
                    throw new Error(`${name} does not take a value`);
                }
                devErrors = true;
                break;
            case '--no-dev-errors':
                if (inlineValue !== undefined) {
                    throw new Error(`${name} does not take a value`);
                }
                devErrors = false;
                break;
            default:
                throw new Error(`unknown flag: ${name}`);
        }
    }

    return {
        distDir: distDir ?? DEFAULT_FLAGS.distDir,
        port,
        host,
        logLevel,
        logFormat,
        resolveTimeoutMs,
        shutdownDrainMs,
        assetsPrefix,
        maxBodyBytes,
        devErrors,
    };
}

function splitFlag(arg: string): [string, string | undefined] {
    const eq = arg.indexOf('=');
    if (eq === -1) return [arg, undefined];
    return [arg.slice(0, eq), arg.slice(eq + 1)];
}

function parsePort(raw: string): number {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error(`invalid --port '${raw}' — must be an integer in [1, 65535]`);
    }
    return n;
}

function parseNonNegativeInt(raw: string, flagName: string): number {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
        throw new Error(`invalid ${flagName} '${raw}' — must be a non-negative integer`);
    }
    return n;
}
