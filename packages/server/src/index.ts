import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import * as restate from "@restatedev/restate-sdk";
import { workspace } from "./workspace/workspace.js";
import { bindEntities } from "./entity-runtime.js";
import { isEntity, type AnyEntity } from "@syncengine/core";

const PORT = parseInt(process.env.PORT ?? "9080", 10);

// ── Load user entities (PLAN Phase 4) ────────────────────────────────────
//
// The CLI sets SYNCENGINE_APP_DIR to the absolute path of the user's app
// directory (e.g., `apps/example`). We walk `<SYNCENGINE_APP_DIR>/src` for
// every `.actor.ts` file and dynamic-import each via tsx. Any export that
// passes `isEntity` gets bound as a Restate virtual object alongside the
// workspace handler.
//
// On the server side there's no Vite in the loop — tsx loads the files
// with their original content including the full handler bodies. The
// Vite plugin's handler-body stripping is a client-bundle-only concern;
// the server always sees the real code.

function walkActorFiles(srcDir: string): string[] {
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
            } else if (st.isFile() && name.endsWith(".actor.ts")) {
                out.push(full);
            }
        }
    }
    return out;
}

async function loadEntities(): Promise<AnyEntity[]> {
    const appDir = process.env.SYNCENGINE_APP_DIR;
    if (!appDir) return [];

    const srcDir = resolve(appDir, "src");
    const files = walkActorFiles(srcDir);
    if (files.length === 0) {
        console.warn(
            `[workspace-service] SYNCENGINE_APP_DIR=${appDir} but no .actor.ts files found under src/`,
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

const entities = await loadEntities();

const endpoint = restate.endpoint().bind(workspace);
const bound = bindEntities(endpoint, entities);
bound.listen(PORT);

console.log(
    `[workspace-service] listening on :${PORT}` +
    (entities.length > 0
        ? ` (entities: ${entities.map((e) => e.$name).join(", ")})`
        : ""),
);
