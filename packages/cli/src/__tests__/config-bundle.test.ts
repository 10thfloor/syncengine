import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConfigBundle } from '../config-bundle.ts';
import { SyncEngineError } from '@syncengine/core';

describe('buildConfigBundle', () => {
    let appDir: string;

    beforeEach(() => {
        appDir = mkdtempSync(join(tmpdir(), 'syncengine-config-bundle-'));
    });

    afterEach(() => {
        rmSync(appDir, { recursive: true, force: true });
    });

    it('emits a stub when no config path is provided', async () => {
        const distDir = join(appDir, 'dist');
        const result = await buildConfigBundle({
            configPath: null,
            distDir,
            appDir,
        });

        expect(result.kind).toBe('stub');
        expect(result.outPath).toBe(join(distDir, 'server', 'config.mjs'));
        expect(existsSync(result.outPath)).toBe(true);

        const content = readFileSync(result.outPath, 'utf8');
        expect(content).toContain('export default');
        expect(content).toContain('workspaces');
        expect(content).toContain('resolve');
    });

    it('stub evaluates to a valid SyncengineConfig whose resolve() returns a non-empty string', async () => {
        const distDir = join(appDir, 'dist');
        const result = await buildConfigBundle({
            configPath: null,
            distDir,
            appDir,
        });

        const content = readFileSync(result.outPath, 'utf8');
        const dataUrl = 'data:text/javascript;base64,' +
            Buffer.from(content, 'utf8').toString('base64');
        const mod = await import(dataUrl) as {
            default: {
                workspaces: {
                    resolve: (ctx: unknown) => string | Promise<string>;
                };
            };
        };
        const ws = await mod.default.workspaces.resolve({
            request: new Request('http://localhost/'),
            user: { id: 'anonymous' },
        });
        expect(typeof ws).toBe('string');
        expect(ws.length).toBeGreaterThan(0);
    });

    it('bundles a user config to dist/server/config.mjs', async () => {
        const configPath = join(appDir, 'syncengine.config.ts');
        writeFileSync(configPath, `
            export default {
                workspaces: {
                    resolve: () => 'alpha',
                },
            };
        `);
        const distDir = join(appDir, 'dist');

        const result = await buildConfigBundle({ configPath, distDir, appDir });

        expect(result.kind).toBe('esbuild');
        expect(result.outPath).toBe(join(distDir, 'server', 'config.mjs'));
        expect(existsSync(result.outPath)).toBe(true);

        const dataUrl = 'data:text/javascript;base64,' +
            Buffer.from(readFileSync(result.outPath, 'utf8'), 'utf8').toString('base64');
        const mod = await import(dataUrl) as {
            default: { workspaces: { resolve: () => string } };
        };
        expect(mod.default.workspaces.resolve()).toBe('alpha');
    });

    it('rejects a user config that imports a native .node module', async () => {
        // Fake a "native module" — esbuild only sees the import path's suffix,
        // so a zero-byte file with .node is enough to trigger the guard.
        const nativePath = join(appDir, 'fake-native.node');
        writeFileSync(nativePath, '');

        const configPath = join(appDir, 'syncengine.config.ts');
        writeFileSync(configPath, `
            import nativeMod from './fake-native.node';
            export default {
                workspaces: { resolve: () => 'x' },
                _native: nativeMod,
            };
        `);
        const distDir = join(appDir, 'dist');

        await expect(
            buildConfigBundle({ configPath, distDir, appDir }),
        ).rejects.toThrow();

        // Should never have written the bundle.
        expect(existsSync(join(distDir, 'server', 'config.mjs'))).toBe(false);
    });

    it('native-import rejection surfaces a SyncEngineError with CliCode.NATIVE_IMPORT_REJECTED', async () => {
        const nativePath = join(appDir, 'fake-native.node');
        writeFileSync(nativePath, '');

        const configPath = join(appDir, 'syncengine.config.ts');
        writeFileSync(configPath, `
            import './fake-native.node';
            export default { workspaces: { resolve: () => 'x' } };
        `);
        const distDir = join(appDir, 'dist');

        let caught: unknown;
        try {
            await buildConfigBundle({ configPath, distDir, appDir });
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeDefined();

        // esbuild wraps plugin errors — dig for the SyncEngineError cause.
        const findSyncErr = (e: unknown): SyncEngineError | null => {
            if (e instanceof SyncEngineError) return e;
            if (e && typeof e === 'object') {
                const anyE = e as { cause?: unknown; errors?: Array<{ detail?: unknown }> };
                if (anyE.cause) {
                    const fromCause = findSyncErr(anyE.cause);
                    if (fromCause) return fromCause;
                }
                if (Array.isArray(anyE.errors)) {
                    for (const inner of anyE.errors) {
                        const fromDetail = findSyncErr(inner?.detail);
                        if (fromDetail) return fromDetail;
                    }
                }
            }
            return null;
        };
        const sErr = findSyncErr(caught);
        expect(sErr).not.toBeNull();
        expect(sErr?.code).toBe('NATIVE_IMPORT_REJECTED');
    });
});
