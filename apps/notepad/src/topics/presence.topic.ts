import { topic, text } from '@syncengine/core';

/**
 * Topics are the third flavor of state: ephemeral NATS pub/sub.
 *
 *   - table  → durable log, CRDT-merged, fully replicated client-side
 *   - entity → durable server state, serialized handlers
 *   - topic  → transient broadcast, no persistence, no replay
 *
 * Topics shine for presence, cursors, typing indicators, drag positions,
 * and anything else that's fine to lose on refresh. Each connected tab
 * publishes its own payload; peers maintain a live map keyed by the
 * publisher's identity. Throttled by the runtime, TTL-reaped when a
 * peer stops broadcasting.
 */
export const presence = topic('presence', {
  userId: text(),
  color: text(),
});
