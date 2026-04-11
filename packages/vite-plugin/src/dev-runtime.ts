import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DevRuntimeJson {
    natsUrl?: string;
    restateUrl?: string;
    gatewayUrl?: string;
    authToken?: string | null;
}

/**
 * Read `.syncengine/dev/runtime.json`. Returns `{}` if the file
 * is missing or malformed — the CLI may not have written it yet.
 */
export function readDevRuntime(root: string): DevRuntimeJson {
    const p = join(root, '.syncengine', 'dev', 'runtime.json');
    try {
        return JSON.parse(readFileSync(p, 'utf8')) as DevRuntimeJson;
    } catch {
        return {};
    }
}
