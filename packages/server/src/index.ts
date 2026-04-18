import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import * as restate from "@restatedev/restate-sdk";
import { errors, SchemaCode } from "@syncengine/core";
import { workspace } from "./workspace/workspace.js";
import { bindEntities, setAuthProvider } from "./entity-runtime.js";
import { isEntity, type AnyEntity, isService, type AnyService, isBus, type BusRef, isChannel, type ChannelConfig } from "@syncengine/core";
import { isWorkflow, isBusSubscriberWorkflow, buildWorkflowObject, type WorkflowDef } from './workflow.js';
import { ServiceContainer } from './service-container.js';
import { isHeartbeat, type HeartbeatDef } from './heartbeat.js';
import { buildHeartbeatWorkflow } from './heartbeat-workflow.js';
import { heartbeatStatus, HEARTBEAT_STATUS_ENTITY_NAME } from '@syncengine/core';
import { registerHeartbeats } from './heartbeat-registry.js';
import { isWebhook, type WebhookDef } from './webhook.js';
import { buildWebhookWorkflow } from './webhook-workflow.js';
import { registerWebhooks } from './webhook-registry.js';

// ── Load user entities (PLAN Phase 4) ────────────────────────────────────
//
// Walk `<appDir>/src` for every `.actor.ts` file and dynamic-import each.
// Any export that passes `isEntity` gets collected.

function walkSourceFiles(srcDir: string): string[] {
    const out: string[] = [];
    if (!existsSync(srcDir)) return out;
    const queue: string[] = [srcDir];
    while (queue.length > 0) {
        const dir = queue.shift()!;
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch {
            continue;
        }
        for (const name of entries) {
            if (name === "node_modules" || name === ".git" || name === "dist") continue;
            const full = join(dir, name);
            let st;
            try {
                st = statSync(full);
            } catch {
                continue;
            }
            if (st.isDirectory()) {
                queue.push(full);
            } else if (st.isFile() && (
                name.endsWith(".actor.ts") ||
                name.endsWith(".workflow.ts") ||
                name.endsWith(".heartbeat.ts") ||
                name.endsWith(".webhook.ts") ||
                name.endsWith(".bus.ts")
            )) {
                out.push(full);
            } else if (
                st.isFile() &&
                name.endsWith(".ts") &&
                !name.startsWith(".") &&
                full.includes("/services/") &&
                !full.includes("/services/test") &&
                !full.includes("/services/staging")
            ) {
                out.push(full);
            }
        }
    }
    return out;
}

/**
 * Walk the app's source tree once and collect entity, workflow, and
 * heartbeat definitions by dynamic-importing each `.actor.ts` /
 * `.workflow.ts` / `.heartbeat.ts` file. Validates framework-reserved
 * entity names and heartbeat-name uniqueness.
 */
export async function loadDefinitions(appDir: string): Promise<{
    entities: AnyEntity[];
    workflows: WorkflowDef[];
    heartbeats: HeartbeatDef[];
    webhooks: WebhookDef[];
    services: AnyService[];
    buses: BusRef<unknown>[];
    channels: ChannelConfig[];
}> {
    const srcDir = resolve(appDir, "src");
    const allFiles = walkSourceFiles(srcDir);
    const entities: AnyEntity[] = [];
    const workflows: WorkflowDef[] = [];
    const heartbeats: HeartbeatDef[] = [];
    const webhooks: WebhookDef[] = [];
    const services: AnyService[] = [];
    const buses: BusRef<unknown>[] = [];
    const channels: ChannelConfig[] = [];
    const channelNameSources = new Map<string, string>();
    const heartbeatSources = new Map<string, string>();
    const webhookNameSources = new Map<string, string>();
    const webhookPathSources = new Map<string, string>();
    const serviceNameSources = new Map<string, string>();
    const busNameSources = new Map<string, string>();

    for (const file of allFiles) {
        try {
            const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
            for (const value of Object.values(mod)) {
                if (isEntity(value)) {
                    if (value.$name === HEARTBEAT_STATUS_ENTITY_NAME) {
                        throw errors.schema(SchemaCode.INVALID_ENTITY_NAME, {
                            message: `Entity name '${HEARTBEAT_STATUS_ENTITY_NAME}' is reserved by the heartbeat primitive.`,
                            hint: `Rename this entity; the framework registers one with this name on your behalf.`,
                            context: { entity: value.$name, file },
                        });
                    }
                    entities.push(value);
                } else if (isWorkflow(value)) {
                    workflows.push(value);
                } else if (isHeartbeat(value)) {
                    const existing = heartbeatSources.get(value.$name);
                    if (existing) {
                        throw errors.schema(SchemaCode.DUPLICATE_HEARTBEAT_NAME, {
                            message: `Duplicate heartbeat name '${value.$name}':\n    ${existing}\n    ${file}`,
                            hint: `Heartbeat names must be unique across the src/ tree because they resolve to single Restate workflow identities.`,
                            context: { heartbeat: value.$name, files: [existing, file] },
                        });
                    }
                    heartbeatSources.set(value.$name, file);
                    heartbeats.push(value);
                } else if (isWebhook(value)) {
                    const existingName = webhookNameSources.get(value.$name);
                    if (existingName) {
                        throw errors.schema(SchemaCode.DUPLICATE_WEBHOOK_NAME, {
                            message: `Duplicate webhook name '${value.$name}':\n    ${existingName}\n    ${file}`,
                            hint: `Webhook names must be unique; each compiles to one Restate workflow identity.`,
                            context: { webhook: value.$name, files: [existingName, file] },
                        });
                    }
                    const existingPath = webhookPathSources.get(value.$path);
                    if (existingPath) {
                        throw errors.schema(SchemaCode.DUPLICATE_WEBHOOK_PATH, {
                            message: `Duplicate webhook path '${value.$path}':\n    ${existingPath}\n    ${file}`,
                            hint: `Each webhook must have a unique path under /webhooks.`,
                            context: { path: value.$path, files: [existingPath, file] },
                        });
                    }
                    webhookNameSources.set(value.$name, file);
                    webhookPathSources.set(value.$path, file);
                    webhooks.push(value);
                } else if (isService(value)) {
                    const existing = serviceNameSources.get(value.$name);
                    if (existing) {
                        throw errors.schema(SchemaCode.DUPLICATE_SERVICE_NAME, {
                            message: `Duplicate service name '${value.$name}':\n    ${existing}\n    ${file}`,
                            hint: `Service names must be unique across the src/ tree.`,
                            context: { service: value.$name, files: [existing, file] },
                        });
                    }
                    serviceNameSources.set(value.$name, file);
                    services.push(value);
                } else if (isBus(value)) {
                    const existing = busNameSources.get(value.$name);
                    if (existing) {
                        throw errors.schema(SchemaCode.DUPLICATE_BUS_NAME, {
                            message: `Duplicate bus name '${value.$name}':\n    ${existing}\n    ${file}`,
                            hint: `Bus names must be unique across the src/ tree.`,
                            context: { bus: value.$name, files: [existing, file] },
                        });
                    }
                    busNameSources.set(value.$name, file);
                    buses.push(value);
                } else if (isChannel(value)) {
                    // Plan 4: discover channel() declarations so the
                    // gateway can authorize subscriptions. Silently dedup
                    // on name — a channel may legitimately be re-exported
                    // from multiple modules.
                    const existing = channelNameSources.get(value.name);
                    if (existing && existing !== file) {
                        // Duplicate from a different file is likely a bug
                        // (two channels with the same name and different
                        // access policies would be ambiguous).
                        console.warn(
                            `[workspace-service] duplicate channel '${value.name}' in ${file} (also defined in ${existing}); using first`,
                        );
                        continue;
                    }
                    if (!existing) {
                        channelNameSources.set(value.name, file);
                        channels.push(value);
                    }
                }
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[workspace-service] failed to load ${file}: ${msg}`);
            throw err;
        }
    }

    // A fresh app legitimately has no entities or heartbeats — suppress
    // the warning. Users hit a concrete error the moment they try to use
    // one that wasn't discovered.

    // Orphan-bus warning: every BusRef without at least one subscriber
    // workflow has its published events piling up in JetStream until
    // retention expires. Usually this means the developer declared a
    // bus() and forgot to defineWorkflow({ on: ... }). Log once per
    // bus so it's visible in `syncengine dev` boot output.
    const subscribedBusNames = new Set<string>();
    for (const wf of workflows) {
        if (isBusSubscriberWorkflow(wf)) {
            subscribedBusNames.add(wf.$subscription.bus.$name);
        }
    }
    for (const b of buses) {
        // DLQ buses are auto-generated and often intentionally
        // unsubscribed; don't nag about them.
        if (b.$name.endsWith('.dlq') || b.$name.endsWith('.dead')) continue;
        if (!subscribedBusNames.has(b.$name)) {
            console.warn(
                `[syncengine] bus('${b.$name}') has no subscribers — ` +
                `events will accumulate on JetStream until the retention window expires. ` +
                `Declare a defineWorkflow({ on: on(${b.$name}), ... }) or remove the bus.`,
            );
        }
    }

    return { entities, workflows, heartbeats, webhooks, services, buses, channels };
}

/**
 * Create a Restate HTTP/2 cleartext endpoint with the workspace handler
 * and all user entities and workflows bound, then start listening.
 *
 * Returns a reference to the endpoint for external callers that need
 * to inspect it (e.g., the CLI's Restate admin registration).
 */
export async function startRestateEndpoint(
    entities: AnyEntity[],
    workflows: WorkflowDef[],
    port: number,
    heartbeats: HeartbeatDef[] = [],
    webhooks: WebhookDef[] = [],
    services: AnyService[] = [],
    serviceOverrides: import('@syncengine/core').AnyServiceOverride[] = [],
    authProvider?: import('@syncengine/core').AuthProvider,
): Promise<void> {
    // Plan 3: install the auth provider so entity-runtime verifies
    // incoming Authorization headers on every handler invocation.
    setAuthProvider(authProvider);

    const endpoint = restate.endpoint().bind(workspace);

    // Framework-owned entities come first so heartbeat workflows can
    // always target them via entityRef.
    const allEntities: AnyEntity[] = [heartbeatStatus, ...entities];
    const bound = bindEntities(endpoint, allEntities);

    // Build the ServiceContainer once at boot so every workflow /
    // heartbeat / webhook invocation sees the same port instances.
    // Overrides flow in from `SyncengineConfig.services.overrides`
    // (loaded by the caller via `loadConfigOverrides`), split from
    // bus overrides by `$tag`.
    const serviceContainer = new ServiceContainer(services, serviceOverrides);
    const resolve = (defs: readonly AnyService[]) =>
        serviceContainer.resolveAll(defs) as Record<
            string,
            Record<string, (...args: unknown[]) => Promise<unknown>>
        >;

    for (const wf of workflows) {
        bound.bind(buildWorkflowObject(wf, resolve(wf.$services)));
    }
    for (const hb of heartbeats) {
        bound.bind(buildHeartbeatWorkflow(hb, resolve(hb.$services)));
    }
    for (const wh of webhooks) {
        bound.bind(buildWebhookWorkflow(wh, resolve(wh.$services)));
    }

    // Make the definition lists available to framework hooks:
    // - heartbeats: workspace.provision fires `trigger: 'boot'`
    // - webhooks: HTTP layer matches incoming /webhooks/... requests
    registerHeartbeats(heartbeats);
    registerWebhooks(webhooks);

    await bound.listen(port);

    console.log(
        `[workspace-service] listening on :${port}` +
        ` (entities: ${allEntities.map((e) => e.$name).join(", ")})` +
        (workflows.length > 0
            ? ` (workflows: ${workflows.map((w) => w.$name).join(", ")})`
            : "") +
        (heartbeats.length > 0
            ? ` (heartbeats: ${heartbeats.map((h) => h.$name).join(", ")})`
            : "") +
        (webhooks.length > 0
            ? ` (webhooks: ${webhooks.map((w) => `${w.$name}@${w.$path}`).join(", ")})`
            : "") +
        (services.length > 0
            ? ` (services: ${services.map((s) => s.$name).join(", ")})`
            : ""),
    );
}

// ── Direct execution (dev mode via tsx watch) ──────────────────────────────
//
// When this file is run directly (`tsx watch src/index.ts`), it reads
// SYNCENGINE_APP_DIR, loads entities, starts the endpoint, and boots the
// bus runtime so dev mode has the same end-to-end publish → subscriber
// pipeline as `syncengine build` + `syncengine start`. In production the
// build system generates an entry that mirrors this wiring.

const appDir = process.env.SYNCENGINE_APP_DIR;
if (appDir) {
    void (async () => {
        const PORT = parseInt(process.env.PORT ?? "9080", 10);
        const { entities, workflows, heartbeats, webhooks, services, buses, channels } = await loadDefinitions(appDir);

        // Plan 4: register channels so the gateway's AuthHook can
        // authorize subscriptions against their $access policies.
        const { registerChannels } = await import('./auth/channel-registry.js');
        registerChannels(channels);

        // Load config + extract overrides. Silently tolerates apps without a
        // syncengine.config.ts — dev-only harnesses and smoke fixtures skip it.
        const { loadConfigOverrides, busOverridesToModeOf } = await import('./overrides-loader.js');
        let appConfig: unknown = null;
        try {
            const configMod = await import(/* @vite-ignore */ `${appDir}/syncengine.config`);
            appConfig = (configMod as { default?: unknown }).default ?? configMod;
        } catch { /* no config file — that's fine for dev */ }
        const { serviceOverrides, busOverrides } = await loadConfigOverrides(appConfig);

        // Extract auth provider from the loaded SyncengineConfig — may be
        // undefined (pre-auth apps). entity-runtime uses this to verify
        // Authorization headers on every handler call.
        const authProvider = (appConfig as { auth?: { provider?: import('@syncengine/core').AuthProvider } } | null)
            ?.auth?.provider;

        await startRestateEndpoint(
            entities, workflows, PORT, heartbeats, webhooks, services,
            [...serviceOverrides],
            authProvider,
        );

        const { bootBusRuntime } = await import('./bus-boot.js');
        const overrideModeOf = busOverridesToModeOf(busOverrides);
        await bootBusRuntime({
            workflows,
            buses,
            // Layer: override > declared. If an override maps this bus,
            // return its choice; otherwise fall through to the declared
            // `$mode` by returning the bus-list default (the boot helper
            // reads bus.$mode.kind for names it doesn't find in modeOf).
            modeOf: (busName) => {
                const overridden = overrideModeOf(busName);
                if (overridden) return overridden;
                const bus = buses.find((b) => b.$name === busName || b.dlq.$name === busName);
                if (!bus) return 'nats';
                return bus.$mode.kind === 'inMemory' ? 'inMemory' : 'nats';
            },
        });
    })();
}

export { entityRef, type EntityRefProxy } from './entity-ref.js';
export { defineWorkflow, isWorkflow, isBusSubscriberWorkflow, type WorkflowDef } from './workflow.js';
export {
    heartbeat,
    isHeartbeat,
    parseInterval,
    computeSleepMs,
    HEARTBEAT_WORKFLOW_PREFIX,
} from './heartbeat.js';
export type {
    HeartbeatDef,
    HeartbeatConfig,
    HeartbeatContext,
    HeartbeatHandler,
    HeartbeatScope,
    HeartbeatTrigger,
    IntervalSpec,
    ParsedCron,
    CronField,
} from './heartbeat.js';
export {
    webhook,
    isWebhook,
    WEBHOOK_WORKFLOW_PREFIX,
} from './webhook.js';
export type {
    WebhookDef,
    WebhookConfig,
    WebhookContext,
    WebhookHandler,
    VerifyConfig,
    VerifyResult,
    HmacVerifyConfig,
    CustomVerifyFn,
} from './webhook.js';
export {
    dispatchWebhook,
    findWebhook,
    MAX_WEBHOOK_BODY_BYTES,
    type WebhookDispatchResult,
} from './webhook-http.js';
export { getRegisteredWebhooks } from './webhook-registry.js';
export { ServiceContainer } from './service-container.js';

// ── Auth adapters (Plan 3) ────────────────────────────────────────────────
export { custom } from './auth/custom-adapter.js';
export { unverified } from './auth/unverified-adapter.js';
export { jwt } from './auth/jwt-adapter.js';
export type { JwtAdapterOptions } from './auth/jwt-adapter.js';

// ── Event bus — subscriber side ────────────────────────────────────────────
export { on, From, isSubscription } from './bus-on.js';
export type { Subscription, CursorConfig } from './bus-on.js';
export {
    runInBusContext,
    installBusPublisher,
    uninstallBusPublisher,
    getInstalledBusNc,
    busContextStorage,
} from './bus-context.js';
export type { BusContext } from './bus-context.js';
export {
    BusManager,
    realDispatcherFactory,
} from './bus-manager.js';
export type {
    BusManagerConfig,
    DispatcherFactory,
    DispatcherHandle,
} from './bus-manager.js';
export { bootBusRuntime } from './bus-boot.js';
export type { BootBusRuntimeOptions, BusRuntimeHandle, BusModeResolver } from './bus-boot.js';
export {
    loadConfigOverrides,
    extractOverrides,
    busOverridesToModeOf,
} from './overrides-loader.js';
export type { LoadedOverrides } from './overrides-loader.js';
