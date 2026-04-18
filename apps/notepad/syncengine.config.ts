import { defineConfig } from '@syncengine/core';

export default defineConfig({
  workspaces: {
    // Return the workspace id for this request. Any stable string works
    // ('user:' + user.id, 'org:' + orgId, a URL path segment, etc.) —
    // syncengine hashes it to a bounded wsKey internally.
    //
    // The demo uses ?workspace=<name> so you can open two tabs at
    // http://localhost:5173/?workspace=alice to see real-time sync.
    resolve: ({ request, user }) => {
      const url = new URL(request.url);
      return url.searchParams.get('workspace') ?? 'default';
    },
  },
});
