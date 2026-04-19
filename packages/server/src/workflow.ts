import * as restate from '@restatedev/restate-sdk';
import { errors, SchemaCode } from '@syncengine/core';
import type { AnyService, RetryConfig } from '@syncengine/core';
import type { Subscription } from './bus-on.js';

export interface WorkflowOptions<TInput = unknown> {
    readonly services?: readonly AnyService[];
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

export function defineWorkflow<const TName extends string, TInput>(
    name: TName,
    options: WorkflowOptions<TInput>,
    handler: (ctx: restate.WorkflowContext, input: TInput) => Promise<void>,
): WorkflowDef<TName, TInput>;
export function defineWorkflow<const TName extends string, TInput>(
    name: TName,
    handler: (ctx: restate.WorkflowContext, input: TInput) => Promise<void>,
): WorkflowDef<TName, TInput>;
export function defineWorkflow<const TName extends string, TInput>(
    name: TName,
    optionsOrHandler: WorkflowOptions<TInput> | ((ctx: restate.WorkflowContext, input: TInput) => Promise<void>),
    maybeHandler?: (ctx: restate.WorkflowContext, input: TInput) => Promise<void>,
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

    let handler: (ctx: restate.WorkflowContext, input: TInput) => Promise<void>;
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

    return {
        $tag: 'workflow',
        $name: name,
        $handler: handler,
        $services: services,
        ...(subscription ? { $subscription: subscription } : {}),
        ...(retry ? { $retry: retry } : {}),
    };
}

export type ResolvedServices = Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;

/** Wrap a user workflow handler with `ctx.services` injection. Exported
 *  so unit tests can exercise the injection without the Restate SDK's
 *  opaque workflow() wrapper. */
export function wrapWorkflowHandler<TInput>(
    userHandler: (ctx: restate.WorkflowContext, input: TInput) => Promise<void>,
    services: ResolvedServices,
): (ctx: restate.WorkflowContext, input: TInput) => Promise<void> {
    return async (ctx, input) => {
        (ctx as unknown as { services: ResolvedServices }).services = services;
        await userHandler(ctx, input);
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
