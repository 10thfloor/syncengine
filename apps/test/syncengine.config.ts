import { defineConfig } from '@syncengine/core';

export default defineConfig({
  workspaces: {
    resolve: ({ request }) => {
      const url = new URL(request.url);
      return `user:${url.searchParams.get('user') ?? 'anon'}`;
    },
  },
});
