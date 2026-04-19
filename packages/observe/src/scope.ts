// Observe scope — AsyncLocalStorage-carried context that declared
// metrics use to auto-tag workspace / user / primitive / name.
//
// The seam helpers (entityEffect, busPublish, webhookRun, heartbeatTick,
// etc.) call `runInScope` on the same fn they wrap in `startActiveSpan`,
// so every metric call inside the handler sees the same scope as the
// enclosing span. User code never touches this — `metric.counter(...)`
// calls `currentScope()` lazily on every add/observe/record.
//
// NodeSDK installs AsyncHooksContextManager for OTel's own context
// propagation; our ALS frame lives in the same async chain so the
// two stay in sync across awaits, promises, and `ctx.run` boundaries.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Primitive } from './semantic';

export interface ObserveScope {
    readonly workspace?: string;
    readonly user?: string;
    readonly primitive?: Primitive;
    readonly name?: string;
}

const SCOPE = new AsyncLocalStorage<ObserveScope>();

/** Run `fn` with `scope` installed as the current observe scope.
 *  Nested runs override outer ones — inner scopes win for metrics
 *  called deep in a handler. */
export function runInScope<T>(
    scope: ObserveScope,
    fn: () => Promise<T> | T,
): Promise<T> {
    // Always return a Promise so callers can await uniformly regardless
    // of fn's sync/async shape.
    return Promise.resolve(SCOPE.run(scope, fn));
}

/** Read the active scope, if any. Called by `metric.ts` on every
 *  add/observe/record so declared metrics auto-tag with no explicit
 *  ctx plumbing. */
export function currentScope(): ObserveScope | undefined {
    return SCOPE.getStore();
}
