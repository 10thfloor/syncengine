export { SyncEngineError, UserHandlerError } from './error.js';
export type { ErrorCategory, ErrorSeverity, SyncEngineErrorInit } from './error.js';
export {
    SchemaCode, EntityCode, StoreCode,
    ConnectionCode, HandlerCode, CliCode,
} from './codes.js';
export type {
    SchemaCodeValue, EntityCodeValue, StoreCodeValue,
    ConnectionCodeValue, HandlerCodeValue, CliCodeValue,
} from './codes.js';
export { errors } from './factory.js';
export type { ErrorOpts } from './factory.js';
export { formatError } from './format.js';
