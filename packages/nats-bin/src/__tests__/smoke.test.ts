/**
 * Smoke test: download the pinned nats-server binary and confirm it runs.
 *
 * Network-dependent — first run downloads from GitHub. Subsequent runs hit
 * the cached binary and complete in milliseconds.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { binaryPath, natsServerVersion } from '../index';

describe('@syncengine/nats-bin smoke', () => {
    it('downloads and executes --version successfully', async () => {
        const path = await binaryPath();
        expect(path).toMatch(/nats-server/);

        const output = execFileSync(path, ['--version'], {
            encoding: 'utf8',
            timeout: 5000,
        });

        expect(output).toContain(natsServerVersion);
    }, 120_000);
});
