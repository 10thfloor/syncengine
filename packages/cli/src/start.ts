/**
 * `syncengine start` — turnkey local run of the production bundle.
 *
 * Mirrors `syncengine dev`'s infra layer (NATS + Restate spawned from
 * the bin cache, deployment registered with Restate admin, default
 * workspace provisioned) but runs the pre-built `dist/server/index.mjs`
 * instead of the tsx-watched source. One instance at a time — dev and
 * start share the same state dir (`.syncengine/dev/`) and ports, so
 * running one while the other is up fails loudly at preflight.
 *
 * Real cloud deploys use the scaffolded Dockerfile and bring their own
 * NATS + Restate; this command is for local smoke tests and single-box
 * deploys where the CLI owns the whole stack.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

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
    findAppRoot,
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
import { restateRegisterDeployment, provisionWorkspace } from './client';
import { hashWorkspaceId } from '@syncengine/core/http';
import { errors, CliCode } from '@syncengine/core';

export async function startCommand(_args: string[]): Promise<void> {
    const repoRoot = await findAppRoot();
    const stateDir = stateDirFor(repoRoot);

    // Refuse to boot a second stack. Stale pids.json with dead orchestrator
    // is fine — `syncengine down` or a previous crash left it behind.
    const existing = readPids(stateDir);
    if (existing && isAlive(existing.orchestrator)) {
        throw errors.cli(CliCode.STACK_ALREADY_RUNNING, {
            message: `A syncengine stack (pid ${existing.orchestrator}) is already running.`,
            hint: `Stop it with \`syncengine down\` before starting another.`,
        });
    }

    const appDir = findBuiltApp(repoRoot);
    if (!appDir) {
        throw errors.cli(CliCode.BUILD_OUTPUT_MISSING, {
            message: `No dist/server/index.mjs found. Run \`syncengine build\` first.`,
            hint: `syncengine build && syncengine start`,
        });
    }
    const serverEntry = join(appDir, 'dist', 'server', 'index.mjs');
    note(`server entry: ${relative(repoRoot, serverEntry)}`);

    const ports: Ports = { ...DEFAULT_PORTS };
    const httpPort = parseInt(process.env.HTTP_PORT ?? '3000', 10);

    await requirePortsFree([
        { port: ports.natsClient, label: 'nats client' },
        { port: ports.natsWs, label: 'nats websocket' },
        { port: ports.natsMonitor, label: 'nats monitor' },
        { port: ports.restateIngress, label: 'restate ingress' },
        { port: ports.restateAdmin, label: 'restate admin' },
        { port: ports.restateNode, label: 'restate cluster' },
        { port: ports.workspace, label: 'server (restate h2c)' },
        { port: httpPort, label: 'http server' },
    ]);

    ensureStateDirs(stateDir);
    writePorts(stateDir, ports);

    const processes: ManagedProcess[] = [];
    const { shutdown, isShuttingDown } = registerShutdown(processes, {
        onDone: () => clearStateFiles(stateDir),
    });

    try {
        await boot(processes, stateDir, repoRoot, appDir, serverEntry, ports, httpPort);
        writePids(stateDir, buildPidsSnapshot(processes));
        writeRuntimeConfig(stateDir, {
            natsUrl: `ws://localhost:${ports.natsWs}`,
            restateUrl: `http://localhost:${ports.restateIngress}`,
            authToken: null,
        });
        banner('ready');
        note(`http     → http://localhost:${httpPort}/`);
        note(`restate  → http://localhost:${ports.restateAdmin}/ (admin)`);
        note(`nats     → ws://localhost:${ports.natsWs} (ws), :${ports.natsClient} (native)`);
        note(`Ctrl-C to stop`);
    } catch (err) {
        process.stderr.write(
            `\n\x1b[1;31msyncengine start failed:\x1b[0m ${String(err instanceof Error ? err.message : err)}\n`,
        );
        await shutdown('error');
        if (!isShuttingDown()) process.exit(1);
    }

    // Keep the orchestrator alive until SIGINT / SIGTERM.
    await new Promise<void>(() => { /* never resolves */ });
}

// ── Boot sequence ─────────────────────────────────────────────────────────

async function boot(
    processes: ManagedProcess[],
    stateDir: string,
    repoRoot: string,
    appDir: string,
    serverEntry: string,
    ports: Ports,
    httpPort: number,
): Promise<void> {
    // 1. NATS + Restate in parallel (same config + args as `syncengine dev`).
    banner('starting nats-server and restate-server');
    const natsPath = await natsBinary();
    const natsConfPath = writeNatsConfig(stateDir, ports);
    const nats = spawnManaged(natsPath, ['-c', natsConfPath], {
        name: 'nats',
        cwd: repoRoot,
        silent: true,
    });
    processes.push(nats);

    const restatePath = await restateBinary();
    const restate = spawnManaged(
        restatePath,
        [
            '--base-dir', join(stateDir, 'restate'),
            '--node-name', 'syncengine-prod',
            '--advertised-address', `http://127.0.0.1:${ports.restateNode}`,
        ],
        {
            name: 'restate',
            cwd: repoRoot,
            silent: true,
            env: {
                ...process.env,
                RESTATE_LOG_FILTER: process.env.RESTATE_LOG_FILTER ?? 'warn,restate=info',
                RESTATE_AUTO_PROVISION: 'true',
                RESTATE_CLUSTER_NAME: 'syncengine-prod',
            },
        },
    );
    processes.push(restate);

    await Promise.all([
        waitForTcp(ports.natsClient, { label: 'nats client', timeoutMs: 15_000 })
            .then(() => waitForHttp(`http://127.0.0.1:${ports.natsMonitor}/healthz`, {
                label: 'nats monitor',
                timeoutMs: 15_000,
            }))
            .then(() => note(`nats listening on :${ports.natsClient} (ws :${ports.natsWs}, mon :${ports.natsMonitor})`)),
        waitForHttp(`http://127.0.0.1:${ports.restateAdmin}/health`, {
            label: 'restate admin',
            timeoutMs: 60_000,
        })
            .then(() => note(`restate admin :${ports.restateAdmin}, ingress :${ports.restateIngress}`)),
    ]);

    // 2. Bundled production server. Listens on PORT (Restate H2C endpoint)
    //    + HTTP_PORT (public) in-process — no separate gateway to spawn.
    banner('starting production server');
    const server = spawnManaged('node', [serverEntry], {
        name: 'workspace',
        cwd: appDir,
        env: {
            ...process.env,
            PORT: String(ports.workspace),
            HTTP_PORT: String(httpPort),
            NATS_URL: `nats://127.0.0.1:${ports.natsClient}`,
            SYNCENGINE_NATS_URL: `ws://localhost:${ports.natsWs}`,
            SYNCENGINE_RESTATE_URL: `http://localhost:${ports.restateIngress}`,
            RESTATE_LOGGING: process.env.RESTATE_LOGGING ?? 'WARN',
        },
    });
    processes.push(server);
    await waitForTcp(ports.workspace, { label: 'production server', timeoutMs: 30_000 });
    note(`production server :${ports.workspace} (http :${httpPort})`);

    // 3. Register the running bundle with Restate. Without this step the
    //    first incoming request gets `service 'workspace' not found` —
    //    Restate needs the admin-API discovery to learn the handler URI.
    banner('registering production server with restate');
    await restateRegisterDeployment(ports, `http://127.0.0.1:${ports.workspace}`);
    note('production server registered');

    // 4. Provision the default workspace (creates the NATS JetStream stream
    //    clients subscribe to). Mirrors `syncengine dev`'s boot step.
    const defaultWsKey = hashWorkspaceId('default');
    await provisionWorkspace(ports, defaultWsKey);
    note(`workspace ${defaultWsKey} provisioned (stream ready)`);
}

// ── Helpers ──────────────────────────────────────────────────────────────

function findBuiltApp(repoRoot: string): string | null {
    const candidates = [join(repoRoot, 'apps', 'example'), repoRoot];
    for (const dir of candidates) {
        if (existsSync(join(dir, 'dist', 'server', 'index.mjs'))) return dir;
    }
    return null;
}

function ensureStateDirs(stateDir: string): void {
    // `writePorts` / `writePids` already `mkdirSync { recursive }` the
    // parent, but the NATS JetStream store dir and Restate base dir are
    // opened by the child processes themselves — create them eagerly so
    // the first write doesn't race a late mkdir.
    for (const sub of ['jetstream', 'restate']) {
        mkdirSync(join(stateDir, sub), { recursive: true });
    }
}

function writeNatsConfig(stateDir: string, ports: Ports): string {
    // Intentionally duplicated from dev.ts. If a third caller ever needs
    // this, lift both to a shared `infra.ts`.
    const confPath = join(stateDir, 'nats-server.conf');
    const jetstreamDir = join(stateDir, 'jetstream');
    const body = `# Generated by syncengine start — do not edit manually
listen: 0.0.0.0:${ports.natsClient}
http_port: ${ports.natsMonitor}
server_name: syncengine_prod

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

function buildPidsSnapshot(processes: ManagedProcess[]): Pids {
    // Mirrors dev.ts/buildPidsSnapshot — duplicated intentionally to
    // keep start.ts self-contained; `syncengine down` reads whichever
    // shape was written.
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
