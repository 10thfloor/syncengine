// ── Cursor Topic ────────────────────────────────────────────────────────────
//
// Demonstrates the ephemeral pub/sub layer (topics) — the counterpart to
// durable entities and tables. Topics are fire-and-forget NATS subjects
// with no persistence: perfect for presence, cursors, typing indicators,
// and other transient collaboration signals.
//
// ── How it fits into the demo ───────────────────────────────────────────────
//
//   App.tsx → useTopic(cursorTopic, 'global')
//     On every mousemove, publishes { x, y, color, userId } to the topic.
//     Every other connected tab receives the message via NATS and feeds it
//     into `cursorPeers` — a live Map<peerId, payload> maintained by the
//     hook. When a user's mouse leaves the window, `leave()` is called,
//     removing that peer from every subscriber's map.
//
//   CursorLayer.tsx → reads the `positions` record derived from cursorPeers
//     Renders each remote cursor with spring-damped interpolation (see the
//     rendering comments in CursorLayer). Because topics are ephemeral,
//     there's no DB write, no Restate call, and no DBSP view — just a
//     direct NATS publish at ~20 fps with sub-frame rendering on the
//     receiving end.
//
// The topic schema below is typed but intentionally lightweight — it only
// carries what the cursor renderer needs. The `$ts` timestamp is injected
// automatically by the framework and used by CursorLayer for stale-cursor
// fade-out and dead-reckoning interpolation.

import { topic, real, text } from '@syncengine/client';

export const cursorTopic = topic('cursors', {
    x: real(),
    y: real(),
    color: text(),
    userId: text(),
});
