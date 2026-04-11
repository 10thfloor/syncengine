// ── CursorLayer ─────────────────────────────────────────────────────────────
//
// Demonstrates that syncengine's topic layer can drive Figma/Miro-quality
// collaborative cursors with minimal application code:
//
//   topic definition  → topics/cursors.ts (schema: x, y, color, userId)
//   publish           → App.tsx: useTopic(cursorTopic, 'global').publish()
//   render            → this file: pure rAF loop, no React re-renders
//
// The data path is: mousemove → NATS publish → peer subscription →
// `cursorPeers` Map → `positions` record → this component. The entire
// round-trip is typically <50ms on a local network; this renderer fills
// the remaining visual gap with interpolation.
//
// ── Rendering technique (spring-damped interpolation) ───────────────────────
//
// Smooth collaborative cursors like Miro/Figma:
//
//   1. Each network sample (~20 fps) sets the TARGET position.
//   2. The rendered position CHASES the target using frame-rate-
//      independent exponential smoothing (half-life based).
//   3. Between samples, brief dead reckoning extrapolates using
//      smoothed velocity — then the spring takes over.
//   4. All DOM writes use CSS transforms (GPU-composited) and
//      bypass React's reconciler entirely.
//
// This decoupling means the renderer is independent of React's render
// cycle — it runs at the display's native refresh rate and never triggers
// a component re-render, even with dozens of cursors moving simultaneously.

import { useEffect, useRef } from "react";

export interface CursorPos {
  x: number;
  y: number;
  color: string;
  ts: number;
}

interface CursorState {
  // Target position (latest network sample)
  tx: number;
  ty: number;
  // Rendered position (smoothly chases target)
  rx: number;
  ry: number;
  // Smoothed velocity (px/ms) for dead reckoning between samples
  vx: number;
  vy: number;
  // Timing
  lastSampleTs: number;
  lastFrameTs: number;
  // Visual
  color: string;
  el: HTMLDivElement | null;
}

// ── Tuning knobs ────────────────────────────────────────────────
//
// HALF_LIFE: time (ms) for the cursor to close half the gap to its
// target. Lower = snappier, higher = smoother. 60-80ms feels like
// Miro. Below 40ms you see network jitter; above 120ms feels laggy.
const HALF_LIFE_MS = 65;
// How long to extrapolate with velocity before letting the spring
// coast to the last known position.
const EXTRAPOLATE_MS = 80;
// Velocity smoothing factor (0-1). Higher = more smoothing, more lag.
// 0.7 gives a good balance — absorbs jitter without adding latency.
const VELOCITY_SMOOTHING = 0.7;
// Fade out stale cursors
const STALE_MS = 5000;

/**
 * Frame-rate-independent exponential smoothing.
 * Returns how much of the gap to close this frame.
 *
 *   halfLife=65, dt=16.7ms (60fps)  → factor ≈ 0.163
 *   halfLife=65, dt=6.9ms  (144fps) → factor ≈ 0.072
 *
 * Both converge at the same wall-clock speed.
 */
function smoothFactor(dt: number): number {
  return 1 - Math.pow(0.5, dt / HALF_LIFE_MS);
}

export function CursorLayer({ positions }: { positions: Record<string, CursorPos> }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const statesRef = useRef<Map<string, CursorState>>(new Map());
  const rafRef = useRef<number>(0);
  const positionsRef = useRef(positions);
  positionsRef.current = positions;

  useEffect(() => {
    const states = statesRef.current;
    let prevFrameTime = performance.now();

    function tick(frameTime: number) {
      const dt = Math.min(frameTime - prevFrameTime, 100); // cap at 100ms to avoid jumps after tab switch
      prevFrameTime = frameTime;
      const now = Date.now();
      const current = positionsRef.current;
      const factor = smoothFactor(dt);

      // ── Phase 1: Ingest new samples ─────────────────────────
      for (const [uid, pos] of Object.entries(current)) {
        if (now - pos.ts > STALE_MS) continue;

        let cs = states.get(uid);
        if (!cs) {
          const el = document.createElement("div");
          el.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;will-change:transform,opacity;";
          containerRef.current?.appendChild(el);
          buildCursorDom(el, pos.color, uid);
          cs = {
            tx: pos.x, ty: pos.y,
            rx: pos.x, ry: pos.y,
            vx: 0, vy: 0,
            lastSampleTs: pos.ts,
            lastFrameTs: frameTime,
            color: pos.color,
            el,
          };
          states.set(uid, cs);
          continue; // first sample — snap, don't interpolate
        }

        // New sample arrived — update target and velocity
        if (pos.ts !== cs.lastSampleTs) {
          const sampleDt = pos.ts - cs.lastSampleTs;
          if (sampleDt > 0) {
            const rawVx = (pos.x - cs.tx) / sampleDt;
            const rawVy = (pos.y - cs.ty) / sampleDt;
            // Exponential moving average on velocity to absorb jitter
            cs.vx = cs.vx * VELOCITY_SMOOTHING + rawVx * (1 - VELOCITY_SMOOTHING);
            cs.vy = cs.vy * VELOCITY_SMOOTHING + rawVy * (1 - VELOCITY_SMOOTHING);
          }
          cs.tx = pos.x;
          cs.ty = pos.y;
          cs.lastSampleTs = pos.ts;
        }
      }

      // ── Phase 2: Render ─────────────────────────────────────
      for (const [uid, cs] of states) {
        const age = now - cs.lastSampleTs;
        if (age > STALE_MS) {
          cs.el?.remove();
          states.delete(uid);
          continue;
        }

        // Dead reckoning: extrapolate target using velocity for a
        // short window after the last sample, then coast.
        const extTime = Math.min(age, EXTRAPOLATE_MS);
        const goalX = cs.tx + cs.vx * extTime;
        const goalY = cs.ty + cs.vy * extTime;

        // Spring chase: close `factor` of the gap this frame
        cs.rx += (goalX - cs.rx) * factor;
        cs.ry += (goalY - cs.ry) * factor;

        // Opacity fade for stale cursors
        const opacity = age > 3000 ? 1 - (age - 3000) / 2000 : 1;
        if (cs.el) {
          cs.el.style.transform = `translate(${cs.rx}px,${cs.ry}px)`;
          cs.el.style.opacity = String(Math.max(0, opacity));
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
