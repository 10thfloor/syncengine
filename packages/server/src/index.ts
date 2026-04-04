import * as restate from "@restatedev/restate-sdk";
import { workspace } from "./workspace/workspace.js";
import { bindEntities } from "./entity-runtime.js";
import { isEntity, type AnyEntity } from "@syncengine/core";

const PORT = parseInt(process.env.PORT ?? "9080", 10);

// ── Load user entities (Phase 4) ─────────────────────────────────────────
//
// The CLI sets SYNCENGINE_ENTITIES_PATH to the absolute path of the user's
// `src/entities.ts` (convention). We dynamic-import the file via tsx (which
// handles TS compilation) and pull every exported entity definition. The
// file is optional — running without entities just binds the workspace
// object the same way as before Phase 4.
//
// We don't care which export name the user picks for an entity — anything
// that passes `isEntity` is registered. This means a single file can export
// many entities and the order doesn't matter.

async function loadEntities(): Promise<AnyEntity[]> {
    const entitiesPath = process.env.SYNCENGINE_ENTITIES_PATH;
    if (!entitiesPath) return [];
    try {
        const mod = (await import(entitiesPath)) as Record<string, unknown>;
        const entities: AnyEntity[] = [];
        for (const value of Object.values(mod)) {
            if (isEntity(value)) entities.push(value);
        }
        if (entities.length === 0) {
            console.warn(
                `[workspace-service] SYNCENGINE_ENTITIES_PATH=${entitiesPath} loaded but exports no entities.`,
            );
        }
        return entities;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
            `[workspace-service] failed to load entities from ${entitiesPath}: ${msg}`,
        );
        // Don't crash the server — entities are optional in Phase 4. Other
        // pieces of the framework still need the workspace handler to come
        // up so the rest of the dev stack stays functional.
        return [];
    }
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
