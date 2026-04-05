/**
 * Smoke test: download the pinned restate-server binary and confirm it runs.
 *
 * Network-dependent — first run downloads from GitHub. Subsequent runs hit
 * the cached binary and complete in milliseconds.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { binaryPath, restateServerVersion } from '../index';

describe('@syncengine/restate-bin smoke', () => {
    it('downloads and executes --version successfully', async () => {
        const path = await binaryPath();
        expect(path).toMatch(/restate-server/);

        const output = execFileSync(path, ['--version'], {
            encoding: 'utf8',
            timeout: 10_000,
        });

        // Restate prints e.g. "restate-server 1.4.4 (...)"
        expect(output).toContain(restateServerVersion);
    }, 180_000);
});
