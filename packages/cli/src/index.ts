#!/usr/bin/env node
/**
 * syncengine — developer CLI for the syncengine framework.
 *
 * Commands:
 *   syncengine dev [--fresh]         Boot NATS + Restate + workspace + Vite
 *   syncengine build                 Production build (client + server)
 *   syncengine start                 Run the production server
 *   syncengine down                  Stop a running dev stack
 *   syncengine status                Report which services are up
 *   syncengine workspace <verb>      Workspace admin (create/delete/list/info)
 *   syncengine entity get <n> <k>   Read entity instance state from Restate
 *   syncengine help                  Show this message
 */

import { initCommand } from './init';
import { devCommand } from './dev';
import { buildCommand } from './build';
import { startCommand } from './start';
import { downCommand } from './down';
import { statusCommand } from './status';
import { workspaceCommand } from './workspace';
import { entityCommand } from './entity';

async function main(): Promise<void> {
    const [, , cmd, ...args] = process.argv;

    switch (cmd) {
        case 'init':
        case 'create':
            await initCommand(args);
            break;
        case 'dev':
            await devCommand(args);
            break;
        case 'build':
            await buildCommand(args);
            break;
        case 'start':
            await startCommand(args);
            break;
        case 'down':
            await downCommand(args);
            break;
        case 'status':
            await statusCommand(args);
            break;
        case 'workspace':
        case 'ws':
            await workspaceCommand(args);
            break;
        case 'entity':
            await entityCommand(args.slice(1));
            break;
        case undefined:
        case 'help':
        case '--help':
        case '-h':
            printHelp();
            break;
        default:
            process.stderr.write(`unknown command: ${cmd}\n\n`);
            printHelp();
            process.exit(1);
    }
}

function printHelp(): void {
    process.stdout.write(`syncengine — framework CLI

Usage:
  syncengine init [dir]           Scaffold a new project
  syncengine dev [--fresh]        Start NATS + Restate + workspace + Vite
  syncengine build                Production build (client + server bundles)
  syncengine start                Run the production server
  syncengine down                 Stop a running dev stack
  syncengine status               Report which services are up
  syncengine workspace <verb>     Workspace admin (see \`workspace help\`)
  syncengine entity get <n> <k>  Read entity instance state from Restate
  syncengine help                 Show this message

Flags:
  --fresh                         Wipe .syncengine/dev/ before starting (dev only)

Environment:
  SYNCENGINE_NATS_URL             NATS WebSocket URL (production)
  SYNCENGINE_RESTATE_URL          Restate ingress URL (production)
  PORT                            Restate H2C endpoint port (default: 9080)
  HTTP_PORT                       HTTP server port (default: 3000)
  SYNCENGINE_STATE_DIR            Override .syncengine/dev state directory
  SYNCENGINE_BIN_CACHE            Override ~/.cache/syncengine binary cache
  SYNCENGINE_DEV_QUIET            Suppress ready banner at startup
`);
}

main().catch((err) => {
    process.stderr.write(`\nsyncengine: ${err?.stack ?? err}\n`);
    process.exit(1);
});
