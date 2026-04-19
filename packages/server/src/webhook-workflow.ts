// ── Webhook workflow compiler ───────────────────────────────────────────────
//
// Each .webhook.ts file produces one WebhookDef. This module wraps
// the handler in a Restate workflow so the webhook inherits durable
// execution + idempotency dedup via Restate's workflow-per-key model.
//
// The HTTP layer (dev middleware + production server) parses the
// incoming POST, verifies the signature, then POSTs to this workflow
// with `idempotencyKey` as the workflow key.

import * as restate from '@restatedev/restate-sdk';
import { instrument } from '@syncengine/observe';
import type { WebhookDef, WebhookContext } from './webhook.js';
import { WEBHOOK_WORKFLOW_PREFIX } from './webhook.js';

export interface WebhookInvocation {
    readonly workspace: string;
    readonly idempotencyKey: string;
    readonly payload: unknown;
    readonly headers: Record<string, string>;
}

export function buildWebhookWorkflow(
    def: WebhookDef,
    services?: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>,
): ReturnType<typeof restate.workflow> {
    const resolvedServices = services ?? {};
    return restate.workflow({
        name: `${WEBHOOK_WORKFLOW_PREFIX}${def.$name}`,
        handlers: {
            run: async (ctx: restate.WorkflowContext, input: WebhookInvocation) => {
                // input.headers carries the inbound W3C traceparent that
                // webhook-http stamped before posting to Restate. Extract
                // it so the handler's span nests under the inbound span.
                const inboundHeaders = new Map(Object.entries(input.headers));
                await instrument.withRemoteParent(inboundHeaders, () =>
                    instrument.webhookRun(
                        {
                            name: def.$name,
                            workspace: input.workspace,
                            idempotencyKey: input.idempotencyKey,
                        },
                        async () => {
                            const hbCtx = buildWebhookContext(ctx, def, input);
                            (hbCtx as unknown as { services: typeof resolvedServices }).services = resolvedServices;
                            await def.$handler(hbCtx, input.payload);
                        },
                    ),
                );
            },
        },
    });
}

function buildWebhookContext(
    ctx: restate.WorkflowContext,
    def: WebhookDef,
    input: WebhookInvocation,
): WebhookContext {
    const headers = new Map<string, string>(
        Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const meta = {
        name: def.$name,
        idempotencyKey: input.idempotencyKey,
        workspace: input.workspace,
        headers: headers as ReadonlyMap<string, string>,
    } as const;
    // Forwarding Proxy so Restate's ctx.sleep / ctx.run / ctx.date etc.
    // reach the user handler unchanged, regardless of whether the SDK
    // implements the context as a plain object or a Proxy. Mirrors the
    // pattern used in heartbeat-workflow.ts.
    return new Proxy(ctx, {
        get(target, prop) {
            if (prop in meta) return meta[prop as keyof typeof meta];
            const value = (target as unknown as Record<PropertyKey, unknown>)[prop as PropertyKey];
            return typeof value === 'function'
                ? (value as (...args: unknown[]) => unknown).bind(target)
                : value;
        },
        has(target, prop) {
            return prop in meta || prop in (target as object);
        },
    }) as unknown as WebhookContext;
}
