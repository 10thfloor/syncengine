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
 * Load entity definitions from `.actor.ts` files under the given app
 * directory. Each file is dynamic-imported and any export that passes
 * `isEntity()` is collected.
 */
export async function loadEntities(appDir: string): Promise<AnyEntity[]> {
    const srcDir = resolve(appDir, "src");
    const files = walkSourceFiles(srcDir).filter(f => f.endsWith('.actor.ts'));
    if (files.length === 0) {
        console.warn(
            `[workspace-service] appDir=${appDir} but no .actor.ts files found under src/`,
        );
        return [];
    }

    const entities: AnyEntity[] = [];
    for (const file of files) {
        try {
            const mod = (await import(file)) as Record<string, unknown>;
            for (const value of Object.values(mod)) {
                if (isEntity(value)) entities.push(value);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(
                `[workspace-service] failed to load actor file ${file}: ${msg}`,
            );
        }
    }
    return entities;
}

export async function loadWorkflows(appDir: string): Promise<WorkflowDef[]> {
    const srcDir = resolve(appDir, "src");
    const files = walkSourceFiles(srcDir).filter(f => f.endsWith('.workflow.ts'));
    const workflows: WorkflowDef[] = [];
    for (const file of files) {
        try {
            const mod = (await import(file)) as Record<string, unknown>;
            for (const value of Object.values(mod)) {
                if (isWorkflow(value)) workflows.push(value);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[workspace-service] failed to load workflow file ${file}: ${msg}`);
        }
    }
    return workflows;
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
    const entities = await loadEntities(appDir);
    const workflows = await loadWorkflows(appDir);
    await startRestateEndpoint(entities, workflows, PORT);
}

export { entityRef, type EntityRefProxy } from './entity-ref.js';
export { defineWorkflow, isWorkflow, type WorkflowDef } from './workflow.js';
