/**
 * `syncengine workspace <verb>` — admin commands for the workspace
 * virtual object. Thin wrappers around the Restate ingress/admin APIs.
 *
 * Subcommands:
 *   create <id> [--tenant X]   Provision a new workspace (creates the
 *                              NATS JetStream and a Restate virtual
 *                              object keyed by id).
 *   delete <id>                Teardown: delete the stream and mark
 *                              the workspace object as deleted.
 *   list                       Enumerate all WS_* streams from NATS
 *                              and show their sizes.
 *   info <id>                  Dump workspace state + members +
 *                              stream details.
 *
 * All commands refuse to run if no dev stack is reachable (printed by
 * `requireStackRunning` from client.ts as a helpful error).
 */

import { banner } from './runner';
import { findAppRoot, stateDirFor, readPortsOrDefaults, type Ports } from './state';
import {
    provisionWorkspace,
    teardownWorkspace,
    getWorkspaceState,
    listWorkspaceMembers,
    natsListStreams,
    streamNameToWorkspaceId,
    requireStackRunning,
    type WorkspaceState,
    type WorkspaceMember,
} from './client';
import { SyncEngineError, CliCode } from '@syncengine/core';

export async function workspaceCommand(args: string[]): Promise<void> {
    const [sub, ...rest] = args;

    try {
        switch (sub) {
            case 'create':
                await workspaceCreate(rest);
                break;
            case 'delete':
            case 'rm':
                await workspaceDelete(rest);
                break;
            case 'list':
            case 'ls':
                await workspaceList();
                break;
            case 'info':
                await workspaceInfo(rest);
                break;
            case undefined:
            case 'help':
            case '--help':
            case '-h':
                printWorkspaceHelp();
                break;
            default:
                process.stderr.write(`unknown workspace subcommand: ${sub}\n\n`);
                printWorkspaceHelp();
                process.exit(1);
        }
    } catch (err) {
        if (err instanceof SyncEngineError && err.code === CliCode.STACK_NOT_RUNNING) {
            process.stderr.write(`\n\x1b[1;31m${err.message}\x1b[0m\n\n`);
            process.exit(1);
        }
        throw err;
    }
}

// ── create ─────────────────────────────────────────────────────────────

async function workspaceCreate(args: string[]): Promise<void> {
    const { id, tenant } = parseCreateArgs(args);
    const ports = await resolvePorts();

    banner(`provisioning workspace '${id}'`);
    const state = await provisionWorkspace(ports, id, tenant);
    printWorkspaceState(state);
}

function parseCreateArgs(args: string[]): { id: string; tenant: string } {
    let id: string | undefined;
    let tenant = 'default';
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--tenant' || arg === '-t') {
            tenant = args[++i] ?? tenant;
        } else if (!id && !arg.startsWith('-')) {
            id = arg;
        }
    }
    if (!id) {
        process.stderr.write('usage: syncengine workspace create <id> [--tenant <tenant-id>]\n');
        process.exit(1);
    }
    return { id, tenant };
}

// ── delete ─────────────────────────────────────────────────────────────

async function workspaceDelete(args: string[]): Promise<void> {
    const id = args.find((a) => !a.startsWith('-'));
    if (!id) {
        process.stderr.write('usage: syncengine workspace delete <id>\n');
        process.exit(1);
    }

    const ports = await resolvePorts();
    banner(`tearing down workspace '${id}'`);
    const result = await teardownWorkspace(ports, id);
    if (result.deleted) {
        process.stdout.write(`\x1b[1;32m✓\x1b[0m workspace '${id}' deleted\n`);
    } else {
        process.stdout.write(`\x1b[2m  workspace '${id}' did not exist\x1b[0m\n`);
    }
}

// ── list ───────────────────────────────────────────────────────────────

async function workspaceList(): Promise<void> {
    const ports = await resolvePorts();
    // Check Restate first — uniform error regardless of subcommand
    await requireStackRunning(ports);
    const streams = await natsListStreams(ports);

    interface WorkspaceRow {
        stream: string;
        id: string;
        messages: number;
        bytes: number;
        consumers: number;
    }

    const workspaces: WorkspaceRow[] = streams.flatMap((s) => {
        const id = streamNameToWorkspaceId(s.name);
        if (id === null) return [];
        return [{
            stream: s.name,
            id,
            messages: s.state.messages,
            bytes: s.state.bytes,
            consumers: s.state.consumer_count,
        }];
    });

    if (workspaces.length === 0) {
        process.stdout.write('\n\x1b[2mno workspaces provisioned\x1b[0m\n\n');
        return;
    }

    printTable<WorkspaceRow>([
        { header: 'ID', get: (w) => w.id },
        { header: 'STREAM', get: (w) => w.stream },
        { header: 'MSGS', get: (w) => String(w.messages) },
        { header: 'BYTES', get: (w) => formatBytes(w.bytes) },
        { header: 'CONSUMERS', get: (w) => String(w.consumers) },
    ], workspaces);
}

// ── info ───────────────────────────────────────────────────────────────

async function workspaceInfo(args: string[]): Promise<void> {
    const id = args.find((a) => !a.startsWith('-'));
    if (!id) {
        process.stderr.write('usage: syncengine workspace info <id>\n');
        process.exit(1);
    }

    const ports = await resolvePorts();
    const [state, members] = await Promise.all([
        getWorkspaceState(ports, id).catch(() => null),
        listWorkspaceMembers(ports, id).catch(() => ({ members: [] as WorkspaceMember[] })),
    ]);

    if (!state) {
        process.stderr.write(`no workspace with id '${id}'\n`);
        process.exit(1);
    }

    printWorkspaceState(state);

    if (members.members.length === 0) {
        process.stdout.write('\n  \x1b[2mmembers: (none)\x1b[0m\n');
    } else {
        process.stdout.write('\n  \x1b[1mmembers:\x1b[0m\n');
        for (const m of members.members) {
            process.stdout.write(`    • ${m.userId}  \x1b[2m${m.role}\x1b[0m\n`);
        }
    }

    // Stream info
    const streams = await natsListStreams(ports);
    const stream = streams.find((s) => s.name === state.streamName);
    if (stream) {
        const { state: st, config: cfg } = stream;
        process.stdout.write(`
  \x1b[1mjetstream:\x1b[0m
    name:      ${stream.name}
    subjects:  ${cfg.subjects.join(', ')}
    retention: ${cfg.retention}
    messages:  ${st.messages}
    bytes:     ${formatBytes(st.bytes)}
    seq range: ${st.first_seq}..${st.last_seq}
    consumers: ${st.consumer_count}
`);
    }
    process.stdout.write('\n');
}

// ── Helpers ────────────────────────────────────────────────────────────

async function resolvePorts(): Promise<Ports> {
    const repoRoot = await findAppRoot();
    const stateDir = stateDirFor(repoRoot);
    return readPortsOrDefaults(stateDir);
}

function printWorkspaceState(state: WorkspaceState): void {
    process.stdout.write(`
  \x1b[1m${state.workspaceId}\x1b[0m
    tenant:        ${state.tenantId}
    status:        ${workspaceStatusColor(state.status)}${state.status}\x1b[0m
    schemaVersion: ${state.schemaVersion}
    stream:        ${state.streamName}
    createdAt:     ${state.createdAt}
`);
}

function workspaceStatusColor(status: WorkspaceState['status']): string {
    switch (status) {
        case 'active':                     return '\x1b[32m';
        case 'deleted':
        case 'teardown':                   return '\x1b[31m';
        case 'provisioning':               return '\x1b[33m';
    }
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

interface Column<T> {
    header: string;
    get: (row: T) => string;
}

function printTable<T>(cols: Array<Column<T>>, rows: T[]): void {
    const widths = cols.map((c) =>
        Math.max(c.header.length, ...rows.map((r) => c.get(r).length)),
    );
    const line = (cells: string[]) =>
        cells.map((c, i) => c.padEnd(widths[i])).join('  ');

    process.stdout.write('\n');
    process.stdout.write('  \x1b[1m' + line(cols.map((c) => c.header)) + '\x1b[0m\n');
    for (const row of rows) {
        process.stdout.write('  ' + line(cols.map((c) => c.get(row))) + '\n');
    }
    process.stdout.write('\n');
}

// ── Help ───────────────────────────────────────────────────────────────

function printWorkspaceHelp(): void {
    process.stdout.write(`syncengine workspace — workspace admin

Usage:
  syncengine workspace create <id> [--tenant <tenant-id>]
      Provision a new workspace and its NATS JetStream.

  syncengine workspace delete <id>
      Teardown a workspace. Deletes the stream and marks the object
      as deleted in Restate.

  syncengine workspace list
      Enumerate all provisioned workspaces with stream stats.

  syncengine workspace info <id>
      Show workspace state, members, and stream details.

All commands require a running dev stack (\`pnpm dev\`).
`);
}
