import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, chmodSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBinaryPath } from '../resolver.ts';

const TMP_CACHE = '/tmp/se-serve-bin-cache';
const TMP_WORKSPACE = '/tmp/se-serve-bin-ws';

beforeEach(() => {
    rmSync(TMP_CACHE, { recursive: true, force: true });
    rmSync(TMP_WORKSPACE, { recursive: true, force: true });
});

afterEach(() => {
    rmSync(TMP_CACHE, { recursive: true, force: true });
    rmSync(TMP_WORKSPACE, { recursive: true, force: true });
});

function cachedBinary(path: string): void {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '#!/bin/sh\necho "cached"\n');
    chmodSync(path, 0o755);
}

function fakeWorkspace(root: string): { sourcePath: string } {
    const sourcePath = join(root, 'packages/serve/src/index.ts');
    mkdirSync(join(root, 'packages/serve/src'), { recursive: true });
    writeFileSync(sourcePath, `console.log("serve source");`);
    // Marker file that signals a syncengine monorepo
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    return { sourcePath };
}

describe('resolveBinaryPath — cache hit', () => {
    it('returns the cached binary path when it already exists', async () => {
        const expected = join(TMP_CACHE, 'syncengine-serve');
        cachedBinary(expected);

        const result = await resolveBinaryPath({
            cacheDir: TMP_CACHE,
            workspaceRoot: null,
            compile: async () => {
                throw new Error('should not compile — cache hit');
            },
        });

        expect(result).toBe(expected);
    });

    it('does not invoke the compile callback on cache hit', async () => {
        const expected = join(TMP_CACHE, 'syncengine-serve');
        cachedBinary(expected);

        let compileCalls = 0;
        await resolveBinaryPath({
            cacheDir: TMP_CACHE,
            workspaceRoot: null,
            compile: async () => {
                compileCalls++;
                return expected;
            },
        });

        expect(compileCalls).toBe(0);
    });
});

describe('resolveForRun — monorepo dev path', () => {
    it('returns kind=source when workspace source exists and no cache', async () => {
        const { resolveForRun } = await import('../resolver.ts');
        const { sourcePath } = fakeWorkspace(TMP_WORKSPACE);

        const res = await resolveForRun({
            cacheDir: TMP_CACHE,
            workspaceRoot: TMP_WORKSPACE,
            compile: async () => { throw new Error('should not compile in source mode'); },
        });

        expect(res.kind).toBe('source');
        expect(res.path).toBe(sourcePath);
    });

    it('returns kind=source when source is newer than cached binary', async () => {
        const { resolveForRun } = await import('../resolver.ts');
        const { sourcePath } = fakeWorkspace(TMP_WORKSPACE);
        cachedBinary(join(TMP_CACHE, 'syncengine-serve'));

        // Make source newer than cache
        const tomorrow = (Date.now() + 24 * 60 * 60 * 1000) / 1000;
        writeFileSync(sourcePath, '// modified');
        utimesSync(sourcePath, tomorrow, tomorrow);

        const res = await resolveForRun({
            cacheDir: TMP_CACHE,
            workspaceRoot: TMP_WORKSPACE,
            compile: async () => { throw new Error('should not compile'); },
        });

        expect(res.kind).toBe('source');
    });

    it('returns kind=binary when cache is fresh and no workspace', async () => {
        const { resolveForRun } = await import('../resolver.ts');
        const cachePath = join(TMP_CACHE, 'syncengine-serve');
        cachedBinary(cachePath);

        const res = await resolveForRun({
            cacheDir: TMP_CACHE,
            workspaceRoot: null,
            compile: async () => { throw new Error('should not compile'); },
        });

        expect(res.kind).toBe('binary');
        expect(res.path).toBe(cachePath);
    });
});

describe('resolveBinaryPath — neither cache nor source available', () => {
    it('falls back to compile when nothing else is available', async () => {
        const cachePath = join(TMP_CACHE, 'syncengine-serve');
        const result = await resolveBinaryPath({
            cacheDir: TMP_CACHE,
            workspaceRoot: null,
            compile: async ({ outPath }) => {
                cachedBinary(outPath);
                return outPath;
            },
        });
        expect(result).toBe(cachePath);
    });

    it('throws a helpful error when compile is unavailable', async () => {
        await expect(
            resolveBinaryPath({
                cacheDir: TMP_CACHE,
                workspaceRoot: null,
                compile: async () => { throw new Error('bun not found'); },
            }),
        ).rejects.toThrow();
    });
});

describe('resolveBinaryPath — workspace detection', () => {
    it('returns null workspace root when no pnpm-workspace.yaml is found', async () => {
        const { findWorkspaceRoot } = await import('../resolver.ts');
        mkdirSync(TMP_WORKSPACE, { recursive: true });
        const found = findWorkspaceRoot(TMP_WORKSPACE);
        expect(found).toBeNull();
    });

    it('returns the root when pnpm-workspace.yaml is present at the start dir', async () => {
        const { findWorkspaceRoot } = await import('../resolver.ts');
        fakeWorkspace(TMP_WORKSPACE);
        const found = findWorkspaceRoot(TMP_WORKSPACE);
        expect(found).toBe(TMP_WORKSPACE);
    });

    it('walks up to find pnpm-workspace.yaml from a nested dir', async () => {
        const { findWorkspaceRoot } = await import('../resolver.ts');
        fakeWorkspace(TMP_WORKSPACE);
        const nested = join(TMP_WORKSPACE, 'packages/serve-bin/src');
        mkdirSync(nested, { recursive: true });
        const found = findWorkspaceRoot(nested);
        expect(found).toBe(TMP_WORKSPACE);
    });
});
