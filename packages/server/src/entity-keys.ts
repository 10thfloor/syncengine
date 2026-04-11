import { errors, StoreCode } from '@syncengine/core';

/** Prefix applied to every entity's Restate virtual-object name. */
export const ENTITY_OBJECT_PREFIX = 'entity_';

/** Split a Restate virtual-object key of the form `{workspaceId}/{entityKey}`
 *  into its two components. */
export function splitObjectKey(objKey: string): { workspaceId: string; entityKey: string } {
    const idx = objKey.indexOf("/");
    if (idx < 0) {
        throw errors.store(StoreCode.INVALID_ENTITY_KEY, {
            message: `Entity key '${objKey}' must be of the form 'workspaceId/entityKey'.`,
            hint: `Format: 'workspace-id/entity-key'`,
            context: { key: objKey },
        });
    }
    return {
        workspaceId: objKey.slice(0, idx),
        entityKey: objKey.slice(idx + 1),
    };
}
