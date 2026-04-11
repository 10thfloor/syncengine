import { SyncEngineError, UserHandlerError } from './error.js';
import type { ErrorSeverity } from './error.js';
import type {
    SchemaCodeValue, EntityCodeValue, StoreCodeValue,
    ConnectionCodeValue, HandlerCodeValue, CliCodeValue,
} from './codes.js';
import { HandlerCode } from './codes.js';

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

// USER_HANDLER_ERROR requires a `cause` — enforced via an overloaded signature so
// the factory can't silently downgrade to a non-UserHandlerError SyncEngineError.
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
