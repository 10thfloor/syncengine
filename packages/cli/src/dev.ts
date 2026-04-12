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
 *   8. Write runtime.json (NATS / Restate URLs only — workspace ids are
 *      resolved per-request by the vite plugin's workspaces middleware
 *      based on the user's syncengine.config.ts, and provisioned lazily
 *      on first page load)
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
    canConnect,
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
} from './client';

// ── Entry ─────────────────────────────────────────────────────────────────

export async function devCommand(args: string[]): Promise<void> {
    const fresh = args.includes('--fresh');
    const rawNats = args.includes('--raw-nats');
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
        ...(!rawNats ? [{ port: ports.gateway, label: 'gateway' }] : []),
        { port: ports.workspace, label: 'workspace service' },
        { port: ports.vite, label: 'vite' },
    ]);

    const processes: ManagedProcess[] = [];
    const { shutdown, isShuttingDown } = registerShutdown(processes, {
        onDone: () => clearStateFiles(stateDir),
    });

    try {
        await boot(processes, stateDir, repoRoot, ports, rawNats);
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
    rawNats: boolean,
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

    // 4.5 Gateway (unless --raw-nats)
    if (!rawNats) {
        banner('starting gateway');
        const gw = spawnManaged(tsxBin, ['src/gateway/standalone.ts'], {
            name: 'gateway',
            cwd: serverDir,
            env: {
                ...process.env,
                PORT: String(ports.gateway),
                NATS_URL: `nats://127.0.0.1:${ports.natsClient}`,
                SYNCENGINE_RESTATE_URL: `http://127.0.0.1:${ports.restateIngress}`,
            },
        });
        processes.push(gw);
        await waitForHttp(`http://127.0.0.1:${ports.gateway}/healthz`, {
            label: 'gateway',
            timeoutMs: 15_000,
        });
        note(`gateway :${ports.gateway}`);
    }

    // 5. Write runtime.json so @syncengine/vite-plugin can pick up the
    //    NATS / Restate URLs for the running stack. This must happen
    //    BEFORE vite starts — otherwise the plugin reads a missing file
    //    and falls back to the static defaults.
    //
    //    NOTE: workspace ids are NOT pinned here. As of PLAN Phase 8 the
    //    vite plugin's workspaces sub-plugin calls the user's
    //    `syncengine.config.ts` → `workspaces.resolve({ request, user })`
    //    on every page load, hashes the result to a bounded wsKey, and
    //    lazy-provisions the first time each wsKey is seen. This lets a
    //    single dev run serve any number of users without restarts.
    writeRuntimeConfig(stateDir, {
        natsUrl: `ws://localhost:${ports.natsWs}`,
        ...(rawNats ? {} : { gatewayUrl: `ws://localhost:${ports.gateway}/gateway` }),
        restateUrl: `http://localhost:${ports.restateIngress}`,
        authToken: null,
    });
    note(
        `runtime.json → nats=ws://localhost:${ports.natsWs}` +
        (rawNats ? '' : `, gateway=ws://localhost:${ports.gateway}/gateway`) +
        `, workspaces resolved per request`,
    );

    // 6. Vite
    if (!appDir) {
        throw new Error(
            'No app directory found. Run from a directory with vite.config.ts, ' +
            'or ensure apps/example exists in the repo.',
        );
    }
    banner('starting vite dev server');
    const viteBin = join(appDir, 'node_modules', '.bin', 'vite');
    const vite = spawnManaged(viteBin, [], {
        name: 'vite',
        cwd: appDir,
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
    // so tsx's own restart has time to settle, waits for the tsx restart
    // to actually cycle (port down THEN up — just waiting for "up" would
    // race the old dying process), and calls the admin API with
    // `force: true` to trigger re-discovery. Entity state is keyed by
    // virtual-object id in Restate's persistent store, so it survives
    // the re-registration — the whole point of Phase 7.
    //
    // A re-entry guard serializes concurrent reload attempts: rapid
    // saves during a reload cycle are coalesced into a single follow-up
    // reload when the current one finishes, so we never have two
    // `restateRegisterDeployment` calls in flight at once.
    if (appDir) {
        let reloadInFlight = false;
        let reloadQueued = false;
        const reload = async (): Promise<void> => {
            if (reloadInFlight) {
                reloadQueued = true;
                return;
            }
            reloadInFlight = true;
            try {
                await waitForWorkspaceRestart(ports.workspace);
                await restateRegisterDeployment(
                    ports,
                    `http://127.0.0.1:${ports.workspace}`,
                    { force: true },
                );
                note('[hot-reload] re-registered workspace service with restate');
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                note(`[hot-reload] re-register failed: ${msg}`);
            } finally {
                reloadInFlight = false;
                if (reloadQueued) {
                    reloadQueued = false;
                    void reload();
                }
            }
        };
        watchActorFiles(appDir, () => { void reload(); });
    }

    if (!process.env.SYNCENGINE_DEV_QUIET) {
        printReadyBanner(ports, rawNats);
    }
}

/**
 * Wait for tsx to complete a restart cycle of the workspace service:
 * first detect the TCP port going DOWN (the old process shutting down),
 * then wait for it to come back UP. This is strictly stronger than
 * `waitForTcp` alone, which would race the old dying process — the
 * old tsx child may still accept connections for 100–500ms after tsx
 * signals a restart, and if we call `restateRegisterDeployment` in
 * that window Restate's admin API re-discovers against the old code.
 *
 * If the port never goes down within `downTimeoutMs`, we assume tsx
 * did not actually restart (e.g., the file change only touched test
 * fixtures in the same tree or tsx's dep-graph diff decided no rebuild
 * was needed) and proceed directly to the re-register anyway — this
 * is idempotent on Restate's side, so a spurious call is harmless.
 */
async function waitForWorkspaceRestart(port: number): Promise<void> {
    const downDeadline = Date.now() + 3_000;
    while (Date.now() < downDeadline) {
        if (!(await canConnect(port, { timeoutMs: 200 }))) {
            // Port has cycled down. Now wait for it to come back up.
            await waitForTcp(port, {
                label: 'workspace service (post-restart)',
                timeoutMs: 15_000,
            });
            // A small settling delay so the new Node process has time
            // to finish binding all Restate handlers after the port
            // starts accepting connections.
            await new Promise<void>((resolve) => setTimeout(resolve, 300));
            return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    // Port never went down. tsx may have decided not to restart. Still
    // do the re-register (idempotent) so the user gets consistent
    // behavior after every .actor.ts save.
}

/**
 * Watch the user's app directory for changes under `src/**\/*.actor.ts`
 * and invoke `onChange` (debounced) when any of them is created,
 * modified, or deleted. Uses Node's native recursive `fs.watch`, which
 * is supported on macOS and Linux (the only platforms the dev
 * orchestrator targets). On change, waits 400ms for tsx's own restart
 * to settle before firing.
 *
 * NOTE: on NFS / sshfs, inotify rename events may arrive with
 * `filename === null`, which we currently filter out via `!filename`.
 * Hot-reload is effectively disabled on those filesystems; there's
 * no cross-platform fix short of polling the directory contents.
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
 * Locate the user's app directory. Resolution order:
 *   1. CWD — if it has a vite.config.ts (scaffolded project or standalone app)
 *   2. apps/example — the monorepo's built-in example app
 *
 * The server walks `src/**\/*.actor.ts` relative to this path on startup
 * (PLAN.md Phase 4).
 */
function resolveAppDir(repoRoot: string): string | null {
    // 1. CWD has a vite config → treat it as the app
    const cwd = process.cwd();
    if (
        existsSync(join(cwd, 'vite.config.ts')) ||
        existsSync(join(cwd, 'vite.config.js'))
    ) {
        return cwd;
    }
    // 2. Monorepo convention: apps/example
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

function printReadyBanner(ports: Ports, rawNats: boolean): void {
    const bar = '━'.repeat(52);
    const gatewayLine = rawNats
        ? ''
        : `\n  \x1b[1mGateway\x1b[0m       → ws://localhost:${ports.gateway}/gateway`;
    process.stdout.write(`
\x1b[1;32m${bar}
  syncengine dev — all services ready
${bar}\x1b[0m
  \x1b[1mApp\x1b[0m           → http://localhost:${ports.vite}
  \x1b[1mNATS WS\x1b[0m       → ws://localhost:${ports.natsWs}
  \x1b[1mNATS monitor\x1b[0m  → http://localhost:${ports.natsMonitor}
  \x1b[1mRestate\x1b[0m       → http://localhost:${ports.restateIngress}
  \x1b[1mRestate admin\x1b[0m → http://localhost:${ports.restateAdmin}
  \x1b[1mWorkspace svc\x1b[0m → http://localhost:${ports.workspace}${gatewayLine}
  \x1b[1mWorkspaces\x1b[0m    → resolved per request via syncengine.config.ts
\x1b[2m
  Ctrl-C to shut everything down.\x1b[0m

`);
}
