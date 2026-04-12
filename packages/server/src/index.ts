import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import * as restate from "@restatedev/restate-sdk";
import { errors, SchemaCode } from "@syncengine/core";
import { workspace } from "./workspace/workspace.js";
import { bindEntities } from "./entity-runtime.js";
import { isEntity, type AnyEntity } from "@syncengine/core";
import { isWorkflow, buildWorkflowObject, type WorkflowDef } from './workflow.js';
import { isHeartbeat, type HeartbeatDef } from './heartbeat.js';
import { buildHeartbeatWorkflow } from './heartbeat-workflow.js';
import { heartbeatStatus, HEARTBEAT_STATUS_ENTITY_NAME } from '@syncengine/core';
import { registerHeartbeats } from './heartbeat-registry.js';

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
                name.endsWith(".heartbeat.ts")
            )) {
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
}> {
    const srcDir = resolve(appDir, "src");
    const allFiles = walkSourceFiles(srcDir);
    const entities: AnyEntity[] = [];
    const workflows: WorkflowDef[] = [];
    const heartbeats: HeartbeatDef[] = [];
    const heartbeatSources = new Map<string, string>();

    for (const file of allFiles) {
        try {
            const mod = (await import(file)) as Record<string, unknown>;
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
                }
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[workspace-service] failed to load ${file}: ${msg}`);
            throw err;
        }
    }

    if (entities.length === 0 && heartbeats.length === 0) {
        console.warn(
            `[workspace-service] appDir=${appDir} but no .actor.ts or .heartbeat.ts files found under src/`,
        );
    }
    return { entities, workflows, heartbeats };
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
): Promise<void> {
    const endpoint = restate.endpoint().bind(workspace);

    // Framework-owned entities come first so heartbeat workflows can
    // always target them via entityRef.
    const allEntities: AnyEntity[] = [heartbeatStatus, ...entities];
    const bound = bindEntities(endpoint, allEntities);

    for (const wf of workflows) {
        bound.bind(buildWorkflowObject(wf));
    }
    for (const hb of heartbeats) {
        bound.bind(buildHeartbeatWorkflow(hb));
    }

    // Make the definition list available to the workspace boot hook so
    // `workspace.provision` can fire `trigger: 'boot'` heartbeats.
    registerHeartbeats(heartbeats);

    await bound.listen(port);

    console.log(
        `[workspace-service] listening on :${port}` +
        ` (entities: ${allEntities.map((e) => e.$name).join(", ")})` +
        (workflows.length > 0
            ? ` (workflows: ${workflows.map((w) => w.$name).join(", ")})`
            : "") +
        (heartbeats.length > 0
            ? ` (heartbeats: ${heartbeats.map((h) => h.$name).join(", ")})`
            : ""),
    );
}

// ── Direct execution (dev mode via tsx watch) ──────────────────────────────
//
// When this file is run directly (`tsx watch src/index.ts`), it reads
// SYNCENGINE_APP_DIR, loads entities, and starts the endpoint. In
// production the build system imports the exported functions instead.

const appDir = process.env.SYNCENGINE_APP_DIR;
if (appDir) {
    void (async () => {
        const PORT = parseInt(process.env.PORT ?? "9080", 10);
        const { entities, workflows, heartbeats } = await loadDefinitions(appDir);
        await startRestateEndpoint(entities, workflows, PORT, heartbeats);
    })();
}

export { entityRef, type EntityRefProxy } from './entity-ref.js';
export { defineWorkflow, isWorkflow, type WorkflowDef } from './workflow.js';
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
