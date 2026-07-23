/**
 * useConstellationLayout — constrained-radial force simulation.
 *
 * Owns the graph's node positions as a stable mutable ref (not React state)
 * so that rAF ticks don't trigger re-renders. Instead, callers subscribe to
 * `layoutVersion` (incremented each tick) to know when to repaint.
 *
 * Single source of truth: the card and the overlay both read from
 * `layoutRef.current.nodes` — dragging in the overlay is reflected on the
 * card because they share the same objects.
 *
 * Node lifecycle: on SSE-driven session changes, new nodes are seeded with
 * physics-start positions; existing nodes keep their x/y/fx/fy untouched.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import type { AgentSession, ProfileOut } from "../../lib/api";
import { profileColor } from "../../lib/profile-utils";

// ── World constants (same as prototype) ──────────────────────────────────────
const RING_R = 235;
const ALPHA_DECAY = 0.022;
const VEL_DECAY = 0.4;
const INITIAL_ALPHA = 0.16;

// ── Node types ────────────────────────────────────────────────────────────────

export interface HubNode {
  readonly kind: "hub";
  id: "hub";
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

export interface ProjectNode {
  readonly kind: "project";
  id: string; // "p:<name>"
  name: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** If set, node is pinned at this world coordinate. */
  fx?: number;
  fy?: number;
  r: number;
  status: "active" | "idle" | "ended";
  count: number;
}

export interface SessionNode {
  readonly kind: "session";
  /** session_id from the backend */
  id: string;
  profile: string;
  color: string;
  status: "active" | "idle" | "ended" | "stopped";
  parentId: string; // ProjectNode.id
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx?: number;
  fy?: number;
  r: number;
  /** The parent project reference (kept for perf — avoids map lookup per-tick). */
  parent: ProjectNode;
}

export type ConstellationNode = HubNode | ProjectNode | SessionNode;

export interface ConstellationLink {
  source: ConstellationNode;
  target: ConstellationNode;
  active: boolean;
}

export interface ConstellationLayout {
  nodes: ConstellationNode[];
  links: ConstellationLink[];
  nodeById: Map<string, ConstellationNode>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(min: number, max: number, value: number): number {
  return Math.min(max, Math.max(min, value));
}

function projR(sessionCount: number): number {
  return clamp(12, 27, 12 + Math.log2(sessionCount + 1) * 3.2);
}

function projectLabel(s: AgentSession): string {
  if (s.project_name) return s.project_name;
  if (s.cwd) {
    const parts = s.cwd.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? s.cwd;
  }
  return "unknown";
}

function deriveProjectStatus(
  sessions: AgentSession[],
): "active" | "idle" | "ended" {
  if (sessions.some((s) => s.status === "active")) return "active";
  if (sessions.some((s) => s.status === "idle")) return "idle";
  return "ended";
}

/** Map a session status to the display-layer status used by the sim. */
function simStatus(s: AgentSession): "active" | "idle" | "ended" {
  if (s.status === "active") return "active";
  if (s.status === "idle") return "idle";
  return "ended";
}

// ── Seed a new layout from scratch ────────────────────────────────────────────

function seedLayout(
  sessions: AgentSession[],
  profiles: ProfileOut[],
): ConstellationLayout {
  const nodes: ConstellationNode[] = [];
  const links: ConstellationLink[] = [];
  const nodeById = new Map<string, ConstellationNode>();

  const hub: HubNode = {
    kind: "hub",
    id: "hub",
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    r: 18,
  };
  nodes.push(hub);
  nodeById.set("hub", hub);

  // Build project groups
  const projectMap = new Map<string, AgentSession[]>();
  for (const s of sessions) {
    const name = projectLabel(s);
    const existing = projectMap.get(name);
    if (existing) {
      existing.push(s);
    } else {
      projectMap.set(name, [s]);
    }
  }

  const projectNames = Array.from(projectMap.keys());
  const n = projectNames.length;

  for (let i = 0; i < n; i++) {
    const name = projectNames[i]!;
    const projectSessions = projectMap.get(name)!;
    const angle = (i / Math.max(n, 1)) * Math.PI * 2 - Math.PI / 2;
    const px = Math.cos(angle) * RING_R;
    const py = Math.sin(angle) * RING_R;
    const status = deriveProjectStatus(projectSessions);

    const projNode: ProjectNode = {
      kind: "project",
      id: `p:${name}`,
      name,
      x: px,
      y: py,
      vx: 0,
      vy: 0,
      r: projR(projectSessions.length),
      status,
      count: projectSessions.length,
    };
    nodes.push(projNode);
    nodeById.set(projNode.id, projNode);

    links.push({ source: hub, target: projNode, active: status === "active" });

    const orbit = projNode.r + 38;
    for (let j = 0; j < projectSessions.length; j++) {
      const s = projectSessions[j]!;
      const sa = (j / projectSessions.length) * Math.PI * 2 + i * 0.7;
      const sessNode: SessionNode = {
        kind: "session",
        id: s.session_id,
        profile: s.profile,
        color: profileColor(profiles, s.profile),
        status: simStatus(s),
        parentId: projNode.id,
        parent: projNode,
        x: px + Math.cos(sa) * orbit,
        y: py + Math.sin(sa) * orbit,
        vx: 0,
        vy: 0,
        r: simStatus(s) === "ended" ? 6.2 : 7.4,
      };
      nodes.push(sessNode);
      nodeById.set(sessNode.id, sessNode);
      links.push({
        source: projNode,
        target: sessNode,
        active: simStatus(s) === "active",
      });
    }
  }

  return { nodes, links, nodeById };
}

// ── Fold live session updates into an existing layout ─────────────────────────
// Preserves positions and pins for unchanged nodes; adds new ones; removes gone ones.

function foldUpdate(
  prev: ConstellationLayout,
  sessions: AgentSession[],
  profiles: ProfileOut[],
): ConstellationLayout {
  // Build new seed to find the desired graph topology
  const fresh = seedLayout(sessions, profiles);

  const nextNodes: ConstellationNode[] = [];
  const nextById = new Map<string, ConstellationNode>();

  // Hub always stays at 0,0
  const hub = prev.nodeById.get("hub") ?? fresh.nodeById.get("hub")!;
  nextNodes.push(hub);
  nextById.set("hub", hub);

  // For project and session nodes: keep existing object (with its position/pins)
  // if it already exists; otherwise take the fresh seed.
  for (const freshNode of fresh.nodes) {
    if (freshNode.kind === "hub") continue;
    const existing = prev.nodeById.get(freshNode.id);
    if (existing && existing.kind === freshNode.kind) {
      // Patch mutable fields that may have changed (status, count, color)
      if (existing.kind === "project" && freshNode.kind === "project") {
        existing.status = freshNode.status;
        existing.count = freshNode.count;
        existing.r = freshNode.r;
      }
      if (existing.kind === "session" && freshNode.kind === "session") {
        existing.status = freshNode.status;
        existing.r = freshNode.r;
        existing.color = freshNode.color;
        // Update parent reference in case the project node object was replaced
        const parentNode =
          nextById.get(freshNode.parentId) ??
          prev.nodeById.get(freshNode.parentId);
        if (parentNode && parentNode.kind === "project") {
          existing.parent = parentNode;
        }
      }
      nextNodes.push(existing);
      nextById.set(freshNode.id, existing);
    } else {
      // New node — seed at fresh position
      if (freshNode.kind === "session") {
        // Fix up parent reference to point to the node in nextById
        const parentNode = nextById.get(freshNode.parentId);
        if (parentNode && parentNode.kind === "project") {
          (freshNode as SessionNode).parent = parentNode;
        }
      }
      nextNodes.push(freshNode);
      nextById.set(freshNode.id, freshNode);
    }
  }

  // Rebuild links from fresh topology, resolving node references from nextById
  const nextLinks: ConstellationLink[] = [];
  for (const l of fresh.links) {
    const source = nextById.get(l.source.id);
    const target = nextById.get(l.target.id);
    if (source && target) {
      nextLinks.push({ source, target, active: l.active });
    }
  }

  return { nodes: nextNodes, links: nextLinks, nodeById: nextById };
}

// ── Force tick ────────────────────────────────────────────────────────────────

function tick(layout: ConstellationLayout, alpha: number): void {
  const { nodes, links } = layout;
  const visible = nodes.filter(isVisible);

  // Charge repulsion (n² — node count is small)
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      const a = visible[i]!;
      const b = visible[j]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d2 = dx * dx + dy * dy + 0.01;
      const d = Math.sqrt(d2);
      const strength = a.kind === "session" && b.kind === "session" ? 260 : 520;
      const f = (strength / d2) * alpha;
      const ux = dx / d;
      const uy = dy / d;
      if (a.kind !== "hub") {
        a.vx -= ux * f;
        a.vy -= uy * f;
      }
      if (b.kind !== "hub") {
        b.vx += ux * f;
        b.vy += uy * f;
      }
    }
  }

  // Link springs
  for (const l of links) {
    if (!isVisible(l.source) || !isVisible(l.target)) continue;
    const rest =
      l.source.kind === "hub"
        ? RING_R
        : l.target.kind === "session"
          ? l.target.parent.r + 38
          : 40;
    const dx = l.target.x - l.source.x;
    const dy = l.target.y - l.source.y;
    const d = Math.hypot(dx, dy) + 0.01;
    const k = ((d - rest) / d) * 0.5 * alpha;
    const fx = dx * k;
    const fy = dy * k;
    if (l.source.kind !== "hub") {
      l.source.vx += fx * 0.5;
      l.source.vy += fy * 0.5;
    }
    if (l.target.kind !== "hub") {
      l.target.vx -= fx * 0.5;
      l.target.vy -= fy * 0.5;
    }
  }

  // Radial constraints: projects → ring, sessions → orbit parent
  for (const nd of visible) {
    if (nd.kind === "project") {
      const d = Math.hypot(nd.x, nd.y) || 0.01;
      const diff = RING_R - d;
      nd.vx += (nd.x / d) * diff * 0.06 * alpha;
      nd.vy += (nd.y / d) * diff * 0.06 * alpha;
      nd.vx += (0 - nd.x) * 0.004 * alpha;
      nd.vy += (0 - nd.y) * 0.004 * alpha;
    } else if (nd.kind === "session") {
      const p = nd.parent;
      const dx = nd.x - p.x;
      const dy = nd.y - p.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const orbit = p.r + 38;
      const diff = orbit - d;
      nd.vx += (dx / d) * diff * 0.12 * alpha;
      nd.vy += (dy / d) * diff * 0.12 * alpha;
    }
  }

  // Integrate + damping
  for (const nd of visible) {
    if (nd.kind === "hub") {
      nd.x = 0;
      nd.y = 0;
      nd.vx = 0;
      nd.vy = 0;
      continue;
    }
    if (nd.kind === "project" || nd.kind === "session") {
      if (nd.fx !== undefined) {
        nd.x = nd.fx;
        nd.y = nd.fy!;
        nd.vx = 0;
        nd.vy = 0;
        continue;
      }
    }
    nd.x += nd.vx;
    nd.y += nd.vy;
    nd.vx *= 1 - VEL_DECAY;
    nd.vy *= 1 - VEL_DECAY;
  }

  // Collision relaxation (one pass)
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      const a = visible[i]!;
      const b = visible[j]!;
      const minDist = a.r + b.r + 5;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 0.01;
      if (d < minDist) {
        const push = (minDist - d) / d / 2;
        const ox = dx * push;
        const oy = dy * push;
        // Hub is always fixed; project/session nodes are free unless pinned (fx set).
        const aFree = a.kind !== "hub" && !("fx" in a && a.fx !== undefined);
        const bFree = b.kind !== "hub" && !("fx" in b && b.fx !== undefined);
        if (aFree) {
          a.x -= ox;
          a.y -= oy;
        }
        if (bFree) {
          b.x += ox;
          b.y += oy;
        }
      }
    }
  }
}

// ── Visibility filter (mirrors prototype's applyVisibility) ───────────────────

function isVisible(nd: ConstellationNode): boolean {
  // HubNode is always visible; visibility is set during layout computation
  // The `vis` flag is computed by the hook and stored on the node objects.
  return (nd as ConstellationNode & { vis?: boolean }).vis !== false;
}

function applyVisibility(
  layout: ConstellationLayout,
  windowMode: "live" | "1h" | "24h" | "7d",
  now: number = Date.now(),
): void {
  const cutoffMap: Record<string, number> = {
    "1h": now - 60 * 60 * 1000,
    "24h": now - 24 * 60 * 60 * 1000,
    "7d": now - 7 * 24 * 60 * 60 * 1000,
  };

  for (const nd of layout.nodes) {
    const n = nd as ConstellationNode & { vis: boolean };
    if (nd.kind === "hub") {
      n.vis = true;
    } else if (nd.kind === "session") {
      n.vis = windowMode === "live" ? nd.status !== "ended" : true;
      // For historical windows: only show if within cutoff
      if (windowMode !== "live") {
        const cutoff = cutoffMap[windowMode];
        if (cutoff !== undefined) {
          // Session nodes in the sim don't carry timestamps — rely on the
          // caller filtering sessions before passing them to this hook.
          // So all session nodes in the layout ARE within window.
          n.vis = true;
        }
      }
    }
  }

  // Projects visible if any visible session belongs to them
  for (const nd of layout.nodes) {
    if (nd.kind !== "project") continue;
    const n = nd as ConstellationNode & { vis: boolean };
    n.vis = layout.nodes.some(
      (s) =>
        s.kind === "session" &&
        s.parentId === nd.id &&
        (s as ConstellationNode & { vis: boolean }).vis,
    );
  }
}

// ── Public hook ───────────────────────────────────────────────────────────────

export interface UseConstellationLayoutResult {
  /** Stable mutable ref — do NOT use as React dep. Read `.current` in rAF callbacks. */
  layoutRef: React.MutableRefObject<ConstellationLayout>;
  /** Increments each animation frame while sim is running. Use as canvas repaint trigger. */
  layoutVersion: number;
  /** Heat the sim (e.g. after a drag pin). Values 0–1; typically 0.1–0.34. */
  reheat: (alpha?: number) => void;
  /**
   * Set to true while a pointer drag is in progress so the rAF loop keeps
   * running even after alpha decays to zero.
   */
  dragActiveRef: React.MutableRefObject<boolean>;
  /** Re-seed all positions from scratch (wipes manual pins). */
  resetLayout: (sessions: AgentSession[], profiles: ProfileOut[]) => void;
}

export function useConstellationLayout(
  sessions: AgentSession[],
  profiles: ProfileOut[],
  windowMode: "live" | "1h" | "24h" | "7d",
): UseConstellationLayoutResult {
  const layoutRef = useRef<ConstellationLayout>(seedLayout(sessions, profiles));

  // Alpha lives in a ref so the rAF loop mutates it without re-renders
  const alphaRef = useRef(INITIAL_ALPHA);
  const dragActiveRef = useRef(false); // set to true while pointer is held
  const [layoutVersion, setLayoutVersion] = useState(0);
  const rafRef = useRef<number | null>(null);

  // Keep a stable ref to current sessions/profiles for resetLayout
  const sessionsRef = useRef(sessions);
  const profilesRef = useRef(profiles);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  useEffect(() => {
    profilesRef.current = profiles;
  }, [profiles]);

  const reheat = useCallback((value = 0.32) => {
    alphaRef.current = Math.max(alphaRef.current, value);
  }, []);

  const resetLayout = useCallback(
    (s: AgentSession[], p: ProfileOut[]) => {
      layoutRef.current = seedLayout(s, p);
      applyVisibility(layoutRef.current, windowMode);
      reheat(0.3);
    },
    [windowMode, reheat],
  );

  // Main animation loop
  useEffect(() => {
    let cancelled = false;

    function frame() {
      if (cancelled) return;

      const alpha = alphaRef.current;
      const hasDrag = dragActiveRef.current;

      if (alpha > 0.0015 || hasDrag) {
        // Decay alpha
        alphaRef.current += (0 - alpha) * ALPHA_DECAY;

        applyVisibility(layoutRef.current, windowMode);
        tick(layoutRef.current, alphaRef.current);
        setLayoutVersion((v) => v + 1);
      }

      rafRef.current = requestAnimationFrame(frame);
    }

    rafRef.current = requestAnimationFrame(frame);
    return () => {
      cancelled = true;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
    // windowMode is read inside the loop; restart loop when it changes.
    // sessions/profiles are handled below in a separate effect.
  }, [windowMode]);

  // Fold session changes into the layout without resetting pins
  useEffect(() => {
    layoutRef.current = foldUpdate(layoutRef.current, sessions, profiles);
    applyVisibility(layoutRef.current, windowMode);
    reheat(0.18);
    // `layoutRef` is a stable mutable ref — not a dep.
  }, [sessions, profiles, windowMode, reheat]);

  return { layoutRef, layoutVersion, reheat, dragActiveRef, resetLayout };
}

// Re-export for canvas renderer convenience
export { RING_R };

// ── View transform helpers (used by canvas renderer + overlay) ────────────────

export interface ViewTransform {
  scale: number;
  tx: number;
  ty: number;
}

/** Compute a fit-to-canvas view from the current visible nodes. */
export function fitView(
  layout: ConstellationLayout,
  cssW: number,
  cssH: number,
  pad = 18,
): ViewTransform {
  const m = 40;
  let minX = 1e9,
    minY = 1e9,
    maxX = -1e9,
    maxY = -1e9;
  for (const nd of layout.nodes) {
    if (!(nd as ConstellationNode & { vis?: boolean }).vis) continue;
    minX = Math.min(minX, nd.x - nd.r - m);
    minY = Math.min(minY, nd.y - nd.r - m);
    maxX = Math.max(maxX, nd.x + nd.r + m);
    maxY = Math.max(maxY, nd.y + nd.r + m);
  }
  if (!Number.isFinite(minX)) return { scale: 1, tx: cssW / 2, ty: cssH / 2 };

  const w = maxX - minX;
  const h = maxY - minY;
  let s = Math.min((cssW - pad * 2) / w, (cssH - pad * 2) / h);
  if (!Number.isFinite(s) || s <= 0) s = 1;
  return {
    scale: s,
    tx: cssW / 2 - ((minX + maxX) / 2) * s,
    ty: cssH / 2 - ((minY + maxY) / 2) * s,
  };
}
