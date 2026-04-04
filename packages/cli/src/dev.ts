/**
 * `syncengine dev` — the one-command orchestrator.
 *
 * Startup sequence:
 *   1. Resolve repo root + state dir, optionally `--fresh` (wipe first)
 *   2. Write ports.json so other commands can find the running stack
 *   3. Generate nats-server config pointing at local JetStream store
 *   4. Spawn nats-server  → wait for port + monitor /healthz
 *   5. Spawn restate-server → wait for admin /health
 *   6. Spawn workspace service → wait for TCP (service speaks h2c)
 *   7. POST to Restate admin to register the workspace deployment
 *   8. POST workspace.provision() for the 'demo' workspace
 *   9. Spawn Vite dev server
 *  10. Write pids.json with the full child set
 *
 * On SIGINT, children are terminated in reverse order via process groups
 * and both state files are unlinked. Second Ctrl-C force-kills.
 */

import { mkdirSync, rmSync, watch, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { binaryPath as natsBinary } from '@syncengine/nats-bin';
import { binaryPath as restateBinary } from '@syncengine/restate-bin';

import {
    banner,
    note,
    spawnManaged,
    registerShutdown,
    waitForHttp,
    waitForTcp,
    requirePortsFree,
    type ManagedProcess,
} from './runner';
import {
    DEFAULT_PORTS,
    findRepoRoot,
    stateDirFor,
    writePorts,
    writePids,
    writeRuntimeConfig,
    readPids,
    isAlive,
    clearStateFiles,
    type Pids,
    type Ports,
} from './state';
import {
    restateRegisterDeployment,
    provisionWorkspace,
} from './client';

const DEMO_WORKSPACE_ID = 'demo';

// ── Entry ─────────────────────────────────────────────────────────────────

export async function devCommand(args: string[]): Promise<void> {
    const fresh = args.includes('--fresh');
    const repoRoot = await findRepoRoot();
    const stateDir = stateDirFor(repoRoot);

    // --fresh: wipe the state dir, but refuse to nuke state that belongs
    // to a currently-running orchestrator (that would orphan processes
    // and corrupt Restate's RocksDB mid-write).
    if (fresh) {
        const existing = readPids(stateDir);
        if (existing && isAlive(existing.orchestrator)) {
            throw new Error(
                `--fresh refused: a syncengine dev stack (pid ${existing.orchestrator}) is already running.\n` +
                `Run \`syncengine down\` first, then retry with \`syncengine dev --fresh\`.`,
            );
        }

        // Safety guard: `rmSync` with `recursive: true, force: true` is a
        // footgun. Since `stateDir` can be overridden via SYNCENGINE_STATE_DIR,
        // a misconfigured env var could point it at `/` or `$HOME`. Refuse to
        // wipe anything that isn't clearly a syncengine state directory.
        if (!isSafeStateDirToWipe(stateDir, repoRoot)) {
            throw new Error(
                `--fresh refused: state dir ${stateDir} is outside the expected locations.\n` +
                `Expected either <repoRoot>/.syncengine/dev or ~/.syncengine/dev.\n` +
                `Remove SYNCENGINE_STATE_DIR or delete the directory manually.`,
            );
        }

        if (existsSync(stateDir)) {
            banner('--fresh: wiping dev state');
            rmSync(stateDir, { recursive: true, force: true });
        }
    }

    ensureStateDirs(stateDir);

    // Persist the chosen ports immediately so concurrent `status` /
    // `workspace *` commands can discover them even during boot.
    const ports: Ports = { ...DEFAULT_PORTS };
    writePorts(stateDir, ports);

    // Preflight: fail fast if any required port is held by a pre-existing
    // process (old docker container, zombie syncengine, etc). Better to
    // crash cleanly here than have half the stack come up pointed at the
    // wrong server.
    await requirePortsFree([
        { port: ports.natsClient, label: 'nats client' },
        { port: ports.natsWs, label: 'nats websocket' },
        { port: ports.natsMonitor, label: 'nats monitor' },
        { port: ports.restateIngress, label: 'restate ingress' },
        { port: ports.restateAdmin, label: 'restate admin' },
        { port: ports.restateNode, label: 'restate cluster' },
        { port: ports.workspace, label: 'workspace service' },
        { port: ports.vite, label: 'vite' },
    ]);

    const processes: ManagedProcess[] = [];
    const { shutdown, isShuttingDown } = registerShutdown(processes, {
        onDone: () => clearStateFiles(stateDir),
    });

    try {
        await boot(processes, stateDir, repoRoot, ports);
        // Everything is up — record the full pid set for `syncengine down`.
        writePids(stateDir, buildPidsSnapshot(processes));
    } catch (err) {
        process.stderr.write(
            `\n\x1b[1;31msyncengine dev failed:\x1b[0m ${String(err instanceof Error ? err.message : err)}\n`,
        );
        // Run shutdown (idempotent with any SIGINT-triggered shutdown that
        // might already be in flight). `clearStateFiles` is called exactly
        // once via the `onDone` hook — no explicit call here.
        await shutdown('error');
        // Only exit 1 if no signal handler has already claimed the exit
        // code. If SIGINT arrived during boot, let its `.finally(exit 130)`
        // win so the caller sees the standard signal exit code.
        if (!isShuttingDown()) process.exit(1);
    }

    // Keep the orchestrator alive — shutdown is driven by SIGINT
    await new Promise<void>(() => { /* never resolves */ });
}

// ── Boot sequence ─────────────────────────────────────────────────────────

async function boot(
    processes: ManagedProcess[],
    stateDir: string,
    repoRoot: string,
    ports: Ports,
): Promise<void> {
    // 1. NATS
    banner('starting nats-server');
    const natsPath = await natsBinary();
    const natsConfPath = writeNatsConfig(stateDir, ports);
    const nats = spawnManaged(natsPath, ['-c', natsConfPath], {
        name: 'nats',
        cwd: repoRoot,
    });
    processes.push(nats);
    await waitForTcp(ports.natsClient, { label: 'nats client', timeoutMs: 15_000 });
    await waitForHttp(`http://127.0.0.1:${ports.natsMonitor}/healthz`, {
        label: 'nats monitor',
        timeoutMs: 15_000,
    });
    note(`nats listening on :${ports.natsClient} (ws :${ports.natsWs}, mon :${ports.natsMonitor})`);

    // 2. Restate
    banner('starting restate-server');
    const restatePath = await restateBinary();
    const restateBaseDir = join(stateDir, 'restate');
    const restate = spawnManaged(
        restatePath,
        ['--base-dir', restateBaseDir, '--node-name', 'syncengine-dev'],
        {
            name: 'restate',
            cwd: repoRoot,
            env: {
                ...process.env,
                RESTATE_LOG_FILTER: process.env.RESTATE_LOG_FILTER ?? 'warn,restate=info',
            },
        },
    );
    processes.push(restate);
    await waitForHttp(`http://127.0.0.1:${ports.restateAdmin}/health`, {
        label: 'restate admin',
        timeoutMs: 60_000,
    });
    note(`restate admin :${ports.restateAdmin}, ingress :${ports.restateIngress}`);

    // 3. Workspace service (tsx directly — going through pnpm breaks the
    //    process-group kill cascade on shutdown)
    banner('starting workspace service');
    const serverDir = join(repoRoot, 'packages', 'server');
    const tsxBin = join(serverDir, 'node_modules', '.bin', 'tsx');
    // PLAN Phase 4: tell the server the user's app directory so it can
    // glob `src/**/*.actor.ts` on startup. Missing dir is OK — the
    // server runs without entities.
    const appDir = resolveAppDir(repoRoot);
    const workspace = spawnManaged(tsxBin, ['watch', 'src/index.ts'], {
        name: 'workspace',
        cwd: serverDir,
        env: {
            ...process.env,
            PORT: String(ports.workspace),
            NATS_URL: `nats://127.0.0.1:${ports.natsClient}`,
            ...(appDir ? { SYNCENGINE_APP_DIR: appDir } : {}),
        },
    });
    processes.push(workspace);
    if (appDir) note(`entities → ${appDir.replace(repoRoot + sep, '')}/src/**/*.actor.ts`);
    // Restate services speak HTTP/2 cleartext — Node's fetch can't probe
    // them directly, so we use a TCP-level readiness check.
    await waitForTcp(ports.workspace, { label: 'workspace service', timeoutMs: 30_000 });
    note(`workspace service :${ports.workspace}`);

    // 4. Register the deployment with Restate
    banner('registering workspace service with restate');
    await restateRegisterDeployment(ports, `http://127.0.0.1:${ports.workspace}`);
    note('workspace service registered');

    // 5. Auto-provision the default 'demo' workspace
    banner(`provisioning workspace '${DEMO_WORKSPACE_ID}'`);
    await provisionWorkspace(ports, DEMO_WORKSPACE_ID);
    note(`workspace '${DEMO_WORKSPACE_ID}' ready`);

    // 5b. Write runtime.json so @syncengine/vite-plugin can populate
    //     `virtual:syncengine/runtime-config` when Vite boots. This must
    //     happen BEFORE vite starts — otherwise the plugin reads a missing
    //     file and falls back to the static defaults.
    writeRuntimeConfig(stateDir, {
        workspaceId: DEMO_WORKSPACE_ID,
        natsUrl: `ws://localhost:${ports.natsWs}`,
        restateUrl: `http://localhost:${ports.restateIngress}`,
        authToken: null,
    });
    note(`runtime.json → workspace=${DEMO_WORKSPACE_ID}, nats=ws://localhost:${ports.natsWs}`);

    // 6. Vite
    banner('starting vite dev server');
    const exampleDir = join(repoRoot, 'apps', 'example');
    const viteBin = join(exampleDir, 'node_modules', '.bin', 'vite');
    const vite = spawnManaged(viteBin, [], {
        name: 'vite',
        cwd: exampleDir,
        env: { ...process.env, FORCE_COLOR: '1' },
    });
    processes.push(vite);
    await waitForTcp(ports.vite, { label: 'vite', timeoutMs: 30_000 });

    // 7. PLAN Phase 7 — HMR for actor files.
    //
    // tsx already auto-restarts the workspace service when any .ts file
    // in its watch set changes, so edits to handler BODIES take effect
    // immediately. What tsx can't do is tell Restate's admin API about
    // changed SERVICE METADATA (new handlers added, handler signatures
    // changed). Restate caches the service's handler list from the
    // original `register-deployment` call, so an unknown handler looks
    // like a 404 until we re-discover.
    //
    // This watcher sits in the CLI process (which knows the admin port
    // and the workspace service URI), debounces .actor.ts change events
    // so tsx's own restart has time to settle, waits for the workspace
    // service TCP port to be live again, and calls the admin API with
    // `force: true` to trigger re-discovery. Entity state is keyed by
    // virtual-object id in Restate's persistent store, so it survives
    // the re-registration — the whole point of Phase 7.
    if (appDir) {
        watchActorFiles(appDir, async () => {
            try {
                await waitForTcp(ports.workspace, {
                    label: 'workspace service',
                    timeoutMs: 10_000,
                });
                await restateRegisterDeployment(
                    ports,
                    `http://127.0.0.1:${ports.workspace}`,
                    { force: true },
                );
                note('[hot-reload] re-registered workspace service with restate');
            } catch (err) {
                process.stderr.write(
                    `\x1b[33m[hot-reload] re-register failed: ${String((err as Error).message ?? err)}\x1b[0m\n`,
                );
            }
        });
    }

    if (!process.env.SYNCENGINE_DEV_QUIET) {
        printReadyBanner(ports);
    }
}

/**
 * Watch the user's app directory for changes under `src/**\/*.actor.ts`
 * and invoke `onChange` (debounced) when any of them is created,
 * modified, or deleted. Uses Node's native recursive `fs.watch`, which
 * is supported on macOS and Linux (the only platforms the dev
 * orchestrator targets). On change, waits 400ms for tsx's own restart
 * to settle before firing.
 */
function watchActorFiles(appDir: string, onChange: () => void): void {
    const srcDir = join(appDir, 'src');
    if (!existsSync(srcDir)) return;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    try {
        watch(
            srcDir,
            { recursive: true, persistent: false },
            (_event, filename) => {
                if (!filename || !String(filename).endsWith('.actor.ts')) return;
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    debounceTimer = null;
                    onChange();
                }, 400);
            },
        );
    } catch (err) {
        process.stderr.write(
            `\x1b[33m[hot-reload] fs.watch(${srcDir}) failed: ${String((err as Error).message ?? err)} — actor hot-reload disabled\x1b[0m\n`,
        );
    }
}

// ── State helpers ─────────────────────────────────────────────────────────

function ensureStateDirs(stateDir: string): void {
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(join(stateDir, 'jetstream'), { recursive: true });
    mkdirSync(join(stateDir, 'restate'), { recursive: true });
}

/**
 * Allow wiping only state directories that look like ours — either the
 * in-repo `.syncengine/dev` or the home-scoped `~/.syncengine/dev`. Any
 * other target (typical signal of a misconfigured SYNCENGINE_STATE_DIR)
 * is rejected to prevent `rmSync(..., { force: true })` from silently
 * deleting unrelated files.
 */
function isSafeStateDirToWipe(stateDir: string, repoRoot: string): boolean {
    const resolvedState = resolve(stateDir);
    const insideRepo = resolve(repoRoot, '.syncengine', 'dev');
    const insideHome = resolve(homedir(), '.syncengine', 'dev');
    if (resolvedState === insideRepo || resolvedState === insideHome) return true;
    // Also allow any path explicitly nested under the repo's .syncengine dir
    // (e.g. users who run their own per-branch state subdir).
    const repoSyncDir = resolve(repoRoot, '.syncengine') + sep;
    return resolvedState.startsWith(repoSyncDir);
}

/**
 * Locate the user's app directory. Convention:
 *   apps/{app}
 *
 * The server walks `src/**\/*.actor.ts` relative to this path on startup
 * (PLAN.md Phase 4). apps/example is the only app today; if/when
 * multi-app lands the resolver can scan `apps/*` dynamically.
 */
function resolveAppDir(repoRoot: string): string | null {
    const candidate = join(repoRoot, 'apps', 'example');
    return existsSync(candidate) ? candidate : null;
}

function buildPidsSnapshot(processes: ManagedProcess[]): Pids {
    const children: Pids['children'] = {};
    for (const { name, child } of processes) {
        if (child.pid) children[name as keyof Pids['children']] = child.pid;
    }
    return {
        orchestrator: process.pid,
        startedAt: Date.now(),
        children,
    };
}

// ── NATS config generation ────────────────────────────────────────────────

function writeNatsConfig(stateDir: string, ports: Ports): string {
    const confPath = join(stateDir, 'nats-server.conf');
    const jetstreamDir = join(stateDir, 'jetstream');
    const body = `# Generated by syncengine dev — do not edit manually
# Local-dev NATS config with JetStream + WebSocket for browser clients.

listen: 0.0.0.0:${ports.natsClient}
http_port: ${ports.natsMonitor}
server_name: syncengine_dev

websocket {
  listen: "0.0.0.0:${ports.natsWs}"
  no_tls: true
}

jetstream {
  store_dir: "${jetstreamDir.replace(/"/g, '\\"')}"
  max_mem: 256MB
  max_file: 1GB
}

authorization {
  default_permissions = {
    publish = ">"
    subscribe = ">"
  }
}

debug: false
trace: false
logtime: true
`;
    writeFileSync(confPath, body);
    return confPath;
}

// ── Ready banner ──────────────────────────────────────────────────────────

function printReadyBanner(ports: Ports): void {
    const bar = '━'.repeat(52);
    process.stdout.write(`
\x1b[1;32m${bar}
  syncengine dev — all services ready
${bar}\x1b[0m
  \x1b[1mApp\x1b[0m           → http://localhost:${ports.vite}
  \x1b[1mNATS WS\x1b[0m       → ws://localhost:${ports.natsWs}
  \x1b[1mNATS monitor\x1b[0m  → http://localhost:${ports.natsMonitor}
  \x1b[1mRestate\x1b[0m       → http://localhost:${ports.restateIngress}
  \x1b[1mRestate admin\x1b[0m → http://localhost:${ports.restateAdmin}
  \x1b[1mWorkspace svc\x1b[0m → http://localhost:${ports.workspace}
  \x1b[1mDemo workspace\x1b[0m → ${DEMO_WORKSPACE_ID}
\x1b[2m
  Ctrl-C to shut everything down.\x1b[0m

`);
}
