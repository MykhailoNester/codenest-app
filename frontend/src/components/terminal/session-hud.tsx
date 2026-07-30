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
import styles from "./session-hud.module.css";

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

  const cells: ReactElement[] = [];

  if (hud?.model) {
    cells.push(
      <div key="model" className={styles.cell} data-cell="model">
        <span className={`${styles.value} ${styles.acc}`} title={hud.model}>
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
      <div key="ctx" className={styles.cell} data-cell="ctx">
        <span className={styles.key}>ctx</span>
        <span className={styles.cbar}>
          <span className={styles.cbarFill} style={{ width: `${pct}%` }} />
        </span>
        <span className={`${styles.value} ${styles.ok}`}>
          {formatContextPercent(hud.context_tokens, hud.context_window)}
        </span>
      </div>,
    );
    cells.push(
      <div key="tokens" className={styles.cell} data-cell="tokens">
        <span className={`${styles.value} ${styles.pink}`}>
          {formatTokens(hud.context_tokens)}/{formatTokens(hud.context_window)}
        </span>
      </div>,
    );
  }

  if (hud !== null) {
    cells.push(
      <div key="cost" className={styles.cell} data-cell="cost">
        <span
          className={`${styles.value} ${styles.warn}`}
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
        <div key="elapsed" className={styles.cell} data-cell="elapsed">
          <span className={styles.value}>{formatElapsed(elapsedSeconds)}</span>
        </div>,
      );
    }
  }

  if (git !== null) {
    cells.push(
      <div key="git" className={styles.cell} data-cell="git">
        <span className={`${styles.value} ${styles.ok}`}>{git.branch}</span>
        {git.dirty ? (
          <span className={`${styles.value} ${styles.warn}`}>*</span>
        ) : null}
        {git.ahead != null && git.ahead > 0 ? (
          <span className={`${styles.value} ${styles.info}`}>
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
      <div key="tool" className={styles.cell} data-cell="tool">
        <span className={styles.spin}>⚙</span>
        <span className={`${styles.value} ${styles.info}`}>
          {hud.current_tool}
        </span>
        <span className={`${styles.value} ${styles.muted}`}>
          {formatElapsed(toolElapsed)}
        </span>
      </div>,
    );
  }

  if (hud?.thinking === true && !dimmed) {
    cells.push(
      <div
        key="thinking"
        className={styles.cell}
        data-cell="thinking"
        title="Inferred from the hook stream — Claude Code fires no thinking hook."
      >
        <span className={styles.think}>
          <span className={styles.thinkDot} />
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
      <div key="todo" className={styles.cell} data-cell="todo">
        <span className={styles.key}>todo</span>
        <span className={styles.tdbar}>
          <span className={styles.tdbarFill} style={{ width: `${pct}%` }} />
        </span>
        <span className={`${styles.value} ${styles.pink}`}>
          {done}/{total}
        </span>
      </div>,
    );
  }

  if (cells.length === 0) return null;

  return (
    <div
      className={dimmed ? `${styles.strip} ${styles.dimmed}` : styles.strip}
      data-testid="session-hud"
      data-dimmed={dimmed ? "true" : "false"}
    >
      {cells}
    </div>
  );
}
