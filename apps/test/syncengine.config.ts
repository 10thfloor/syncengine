import { config } from '@syncengine/core';

export default config({
  workspaces: {
    // Workspace = shared space (tables, entities, topics all scoped here).
    // User identity (?user=) is separate — it controls who you ARE inside
    // the workspace, not which workspace you're in.
    //
    //   ?user=alice&ws=room1   ← alice in room1
    //   ?user=bob&ws=room1     ← bob in room1 (sees alice's cursors + shared state)
    //   ?user=bob&ws=room2     ← bob in room2 (isolated)
    //   ?user=alice             ← alice in default workspace
    resolve: ({ request }) => {
      const url = new URL(request.url);
      return url.searchParams.get('ws') ?? 'default';
    },
  },
  services: {
    // The overrides module is lazy-imported at boot. In test, it flips
    // `orderEvents` to BusMode.inMemory() so integration tests run
    // without NATS. Production boots normally — this import never fires.
    overrides:
      process.env.NODE_ENV === 'test'
        ? () => import('./src/events/test')
        : undefined,
  },
});
