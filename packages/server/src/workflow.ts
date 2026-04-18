import * as restate from '@restatedev/restate-sdk';
import { errors, SchemaCode } from '@syncengine/core';
import type { AnyService, RetryConfig, ServicesOf } from '@syncengine/core';
import type { Subscription } from './bus-on.js';
import { getInstalledBusNc, runInBusContext } from './bus-context.js';

/** Restate's WorkflowContext augmented with the framework-injected
 *  `services` bag. `TServices` is the tuple the user passed to
 *  `defineWorkflow({ services: [...] }, ...)`; `ServicesOf` maps it to
 *  `{ [$name]: ServicePort<T> }`. The empty-tuple default is what
 *  non-hex workflows see (just the Restate primitives). */
export type WorkflowCtx<TServices extends readonly AnyService[] = readonly []> =
    restate.WorkflowContext & { readonly services: ServicesOf<TServices> };

export interface WorkflowOptions<
    TInput = unknown,
    TServices extends readonly AnyService[] = readonly AnyService[],
> {
    readonly services?: TServices;
    /** When set, this workflow is a bus subscriber. The server
     *  bootstrap spawns a `BusDispatcher` per subscriber at load
     *  time; messages flow → filter → Restate invocation with
     *  invocation id derived from `<bus>:<seq>`. See
     *  @syncengine/gateway-core BusDispatcher. */
    readonly on?: Subscription<TInput>;
    /** Per-subscriber retry override. Applies only when `on` is set
     *  (non-subscriber workflows have Restate's own invocation
     *  retry semantics and don't consult this field). Falls back to
     *  the BusManager's default retry when absent. */
    readonly retry?: RetryConfig;
}

export interface WorkflowDef<TName extends string = string, TInput = unknown> {
    readonly $tag: 'workflow';
    readonly $name: TName;
    readonly $handler: (ctx: restate.WorkflowContext, input: TInput) => Promise<void>;
    readonly $services: readonly AnyService[];
    /** Present iff the workflow was declared with `{ on: on(bus) }`. */
    readonly $subscription?: Subscription<TInput>;
    /** Present iff the workflow was declared with `{ retry: ... }`.
     *  `BusManager.spawnOne` reads this before falling back to the
     *  manager's default retry. */
    readonly $retry?: RetryConfig;
}

/** Narrowing guard for subscriber workflows. */
export function isBusSubscriberWorkflow(
    wf: WorkflowDef,
): wf is WorkflowDef & { $subscription: Subscription<unknown> } {
    return wf.$subscription !== undefined;
}

export function isWorkflow(value: unknown): value is WorkflowDef {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as Record<string, unknown>).$tag === 'workflow'
    );
}

export const WORKFLOW_OBJECT_PREFIX = 'workflow_';

export function defineWorkflow<
    const TName extends string,
    TInput,
    const TServices extends readonly AnyService[] = readonly [],
>(
    name: TName,
    options: WorkflowOptions<TInput, TServices>,
    handler: (ctx: WorkflowCtx<TServices>, input: TInput) => Promise<void>,
): WorkflowDef<TName, TInput>;
export function defineWorkflow<const TName extends string, TInput>(
    name: TName,
    handler: (ctx: WorkflowCtx, input: TInput) => Promise<void>,
): WorkflowDef<TName, TInput>;
export function defineWorkflow<const TName extends string, TInput>(
    name: TName,
    optionsOrHandler: WorkflowOptions<TInput> | ((ctx: WorkflowCtx, input: TInput) => Promise<void>),
    maybeHandler?: (ctx: WorkflowCtx, input: TInput) => Promise<void>,
): WorkflowDef<TName, TInput> {
    if (!name || typeof name !== 'string') {
        throw errors.schema(SchemaCode.INVALID_WORKFLOW_NAME, {
            message: `defineWorkflow: name must be a non-empty string.`,
            hint: `Pass a valid name: defineWorkflow('myWorkflow', { ... })`,
        });
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
        throw errors.schema(SchemaCode.INVALID_WORKFLOW_NAME, {
            message: `defineWorkflow('${name}'): name must match /^[a-zA-Z][a-zA-Z0-9_]*$/.`,
            hint: `Use only letters, numbers, and underscores. Must start with a letter.`,
            context: { workflow: name },
        });
    }

    let handler: (ctx: WorkflowCtx, input: TInput) => Promise<void>;
    let services: readonly AnyService[] = [];
    let subscription: Subscription<TInput> | undefined;
    let retry: RetryConfig | undefined;

    if (typeof optionsOrHandler === 'function') {
        handler = optionsOrHandler;
    } else {
        services = optionsOrHandler.services ?? [];
        subscription = optionsOrHandler.on;
        retry = optionsOrHandler.retry;
        handler = maybeHandler!;
    }

    // $handler's storage type is Restate's bare WorkflowContext — that's
    // what Restate invokes us with. The services bag is attached by
    // wrapWorkflowHandler just before the user handler runs, so the cast
    // here crosses exactly one boundary and narrows again inside the
    // wrapper.
    return {
        $tag: 'workflow',
        $name: name,
        $handler: handler as (ctx: restate.WorkflowContext, input: TInput) => Promise<void>,
        $services: services,
        ...(subscription ? { $subscription: subscription } : {}),
        ...(retry ? { $retry: retry } : {}),
    };
}

export type ResolvedServices = Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;

/** Wrap a user workflow handler with two framework concerns:
 *    1. `ctx.services` injection — the resolved hex-adapter port bag
 *       matching the workflow's declared `services: [...]`.
 *    2. `BusContext` ALS frame — so imperative `bus.publish(ctx, ...)`
 *       inside the handler has a workspace id + NATS handle to publish
 *       through without the user threading either explicitly.
 *
 *  The ALS frame is only established when a module-level NATS handle
 *  was registered via `installBusPublisher(nc)`; unit tests that
 *  don't install a publisher simply run the handler directly (same as
 *  pre-2a behaviour), and tests that exercise publishing wrap
 *  manually in `runInBusContext`.
 *
 *  Exported so unit tests can exercise the injection path without the
 *  Restate SDK's opaque `workflow()` wrapper. */
export function wrapWorkflowHandler<TInput>(
    userHandler: (ctx: restate.WorkflowContext, input: TInput) => Promise<void>,
    services: ResolvedServices,
): (ctx: restate.WorkflowContext, input: TInput) => Promise<void> {
    return async (ctx, input) => {
        (ctx as unknown as { services: ResolvedServices }).services = services;
        const nc = getInstalledBusNc();
        if (!nc) {
            await userHandler(ctx, input);
            return;
        }
        // Subscriber workflows are keyed `${workspaceId}/${invocationId}`
        // (see BusDispatcher.postToRestate), so the workspace id is the
        // slice before the first '/'. Non-subscriber workflows still
        // receive a workspace-scoped key through `workflow.start`.
        const key = (ctx as unknown as { key?: string }).key ?? '';
        const workspaceId = key.split('/')[0] || 'default';
        await runInBusContext({ workspaceId, nc }, () => userHandler(ctx, input));
    };
}

export function buildWorkflowObject(
    def: WorkflowDef,
    services?: ResolvedServices,
): ReturnType<typeof restate.workflow> {
    // Services are resolved once per workflow DEFINITION at bind time
    // (server boot), not per invocation. That matches the hex adapter
    // pattern — a port is a pure method bag; replaying the same
    // handler against the same services is deterministic from the
    // Restate journal's perspective.
    const wrapped = wrapWorkflowHandler(def.$handler, services ?? {});
    return restate.workflow({
        name: `${WORKFLOW_OBJECT_PREFIX}${def.$name}`,
        handlers: {
            run: wrapped,
        },
    });
}
