import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export async function addCommand(args: string[]): Promise<void> {
    const [kind, name] = args;

    if (kind !== 'service') {
        console.error(`syncengine add: unknown kind '${kind}'. Supported: syncengine add service <name>`);
        process.exit(1);
    }

    if (!name || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
        console.error(`syncengine add service: invalid name '${name}'. Use letters, numbers, underscores; start with a letter.`);
        process.exit(1);
    }

    const servicesDir = join(resolve('.'), 'src', 'services');
    mkdirSync(servicesDir, { recursive: true });

    const filePath = join(servicesDir, `${name}.ts`);
    if (existsSync(filePath)) {
        console.error(`Service file already exists: ${filePath}`);
        process.exit(1);
    }

    const content = `import { service } from '@syncengine/core';

export const ${name} = service('${name}', {
  // Add your methods here. Each must be async and return serializable data.
  // Example:
  //   async fetch(id: string) {
  //     const res = await externalApi.get(id);
  //     return { id: res.id, name: res.name };
  //   },
});
`;

    writeFileSync(filePath, content);
    console.log(`Created: src/services/${name}.ts`);
}
