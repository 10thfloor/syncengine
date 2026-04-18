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
import { buildConfigBundle } from './config-bundle';

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
    // `--configLoader runner` is required for workspaces that import TS
    // source directly (packages/*/src/*.ts). The default `bundle` loader
    // externalizes every workspace dep and Node's native ESM resolver
    // then can't follow the internal extensionless imports. Mirrors the
    // flag passed in dev.ts.
    execFileSync(viteBin, ['build', '--configLoader', 'runner'], {
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

    // 8. Emit dist/server/config.mjs — the isolated user-config bundle
    //    the serve binary dynamic-imports at startup. Kept separate from
    //    index.mjs so the HTML server doesn't have to load ~4 MB of
    //    Restate + NATS runtime just to read a resolve() callback.
    await buildConfigBundle({
        configPath: configPath ? join(appDir, configPath) : null,
        distDir,
        appDir,
    });

    note(`client → ${relative(repoRoot, distDir)}/`);
    note(`server → ${relative(repoRoot, serverOutDir)}/index.mjs`);
    note(`config → ${relative(repoRoot, serverOutDir)}/config.mjs`);
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
        `import { startRestateEndpoint, BusManager, realDispatcherFactory, installBusPublisher } from '@syncengine/server';`,
        `import { startHttpServer } from '@syncengine/server/serve';`,
        `import { isEntity, isBus, isService } from '@syncengine/core';`,
        `import { isWorkflow, isBusSubscriberWorkflow, isHeartbeat, isWebhook } from '@syncengine/server';`,
        `import { connectNats } from '@syncengine/gateway-core';`,
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

    // Collect entities, workflows, and heartbeats from the loaded modules.
    // The manifest lists every `.actor.ts` / `.workflow.ts` / `.heartbeat.ts`
    // file discovered by the vite plugin; we filter by tag at runtime.
    lines.push(
        `const _allModules = [${manifest.actors.map((_, i) => `_actor_${i}`).join(', ')}];`,
        `const entities = _allModules.flatMap(m => Object.values(m).filter(isEntity));`,
        `const workflows = _allModules.flatMap(m => Object.values(m).filter(isWorkflow));`,
        `const heartbeats = _allModules.flatMap(m => Object.values(m).filter(isHeartbeat));`,
        `const webhooks = _allModules.flatMap(m => Object.values(m).filter(isWebhook));`,
        `const buses = _allModules.flatMap(m => Object.values(m).filter(isBus));`,
        ``,
        `// Services are discovered two ways: (1) re-exported from an actor`,
        `// module (rare), (2) referenced on a workflow/heartbeat/webhook's`,
        `// \`$services\` array (the canonical path — that's how the hex`,
        `// adapter pattern connects primitives to ports). Dedupe by \$name`,
        `// so a service bound to two workflows only registers once in the`,
        `// ServiceContainer.`,
        `const _services = new Map();`,
        `for (const m of _allModules) {`,
        `    for (const v of Object.values(m)) {`,
        `        if (isService(v)) _services.set(v.$name, v);`,
        `    }`,
        `}`,
        `for (const def of [...workflows, ...heartbeats, ...webhooks]) {`,
        `    for (const s of def.$services ?? []) _services.set(s.$name, s);`,
        `}`,
        `const services = [..._services.values()];`,
        ``,
        `// Orphan-bus warning — fires once at boot for every declared bus`,
        `// that has no subscriber workflow. Matches loadDefinitions' behaviour`,
        `// so prod and dev agree on diagnostics.`,
        `{`,
        `    const subscribed = new Set(`,
        `        workflows`,
        `            .filter(isBusSubscriberWorkflow)`,
        `            .map(w => w.$subscription.bus.$name),`,
        `    );`,
        `    for (const b of buses) {`,
        `        if (b.$name.endsWith('.dlq') || b.$name.endsWith('.dead')) continue;`,
        `        if (!subscribed.has(b.$name)) {`,
        `            console.warn(`,
        "                `[syncengine] bus('${b.$name}') has no subscribers — events will accumulate on JetStream until the retention window expires. Declare a defineWorkflow({ on: on(${b.$name}), ... }) or remove the bus.`,",
        `            );`,
        `        }`,
        `    }`,
        `}`,
        ``,
    );

    // Start Restate endpoint
    lines.push(
        `const PORT = parseInt(process.env.PORT ?? '9080', 10);`,
        `await startRestateEndpoint(entities, workflows, PORT, heartbeats, webhooks, services);`,
        ``,
    );

    // Bus runtime — spawn a BusDispatcher per (workspace × subscriber)
    // once the Restate endpoint is listening (so dispatched Restate
    // invocations land on a ready service). Also wire the bus publisher
    // seam so workflows / webhooks / heartbeats can call bus.publish(ctx,
    // payload) imperatively (entity runtime has its own publish path).
    // Runs in BOTH syncengine start AND SYNCENGINE_HANDLERS_ONLY modes —
    // subscribers live in the handlers tier either way.
    lines.push(
        `if (workflows.some(isBusSubscriberWorkflow) || buses.length > 0) {`,
        `    const natsUrl = process.env.SYNCENGINE_NATS_URL ?? 'ws://localhost:9222';`,
        `    const restateUrl = process.env.SYNCENGINE_RESTATE_URL ?? 'http://localhost:8080';`,
        `    const busManager = new BusManager({`,
        `        natsUrl,`,
        `        restateUrl,`,
        `        workflows,`,
        `        dispatcherFactory: realDispatcherFactory,`,
        `        installSignalHandlers: process.env.SYNCENGINE_NO_BUS_SIGNALS !== '1',`,
        `    });`,
        `    await busManager.start();`,
        `    try {`,
        `        const nc = await connectNats(natsUrl);`,
        `        // installBusPublisher(nc) stores the NATS handle module-level`,
        `        // so subscriber workflow / heartbeat / webhook wrappers can`,
        `        // establish a BusContext ALS frame around user handler calls.`,
        `        // Without it, imperative bus.publish(ctx, ...) throws at runtime.`,
        `        installBusPublisher(nc);`,
        `        await busManager.attachToNats(nc);`,
        "        console.log('[syncengine] bus runtime attached to ' + natsUrl);",
        `    } catch (err) {`,
        "        console.warn('[syncengine] bus runtime could not attach to NATS: ' + (err instanceof Error ? err.message : String(err)));",
        `    }`,
        `}`,
        ``,
    );

    // Start HTTP server — unless SYNCENGINE_HANDLERS_ONLY=1, in which
    // case this process runs Restate handlers only (the scale-out
    // topology's "handlers" tier; a Bun `syncengine serve` binary on
    // the "edge" tier handles HTTP).
    lines.push(
        `if (process.env.SYNCENGINE_HANDLERS_ONLY !== '1') {`,
        `    const HTTP_PORT = parseInt(process.env.HTTP_PORT ?? '3000', 10);`,
        `    const __dirname = dirname(fileURLToPath(import.meta.url));`,
        `    const staticDir = join(__dirname, '..');`,
        `    const indexHtml = readFileSync(join(staticDir, 'index.html'), 'utf8');`,
        ``,
        `    startHttpServer({`,
        `        staticDir,`,
        `        indexHtml,`,
        `        restateUrl: process.env.SYNCENGINE_RESTATE_URL ?? 'http://localhost:8080',`,
        `        natsUrl: process.env.SYNCENGINE_NATS_URL ?? 'ws://localhost:9222',`,
        // Public URLs only differ from internal ones in split-network
        // deploys (e.g. Docker: server talks to 'http://restate:8080';
        // browser needs 'http://localhost:<published>'). Left unset
        // when the envs aren't provided — serve.ts falls back to the
        // internal URLs, preserving single-host semantics.
        `        ...(process.env.SYNCENGINE_RESTATE_PUBLIC_URL ? { publicRestateUrl: process.env.SYNCENGINE_RESTATE_PUBLIC_URL } : {}),`,
        `        ...(process.env.SYNCENGINE_NATS_PUBLIC_URL ? { publicNatsUrl: process.env.SYNCENGINE_NATS_PUBLIC_URL } : {}),`,
        `        appConfig: _config,`,
        `        port: HTTP_PORT,`,
        `    });`,
        `} else {`,
        `    console.log('[syncengine] handlers-only mode — HTTP server skipped');`,
        `}`,
    );

    return lines.join('\n') + '\n';
}
