import { useEffect, useRef } from "react";

// ── Cursor rendering (rAF-driven interpolation) ─────────────────
//
// Collaborative cursor best practices: decouple network updates
// (20fps) from rendering (60-144fps). The renderer interpolates
// between samples using velocity-aware lerp with brief dead
// reckoning. All DOM writes use CSS transforms (GPU-composited)
// and bypass React's reconciler entirely via refs + rAF.

export interface CursorPos {
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

export function CursorLayer({ positions }: { positions: Record<string, CursorPos> }) {
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
