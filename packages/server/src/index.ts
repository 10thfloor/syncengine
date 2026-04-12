import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import * as restate from "@restatedev/restate-sdk";
import { workspace } from "./workspace/workspace.js";
import { bindEntities } from "./entity-runtime.js";
import { isEntity, type AnyEntity } from "@syncengine/core";
import { isWorkflow, buildWorkflowObject, type WorkflowDef } from './workflow.js';

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
            } else if (st.isFile() && (name.endsWith(".actor.ts") || name.endsWith(".workflow.ts"))) {
                out.push(full);
            }
        }
    }
    return out;
}

/**
 * Walk the app's source tree once and collect all entity + workflow
 * definitions by dynamic-importing each `.actor.ts` / `.workflow.ts` file.
 */
export async function loadDefinitions(appDir: string): Promise<{
    entities: AnyEntity[];
    workflows: WorkflowDef[];
}> {
    const srcDir = resolve(appDir, "src");
    const allFiles = walkSourceFiles(srcDir);
    const entities: AnyEntity[] = [];
    const workflows: WorkflowDef[] = [];

    for (const file of allFiles) {
        try {
            const mod = (await import(file)) as Record<string, unknown>;
            for (const value of Object.values(mod)) {
                if (isEntity(value)) entities.push(value);
                else if (isWorkflow(value)) workflows.push(value);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[workspace-service] failed to load ${file}: ${msg}`);
        }
    }

    if (entities.length === 0) {
        console.warn(
            `[workspace-service] appDir=${appDir} but no .actor.ts files found under src/`,
        );
    }
    return { entities, workflows };
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
): Promise<void> {
    const endpoint = restate.endpoint().bind(workspace);
    const bound = bindEntities(endpoint, entities);
    for (const wf of workflows) {
        bound.bind(buildWorkflowObject(wf));
    }
    await bound.listen(port);

    console.log(
        `[workspace-service] listening on :${port}` +
        (entities.length > 0
            ? ` (entities: ${entities.map((e) => e.$name).join(", ")})`
            : "") +
        (workflows.length > 0
            ? ` (workflows: ${workflows.map((w) => w.$name).join(", ")})`
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
    const PORT = parseInt(process.env.PORT ?? "9080", 10);
    const { entities, workflows } = await loadDefinitions(appDir);
    await startRestateEndpoint(entities, workflows, PORT);
}

export { entityRef, type EntityRefProxy } from './entity-ref.js';
export { defineWorkflow, isWorkflow, type WorkflowDef } from './workflow.js';
