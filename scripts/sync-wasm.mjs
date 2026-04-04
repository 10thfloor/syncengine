#!/usr/bin/env node
// ── sync-wasm ─────────────────────────────────────────────────────────────
//
// `@syncengine/client` depends on `@syncengine/dbsp` via `file:`, which pnpm
// materializes as a COPY in `node_modules/.pnpm/@syncengine+dbsp@file+...`.
// Rebuilding the WASM via `pnpm build:wasm` updates `packages/dbsp-engine/pkg/`
// but leaves that copy stale until the next `pnpm install`. Vite then serves
// the stale WASM to the browser, producing hard-to-trace `LinkError: function
// import requires a callable` crashes or silent behavioral regressions.
//
// This script copies the fresh pkg/ output over the stale pnpm copy and,
// for good measure, blows away vite's prebundle cache so the next dev
// server start re-prebundles from the correct WASM. It runs automatically
// as part of `pnpm build:wasm`.

import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);

// 1. Copy every file from pkg/ into the pnpm link
const src = join(repoRoot, 'packages', 'dbsp-engine', 'pkg');
const dst = join(
    repoRoot,
    'node_modules',
    '.pnpm',
    '@syncengine+dbsp@file+packages+dbsp-engine+pkg',
    'node_modules',
    '@syncengine',
    'dbsp',
);

if (!existsSync(dst)) {
    // First-time `pnpm install` hasn't run yet — nothing to sync.
    console.log('[sync-wasm] pnpm link not found, skipping (run `pnpm install` first)');
    process.exit(0);
}

const files = readdirSync(src);
let copied = 0;
for (const f of files) {
    const srcPath = join(src, f);
    const dstPath = join(dst, f);
    if (!statSync(srcPath).isFile()) continue;
    copyFileSync(srcPath, dstPath);
    copied++;
}
console.log(`[sync-wasm] copied ${copied} files from pkg/ → ${dst.replace(repoRoot + '/', '')}`);

// 2. Clear vite's prebundle cache so the next dev start re-optimizes the dep
const viteCache = join(repoRoot, 'apps', 'example', 'node_modules', '.vite');
const viteTemp = join(repoRoot, 'apps', 'example', 'node_modules', '.vite-temp');
for (const cachePath of [viteCache, viteTemp]) {
    if (existsSync(cachePath)) {
        rmSync(cachePath, { recursive: true, force: true });
        console.log(`[sync-wasm] cleared ${cachePath.replace(repoRoot + '/', '')}`);
    }
}
