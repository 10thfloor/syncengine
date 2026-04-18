// ── Webhook registry ────────────────────────────────────────────────────────
//
// Module-level registry of webhook definitions, populated at endpoint
// startup by `startRestateEndpoint`. The HTTP layer (production server
// and Vite dev middleware) reads it to match incoming `/webhooks/...`
// requests to the corresponding WebhookDef.
//
// Same scope reasoning as heartbeat-registry: single process, consistent
// across replicas because every replica loads the same source tree.

import type { WebhookDef } from './webhook.js';

let registered: readonly WebhookDef[] = [];

export function registerWebhooks(defs: readonly WebhookDef[]): void {
    registered = defs;
}

export function getRegisteredWebhooks(): readonly WebhookDef[] {
    return registered;
}
