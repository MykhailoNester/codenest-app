import { useEffect, useState, type ReactElement } from "react";
import { formatUSD } from "../../lib/format-helpers";
import {
  startSessionHudFeed,
  useGitPaneStatus,
  useSessionHud,
} from "../../stores/session-hud-store";
import {
  elapsedSecondsBetween,
  elapsedSecondsSince,
  formatContextPercent,
  formatElapsed,
  formatModelLabel,
  formatTokens,
} from "./session-hud-format";
import {
  CELL_STYLE,
  hudCells,
  type HudCell,
  KEY_STYLE,
  STRIP_DIMMED_STYLE,
  STRIP_STYLE,
  THINK_STYLE,
  VALUE_ACC_STYLE,
  VALUE_INFO_STYLE,
  VALUE_MUTED_STYLE,
  VALUE_NUM_STYLE,
  VALUE_OK_STYLE,
  VALUE_STYLE,
  VALUE_WARN_STYLE,
} from "./session-hud-chrome";
import { ThinkingDot, ToolSpinner } from "./session-hud-motion";

// ─── Per-pane session-state strip ──────────────────────────────────────────
//
// Honesty contract (binding on every cell added here): a cell renders a real
// value or it does not render at all. No placeholder number, no em dash, no
// zero standing in for "unknown" — see `app/models/session_hud.py`'s module
// docstring for the sidecar side of the same contract.
//
// - D7 (see `app/services/session_hud_service.py::_thinking`): "thinking" has
//   no hook — it is inferred from the newest hook event type. The cell's
//   `title` says so; treat it as the one cell here that is an inference
//   rather than a fact.
// - D8: the cost cell shows `cost_usd` exactly as the sidecar stored it. That
//   arithmetic prices every model at Sonnet-4 rates (a real, separately
//   tracked defect this branch does not touch) — the cell's `title` says so.
// - D11: elapsed never runs on a dead pane. `ended_at` present freezes it
//   exactly; a pane that exited with no `ended_at` omits the cell rather than
//   guessing when it ended. The same rule drops the live-tool and thinking
//   cells for a dimmed pane — a "tool is running" claim on a dead process
//   would be a lie.
// - The strip is independent of the pane header (D9): it renders as long as
//   it has at least one real cell, so it still shows up on the default
//   single-terminal layout, which has no header at all.

interface SessionHudProps {
  paneId: string;
  cwd: string | undefined;
  /** True once the pane's backing process has exited — see D11. */
  exited: boolean;
}

export function SessionHud({
  paneId,
  cwd,
  exited,
}: SessionHudProps): ReactElement | null {
  const hud = useSessionHud(paneId);
  const git = useGitPaneStatus(cwd);

  useEffect(() => {
    startSessionHudFeed();
  }, []);

  // "No live agent session bound to this pane" (prototype:383's shell-pane
  // treatment), extended by D11 to a pane whose process has exited: an
  // `active` DB row on a dead PTY must still dim and must not show a
  // spinning tool or a pulsing "Thinking".
  const live =
    !exited &&
    hud !== null &&
    (hud.status === "active" || hud.status === "idle");
  const dimmed = !live;

  // D11 — nothing ticks on a dead pane: no live session, an exited process,
  // or a session that already recorded ended_at (elapsed is then frozen).
  const ticking = live && hud !== null && hud.ended_at == null;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [ticking]);

  const cells: HudCell[] = [];

  if (hud?.model) {
    cells.push(
      <div key="model" style={CELL_STYLE} data-cell="model">
        <span style={VALUE_ACC_STYLE} title={hud.model}>
          {formatModelLabel(hud.model)}
        </span>
      </div>,
    );
  }

  if (hud !== null && hud.context_tokens != null && hud.context_window != null) {
    const pct = Math.min(
      100,
      Math.round((hud.context_tokens / hud.context_window) * 100),
    );
    cells.push(
      <div key="ctx" style={CELL_STYLE} data-cell="ctx">
        <span style={KEY_STYLE}>ctx</span>
        <span className="dk-meter">
          <i style={{ width: `${pct}%` }} />
        </span>
        <span style={VALUE_OK_STYLE}>
          {formatContextPercent(hud.context_tokens, hud.context_window)}
        </span>
      </div>,
    );
    cells.push(
      <div key="tokens" style={CELL_STYLE} data-cell="tokens">
        <span style={VALUE_NUM_STYLE}>
          {formatTokens(hud.context_tokens)}/{formatTokens(hud.context_window)}
        </span>
      </div>,
    );
  }

  if (hud !== null) {
    cells.push(
      <div key="cost" style={CELL_STYLE} data-cell="cost">
        <span
          style={VALUE_WARN_STYLE}
          title="Estimated — all models are currently priced at Sonnet-4 rates"
        >
          {formatUSD(hud.cost_usd)}
        </span>
      </div>,
    );

    let elapsedSeconds: number | null = null;
    if (hud.ended_at != null) {
      elapsedSeconds = elapsedSecondsBetween(hud.started_at, hud.ended_at);
    } else if (!exited) {
      elapsedSeconds = elapsedSecondsSince(hud.started_at);
    }
    // exited with no ended_at leaves elapsedSeconds null — omitted, not
    // guessed (D11).
    if (elapsedSeconds !== null) {
      cells.push(
        <div key="elapsed" style={CELL_STYLE} data-cell="elapsed">
          <span style={VALUE_STYLE}>{formatElapsed(elapsedSeconds)}</span>
        </div>,
      );
    }
  }

  if (git !== null) {
    cells.push(
      <div key="git" style={CELL_STYLE} data-cell="git">
        <span style={VALUE_OK_STYLE}>{git.branch}</span>
        {git.dirty ? (
          <span style={VALUE_WARN_STYLE}>*</span>
        ) : null}
        {git.ahead != null && git.ahead > 0 ? (
          <span style={VALUE_INFO_STYLE}>
            +{git.ahead}
          </span>
        ) : null}
      </div>,
    );
  }

  if (
    hud !== null &&
    hud.current_tool &&
    hud.current_tool_started_at &&
    !dimmed
  ) {
    const toolElapsed = elapsedSecondsSince(hud.current_tool_started_at);
    cells.push(
      <div key="tool" style={CELL_STYLE} data-cell="tool">
        <ToolSpinner />
        <span style={VALUE_INFO_STYLE}>
          {hud.current_tool}
        </span>
        <span style={VALUE_MUTED_STYLE}>
          {formatElapsed(toolElapsed)}
        </span>
      </div>,
    );
  }

  if (hud?.thinking === true && !dimmed) {
    cells.push(
      <div
        key="thinking"
        style={CELL_STYLE}
        data-cell="thinking"
        title="Inferred from the hook stream — Claude Code fires no thinking hook."
      >
        <span style={THINK_STYLE}>
          <ThinkingDot />
          Thinking
        </span>
      </div>,
    );
  }

  if (hud !== null && hud.todo_total != null && hud.todo_total > 0) {
    const total = hud.todo_total;
    const done = hud.todo_done ?? 0;
    const pct = Math.min(100, Math.round((done / total) * 100));
    cells.push(
      <div key="todo" style={CELL_STYLE} data-cell="todo">
        <span style={KEY_STYLE}>todo</span>
        <span className="dk-meter">
          <i style={{ width: `${pct}%` }} />
        </span>
        <span style={VALUE_NUM_STYLE}>
          {done}/{total}
        </span>
      </div>,
    );
  }

  if (cells.length === 0) return null;

  return (
    <div
      style={dimmed ? STRIP_DIMMED_STYLE : STRIP_STYLE}
      data-testid="session-hud"
      data-dimmed={dimmed ? "true" : "false"}
    >
      {hudCells(cells)}
    </div>
  );
}
