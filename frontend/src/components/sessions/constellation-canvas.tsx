/**
 * ConstellationCanvas — shared Canvas 2D renderer.
 *
 * Used by both the minimized card (fitView, non-interactive) and the overlay
 * (pan/zoom, drag, hover). Identical paint ensures identical look.
 *
 * The component reads from the mutable layoutRef on every rAF tick — it does
 * NOT own the layout. The parent drives repaints by passing a new layoutVersion.
 */

import {
  useRef,
  useEffect,
  forwardRef,
  useImperativeHandle,
  type CSSProperties,
} from "react";
import type {
  ConstellationLayout,
  ConstellationNode,
  ViewTransform,
} from "./use-constellation-layout";
import { RING_R, fitView } from "./use-constellation-layout";

const MONO_FONT = "ui-monospace, Menlo, monospace";

// ── hexA helper ───────────────────────────────────────────────────────────────

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ── STATUS_OP (matches prototype) ─────────────────────────────────────────────

const STATUS_OP: Record<string, number> = {
  active: 1,
  idle: 0.62,
  ended: 0.32,
  stopped: 0.32,
};

// ── World-to-screen ───────────────────────────────────────────────────────────

function worldToScreen(
  wx: number,
  wy: number,
  view: ViewTransform,
): [number, number] {
  return [wx * view.scale + view.tx, wy * view.scale + view.ty];
}

// ── Draw scene ────────────────────────────────────────────────────────────────

function drawScene(
  ctx: CanvasRenderingContext2D,
  layout: ConstellationLayout,
  view: ViewTransform,
  cssW: number,
  cssH: number,
  opts: {
    interactive: boolean;
    selected: string | null;
    hover: string | null;
    focusProfile: string | null;
    t: number; // performance.now() for animations
  },
): void {
  const { scale: S } = view;

  ctx.clearRect(0, 0, cssW, cssH);

  const [hx, hy] = worldToScreen(0, 0, view);

  // Guide rings (dashed)
  ctx.save();
  ctx.setLineDash([2, 5]);
  ctx.strokeStyle = "rgba(255,255,255,.05)";
  ctx.lineWidth = 1;
  for (const rw of [120, RING_R, RING_R + 95]) {
    ctx.beginPath();
    ctx.arc(hx, hy, rw * S, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

  // Hub glow
  const grd = ctx.createRadialGradient(hx, hy, 0, hx, hy, 70 * S);
  grd.addColorStop(0, "rgba(59,130,246,.5)");
  grd.addColorStop(1, "rgba(59,130,246,0)");
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(hx, hy, 70 * S, 0, Math.PI * 2);
  ctx.fill();

  const visNodes = layout.nodes.filter(
    (nd) => (nd as ConstellationNode & { vis?: boolean }).vis !== false,
  );
  const visLinks = layout.links.filter(
    (l) =>
      (l.source as ConstellationNode & { vis?: boolean }).vis !== false &&
      (l.target as ConstellationNode & { vis?: boolean }).vis !== false,
  );

  // Links (draw before nodes so nodes render on top)
  for (const l of visLinks) {
    const [x1, y1] = worldToScreen(l.source.x, l.source.y, view);
    const [x2, y2] = worldToScreen(l.target.x, l.target.y, view);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = l.active
      ? "rgba(34,197,94,.30)"
      : "rgba(255,255,255,.06)";
    ctx.lineWidth = l.active ? 1.4 : 1;
    ctx.stroke();
  }

  // Particles flowing along active links
  for (const l of visLinks) {
    if (!l.active) continue;
    const [x1, y1] = worldToScreen(l.source.x, l.source.y, view);
    const [x2, y2] = worldToScreen(l.target.x, l.target.y, view);
    // Use source x as a pseudo-random phase offset
    const phaseOff = l.source.x * 0.001;
    for (const off of [0, 0.5] as const) {
      const p = (opts.t / 1600 + off + phaseOff) % 1;
      const px = x1 + (x2 - x1) * p;
      const py = y1 + (y2 - y1) * p;
      ctx.save();
      ctx.shadowColor = "#22c55e";
      ctx.shadowBlur = 8 * Math.max(0.6, S);
      ctx.fillStyle = "rgba(120,255,170,.9)";
      ctx.beginPath();
      ctx.arc(px, py, 2 * Math.max(0.7, S), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // Project nodes
  for (const nd of visNodes) {
    if (nd.kind !== "project") continue;
    const [x, y] = worldToScreen(nd.x, nd.y, view);
    const r = nd.r * S;
    const live = nd.status === "active";

    // Pulse ring
    if (live) {
      const ph = (opts.t / 1400) % 1;
      ctx.beginPath();
      ctx.arc(x, y, r + ph * 16 * S, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(34,197,94,${(1 - ph) * 0.4})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = live ? "rgba(34,197,94,.10)" : "rgba(255,255,255,.04)";
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = live ? "#22c55e" : "rgba(255,255,255,.14)";
    ctx.stroke();

    // Label below node
    const labelSize = Math.max(8, 10 * S);
    ctx.fillStyle = live ? "#e3e7ee" : "#8b93a1";
    ctx.font = `${labelSize}px ${MONO_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const name = nd.name.length > 18 ? `${nd.name.slice(0, 17)}…` : nd.name;
    ctx.fillText(name, x, y + r + 5);
  }

  // Session nodes
  for (const nd of visNodes) {
    if (nd.kind !== "session") continue;
    const [x, y] = worldToScreen(nd.x, nd.y, view);
    const sel = opts.selected === nd.id;
    const hov = opts.hover === nd.id;
    const r = (sel ? nd.r + 2 : nd.r) * S;
    const live = nd.status === "active";
    const dim =
      opts.interactive && opts.focusProfile && nd.profile !== opts.focusProfile
        ? 0.14
        : 1;

    // Active pulse ring
    if (live && dim === 1) {
      const ph = (opts.t / 1200 + nd.x * 0.002) % 1;
      ctx.beginPath();
      ctx.arc(x, y, r + ph * 12 * S, 0, Math.PI * 2);
      ctx.strokeStyle = hexA(nd.color, (1 - ph) * 0.5);
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    ctx.save();
    if (live && dim === 1) {
      ctx.shadowColor = nd.color;
      ctx.shadowBlur = 10 * Math.max(0.6, S);
    }
    const op = (STATUS_OP[nd.status] ?? 0.32) * dim;
    ctx.globalAlpha = op;
    ctx.fillStyle = nd.color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();

    // Selection / hover ring + label
    if (sel || hov) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = sel ? "#fff" : "rgba(255,255,255,.55)";
      ctx.stroke();
      if (opts.interactive) {
        const lSize = Math.max(8, 9.5 * S);
        ctx.fillStyle = "#e7ebf2";
        ctx.font = `${lSize}px ${MONO_FONT}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(nd.profile, x, y - r - 4);
      }
    }
  }

  // Hub core + label (drawn last so it's always on top)
  ctx.beginPath();
  ctx.arc(hx, hy, 22 * S, 0, Math.PI * 2);
  ctx.fillStyle = "#0b0e14";
  ctx.strokeStyle = "rgba(59,130,246,.6)";
  ctx.lineWidth = 1.4;
  ctx.fill();
  ctx.stroke();
  const hubFontSize = Math.max(8, 10 * S);
  ctx.fillStyle = "#e3e7ee";
  ctx.font = `${hubFontSize}px ${MONO_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("YOU", hx, hy + 1);
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ConstellationCanvasProps {
  layoutRef: React.MutableRefObject<ConstellationLayout>;
  /** Incrementing counter — triggers a repaint each time it changes. */
  layoutVersion: number;
  /** Whether this is the interactive overlay view or the passive card view. */
  interactive?: boolean;
  /** Controlled view transform — if undefined, fit-to-canvas on each paint. */
  view?: ViewTransform;
  selected?: string | null;
  hover?: string | null;
  focusProfile?: string | null;
  className?: string;
  style?: CSSProperties;
  /** Called with the canvas element once it's ready (for FLIP coordinate reads). */
  onCanvasReady?: (canvas: HTMLCanvasElement) => void;
  // Pointer events forwarded from the overlay (not used in card mode)
  onPointerDown?: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove?: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp?: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerCancel?: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onDoubleClick?: (e: React.MouseEvent<HTMLCanvasElement>) => void;
}

export interface ConstellationCanvasRef {
  canvas: HTMLCanvasElement | null;
  /** Read the current device-pixel-aware context dimensions. */
  getSize: () => { cssW: number; cssH: number } | null;
}

export const ConstellationCanvas = forwardRef<
  ConstellationCanvasRef,
  ConstellationCanvasProps
>(function ConstellationCanvas(
  {
    layoutRef,
    interactive = false,
    view,
    selected = null,
    hover = null,
    focusProfile = null,
    className,
    style,
    onCanvasReady,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onDoubleClick,
  },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const cssSizeRef = useRef({ cssW: 0, cssH: 0 });

  useImperativeHandle(ref, () => ({
    canvas: canvasRef.current,
    getSize: () =>
      cssSizeRef.current.cssW > 0 ? { ...cssSizeRef.current } : null,
  }));

  // Latest render params — read by the continuous rAF loop so prop changes
  // (view / selection / hover) don't need to restart it.
  const paramsRef = useRef({
    view,
    interactive,
    selected,
    hover,
    focusProfile,
  });
  paramsRef.current = { view, interactive, selected, hover, focusProfile };

  // onCanvasReady kept in a ref so the setup effect never re-runs on its
  // identity — the parent passes a fresh inline callback on every (per-frame)
  // re-render, which would otherwise thrash the ResizeObserver below.
  const onReadyRef = useRef(onCanvasReady);
  onReadyRef.current = onCanvasReady;

  // Context + size setup, kept current by a ResizeObserver. Runs ONCE (stable
  // deps) so the parent's per-frame re-renders can't tear it down mid-flight.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    function syncSize(cssW: number, cssH: number): void {
      if (!canvas || cssW <= 0 || cssH <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
      cssSizeRef.current = { cssW, cssH };
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctxRef.current = ctx;
      }
    }

    // Measure synchronously on mount — don't wait for the async observer.
    syncSize(canvas.clientWidth, canvas.clientHeight);
    onReadyRef.current?.(canvas);

    const obs = new ResizeObserver((entries) => {
      const box = entries[0]?.contentBoxSize?.[0];
      const cssW = box ? box.inlineSize : canvas.clientWidth;
      const cssH = box ? box.blockSize : canvas.clientHeight;
      syncSize(cssW, cssH);
    });
    obs.observe(canvas);
    return () => obs.disconnect();
  }, []);

  // Continuous render loop — always paints the latest shared layout and keeps
  // particles / pulses animating, independent of React re-renders or settling.
  useEffect(() => {
    let raf = 0;
    function loop(): void {
      const ctx = ctxRef.current;
      const { cssW, cssH } = cssSizeRef.current;
      if (ctx && cssW > 0 && cssH > 0) {
        const p = paramsRef.current;
        const resolvedView =
          p.view !== undefined
            ? p.view
            : fitView(layoutRef.current, cssW, cssH);
        drawScene(ctx, layoutRef.current, resolvedView, cssW, cssH, {
          interactive: p.interactive ?? false,
          selected: p.selected ?? null,
          hover: p.hover ?? null,
          focusProfile: p.focusProfile ?? null,
          t: performance.now(),
        });
      }
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [layoutRef]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ display: "block", width: "100%", height: "100%", ...style }}
      aria-label="Session constellation"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onDoubleClick={onDoubleClick}
    />
  );
});
