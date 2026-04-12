import * as restate from '@restatedev/restate-sdk';

export interface WorkflowDef<TName extends string = string, TInput = unknown> {
    readonly $tag: 'workflow';
    readonly $name: TName;
    readonly $handler: (ctx: restate.WorkflowContext, input: TInput) => Promise<void>;
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
    handler: (ctx: restate.WorkflowContext, input: TInput) => Promise<void>,
): WorkflowDef<TName, TInput> {
    if (!name || typeof name !== 'string') {
        throw new Error('defineWorkflow: name must be a non-empty string.');
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
        throw new Error(
            `defineWorkflow('${name}'): name must match /^[a-zA-Z][a-zA-Z0-9_]*$/.`,
        );
    }
    return { $tag: 'workflow', $name: name, $handler: handler };
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
