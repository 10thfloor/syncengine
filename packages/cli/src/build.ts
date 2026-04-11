/**
 * `syncengine build` — production build command (PLAN Phase 9).
 *
 * Steps:
 *   1. Find the app directory (look for vite.config.ts)
 *   2. Run `vite build` → dist/ (client static files)
 *   3. Read dist/.syncengine/manifest.json (written by the plugin)
 *   4. Generate a server entry file that statically imports all actors
 *   5. Bundle with esbuild → dist/server/index.mjs
 *   6. Write dist/server/package.json with external deps
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

import { banner, note } from './runner';
import { findAppRoot } from './state';
import { errors, CliCode } from '@syncengine/core';

interface Manifest {
    actors: string[];
    configCandidates: string[];
}

export async function buildCommand(_args: string[]): Promise<void> {
    const repoRoot = await findAppRoot();

    // 1. Find the app directory
    const appDir = findAppDir(repoRoot);
    if (!appDir) {
        throw errors.cli(CliCode.APP_DIR_NOT_FOUND, {
            message: `Could not find an app directory with vite.config.ts under ${repoRoot}`,
            context: { repoRoot },
        });
    }
    note(`app directory: ${relative(repoRoot, appDir)}`);

    const distDir = join(appDir, 'dist');

    // 2. Run vite build
    banner('building client bundle');
    const viteBin = join(appDir, 'node_modules', '.bin', 'vite');
    execFileSync(viteBin, ['build'], {
        cwd: appDir,
        stdio: 'inherit',
        env: {
            ...process.env,
            // Production build reads NATS/Restate URLs from env if set;
            // if not, the virtual module falls back to defaults and the
            // production server injects the real values via meta tags.
            SYNCENGINE_NATS_URL: process.env.SYNCENGINE_NATS_URL ?? 'ws://localhost:9222',
            SYNCENGINE_RESTATE_URL: process.env.SYNCENGINE_RESTATE_URL ?? 'http://localhost:8080',
        },
    });

    // 3. Read manifest
    const manifestPath = join(distDir, '.syncengine', 'manifest.json');
    if (!existsSync(manifestPath)) {
        throw errors.cli(CliCode.BUILD_OUTPUT_MISSING, {
            message: `Plugin did not write ${manifestPath} — is @syncengine/vite-plugin in your vite.config.ts?`,
            hint: `Add the syncengine plugin to your vite.config.ts.`,
            context: { manifestPath },
        });
    }
    const manifest: Manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    note(`found ${manifest.actors.length} actor file(s)`);

    // 4. Find the syncengine.config
    let configPath: string | null = null;
    for (const candidate of manifest.configCandidates) {
        const abs = join(appDir, candidate);
        if (existsSync(abs)) {
            configPath = candidate;
            break;
        }
    }

    // 5. Generate server entry
    banner('bundling production server');
    const serverEntryDir = join(distDir, '.syncengine');
    const serverEntryPath = join(serverEntryDir, 'server-entry.ts');
    const serverEntry = generateServerEntry(manifest, configPath, appDir, distDir);
    writeFileSync(serverEntryPath, serverEntry);

    // 6. Bundle with esbuild
    const serverOutDir = join(distDir, 'server');
    mkdirSync(serverOutDir, { recursive: true });

    // The actor files may import from @syncengine/client which
    // references the Vite virtual module `virtual:syncengine/runtime-config`.
    // On the server side this module is never evaluated (the runtime
    // config is only read by client-side code paths), but esbuild
    // still needs a resolvable stub to bundle without errors.
    const runtimeConfigStub = join(serverEntryDir, 'runtime-config-stub.mjs');
    writeFileSync(runtimeConfigStub, [
        `// Stub for virtual:syncengine/runtime-config (server-side build)`,
        `export const workspaceId = 'server';`,
        `export const natsUrl = '';`,
        `export const restateUrl = '';`,
        `export const authToken = null;`,
    ].join('\n') + '\n');

    const esbuildBin = resolveEsbuild(repoRoot);
    execFileSync(esbuildBin, [
        serverEntryPath,
        '--bundle',
        '--platform=node',
        '--format=esm',
        `--outfile=${join(serverOutDir, 'index.mjs')}`,
        '--target=node22',
        // nats and some deps use CJS require('crypto') etc. which
        // esbuild's ESM output can't resolve. The banner shim creates
        // a CJS-compatible require function for the bundled code.
        '--banner:js=import { createRequire } from "module"; const require = createRequire(import.meta.url);',
        `--alias:virtual:syncengine/runtime-config=./${relative(appDir, runtimeConfigStub)}`,
    ], {
        cwd: appDir,
        stdio: 'inherit',
    });

    // 7. Write a minimal package.json so Node treats the dir as ESM
    writeFileSync(
        join(serverOutDir, 'package.json'),
        JSON.stringify({ type: 'module' }, null, 2),
    );

    note(`client → ${relative(repoRoot, distDir)}/`);
    note(`server → ${relative(repoRoot, serverOutDir)}/index.mjs`);
    banner('build complete');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function findAppDir(repoRoot: string): string | null {
    // Check apps/example first (our convention), then root
    const candidates = [
        join(repoRoot, 'apps', 'example'),
        repoRoot,
    ];
    for (const dir of candidates) {
        if (
            existsSync(join(dir, 'vite.config.ts')) ||
            existsSync(join(dir, 'vite.config.js'))
        ) {
            return dir;
        }
    }
    return null;
}

function resolveEsbuild(repoRoot: string): string {
    // Try the CLI package's own node_modules first, then app, then root
    const candidates = [
        join(dirname(new URL(import.meta.url).pathname), '..', 'node_modules', '.bin', 'esbuild'),
        join(repoRoot, 'node_modules', '.bin', 'esbuild'),
    ];
    for (const p of candidates) {
        if (existsSync(p)) return p;
    }
    throw errors.cli(CliCode.DEPENDENCY_NOT_FOUND, {
        message: `esbuild not found — run pnpm install`,
        hint: `Run: pnpm install`,
    });
}

function generateServerEntry(
    manifest: Manifest,
    configPath: string | null,
    appDir: string,
    distDir: string,
): string {
    const lines: string[] = [
        `// Generated by syncengine build — do not edit`,
        `import { readFileSync } from 'node:fs';`,
        `import { fileURLToPath } from 'node:url';`,
        `import { dirname, join } from 'node:path';`,
        ``,
        `import { startRestateEndpoint } from '@syncengine/server';`,
        `import { startHttpServer } from '@syncengine/server/serve';`,
        `import { isEntity } from '@syncengine/core';`,
        `import { isWorkflow } from '@syncengine/server';`,
        ``,
    ];

    // Static imports for each actor file
    manifest.actors.forEach((relPath, i) => {
        // Resolve relative to the server entry's location (dist/.syncengine/)
        const importPath = relative(join(distDir, '.syncengine'), join(appDir, relPath))
            .replace(/\\/g, '/');
        lines.push(`import * as _actor_${i} from '${importPath}';`);
    });
    lines.push('');

    // Config import
    if (configPath) {
        const configImportPath = relative(join(distDir, '.syncengine'), join(appDir, configPath))
            .replace(/\\/g, '/');
        lines.push(`import _config from '${configImportPath}';`);
    } else {
        lines.push(`const _config = { workspaces: { resolve: () => 'default' } };`);
    }
    lines.push('');

    // Collect entities
    lines.push(
        `const _allModules = [${manifest.actors.map((_, i) => `_actor_${i}`).join(', ')}];`,
        `const entities = _allModules.flatMap(m => Object.values(m).filter(isEntity));`,
        `const workflows = _allModules.flatMap(m => Object.values(m).filter(isWorkflow));`,
        ``,
    );

    // Start Restate endpoint
    lines.push(
        `const PORT = parseInt(process.env.PORT ?? '9080', 10);`,
        `await startRestateEndpoint(entities, workflows, PORT);`,
        ``,
    );

    // Start HTTP server
    lines.push(
        `const HTTP_PORT = parseInt(process.env.HTTP_PORT ?? '3000', 10);`,
        `const __dirname = dirname(fileURLToPath(import.meta.url));`,
        `const staticDir = join(__dirname, '..');`,
        `const indexHtml = readFileSync(join(staticDir, 'index.html'), 'utf8');`,
        ``,
        `startHttpServer({`,
        `    staticDir,`,
        `    indexHtml,`,
        `    restateUrl: process.env.SYNCENGINE_RESTATE_URL ?? 'http://localhost:8080',`,
        `    natsUrl: process.env.SYNCENGINE_NATS_URL ?? 'ws://localhost:9222',`,
        `    appConfig: _config,`,
        `    port: HTTP_PORT,`,
        `});`,
    );

    return lines.join('\n') + '\n';
}
