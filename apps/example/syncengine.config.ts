import { defineConfig } from '@syncengine/core';

/**
 * Example app workspace resolver.
 *
 * In a real application this would consult a session / auth provider
 * (Clerk, Auth.js, custom JWT, …) and return a stable id that anchors
 * the user's sync scope — typically `user:<id>`, `org:<id>`, or some
 * mix derived from the URL path.
 *
 * For the demo we read a `?user=<name>` query param off the incoming
 * request and fall back to `anon`. Two browser tabs with different
 * `?user=` values end up in two different NATS streams and two
 * different Restate virtual objects — completely isolated state,
 * without the app code needing to know how multi-tenancy works.
 *
 * The string returned here is hashed inside the plugin to a bounded
 * 16-hex-char `wsKey` before it hits NATS / Restate, so long ids are
 * fine.
 */
export default defineConfig({
    workspaces: {
        resolve: ({ request }) => {
            const url = new URL(request.url);
            const user = url.searchParams.get('user') ?? 'anon';
            return `user:${user}`;
        },
    },
});
