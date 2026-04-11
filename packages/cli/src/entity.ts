/**
 * `syncengine entity get <name> <key>` — read entity state from Restate.
 *
 * Uses the same RPC path as the client: POST to
 * `<restateUrl>/entity_<name>/<workspaceId>/<key>/_read`
 */

import { findAppRoot, stateDirFor, readPortsOrDefaults } from './state';
import { hashWorkspaceId } from '@syncengine/core/http';

export async function entityCommand(args: string[]): Promise<void> {
    const verb = args[0];
    if (verb !== 'get') {
        process.stderr.write(`Unknown entity command: ${verb}\n`);
        process.stderr.write('Usage: syncengine entity get <entityName> <key> [--workspace <wsKey>]\n');
        process.exit(1);
    }

    const entityName = args[1];
    const entityKey = args[2];
    if (!entityName || !entityKey) {
        process.stderr.write('Usage: syncengine entity get <entityName> <key> [--workspace <wsKey>]\n');
        process.exit(1);
    }

    // Optional workspace override (default: hash of 'default')
    const wsIdx = args.indexOf('--workspace');
    let workspaceId: string;
    if (wsIdx !== -1 && args[wsIdx + 1]) {
        workspaceId = args[wsIdx + 1];
    } else {
        workspaceId = hashWorkspaceId('default');
    }

    const repoRoot = await findAppRoot();
    const stateDir = stateDirFor(repoRoot);
    const ports = readPortsOrDefaults(stateDir);
    const restateUrl = `http://127.0.0.1:${ports.restateIngress}`;

    const url = `${restateUrl}/entity_${entityName}/${encodeURIComponent(`${workspaceId}/${entityKey}`)}/_read`;

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '[]',
        });

        if (!res.ok) {
            const text = await res.text().catch(() => '<no body>');
            process.stderr.write(`Error: ${res.status} ${text}\n`);
            process.exit(1);
        }

        const body = await res.json() as Record<string, unknown>;
        // The response is { state: {...} } from the entity runtime's _read handler
        const state = body?.state ?? body;
        process.stdout.write(JSON.stringify(state, null, 2) + '\n');
    } catch (err) {
        process.stderr.write(`Failed to reach Restate at ${restateUrl}: ${(err as Error).message}\n`);
        process.stderr.write('Is the dev stack running? (syncengine dev)\n');
        process.exit(1);
    }
}
