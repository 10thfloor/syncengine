# Topics Guide

> `topic()` is the ephemeral pub/sub primitive — fire-and-forget
> NATS core, no JetStream, no persistence, no replay. Use it for
> state that vanishes on reload: cursors, selections, typing
> indicators, presence.

## When to reach for a topic

| Primitive | Persistence | Use for |
|---|---|---|
| `table` | Durable (JetStream) | Lists clients read as state. |
| `entity` | Durable (Restate) | Stateful objects with handlers. |
| `bus` | Durable (JetStream) | Server-only domain events. |
| **`topic`** | **None** | **Presence, cursors, typing, selections, anything that would be garbage in an hour.** |

If you reload the tab, the data is gone. That's the feature.

## Five-line declaration

```ts
// src/topics/cursors.ts
import { topic, real, text } from '@syncengine/core';

export const cursors = topic('cursors', {
  x: real(),
  y: real(),
  color: text(),
  userId: text(),
});
```

Drop it under `src/topics/` — no special suffix needed, just export from a `.ts` file. The vite plugin auto-discovers.

Topics use the same column factories as tables (`real()`, `text()`, `boolean()`, `integer()`), but **don't** have primary keys, merge strategies, or transitions. They're schema-checked at publish time, then forgotten.

## Publishing + subscribing in the browser

```tsx
import { useStore } from '@syncengine/client';
import { cursors } from './topics/cursors';

function Canvas({ userId }: { userId: string }) {
  const s = useStore<DB>();
  const { peers, publish } = s.useTopic(cursors, 'canvas-1');  // scope key

  return (
    <div
      onMouseMove={(e) => publish({ x: e.clientX, y: e.clientY, color: 'red', userId })}
    >
      {Object.entries(peers).map(([peer, c]) => (
        <div key={peer} style={{ position: 'absolute', left: c.x, top: c.y }}>🔵</div>
      ))}
    </div>
  );
}
```

- **`peers`** — map of `peerId → latest-message-from-that-peer`. Auto-prunes peers that haven't published in a while.
- **`publish(payload)`** — fire-and-forget. Returns void; no ack, no retry.
- **`'canvas-1'`** is a scope — topics partition by scope, so `cursors` in canvas-1 doesn't leak into canvas-2.

## Wire shape

Topic messages fly on NATS subject `ws.<wsId>.topic.<topicName>.<scope>`. No stream, no consumer, no retention. A subscriber that joins after a message has been published won't see it — that's the point.

Bandwidth is cheap; latency is what matters. A 60 Hz cursor update = 60 messages/sec/user.

## Publishing from server code

Rare but supported — topics don't have an explicit `publish(ctx, ...)` on the server today. If you need durable event fan-out from a workflow, reach for **`bus`** instead.

For cases where a heartbeat wants to emit presence heartbeats, publish via a raw NATS connection inside `ctx.run`:

```ts
await ctx.run('presence:beat', async () => {
  const nc = await getNatsConnection();
  nc.publish(`ws.${wsId}.topic.presence.global`, JSON.stringify({ at: Date.now() }));
});
```

## Footguns

- **Schema is enforced at publish, not subscribe.** Clients receiving an unexpected shape will throw at parse time. Keep topic schemas narrow.
- **No replay.** If the tab reconnects after a network blip, recent history is gone.
- **Names follow `/^[a-zA-Z][a-zA-Z0-9_]*$/`** — same regex as every other primitive. No dots (those are reserved for DLQ suffixes on `bus`).
- **Don't use topics for anything you'd want to debug after the fact.** Nothing lands on disk. Use `bus` if you need trails.
- **Bandwidth adds up.** 10 users × 60 Hz × 200 B payload = ~1 MB/s of NATS traffic per room. Throttle on the client side if you're moving a lot.

## Pairs with

- Nothing on the server. Topics are a client-coordination primitive.
- Pair with **presence** patterns — topics for the "what I'm doing right now" signal, entities/tables for the persistent profile.
- Pair with **bus** when a topic event SHOULD also land on disk — publish both.

## Testing

Topic tests usually mock the NATS connection. There isn't a dedicated harness — most tests assert on the `peers` map structure or publish payload schema directly.

## Links

- Core code: `packages/core/src/topic.ts`
- Client hook: `packages/client/src/useTopic.ts`
- Demo: `apps/kitchen-sink/src/topics/cursors.ts`
