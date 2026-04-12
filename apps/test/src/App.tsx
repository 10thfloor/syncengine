import { useEffect, useRef, useMemo, useState } from "react";
import { store, useStore } from "@syncengine/client";

// ── Schema: tables, views, channels ─────────────────────────────
// Tables are CRDT-replicated rows synced via JetStream. Views are
// incremental projections computed by the DBSP engine in the worker.
import { clicks, totalsView, notes, notesList, channels } from "./schema";

// ── Entities: durable single-writer actors (Restate) ────────────
// Each entity is a virtual object with serialized handler execution.
// State persists across restarts; mutations go through HTTP → Restate.
import { counter } from "./entities/counter.actor";
import { account } from "./entities/account.actor";

// ── Topics: ephemeral multi-writer pub/sub (NATS core) ──────────
// Topics broadcast transient per-peer state directly over NATS with
// no persistence, no Restate, no HTTP. Ideal for cursors, typing
// indicators, selections — anything high-frequency and short-lived.
import { cursorTopic } from "./topics/cursors";

import { CursorLayer, type CursorPos } from "./CursorLayer";

// ── Store ────────────────────────────────────────────────────────
export const db = store({
  tables: [clicks, notes] as const,
  views: [totalsView, notesList],
  channels,
});

type DB = typeof db;

// ── Stable user identity ─────────────────────────────────────────
function getUserId(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("user") ?? "anon";
}

function randomColor(): string {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}, 75%, 60%)`;
}

// ── App ──────────────────────────────────────────────────────────
export default function App() {
  const s = useStore<DB>();

  // ── Tables + Views: CRDT rows with incremental projections ────
  const { views, ready } = s.useView({ totalsView, notesList });
  const total = views.totalsView[0]?.total ?? 0;
  const numClicks = views.totalsView[0]?.numClicks ?? 0;

  const userId = useMemo(getUserId, []);
  const color = useMemo(randomColor, []);

  // ── Entities: durable actors via Restate ──────────────────────
  const { state: counterState, actions: counterActions } = s.useEntity(
    counter,
    "global",
  );
  const { state: acctState, actions: acctActions } = s.useEntity(account, userId);
  const [acctError, setAcctError] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");

  // ── Topics: ephemeral peer state via NATS core ────────────────
  const { peers: cursorPeers, publish: publishCursor, leave: leaveCursor } =
    s.useTopic(cursorTopic, "global");
  const publishRef = useRef(publishCursor);
  publishRef.current = publishCursor;
  const leaveRef = useRef(leaveCursor);
  leaveRef.current = leaveCursor;

  // Track mouse position and broadcast via topic
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      publishRef.current({ x: e.clientX, y: e.clientY, color, userId });
    };

    const onMouseLeave = () => {
      leaveRef.current();
    };

    window.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseleave", onMouseLeave);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseleave", onMouseLeave);
      leaveRef.current();
    };
  }, [color, userId]);

  // Convert peers Map to positions object for CursorLayer.
  // Key by userId (from query string) so the label shows the user name.
  const positions: Record<string, CursorPos> = useMemo(() => {
    const out: Record<string, CursorPos> = {};
    for (const [, data] of cursorPeers) {
      out[data.userId as string] = {
        x: data.x as number,
        y: data.y as number,
        color: data.color as string,
        ts: data.$ts,
      };
    }
    return out;
  }, [cursorPeers]);

  const otherCount = Object.keys(positions).length;

  if (!ready) {
    return (
      <div style={{ padding: "2rem", color: "#737373" }}>Connecting...</div>
    );
  }

  return (
    <>
      <CursorLayer positions={positions} />

      <div style={{ padding: "2rem", maxWidth: 600, margin: "0 auto" }}>
        <h1>
          syncengine
          <span
            style={{ fontSize: "0.6em", color: "#737373", marginLeft: "0.5em" }}
          >
            {userId}
          </span>
        </h1>

        {otherCount > 0 && (
          <p
            style={{
              color: "#6366f1",
              fontSize: "0.85rem",
              marginBottom: "1rem",
            }}
          >
            {otherCount} other cursor{otherCount > 1 ? "s" : ""} live
          </p>
        )}

        <section>
          <h2>Counter entity (Restate actor)</h2>
          <p>
            Value:{" "}
            <strong style={{ fontSize: "1.5rem" }}>
              {counterState?.value ?? "..."}
            </strong>
          </p>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button type="button" onClick={() => counterActions.increment(1)}>
              +1
            </button>
            <button type="button" onClick={() => counterActions.increment(10)}>
              +10
            </button>
            <button type="button" onClick={() => counterActions.decrement(1)}>
              -1
            </button>
            <button type="button" onClick={() => counterActions.reset()}>
              reset
            </button>
          </div>
        </section>

        <section style={{ marginTop: "2rem" }}>
          <h2>Clicks (DBSP incremental view)</h2>
          <p>
            <strong style={{ fontSize: "1.5rem" }}>{numClicks}</strong> clicks,
            total: <strong style={{ fontSize: "1.5rem" }}>{total}</strong>
          </p>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="button"
              onClick={() =>
                s.tables.clicks.insert({ label: userId, amount: 1 })
              }
            >
              +1
            </button>
            <button
              type="button"
              onClick={() =>
                s.tables.clicks.insert({ label: userId, amount: 10 })
              }
            >
              +10
            </button>
            <button
              type="button"
              onClick={() =>
                s.tables.clicks.insert({ label: userId, amount: 100 })
              }
            >
              +100
            </button>
          </div>
        </section>

        <section style={{ marginTop: "2rem" }}>
          <h2>Account (source projections)</h2>
          <p>
            Balance:{" "}
            <strong style={{ fontSize: "1.5rem" }}>
              $
              {((acctState as Record<string, unknown>)?.balance as number) ?? 0}
            </strong>{" "}
            &middot;{" "}
            {String((acctState as Record<string, unknown>)?.txnCount ?? 0)} txns
            {((acctState as Record<string, unknown>)?.frozen as boolean) && (
              <span style={{ color: "#ef4444", marginLeft: "0.5rem" }}>
                FROZEN
              </span>
            )}
          </p>
          {acctError && (
            <p style={{ color: "#ef4444", fontSize: "0.85rem" }}>{acctError}</p>
          )}
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => {
                setAcctError(null);
                acctActions
                  .deposit(100)
                  .catch((e: Error) => setAcctError(e.message));
              }}
            >
              Deposit $100
            </button>
            <button
              type="button"
              onClick={() => {
                setAcctError(null);
                acctActions
                  .deposit(50)
                  .catch((e: Error) => setAcctError(e.message));
              }}
            >
              Deposit $50
            </button>
            <button
              type="button"
              onClick={() => {
                setAcctError(null);
                acctActions
                  .withdraw(30)
                  .catch((e: Error) => setAcctError(e.message));
              }}
            >
              Withdraw $30
            </button>
            <button
              type="button"
              onClick={() => {
                setAcctError(null);
                acctActions
                  .withdraw(99999)
                  .catch((e: Error) => setAcctError(e.message));
              }}
            >
              Withdraw $99999
            </button>
            <button
              type="button"
              onClick={() => {
                setAcctError(null);
                acctActions
                  .freeze()
                  .catch((e: Error) => setAcctError(e.message));
              }}
            >
              Freeze
            </button>
            <button
              type="button"
              onClick={() => {
                setAcctError(null);
                acctActions
                  .unfreeze()
                  .catch((e: Error) => setAcctError(e.message));
              }}
            >
              Unfreeze
            </button>
          </div>
        </section>

        <section style={{ marginTop: "2rem" }}>
          <h2>Notes (separate channel)</h2>
          <p style={{ color: "#737373", fontSize: "0.85rem", marginBottom: "0.5rem" }}>
            Syncs on its own JetStream subject, independent of clicks.
          </p>
          <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem" }}>
            <input
              type="text"
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && noteText.trim()) {
                  s.tables.notes.insert({ author: userId, body: noteText.trim() });
                  setNoteText("");
                }
              }}
              placeholder="Type a note and press Enter..."
              style={{
                flex: 1,
                padding: "0.4rem 0.6rem",
                background: "#1a1a1a",
                border: "1px solid #333",
                borderRadius: "4px",
                color: "#e5e5e5",
              }}
            />
          </div>
          <ul style={{ listStyle: "none", padding: 0 }}>
            {views.notesList.map((n) => (
              <li
                key={String(n.id)}
                style={{
                  padding: "0.3rem 0",
                  borderBottom: "1px solid #1a1a1a",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span>
                  <strong style={{ color: "#6366f1" }}>{String(n.author)}</strong>{" "}
                  {String(n.body)}
                </span>
                <button
                  type="button"
                  onClick={() => s.tables.notes.remove(n.id)}
                  style={{ fontSize: "0.75rem", opacity: 0.5 }}
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
        </section>

        <footer
          style={{ marginTop: "3rem", color: "#525252", fontSize: "0.8rem" }}
        >
          Open two tabs: <code>?user=alice</code> and{" "}
          <code>?user=bob</code> to see live cursors and shared state.
          Add <code>&amp;ws=room1</code> to switch workspaces.
        </footer>
      </div>
    </>
  );
}
