import type {
    SchemaCodeValue, EntityCodeValue, StoreCodeValue,
    ConnectionCodeValue, HandlerCodeValue, CliCodeValue,
} from './codes.js';
import { HandlerCode } from './codes.js';

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
