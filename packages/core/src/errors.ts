// ── Platform error system ──────────────────────────────────────────────────
//
// Single-file module so Node's native ESM resolver (used by Vite's config
// loader for externalized workspace packages, among other callers) can
// resolve `@syncengine/core` → `./src/index.ts` → `./errors` without
// tripping over a directory-index lookup that native ESM doesn't do.
//
// One-way conversation from the framework to the developer: "this is what
// syncengine broke, this is how to fix it." Not for user code — user domain
// errors use `EntityError` in ./entity.ts, which is intentionally separate.

// ── Code registries ────────────────────────────────────────────────────────

export const SchemaCode = Object.freeze({
    MISSING_PRIMARY_KEY: 'MISSING_PRIMARY_KEY',
    RESERVED_COLUMN_PREFIX: 'RESERVED_COLUMN_PREFIX',
    INVALID_TABLE_NAME: 'INVALID_TABLE_NAME',
    DUPLICATE_TABLE_NAME: 'DUPLICATE_TABLE_NAME',
    DUPLICATE_VIEW_ID: 'DUPLICATE_VIEW_ID',
    DUPLICATE_CHANNEL_NAME: 'DUPLICATE_CHANNEL_NAME',
    VIEW_TABLE_NOT_FOUND: 'VIEW_TABLE_NOT_FOUND',
    CHANNEL_TABLE_NOT_FOUND: 'CHANNEL_TABLE_NOT_FOUND',
    INVALID_COLUMN_NAME: 'INVALID_COLUMN_NAME',
    INVALID_SQL_IDENTIFIER: 'INVALID_SQL_IDENTIFIER',
    INVALID_ENTITY_NAME: 'INVALID_ENTITY_NAME',
    INVALID_TOPIC_NAME: 'INVALID_TOPIC_NAME',
    INVALID_WORKFLOW_NAME: 'INVALID_WORKFLOW_NAME',
    INVALID_HEARTBEAT_NAME: 'INVALID_HEARTBEAT_NAME',
    INVALID_HEARTBEAT_INTERVAL: 'INVALID_HEARTBEAT_INTERVAL',
    INVALID_HEARTBEAT_CONFIG: 'INVALID_HEARTBEAT_CONFIG',
    DUPLICATE_HEARTBEAT_NAME: 'DUPLICATE_HEARTBEAT_NAME',
    INVALID_WEBHOOK_NAME: 'INVALID_WEBHOOK_NAME',
    INVALID_WEBHOOK_CONFIG: 'INVALID_WEBHOOK_CONFIG',
    DUPLICATE_WEBHOOK_NAME: 'DUPLICATE_WEBHOOK_NAME',
    DUPLICATE_WEBHOOK_PATH: 'DUPLICATE_WEBHOOK_PATH',
    INVALID_SERVICE_NAME: 'INVALID_SERVICE_NAME',
    INVALID_SERVICE_CONFIG: 'INVALID_SERVICE_CONFIG',
    DUPLICATE_SERVICE_NAME: 'DUPLICATE_SERVICE_NAME',
    INVALID_BUS_NAME: 'INVALID_BUS_NAME',
    DUPLICATE_BUS_NAME: 'DUPLICATE_BUS_NAME',
    INVALID_VALUE_NAME: 'INVALID_VALUE_NAME',
    INVALID_VALUE: 'INVALID_VALUE',
    HANDLER_NAME_RESERVED: 'HANDLER_NAME_RESERVED',
    HANDLER_NAME_INVALID: 'HANDLER_NAME_INVALID',
    HANDLER_NOT_FUNCTION: 'HANDLER_NOT_FUNCTION',
    STATE_FIELD_COLLISION: 'STATE_FIELD_COLLISION',
    TRANSITION_NOT_EXHAUSTIVE: 'TRANSITION_NOT_EXHAUSTIVE',
    TRANSITION_AMBIGUOUS: 'TRANSITION_AMBIGUOUS',
    TRANSITION_NO_MATCH: 'TRANSITION_NO_MATCH',
    UNKNOWN_MIGRATION_OP: 'UNKNOWN_MIGRATION_OP',
    CONFIG_LOAD_FAILED: 'CONFIG_LOAD_FAILED',
    CONFIG_NO_DEFAULT_EXPORT: 'CONFIG_NO_DEFAULT_EXPORT',
    NOT_ENTITY_DEFINITION: 'NOT_ENTITY_DEFINITION',
} as const);

export type SchemaCodeValue = typeof SchemaCode[keyof typeof SchemaCode];

export const EntityCode = Object.freeze({
    INVALID_TRANSITION: 'INVALID_TRANSITION',
    MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
    TYPE_MISMATCH: 'TYPE_MISMATCH',
    ENUM_VIOLATION: 'ENUM_VIOLATION',
} as const);

export type EntityCodeValue = typeof EntityCode[keyof typeof EntityCode];

export const StoreCode = Object.freeze({
    INVALID_SEED_KEY: 'INVALID_SEED_KEY',
    INVALID_WORKSPACE_FORMAT: 'INVALID_WORKSPACE_FORMAT',
    INVALID_ENTITY_KEY: 'INVALID_ENTITY_KEY',
    WORKSPACE_NOT_ACTIVE: 'WORKSPACE_NOT_ACTIVE',
    RESET_DISABLED: 'RESET_DISABLED',
    TEST_STORE_ROW_NOT_FOUND: 'TEST_STORE_ROW_NOT_FOUND',
    TEST_STORE_UNKNOWN_TABLE: 'TEST_STORE_UNKNOWN_TABLE',
} as const);

export type StoreCodeValue = typeof StoreCode[keyof typeof StoreCode];

export const ConnectionCode = Object.freeze({
    NATS_UNREACHABLE: 'NATS_UNREACHABLE',
    RESTATE_UNREACHABLE: 'RESTATE_UNREACHABLE',
    AUTH_FAILED: 'AUTH_FAILED',
    WORKER_CRASHED: 'WORKER_CRASHED',
    HTTP_ERROR: 'HTTP_ERROR',
    MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
} as const);

export type ConnectionCodeValue = typeof ConnectionCode[keyof typeof ConnectionCode];

export const HandlerCode = Object.freeze({
    USER_HANDLER_ERROR: 'USER_HANDLER_ERROR',
    HANDLER_NOT_FOUND: 'HANDLER_NOT_FOUND',
    WORKFLOW_FAILED: 'WORKFLOW_FAILED',
} as const);

export type HandlerCodeValue = typeof HandlerCode[keyof typeof HandlerCode];

export const CliCode = Object.freeze({
    STACK_NOT_RUNNING: 'STACK_NOT_RUNNING',
    STACK_ALREADY_RUNNING: 'STACK_ALREADY_RUNNING',
    PORT_CONFLICT: 'PORT_CONFLICT',
    APP_DIR_NOT_FOUND: 'APP_DIR_NOT_FOUND',
    DEPENDENCY_NOT_FOUND: 'DEPENDENCY_NOT_FOUND',
    BUILD_OUTPUT_MISSING: 'BUILD_OUTPUT_MISSING',
    DIRECTORY_NOT_EMPTY: 'DIRECTORY_NOT_EMPTY',
    FRESH_REFUSED: 'FRESH_REFUSED',
    TIMEOUT: 'TIMEOUT',
    ENV_MISSING: 'ENV_MISSING',
    UNSUPPORTED_PLATFORM: 'UNSUPPORTED_PLATFORM',
    CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH',
    UNSUPPORTED_ARCHIVE: 'UNSUPPORTED_ARCHIVE',
    BINARY_NOT_FOUND: 'BINARY_NOT_FOUND',
    PROVIDER_MISSING: 'PROVIDER_MISSING',
    RESOLVE_FAILED: 'RESOLVE_FAILED',
    RESOLVE_TIMEOUT: 'RESOLVE_TIMEOUT',
    NATIVE_IMPORT_REJECTED: 'NATIVE_IMPORT_REJECTED',
} as const);

export type CliCodeValue = typeof CliCode[keyof typeof CliCode];

// ── Error classes ──────────────────────────────────────────────────────────

export type ErrorCategory = 'schema' | 'entity' | 'store' | 'connection' | 'handler' | 'cli';
export type ErrorSeverity = 'fatal' | 'warning' | 'info';

type AnyCode =
    | SchemaCodeValue | EntityCodeValue | StoreCodeValue
    | ConnectionCodeValue | HandlerCodeValue | CliCodeValue;

export interface SyncEngineErrorInit {
    code: AnyCode;
    category: ErrorCategory;
    severity: ErrorSeverity;
    message: string;
    hint?: string;
    context?: Record<string, unknown>;
    cause?: Error;
}

export class SyncEngineError extends Error {
    readonly code: AnyCode;
    readonly category: ErrorCategory;
    readonly severity: ErrorSeverity;
    readonly hint?: string;
    readonly context: Record<string, unknown>;

    constructor(init: SyncEngineErrorInit) {
        super(init.message, { cause: init.cause });
        this.name = 'SyncEngineError';
        this.code = init.code;
        this.category = init.category;
        this.severity = init.severity;
        this.hint = init.hint;
        this.context = init.context ?? {};
    }
}

export interface UserHandlerErrorInit {
    message: string;
    context?: Record<string, unknown>;
    cause: Error;
}

export class UserHandlerError extends SyncEngineError {
    constructor(init: UserHandlerErrorInit) {
        super({
            code: HandlerCode.USER_HANDLER_ERROR,
            category: 'handler',
            severity: 'fatal',
            message: init.message,
            context: init.context ?? {},
            cause: init.cause,
        });
        this.name = 'UserHandlerError';
    }
}

// ── Factory ────────────────────────────────────────────────────────────────

export interface ErrorOpts {
    message: string;
    hint?: string;
    context?: Record<string, unknown>;
    cause?: Error;
    severity?: ErrorSeverity;
}

function make(
    code: string,
    category: SyncEngineError['category'],
    defaultSeverity: ErrorSeverity,
    opts: ErrorOpts,
): SyncEngineError {
    return new SyncEngineError({
        code: code as SyncEngineError['code'],
        category,
        severity: opts.severity ?? defaultSeverity,
        message: opts.message,
        hint: opts.hint,
        context: opts.context,
        cause: opts.cause,
    });
}

// USER_HANDLER_ERROR requires a `cause` — enforced via an overloaded
// signature so the factory can't silently downgrade to a non-UserHandlerError
// SyncEngineError.
interface HandlerFactory {
    (code: typeof HandlerCode.USER_HANDLER_ERROR, opts: ErrorOpts & { cause: Error }): UserHandlerError;
    (code: Exclude<HandlerCodeValue, typeof HandlerCode.USER_HANDLER_ERROR>, opts: ErrorOpts): SyncEngineError;
}

const handler: HandlerFactory = ((code: HandlerCodeValue, opts: ErrorOpts & { cause?: Error }) => {
    if (code === HandlerCode.USER_HANDLER_ERROR) {
        return new UserHandlerError({
            message: opts.message,
            context: opts.context,
            cause: opts.cause as Error,
        });
    }
    return make(code, 'handler', 'fatal', opts);
}) as HandlerFactory;

export const errors = {
    schema(code: SchemaCodeValue, opts: ErrorOpts): SyncEngineError {
        return make(code, 'schema', 'fatal', opts);
    },
    entity(code: EntityCodeValue, opts: ErrorOpts): SyncEngineError {
        return make(code, 'entity', 'fatal', opts);
    },
    store(code: StoreCodeValue, opts: ErrorOpts): SyncEngineError {
        return make(code, 'store', 'fatal', opts);
    },
    connection(code: ConnectionCodeValue, opts: ErrorOpts): SyncEngineError {
        return make(code, 'connection', 'warning', opts);
    },
    handler,
    cli(code: CliCodeValue, opts: ErrorOpts): SyncEngineError {
        return make(code, 'cli', 'fatal', opts);
    },
};

// ── Console renderer ───────────────────────────────────────────────────────

interface FormatOpts {
    color?: boolean;
}

const SEVERITY_ICONS = { fatal: '✘', warning: '⚠', info: 'ℹ' } as const;

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function wrap(text: string, code: string, color: boolean): string {
    return color ? `${code}${text}${RESET}` : text;
}

function severityColor(severity: SyncEngineError['severity']): string {
    if (severity === 'fatal') return RED;
    if (severity === 'warning') return YELLOW;
    return DIM;
}

interface ParsedFrame {
    raw: string;
    path: string;
    isUserCode: boolean;
}

function parseStack(stack: string | undefined): ParsedFrame[] {
    if (!stack) return [];
    return stack
        .split('\n')
        .slice(1)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('at '))
        .map((raw) => {
            // Non-greedy + end-anchored so "at foo (bar) (path)" (rare)
            // captures the final parenthesized group, not everything between
            // the first and last paren.
            const match = raw.match(/\(([^)]+)\)$/) ?? raw.match(/at (.+)$/);
            const path = match?.[1] ?? raw;
            const isUserCode =
                !path.includes('node_modules') && !path.startsWith('node:');
            return { raw, path, isUserCode };
        });
}

function formatStack(frames: ParsedFrame[], color: boolean): string[] {
    const lines: string[] = [];
    let collapsedSyncEngine = 0;
    let collapsedOther = 0;
    let firstUserFrame = true;

    function flushCollapsed() {
        if (collapsedSyncEngine > 0) {
            lines.push(
                `   ${wrap(`┄ (${collapsedSyncEngine} syncengine internals hidden)`, DIM, color)}`,
            );
            collapsedSyncEngine = 0;
        }
        if (collapsedOther > 0) {
            lines.push(
                `   ${wrap(`┄ (${collapsedOther} internals hidden)`, DIM, color)}`,
            );
            collapsedOther = 0;
        }
    }

    for (const frame of frames) {
        if (frame.isUserCode) {
            flushCollapsed();
            const prefix = firstUserFrame ? '→' : ' ';
            firstUserFrame = false;
            lines.push(`   ${prefix} ${frame.path}`);
        } else if (frame.path.includes('@syncengine')) {
            collapsedSyncEngine++;
        } else {
            collapsedOther++;
        }
    }

    flushCollapsed();
    return lines;
}

export function formatError(error: Error, opts: FormatOpts = {}): string {
    const color = opts.color ?? true;

    if (!(error instanceof SyncEngineError)) {
        return `${wrap('✘', RED, color)} ${error.message}`;
    }

    const icon = SEVERITY_ICONS[error.severity];
    const sColor = severityColor(error.severity);
    const lines: string[] = [];

    lines.push(
        ` ${wrap(icon, sColor, color)} ${wrap(`SE::${error.category}`, BOLD, color)} ${wrap(error.code, sColor, color)}`,
    );
    lines.push('');
    lines.push(`   ${error.message}`);

    if (error.hint) {
        lines.push('');
        lines.push(`   ${wrap('hint:', DIM, color)} ${error.hint.split('\n')[0]}`);
        for (const hintLine of error.hint.split('\n').slice(1)) {
            lines.push(`   ${hintLine ? '      ' + hintLine : ''}`);
        }
    }

    const frames = parseStack(error.stack);
    if (frames.length > 0) {
        lines.push('');
        lines.push(...formatStack(frames, color));
    }

    return lines.join('\n');
}
