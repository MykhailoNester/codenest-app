import { memo, type ReactElement } from "react";
import type { AgentSession, ProfileOut } from "../../lib/api";
import type { ConstellationLayout } from "./use-constellation-layout";
import { ConstellationCanvas } from "./constellation-canvas";

export interface SessionSource {
  kind: "task" | "inbox";
  id: number;
}

export type ConstellationWindow = "live" | "1h" | "24h" | "7d";

export interface ConstellationProps {
  sessions: AgentSession[];
  activeId: string | null;
  onPick: (sessionId: string) => void;
  profiles: ProfileOut[];
  windowMode: ConstellationWindow;
  /** Optional source attribution per session, derived from recent events payload. */
  sourcesBySession?: ReadonlyMap<string, SessionSource>;
  // ── Lifted layout (shared with overlay) ──────────────────────────────────
  /** Shared layout ref from useConstellationLayout lifted to CommandCenterPage. */
  layoutRef: React.MutableRefObject<ConstellationLayout>;
  /** Layout version counter — triggers canvas repaint. */
  layoutVersion: number;
  /** Called once the canvas element is mounted (used by the maximize FLIP). */
  onCanvasReady?: (canvas: HTMLCanvasElement) => void;
}

/**
 * Constellation card (non-interactive, fit-to-card view).
 *
 * Renders from the shared layoutRef so any arrangement dragged in the overlay
 * is immediately reflected on the card.
 */
function ConstellationInner({
  activeId,
  layoutRef,
  layoutVersion,
  onCanvasReady,
}: ConstellationProps): ReactElement {
  return (
    <ConstellationCanvas
      layoutRef={layoutRef}
      layoutVersion={layoutVersion}
      interactive={false}
      selected={activeId}
      className="d3-net"
      style={{ height: "320px" }}
      onCanvasReady={onCanvasReady}
    />
  );
}

function constellationEqual(
  prev: ConstellationProps,
  next: ConstellationProps,
): boolean {
  // Always re-render when layoutVersion changes — that is the repaint signal.
  if (prev.layoutVersion !== next.layoutVersion) return false;
  if (prev.activeId !== next.activeId) return false;
  if (prev.onPick !== next.onPick) return false;
  if (prev.windowMode !== next.windowMode) return false;
  if (prev.sourcesBySession !== next.sourcesBySession) return false;
  if (prev.sessions.length !== next.sessions.length) return false;
  return prev.sessions.every((s, i) => {
    const n = next.sessions[i]!;
    return s.session_id === n.session_id && s.status === n.status;
  });
}

export const Constellation = memo(ConstellationInner, constellationEqual);
