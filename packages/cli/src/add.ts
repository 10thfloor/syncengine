import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export async function addCommand(args: string[]): Promise<void> {
    const [kind, name] = args;

    if (kind === 'service') {
        addService(name);
        return;
    }
    if (kind === 'bus') {
        addBus(name);
        return;
    }

    console.error(
        `syncengine add: unknown kind '${kind}'. Supported: ` +
        `syncengine add service <name> | syncengine add bus <name>`,
    );
    process.exit(1);
}

function addService(name: string | undefined): void {
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

function addBus(name: string | undefined): void {
    // Bus name rules match the core primitive's regex — no dots,
    // reserving the `.dlq` / `.dead` suffixes for auto-generated DLQs.
    if (!name || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
        console.error(
            `syncengine add bus: invalid name '${name}'. ` +
            `Use letters, numbers, hyphens, underscores; start with a letter. No dots.`,
        );
        process.exit(1);
    }

    const eventsDir = join(resolve('.'), 'src', 'events');
    mkdirSync(eventsDir, { recursive: true });

    const filePath = join(eventsDir, `${name}.bus.ts`);
    if (existsSync(filePath)) {
        console.error(`Bus file already exists: ${filePath}`);
        process.exit(1);
    }

    const content = `import { bus } from '@syncengine/core';
import { z } from 'zod';

// Define the payload shape for every event on this bus. Subscribers
// and publishers both see this type; framework validates at publish
// time so bad shapes never reach NATS.
export const ${name}Schema = z.object({
    id: z.string(),
    at: z.number(),
    // ...your fields
});

export const ${name} = bus('${name}', {
    schema: ${name}Schema,
    // Override defaults with typed Retention / Delivery / Storage factories:
    //   retention: Retention.durableFor(days(30)).maxMessages(1_000_000),
    //   delivery: Delivery.fanout(),   // or Delivery.queue() for work-queue
    //   storage: Storage.replicatedFile({ replicas: 3 }),
    //   dedupWindow: minutes(5),
});
`;

    writeFileSync(filePath, content);
    console.log(`Created: src/events/${name}.bus.ts`);
}
