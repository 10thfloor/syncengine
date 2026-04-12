import { useEffect, useRef, useMemo, useState, memo } from "react";
import { store, useStore } from "@syncengine/client";

// ── Schema: tables, views, channels ─────────────────────────────
import { clicks, totalsView, notes, notesList, channels } from "./schema";

// ── Entities: durable single-writer actors (Restate) ────────────
import { counter } from "./entities/counter.actor";
import { account } from "./entities/account.actor";

// ── Topics: ephemeral multi-writer pub/sub (NATS core) ──────────
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

// ── Section components ───────────────────────────────────────────
//
// Each section is its own component with its own hooks. This is the
// key performance pattern: syncengine hooks (useView, useEntity,
// useTopic) trigger re-renders when their data changes. If every
// hook lives in one big component, ANY data change re-renders
// EVERYTHING — causing visible flicker (7-8 renders per click).
//
// By splitting into focused components, a deposit that updates the
// account entity only re-renders AccountSection. The counter,
// clicks, and notes sections are untouched. Each component calls
// useStore() independently — the store is shared via context, so
// there's no extra cost.
//
// Rule of thumb: one section per hook, or group hooks that always
// change together. Never put unrelated useView + useEntity calls
// in the same component.

const CounterSection = memo(function CounterSection() {
  const s = useStore<DB>();
  const { state, actions } = s.useEntity(counter, "global");
  return (
    <section>
      <h2>Counter entity (Restate actor)</h2>
      <p>
        Value:{" "}
        <strong style={{ fontSize: "1.5rem" }}>{state?.value ?? "..."}</strong>
      </p>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button type="button" onClick={() => actions.increment(1)}>+1</button>
        <button type="button" onClick={() => actions.increment(10)}>+10</button>
        <button type="button" onClick={() => actions.decrement(1)}>-1</button>
        <button type="button" onClick={() => actions.reset()}>reset</button>
      </div>
    </section>
  );
});

const ClicksSection = memo(function ClicksSection({ userId }: { userId: string }) {
  const s = useStore<DB>();
  const { views } = s.useView({ totalsView });
  const total = views.totalsView[0]?.total ?? 0;
  const numClicks = views.totalsView[0]?.numClicks ?? 0;
  return (
    <section style={{ marginTop: "2rem" }}>
      <h2>Clicks (DBSP incremental view)</h2>
      <p>
        <strong style={{ fontSize: "1.5rem" }}>{numClicks}</strong> clicks,
        total: <strong style={{ fontSize: "1.5rem" }}>{total}</strong>
      </p>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button type="button" onClick={() => s.tables.clicks.insert({ label: userId, amount: 1 })}>+1</button>
        <button type="button" onClick={() => s.tables.clicks.insert({ label: userId, amount: 10 })}>+10</button>
        <button type="button" onClick={() => s.tables.clicks.insert({ label: userId, amount: 100 })}>+100</button>
      </div>
    </section>
  );
});

const AccountSection = memo(function AccountSection({ userId }: { userId: string }) {
  const s = useStore<DB>();
  const { state: acctState, actions: acctActions } = s.useEntity(account, userId);
  const [acctError, setAcctError] = useState<string | null>(null);

  const st = acctState as Record<string, unknown> | null;
  const balance = (st?.balance as number) ?? 0;
  const txnCount = (st?.txnCount as number) ?? 0;
  const frozen = st?.frozen as boolean;

  function act(fn: () => Promise<unknown>) {
    setAcctError(null);
    fn().catch((e: Error) => setAcctError(e.message));
  }

  return (
    <section style={{ marginTop: "2rem" }}>
      <h2>Account (source projections)</h2>
      <p>
        Balance: <strong style={{ fontSize: "1.5rem" }}>${balance}</strong>
        {" "}&middot; {txnCount} txns
        {frozen && (
          <span style={{ color: "#ef4444", marginLeft: "0.5rem" }}>FROZEN</span>
        )}
      </p>
      {acctError && (
        <p style={{ color: "#ef4444", fontSize: "0.85rem" }}>{acctError}</p>
      )}
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <button type="button" onClick={() => act(() => acctActions.deposit(100))}>Deposit $100</button>
        <button type="button" onClick={() => act(() => acctActions.deposit(50))}>Deposit $50</button>
        <button type="button" onClick={() => act(() => acctActions.withdraw(30))}>Withdraw $30</button>
        <button type="button" onClick={() => act(() => acctActions.withdraw(99999))}>Withdraw $99999</button>
        <button type="button" onClick={() => act(() => acctActions.freeze())}>Freeze</button>
        <button type="button" onClick={() => act(() => acctActions.unfreeze())}>Unfreeze</button>
      </div>
    </section>
  );
});

const NotesSection = memo(function NotesSection({ userId }: { userId: string }) {
  const s = useStore<DB>();
  const { views } = s.useView({ notesList });
  const [noteText, setNoteText] = useState("");
  return (
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
            flex: 1, padding: "0.4rem 0.6rem",
            background: "#1a1a1a", border: "1px solid #333",
            borderRadius: "4px", color: "#e5e5e5",
          }}
        />
      </div>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {views.notesList.map((n) => (
          <li
            key={String(n.id)}
            style={{
              padding: "0.3rem 0", borderBottom: "1px solid #1a1a1a",
              display: "flex", justifyContent: "space-between", alignItems: "center",
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
  );
});

// ── App (thin shell) ─────────────────────────────────────────────
// The root component only owns: the ready gate, cursor topic, and
// layout. It delegates each demo section to a child component so
// section-level data changes don't cascade upward.
export default function App() {
  const s = useStore<DB>();
  const { ready } = s.useView({ totalsView });

  const userId = useMemo(getUserId, []);
  const color = useMemo(randomColor, []);

  // ── Topics: ephemeral peer state via NATS core ────────────────
  const { peers: cursorPeers, publish: publishCursor, leave: leaveCursor } =
    s.useTopic(cursorTopic, "global");
  const publishRef = useRef(publishCursor);
  publishRef.current = publishCursor;
  const leaveRef = useRef(leaveCursor);
  leaveRef.current = leaveCursor;

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      publishRef.current({ x: e.clientX, y: e.clientY, color, userId });
    };
    const onMouseLeave = () => { leaveRef.current(); };

    window.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseleave", onMouseLeave);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseleave", onMouseLeave);
      leaveRef.current();
    };
  }, [color, userId]);

  const positions: Record<string, CursorPos> = useMemo(() => {
    const out: Record<string, CursorPos> = {};
    for (const [, data] of cursorPeers) {
      if (data.userId === userId) continue;
      out[data.userId as string] = {
        x: data.x as number, y: data.y as number,
        color: data.color as string, ts: data.$ts,
      };
    }
    return out;
  }, [cursorPeers, userId]);

  const otherCount = Object.keys(positions).length;

  if (!ready) {
    return <div style={{ padding: "2rem", color: "#737373" }}>Connecting...</div>;
  }

  return (
    <>
      <CursorLayer positions={positions} />
      <div style={{ padding: "2rem", maxWidth: 600, margin: "0 auto" }}>
        <h1>
          syncengine
          <span style={{ fontSize: "0.6em", color: "#737373", marginLeft: "0.5em" }}>
            {userId}
          </span>
        </h1>

        {otherCount > 0 && (
          <p style={{ color: "#6366f1", fontSize: "0.85rem", marginBottom: "1rem" }}>
            {otherCount} other cursor{otherCount > 1 ? "s" : ""} live
          </p>
        )}

        <CounterSection />
        <ClicksSection userId={userId} />
        <AccountSection userId={userId} />
        <NotesSection userId={userId} />

        <footer style={{ marginTop: "3rem", color: "#525252", fontSize: "0.8rem" }}>
          Open two tabs: <code>?user=alice</code> and <code>?user=bob</code> to
          see live cursors and shared state. Add <code>&amp;ws=room1</code> to
          switch workspaces.
        </footer>
      </div>
    </>
  );
}
