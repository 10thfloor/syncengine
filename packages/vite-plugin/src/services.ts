import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Plugin } from 'vite';

export function servicesPlugin(): Plugin {
    let appRoot = '';
    const discoveredServices: string[] = [];

    return {
        name: 'syncengine:services',

        configResolved(config) {
            appRoot = config.root;
        },

        buildStart() {
            discoveredServices.length = 0;
            const servicesDir = join(appRoot, 'src', 'services');
            if (!existsSync(servicesDir)) return;

            let entries: string[];
            try {
                entries = readdirSync(servicesDir);
            } catch {
                return;
            }

            for (const entry of entries) {
                const full = join(servicesDir, entry);
                try {
                    if (statSync(full).isDirectory()) continue;
                } catch {
                    continue;
                }
                if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue;
                if (entry.startsWith('.')) continue;

                const name = basename(entry, entry.endsWith('.tsx') ? '.tsx' : '.ts');
                discoveredServices.push(name);
            }

            if (discoveredServices.length > 0) {
                console.log(`[syncengine] services: ${discoveredServices.join(', ')}`);
            }
        },
    };
}
