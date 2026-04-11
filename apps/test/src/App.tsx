import { useEffect, useRef, useMemo, useState } from "react";
import { store, useStore, useEntity } from "@syncengine/client";
import { clicks, totalsView, channels } from "./schema";
import { counter } from "./entities/counter.actor";
import { account } from "./entities/account.actor";
import { cursorTopic } from "./topics/cursors";

// ── Store ────────────────────────────────────────────────────────
export const db = store({
  tables: [clicks] as const,
  views: [totalsView],
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

// ── Cursor rendering (rAF-driven interpolation) ─────────────────
//
// Collaborative cursor best practices: decouple network updates
// (20fps) from rendering (60-144fps). The renderer interpolates
// between samples using velocity-aware lerp with brief dead
// reckoning. All DOM writes use CSS transforms (GPU-composited)
// and bypass React's reconciler entirely via refs + rAF.

interface CursorPos {
  x: number;
  y: number;
  color: string;
  ts: number;
}

interface CursorInterp {
  curr: { x: number; y: number; ts: number };
  rx: number;
  ry: number;
  vx: number;
  vy: number;
  color: string;
  el: HTMLDivElement | null;
}

const STALE_MS = 5000;
const EXTRAPOLATE_CAP_MS = 150;
const LERP_SPEED = 0.15;

function CursorLayer({ positions }: { positions: Record<string, CursorPos> }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const interpsRef = useRef<Map<string, CursorInterp>>(new Map());
  const rafRef = useRef<number>(0);
  const positionsRef = useRef(positions);
  positionsRef.current = positions;

  useEffect(() => {
    const interps = interpsRef.current;

    function tick() {
      const now = Date.now();
      const current = positionsRef.current;

      for (const [uid, pos] of Object.entries(current)) {
        if (now - pos.ts > STALE_MS) continue;

        let ci = interps.get(uid);
        if (!ci) {
          const el = document.createElement("div");
          el.style.cssText =
            "position:absolute;left:0;top:0;pointer-events:none;";
          containerRef.current?.appendChild(el);
          // Build cursor DOM safely (no innerHTML)
          buildCursorDom(el, pos.color, uid);
          ci = {
            curr: { x: pos.x, y: pos.y, ts: pos.ts },
            rx: pos.x,
            ry: pos.y,
            vx: 0,
            vy: 0,
            color: pos.color,
            el,
          };
          interps.set(uid, ci);
        }

        if (pos.ts !== ci.curr.ts) {
          const dt = pos.ts - ci.curr.ts;
          if (dt > 0) {
            ci.vx = (pos.x - ci.curr.x) / dt;
            ci.vy = (pos.y - ci.curr.y) / dt;
          }
          ci.curr = { x: pos.x, y: pos.y, ts: pos.ts };
        }
      }

      for (const [uid, ci] of interps) {
        const age = now - ci.curr.ts;
        if (age > STALE_MS) {
          ci.el?.remove();
          interps.delete(uid);
          continue;
        }

        const ext = Math.min(age, EXTRAPOLATE_CAP_MS);
        const tx = ci.curr.x + ci.vx * ext;
        const ty = ci.curr.y + ci.vy * ext;
        ci.rx += (tx - ci.rx) * LERP_SPEED;
        ci.ry += (ty - ci.ry) * LERP_SPEED;

        const opacity = age > 3000 ? 1 - (age - 3000) / 2000 : 1;
        if (ci.el) {
          ci.el.style.transform = `translate(${ci.rx}px, ${ci.ry}px)`;
          ci.el.style.opacity = String(Math.max(0, opacity));
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 9999,
      }}
    />
  );
}

function buildCursorDom(
  parent: HTMLDivElement,
  color: string,
  label: string,
): void {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "22");
  svg.setAttribute("viewBox", "0 0 16 22");
  svg.setAttribute("fill", "none");
  svg.style.display = "block";

  const fill = document.createElementNS(ns, "path");
  fill.setAttribute(
    "d",
    "M0.928 0.32L15.2 13.184H8.032L7.264 13.408L3.872 21.344L0.928 20.032L4.256 12.192L0.928 8.864V0.32Z",
  );
  fill.setAttribute("fill", color);
  svg.appendChild(fill);

  const detail = document.createElementNS(ns, "path");
  detail.setAttribute(
    "d",
    "M1.728 2.688V8.512L4.544 11.328L4.864 12.032L1.888 19.328L3.36 19.968L6.4 12.576L6.976 12.384H13.024L1.728 2.688Z",
  );
  detail.setAttribute("fill", "white");
  svg.appendChild(detail);

  parent.appendChild(svg);

  const pill = document.createElement("div");
  pill.textContent = label;
  pill.style.cssText = `position:absolute;left:14px;top:16px;font-size:11px;line-height:18px;background:${color};color:white;padding:0 6px;border-radius:3px;white-space:nowrap;font-weight:500;box-shadow:0 1px 4px rgba(0,0,0,0.25);`;
  parent.appendChild(pill);
}

// ── App ──────────────────────────────────────────────────────────
export default function App() {
  const s = useStore<DB>();
  const { views, ready } = s.use({ totalsView });
  const total = views.totalsView[0]?.total ?? 0;
  const numClicks = views.totalsView[0]?.numClicks ?? 0;

  const userId = useMemo(getUserId, []);
  const color = useMemo(randomColor, []);

  const { state: counterState, actions: counterActions } = useEntity(
    counter,
    "global",
  );
  const { peers: cursorPeers, publish: publishCursor, leave: leaveCursor } =
    s.useTopic(cursorTopic, "global");
  const { state: acctState, actions: acctActions } = useEntity(account, userId);
  const [acctError, setAcctError] = useState<string | null>(null);
  const publishRef = useRef(publishCursor);
  publishRef.current = publishCursor;
  const leaveRef = useRef(leaveCursor);
  leaveRef.current = leaveCursor;

  // Track mouse position and broadcast via topic
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      publishRef.current({ x: e.clientX, y: e.clientY, color });
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
  }, [color]);

  // Convert peers Map to positions object for CursorLayer
  const positions: Record<string, CursorPos> = useMemo(() => {
    const out: Record<string, CursorPos> = {};
    for (const [peerId, data] of cursorPeers) {
      out[peerId] = {
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

        <footer
          style={{ marginTop: "3rem", color: "#525252", fontSize: "0.8rem" }}
        >
          Open in two tabs: <code>?user=alice</code> and <code>?user=bob</code>{" "}
          to see live cursors and shared state.
        </footer>
      </div>
    </>
  );
}
