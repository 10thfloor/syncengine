import * as restate from '@restatedev/restate-sdk';
import { errors, SchemaCode } from '@syncengine/core';
import type { AnyService } from '@syncengine/core';
import type { Subscription } from './bus-on.js';

export interface WorkflowOptions<TInput = unknown> {
    readonly services?: readonly AnyService[];
    /** When set, this workflow is a bus subscriber. The server
     *  bootstrap spawns a `BusDispatcher` per subscriber at load
     *  time; messages flow → filter → Restate invocation with
     *  invocation id derived from `<bus>:<seq>`. See
     *  @syncengine/gateway-core BusDispatcher. */
    readonly on?: Subscription<TInput>;
}

export interface WorkflowDef<TName extends string = string, TInput = unknown> {
    readonly $tag: 'workflow';
    readonly $name: TName;
    readonly $handler: (ctx: restate.WorkflowContext, input: TInput) => Promise<void>;
    readonly $services: readonly AnyService[];
    /** Present iff the workflow was declared with `{ on: on(bus) }`. */
    readonly $subscription?: Subscription<TInput>;
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

    if (typeof optionsOrHandler === 'function') {
        handler = optionsOrHandler;
    } else {
        services = optionsOrHandler.services ?? [];
        subscription = optionsOrHandler.on;
        handler = maybeHandler!;
    }

    return {
        $tag: 'workflow',
        $name: name,
        $handler: handler,
        $services: services,
        ...(subscription ? { $subscription: subscription } : {}),
    };
}

export function buildWorkflowObject(def: WorkflowDef): ReturnType<typeof restate.workflow> {
    return restate.workflow({
        name: `${WORKFLOW_OBJECT_PREFIX}${def.$name}`,
        handlers: {
            run: async (ctx: restate.WorkflowContext, input: unknown) => {
                await def.$handler(ctx, input);
            },
        },
    });
}
