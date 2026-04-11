/** Prefix applied to every entity's Restate virtual-object name. */
export const ENTITY_OBJECT_PREFIX = 'entity_';

/** Split a Restate virtual-object key of the form `{workspaceId}/{entityKey}`
 *  into its two components. */
export function splitObjectKey(objKey: string): { workspaceId: string; entityKey: string } {
    const idx = objKey.indexOf("/");
    if (idx < 0) {
        throw new Error(
            `Entity key '${objKey}' must be of the form 'workspaceId/entityKey'.`,
        );
    }
    return {
        workspaceId: objKey.slice(0, idx),
        entityKey: objKey.slice(idx + 1),
    };
}
