#!/usr/bin/env node
/**
 * syncengine — developer CLI for the syncengine monorepo.
 *
 * Commands:
 *   syncengine dev [--fresh]         Boot NATS + Restate + workspace + Vite
 *   syncengine down                  Stop a running dev stack
 *   syncengine status                Report which services are up
 *   syncengine workspace <verb>      Workspace admin (create/delete/list/info)
 *   syncengine help                  Show this message
 */

import { devCommand } from './dev';
import { downCommand } from './down';
import { statusCommand } from './status';
import { workspaceCommand } from './workspace';

async function main(): Promise<void> {
    const [, , cmd, ...args] = process.argv;

    switch (cmd) {
        case 'dev':
            await devCommand(args);
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
    process.stdout.write(`syncengine — developer CLI

Usage:
  syncengine dev [--fresh]        Start NATS + Restate + workspace + Vite
  syncengine down                 Stop a running dev stack
  syncengine status               Report which services are up
  syncengine workspace <verb>     Workspace admin (see \`workspace help\`)
  syncengine help                 Show this message

Flags:
  --fresh                         Wipe .syncengine/dev/ before starting

Environment:
  SYNCENGINE_STATE_DIR            Override .syncengine/dev state directory
  SYNCENGINE_BIN_CACHE            Override ~/.cache/syncengine binary cache
  SYNCENGINE_DEV_QUIET            Suppress ready banner at startup
`);
}

main().catch((err) => {
    process.stderr.write(`\nsyncengine: ${err?.stack ?? err}\n`);
    process.exit(1);
});
