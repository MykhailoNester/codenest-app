/**
 * ConstellationOverlay — maximized interactive showpiece.
 *
 * React Portal to document.body. Opened with a FLIP expand from the card rect.
 * Closed by Esc, close button, or backdrop click.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
  type ReactElement,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import type {
  ConstellationLayout,
  ConstellationNode,
  ViewTransform,
  SessionNode,
  ProjectNode,
} from "./use-constellation-layout";
import { fitView } from "./use-constellation-layout";
import { ConstellationCanvas } from "./constellation-canvas";
import type { ConstellationWindow } from "./constellation";
import { Icon } from "../icon";
import type { AgentSession, ProfileOut } from "../../lib/api";

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(min: number, max: number, v: number): number {
  return Math.min(max, Math.max(min, v));
}

function screenToWorld(
  sx: number,
  sy: number,
  view: ViewTransform,
): [number, number] {
  return [(sx - view.tx) / view.scale, (sy - view.ty) / view.scale];
}

function pickNode(
  sx: number,
  sy: number,
  layout: ConstellationLayout,
  view: ViewTransform,
): ConstellationNode | null {
  const [wx, wy] = screenToWorld(sx, sy, view);
  let best: ConstellationNode | null = null;
  let bd = 1e9;
  for (const nd of layout.nodes) {
    if (nd.kind === "hub") continue;
    if (!(nd as ConstellationNode & { vis?: boolean }).vis) continue;
    const d = Math.hypot(nd.x - wx, nd.y - wy);
    if (d < nd.r + 6 && d < bd) {
      bd = d;
      best = nd;
    }
  }
  return best;
}

function statusColor(status: string): string {
  if (status === "active") return "#22c55e";
  if (status === "idle") return "#f59e0b";
  return "#7a8290";
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConstellationOverlayProps {
  open: boolean;
  cardCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  layoutRef: React.MutableRefObject<ConstellationLayout>;
  layoutVersion: number;
  reheat: (alpha?: number) => void;
  dragActiveRef: React.MutableRefObject<boolean>;
  resetLayout: (sessions: AgentSession[], profiles: ProfileOut[]) => void;
  sessions: AgentSession[];
  profiles: ProfileOut[];
  windowMode: ConstellationWindow;
  activeId: string | null;
  onPick: (id: string) => void;
  onWindowChange: (w: ConstellationWindow) => void;
  onClose: () => void;
  onLayoutMoved: () => void;
}

const WINDOW_OPTIONS: { label: string; value: ConstellationWindow }[] = [
  { label: "Live", value: "live" },
  { label: "1h", value: "1h" },
  { label: "24h", value: "24h" },
  { label: "7d", value: "7d" },
];

// ── Component ─────────────────────────────────────────────────────────────────

type Phase = "closed" | "animating-in" | "open" | "animating-out";

export function ConstellationOverlay({
  open,
  cardCanvasRef,
  layoutRef,
  layoutVersion,
  reheat,
  dragActiveRef,
  resetLayout,
  sessions,
  profiles,
  windowMode,
  activeId,
  onPick,
  onWindowChange,
  onClose,
  onLayoutMoved,
}: ConstellationOverlayProps): ReactElement | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // View transform
  const [view, setView] = useState<ViewTransform>({ scale: 1, tx: 0, ty: 0 });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [focusProfile, setFocusProfile] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Local selected id — initialised from activeId, updated by overlay clicks
  const [selectedId, setSelectedId] = useState<string | null>(activeId);

  // Phase state machine — driven by layout effects (no render-time setState)
  const phaseRef = useRef<Phase>("closed");
  const [phase, setPhaseState] = useState<Phase>("closed");
  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);

  const layoutMovedRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2200);
  }, []);

  // ── Sync activeId into selectedId when overlay is closed (external nav) ──────
  // Only update when overlay isn't open so we don't clobber the user's in-overlay selection.
  const prevOpenRef = useRef(open);
  useLayoutEffect(() => {
    // Sync on open transition (reset to parent selection)
    if (open && !prevOpenRef.current) {
      setSelectedId(activeId);
    }
    prevOpenRef.current = open;
  }, [open, activeId]);

  // ── Drive phase from `open` prop using layoutEffect (DOM-measured) ────────────
  useLayoutEffect(() => {
    const cur = phaseRef.current;
    if (open) {
      if (cur === "closed") {
        setPhase("animating-in");
        layoutMovedRef.current = false;
      }
    } else {
      if (cur === "open" || cur === "animating-in") {
        setPhase("animating-out");
      }
    }
  }, [open, setPhase]);

  // ── FLIP open animation ───────────────────────────────────────────────────────
  useLayoutEffect(() => {
    if (phase !== "animating-in") return;
    const panel = panelRef.current;
    const backdrop = backdropRef.current;
    const card = cardCanvasRef.current;
    if (!panel || !backdrop) {
      setPhase("open");
      return;
    }

    // Seed fit view
    const wrap = canvasWrapRef.current;
    if (wrap) {
      const cssW = wrap.clientWidth;
      const cssH = wrap.clientHeight;
      if (cssW > 0 && cssH > 0)
        setView(fitView(layoutRef.current, cssW, cssH, 40));
    }
    reheat(0.18);

    // FLIP from card rect
    const pr = panel.getBoundingClientRect();
    if (card) {
      const cr = card.getBoundingClientRect();
      const sx = cr.width / Math.max(pr.width, 1);
      const sy = cr.height / Math.max(pr.height, 1);
      panel.style.transition = "none";
      panel.style.transformOrigin = "top left";
      panel.style.transform = `translate(${cr.left - pr.left}px,${cr.top - pr.top}px) scale(${sx},${sy})`;
      panel.style.opacity = "0.6";
    }
    backdrop.style.opacity = "0";

    void panel.offsetWidth; // force reflow
    panel.style.transition =
      "transform 0.26s cubic-bezier(.2,.7,.2,1), opacity 0.26s ease";
    backdrop.style.transition = "opacity 0.26s ease";
    panel.style.transform = "";
    panel.style.opacity = "1";
    backdrop.style.opacity = "1";

    const t = setTimeout(() => {
      setPhase("open");
      panel.style.transition = "";
      backdrop.style.transition = "";
    }, 280);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // ── FLIP close animation ──────────────────────────────────────────────────────
  useLayoutEffect(() => {
    if (phase !== "animating-out") return;
    const panel = panelRef.current;
    const backdrop = backdropRef.current;
    const card = cardCanvasRef.current;
    if (!panel || !backdrop) {
      setPhase("closed");
      if (layoutMovedRef.current) {
        onLayoutMoved();
        layoutMovedRef.current = false;
      }
      onClose();
      return;
    }

    const pr = panel.getBoundingClientRect();
    if (card) {
      const cr = card.getBoundingClientRect();
      const sx = cr.width / Math.max(pr.width, 1);
      const sy = cr.height / Math.max(pr.height, 1);
      panel.style.transition =
        "transform 0.24s cubic-bezier(.4,0,.2,1), opacity 0.24s ease";
      backdrop.style.transition = "opacity 0.24s ease";
      panel.style.transformOrigin = "top left";
      panel.style.transform = `translate(${cr.left - pr.left}px,${cr.top - pr.top}px) scale(${sx},${sy})`;
      panel.style.opacity = "0.4";
      backdrop.style.opacity = "0";
    }

    const t = setTimeout(() => {
      panel.style.transition = "";
      panel.style.transform = "";
      panel.style.opacity = "1";
      backdrop.style.transition = "";
      setPhase("closed");
      setFocusProfile(null);
      if (layoutMovedRef.current) {
        onLayoutMoved();
        layoutMovedRef.current = false;
        showToast("Arrangement synced to the minimized card");
      }
      onClose();
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // ── Close on Esc ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase === "closed") return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPhase("animating-out");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, setPhase]);

  // ── Focus trap ────────────────────────────────────────────────────────────────
  const firstFocusableRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (phase !== "open") return;
    firstFocusableRef.current?.focus();
    const panel = panelRef.current;
    if (!panel) return;
    function trapFocus(e: KeyboardEvent) {
      if (e.key !== "Tab" || !panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    panel.addEventListener("keydown", trapFocus);
    return () => panel.removeEventListener("keydown", trapFocus);
  }, [phase]);

  // ── View helpers ──────────────────────────────────────────────────────────────
  const zoomBy = useCallback((factor: number) => {
    const wrap = canvasWrapRef.current;
    if (!wrap) return;
    const cx = wrap.clientWidth / 2;
    const cy = wrap.clientHeight / 2;
    setView((v) => {
      const ns = clamp(0.25, 4, v.scale * factor);
      const k = ns / v.scale;
      return { scale: ns, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k };
    });
  }, []);

  const doFit = useCallback(() => {
    const wrap = canvasWrapRef.current;
    if (!wrap) return;
    setView(
      fitView(layoutRef.current, wrap.clientWidth, wrap.clientHeight, 40),
    );
  }, [layoutRef]);

  const doReset = useCallback(() => {
    resetLayout(sessions, profiles);
    const wrap = canvasWrapRef.current;
    if (wrap)
      setView(
        fitView(layoutRef.current, wrap.clientWidth, wrap.clientHeight, 40),
      );
    setSelectedId(null);
    setFocusProfile(null);
    layoutMovedRef.current = true;
  }, [resetLayout, sessions, profiles, layoutRef]);

  const handlePanelToggle = useCallback(() => {
    setPanelOpen((o) => {
      setTimeout(() => {
        const wrap = canvasWrapRef.current;
        if (wrap)
          setView(
            fitView(layoutRef.current, wrap.clientWidth, wrap.clientHeight, 40),
          );
      }, 250);
      return !o;
    });
  }, [layoutRef]);

  // ── Pointer events ────────────────────────────────────────────────────────────
  const [cursor, setCursor] = useState<"grab" | "grabbing" | "pointer">("grab");
  const dragNodeRef = useRef<ConstellationNode | null>(null);
  const panningRef = useRef(false);
  const lastPointerRef = useRef({ x: 0, y: 0 });
  const downAtRef = useRef<{ x: number; y: number } | null>(null);
  const pointerMovedRef = useRef(false);

  // We need the current view in pointer handlers but don't want stale closures.
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const getRelPos = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>): [number, number] => {
      const rect = e.currentTarget.getBoundingClientRect();
      return [e.clientX - rect.left, e.clientY - rect.top];
    },
    [],
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      const [x, y] = getRelPos(e);
      downAtRef.current = { x, y };
      pointerMovedRef.current = false;
      lastPointerRef.current = { x, y };
      const nd = pickNode(x, y, layoutRef.current, viewRef.current);
      if (nd) {
        dragNodeRef.current = nd;
        const [wx, wy] = screenToWorld(x, y, viewRef.current);
        if (nd.kind === "project" || nd.kind === "session") {
          nd.fx = wx;
          nd.fy = wy;
        }
        dragActiveRef.current = true;
        setCursor("grabbing");
        reheat(0.34);
      } else {
        panningRef.current = true;
        setCursor("grabbing");
      }
    },
    [getRelPos, layoutRef, dragActiveRef, reheat],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      const [x, y] = getRelPos(e);
      const down = downAtRef.current;
      if (down && Math.abs(x - down.x) + Math.abs(y - down.y) > 3) {
        pointerMovedRef.current = true;
      }
      const dragNode = dragNodeRef.current;
      if (dragNode) {
        const [wx, wy] = screenToWorld(x, y, viewRef.current);
        if (dragNode.kind === "project" || dragNode.kind === "session") {
          dragNode.fx = wx;
          dragNode.fy = wy;
          dragNode.x = wx;
          dragNode.y = wy;
        }
        reheat(0.34);
        layoutMovedRef.current = true;
        setTooltip(null);
      } else if (panningRef.current) {
        const dx = x - lastPointerRef.current.x;
        const dy = y - lastPointerRef.current.y;
        setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));
        lastPointerRef.current = { x, y };
      } else {
        const nd = pickNode(x, y, layoutRef.current, viewRef.current);
        setHoverId(nd ? nd.id : null);
        setCursor(nd ? "pointer" : "grab");
        if (nd && nd.kind === "session") {
          setTooltip({
            x: e.clientX + 12,
            y: e.clientY + 12,
            text: `${nd.profile} — ${nd.status} · ${nd.parent.name}`,
          });
        } else if (nd && nd.kind === "project") {
          setTooltip({
            x: e.clientX + 12,
            y: e.clientY + 12,
            text: `${nd.name} — ${nd.count} session${nd.count !== 1 ? "s" : ""}`,
          });
        } else {
          setTooltip(null);
        }
      }
    },
    [getRelPos, layoutRef, reheat],
  );

  const endPointer = useCallback(() => {
    const dragNode = dragNodeRef.current;
    if (dragNode && !pointerMovedRef.current) {
      setSelectedId(dragNode.id);
      onPick(dragNode.id);
    }
    dragNodeRef.current = null;
    dragActiveRef.current = false;
    panningRef.current = false;
    setCursor("grab");
  }, [onPick, dragActiveRef]);

  const onDblClick = useCallback(
    (e: ReactMouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const nd = pickNode(x, y, layoutRef.current, viewRef.current);
      if (nd && nd.kind !== "hub") {
        if (nd.kind === "project" || nd.kind === "session") {
          delete nd.fx;
          delete nd.fy;
          reheat(0.34);
          layoutMovedRef.current = true;
        }
      }
    },
    [layoutRef, reheat],
  );

  // Scroll-zoom (passive:false so we can preventDefault)
  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.0012);
    setView((v) => {
      const ns = clamp(0.25, 4, v.scale * factor);
      const k = ns / v.scale;
      return { scale: ns, tx: x - (x - v.tx) * k, ty: y - (y - v.ty) * k };
    });
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || phase !== "open") return;
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [phase, onWheel]);

  // ── Fly-to ────────────────────────────────────────────────────────────────────
  const selectAndCenter = useCallback(
    (nd: ConstellationNode) => {
      setSelectedId(nd.id);
      onPick(nd.id);
      const wrap = canvasWrapRef.current;
      if (!wrap) return;
      setView((v) => {
        const z = Math.max(v.scale, 1.15);
        return {
          scale: z,
          tx: wrap.clientWidth / 2 - nd.x * z,
          ty: wrap.clientHeight / 2 - nd.y * z,
        };
      });
      reheat(0.04);
    },
    [onPick, reheat],
  );

  // ── Export ────────────────────────────────────────────────────────────────────
  const handlePNG = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "constellation.png";
      a.click();
      URL.revokeObjectURL(url);
      showToast("Saved constellation.png");
    });
  }, [showToast]);

  const handleCopy = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) {
      showToast("Clipboard blocked — use PNG to save");
      return;
    }
    try {
      if (!navigator.clipboard || !window.ClipboardItem)
        throw new Error("no clipboard api");
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) =>
          b ? resolve(b) : reject(new Error("toBlob failed")),
        ),
      );
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      showToast("Copied image to clipboard");
    } catch {
      showToast("Clipboard blocked here — use PNG to save");
    }
  }, [showToast]);

  // ── Info panel: derive from layoutVersion (re-runs on each tick when open) ───
  // layoutVersion is the repaint signal; we read layoutRef.current inside useMemo
  // rather than during render to satisfy the react-hooks/refs rule.
  const [infoPanelData, setInfoPanelData] = useState<{
    agents: [string, { color: string; active: number; total: number }][];
    projects: ProjectNode[];
    sessions: SessionNode[];
  }>({ agents: [], projects: [], sessions: [] });

  useEffect(() => {
    if (phase === "closed") return;
    const nodes = layoutRef.current.nodes;
    const visSessions = nodes.filter(
      (nd): nd is SessionNode =>
        nd.kind === "session" &&
        (nd as ConstellationNode & { vis?: boolean }).vis !== false,
    );
    const visProjects = nodes.filter(
      (nd): nd is ProjectNode =>
        nd.kind === "project" &&
        (nd as ConstellationNode & { vis?: boolean }).vis !== false,
    );
    type AgentStat = { color: string; active: number; total: number };
    const agentStats = new Map<string, AgentStat>();
    for (const nd of visSessions) {
      const ex = agentStats.get(nd.profile);
      if (ex) {
        if (nd.status === "active") ex.active++;
        ex.total++;
      } else
        agentStats.set(nd.profile, {
          color: nd.color,
          active: nd.status === "active" ? 1 : 0,
          total: 1,
        });
    }
    const agents = Array.from(agentStats.entries()).sort(
      ([, a], [, b]) => b.active - a.active || b.total - a.total,
    );
    setInfoPanelData({ agents, projects: visProjects, sessions: visSessions });
    // layoutVersion is the correct dep — it increments each tick, triggering re-derivation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutVersion, phase]);

  // cursor state is updated in pointer handlers (onPointerDown sets "grabbing",
  // endPointer resets to "grab", onPointerMove sets "pointer"/"grab" on hover).
  const cursorStyle = cursor;

  if (phase === "closed") return null;

  return createPortal(
    <div
      style={{ position: "fixed", inset: 0, zIndex: 50 }}
      role="dialog"
      aria-modal="true"
      aria-label="Live constellation, maximized"
    >
      {/* Backdrop */}
      <div
        ref={backdropRef}
        onClick={() => setPhase("animating-out")}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(4,6,10,.72)",
          backdropFilter: "blur(7px)",
          WebkitBackdropFilter: "blur(7px)",
          opacity: 0,
        }}
      />

      {/* Panel */}
      <div
        ref={panelRef}
        style={{
          position: "absolute",
          inset: 18,
          background: "linear-gradient(180deg,#0c121b,#080b11)",
          border: "1px solid var(--line-2)",
          borderRadius: 18,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 40px 120px -40px #000, 0 0 0 1px rgba(59,130,246,.06)",
          willChange: "transform, opacity",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 14px",
            borderBottom: "1px solid var(--line-1)",
            flexWrap: "wrap",
          }}
        >
          <span
            style={{ fontSize: 13, fontWeight: 600, letterSpacing: ".4px" }}
          >
            Live constellation ·{" "}
            <span style={{ color: "var(--accent)" }}>
              {WINDOW_OPTIONS.find((o) => o.value === windowMode)?.label ??
                "Live"}
            </span>
          </span>

          {/* Window chips */}
          <div style={{ display: "flex", gap: 4 }}>
            {WINDOW_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                ref={opt.value === "live" ? firstFocusableRef : undefined}
                onClick={() => onWindowChange(opt.value)}
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "10.5px",
                  color: windowMode === opt.value ? "#cfe0ff" : "var(--fg-2)",
                  background:
                    windowMode === opt.value
                      ? "rgba(59,130,246,.16)"
                      : "transparent",
                  border: `1px solid ${windowMode === opt.value ? "var(--accent)" : "var(--line-2)"}`,
                  borderRadius: 999,
                  padding: "3px 9px",
                  cursor: "pointer",
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Legend */}
          <div
            style={{
              display: "flex",
              gap: 11,
              fontSize: "10.5px",
              color: "var(--fg-3)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {(["#22c55e", "#f59e0b", "#7a8290"] as const).map((c, i) => (
              <span key={c}>
                <span
                  style={{
                    display: "inline-block",
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: c,
                    marginRight: 5,
                    verticalAlign: "middle",
                  }}
                />
                {["active", "idle", "ended"][i]}
              </span>
            ))}
          </div>

          <div style={{ flex: 1 }} />

          <div style={{ display: "flex", gap: 4 }}>
            <ToolBtn onClick={() => zoomBy(0.8)}>−</ToolBtn>
            <ToolBtn onClick={() => zoomBy(1.25)}>＋</ToolBtn>
            <ToolBtn onClick={doFit}>Fit</ToolBtn>
          </div>
          <ToolBtn onClick={doReset}>⟳ Reset</ToolBtn>
          <ToolBtn onClick={handlePanelToggle}>▦ Panel</ToolBtn>
          <ToolBtn onClick={handleCopy}>⧉ Copy</ToolBtn>
          <ToolBtn onClick={handlePNG}>⤓ PNG</ToolBtn>
          <ToolBtn
            onClick={() => setPhase("animating-out")}
            style={{ borderColor: "rgba(239,68,68,.4)", color: "#ffb4b4" }}
          >
            <Icon name="minimize" size={14} /> Close · Esc
          </ToolBtn>
        </div>

        {/* Body */}
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <div
            ref={canvasWrapRef}
            style={{ position: "relative", flex: 1, minHeight: 0, minWidth: 0 }}
          >
            <ConstellationCanvas
              layoutRef={layoutRef}
              layoutVersion={layoutVersion}
              interactive={true}
              view={view}
              selected={selectedId}
              hover={hoverId}
              focusProfile={focusProfile}
              style={{ cursor: cursorStyle }}
              onCanvasReady={(c) => {
                canvasRef.current = c;
              }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endPointer}
              onPointerCancel={endPointer}
              onDoubleClick={onDblClick}
            />
          </div>

          {/* Info side panel */}
          <div
            style={{
              flexShrink: 0,
              width: panelOpen ? 268 : 0,
              borderLeft: panelOpen ? "1px solid var(--line-1)" : "none",
              background: "rgba(9,13,19,.55)",
              overflowY: "auto",
              overflowX: "hidden",
              transition: "width 0.22s ease",
            }}
          >
            <div style={{ width: 268, padding: "13px 13px 20px" }}>
              {/* Agents */}
              <div style={{ marginBottom: 16 }}>
                <SectionHead>
                  Agents · {infoPanelData.agents.length}
                </SectionHead>
                {infoPanelData.agents.map(([name, stat]) => (
                  <div
                    key={name}
                    onClick={() =>
                      setFocusProfile((p) => (p === name ? null : name))
                    }
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                      padding: "5px 7px",
                      borderRadius: 8,
                      cursor: "pointer",
                      background:
                        focusProfile === name
                          ? "rgba(59,130,246,.14)"
                          : "transparent",
                      outline:
                        focusProfile === name
                          ? "1px solid rgba(59,130,246,.4)"
                          : "none",
                    }}
                  >
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: "50%",
                        background: stat.color,
                        boxShadow: `0 0 7px ${stat.color}`,
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ fontSize: 12.5, color: "var(--fg-0)" }}>
                      {name}
                    </span>
                    <span
                      style={{
                        marginLeft: "auto",
                        fontFamily: "var(--font-mono)",
                        fontSize: 10,
                        color: "var(--fg-3)",
                      }}
                    >
                      {stat.active} live · {stat.total}
                    </span>
                  </div>
                ))}
              </div>

              {/* Projects */}
              <div>
                <SectionHead>
                  Projects · {infoPanelData.projects.length}
                </SectionHead>
                {infoPanelData.projects.map((proj) => {
                  const projSessions = infoPanelData.sessions.filter(
                    (s) => s.parentId === proj.id,
                  );
                  return (
                    <div
                      key={proj.id}
                      onClick={() => selectAndCenter(proj)}
                      style={{
                        border: "1px solid var(--line-1)",
                        borderRadius: 11,
                        padding: "9px 10px 10px",
                        marginBottom: 8,
                        cursor: "pointer",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 7,
                          marginBottom: 8,
                        }}
                      >
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            background: statusColor(proj.status),
                            flexShrink: 0,
                          }}
                        />
                        <span
                          style={{
                            fontSize: 12.5,
                            fontWeight: 600,
                            color: "var(--fg-0)",
                          }}
                        >
                          {proj.name}
                        </span>
                        <span
                          style={{
                            marginLeft: "auto",
                            fontFamily: "var(--font-mono)",
                            fontSize: 9.5,
                            color: "var(--fg-3)",
                          }}
                        >
                          {projSessions.length} session
                          {projSessions.length !== 1 ? "s" : ""}
                        </span>
                      </div>
                      <div
                        style={{ display: "flex", flexWrap: "wrap", gap: 5 }}
                      >
                        {projSessions.map((s) => (
                          <span
                            key={s.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              selectAndCenter(s);
                            }}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 5,
                              fontSize: 11,
                              padding: "3px 8px 3px 6px",
                              borderRadius: 999,
                              border: "1px solid var(--line-2)",
                              color: "var(--fg-2)",
                              cursor: "pointer",
                              opacity: s.status === "ended" ? 0.45 : 1,
                            }}
                          >
                            <span
                              style={{
                                width: 7,
                                height: 7,
                                borderRadius: "50%",
                                background: s.color,
                                flexShrink: 0,
                              }}
                            />
                            {s.profile}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "9px 14px",
            borderTop: "1px solid var(--line-1)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--fg-3)",
            display: "flex",
            gap: 18,
            flexWrap: "wrap",
          }}
        >
          <span>
            <b style={{ color: "var(--fg-2)" }}>drag</b> a node — it stays where
            you drop it
          </span>
          <span>
            <b style={{ color: "var(--fg-2)" }}>double-click</b> to release back
            to physics
          </span>
          <span>
            <b style={{ color: "var(--fg-2)" }}>scroll</b> zoom ·{" "}
            <b style={{ color: "var(--fg-2)" }}>drag bg</b> pan
          </span>
          <span style={{ marginLeft: "auto", color: "var(--fg-4)" }}>
            arrangement syncs to card on close
          </span>
        </div>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          style={{
            position: "fixed",
            left: tooltip.x,
            top: tooltip.y,
            pointerEvents: "none",
            zIndex: 60,
            background: "#0b1018",
            border: "1px solid var(--line-2)",
            borderRadius: 8,
            padding: "6px 9px",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--fg-0)",
            boxShadow: "0 10px 30px -12px #000",
            maxWidth: 260,
          }}
        >
          {tooltip.text}
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div
          style={{
            position: "fixed",
            left: "50%",
            bottom: 34,
            zIndex: 70,
            transform: "translateX(-50%)",
            background: "#0c1422",
            border: "1px solid var(--accent)",
            color: "#dfe9ff",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            padding: "9px 14px",
            borderRadius: 10,
            boxShadow: "0 12px 40px -16px #000",
            pointerEvents: "none",
          }}
        >
          {toast}
        </div>
      )}
    </div>,
    document.body,
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function ToolBtn({
  children,
  onClick,
  style,
}: {
  children: React.ReactNode;
  onClick: () => void;
  style?: React.CSSProperties;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: "var(--fg-2)",
        background: "rgba(255,255,255,.02)",
        border: "1px solid var(--line-2)",
        borderRadius: 9,
        padding: "6px 11px",
        cursor: "pointer",
        display: "inline-flex",
        gap: 6,
        alignItems: "center",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

function SectionHead({
  children,
}: {
  children: React.ReactNode;
}): ReactElement {
  return (
    <div
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        letterSpacing: ".7px",
        textTransform: "uppercase",
        color: "var(--fg-3)",
        margin: "4px 2px 9px",
      }}
    >
      {children}
    </div>
  );
}
