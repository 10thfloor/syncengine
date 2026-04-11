/**
 * `syncengine start` — run the production server (PLAN Phase 9).
 *
 * Expects `syncengine build` to have already run. Finds
 * `dist/server/index.mjs`, validates the environment, spawns Node,
 * and registers the Restate deployment.
 */

import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

import { banner, note } from './runner';
import { findRepoRoot } from './state';

export async function startCommand(_args: string[]): Promise<void> {
    const repoRoot = await findRepoRoot();

    // Find the built server entry
    const appDir = findBuiltApp(repoRoot);
    if (!appDir) {
        throw new Error(
            `No dist/server/index.mjs found. Run \`syncengine build\` first.`,
        );
    }

    const serverEntry = join(appDir, 'dist', 'server', 'index.mjs');
    note(`server entry: ${relative(repoRoot, serverEntry)}`);

    const port = parseInt(process.env.PORT ?? '9080', 10);
    const httpPort = parseInt(process.env.HTTP_PORT ?? '3000', 10);
    const restateUrl = process.env.SYNCENGINE_RESTATE_URL ?? 'http://localhost:8080';
    const natsUrl = process.env.SYNCENGINE_NATS_URL ?? 'ws://localhost:9222';
    if (!process.env.SYNCENGINE_NATS_URL) {
        note(`SYNCENGINE_NATS_URL not set, using default: ${natsUrl}`);
    }
    if (!process.env.SYNCENGINE_RESTATE_URL) {
        note(`SYNCENGINE_RESTATE_URL not set, using default: ${restateUrl}`);
    }

    banner('starting production server');

    // Run the server entry. It starts both the Restate H2C endpoint
    // and the HTTP server internally.
    execFileSync('node', [serverEntry], {
        cwd: appDir,
        stdio: 'inherit',
        env: {
            ...process.env,
            PORT: String(port),
            HTTP_PORT: String(httpPort),
            SYNCENGINE_NATS_URL: natsUrl,
            SYNCENGINE_RESTATE_URL: restateUrl,
            NATS_URL: natsUrl.replace(/^ws/, 'nats').replace(/:9222/, ':4222'),
        },
    });
}

function findBuiltApp(repoRoot: string): string | null {
    const candidates = [
        join(repoRoot, 'apps', 'example'),
        repoRoot,
    ];
    for (const dir of candidates) {
        if (existsSync(join(dir, 'dist', 'server', 'index.mjs'))) {
            return dir;
        }
    }
    return null;
}
