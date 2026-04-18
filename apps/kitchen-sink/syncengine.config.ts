import { config } from '@syncengine/core';
import { unverified } from '@syncengine/server';

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
  auth: {
    // Dev adapter: the bearer token IS the user id — no signature check,
    // no expiry. Apps going to production swap this for jwt({ jwksUri, ... })
    // pointed at their real identity provider (Clerk, Auth0, Descope, ...).
    provider: unverified(),
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
  observability: {
    // Set OTEL_EXPORTER_OTLP_ENDPOINT in your shell to point at a
    // collector (Jaeger at http://localhost:4318, Honeycomb, Grafana
    // Tempo, etc.) and every framework seam — HTTP, RPC, entity,
    // bus, webhook, heartbeat, gateway — starts emitting spans
    // without further code changes. `*.metrics.ts` files (see
    // src/orders.metrics.ts) auto-load at boot and their declared
    // handles ship readings through the same OTLP pipeline.
    //
    // Quick start (Jaeger all-in-one):
    //   docker run -d -p 4318:4318 -p 16686:16686 \
    //     -e COLLECTOR_OTLP_ENABLED=true \
    //     jaegertracing/all-in-one:latest
    //   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 pnpm dev
    //
    serviceName: 'syncengine-kitchen-sink',

    // Parent-based sampling ratio. Default is 1.0 in non-production,
    // 0.1 in production. Override here if you want a different
    // dev-time rate — e.g. `sampling: { ratio: 0.5 }` to keep half.
    // sampling: { ratio: 1.0 },

    // Set `exporter: false` to disable telemetry entirely. The OTel
    // SDK is never imported; seam helpers become zero-cost no-ops.
    // exporter: false,

    // Opt-in outbound-fetch instrumentation. When set, Node-runtime
    // `fetch()` calls (Vite dev server) produce a CLIENT span and
    // auto-propagate traceparent onto the request. Off by default.
    // autoInstrument: ['fetch'],
  },
});
