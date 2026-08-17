/**
 * The metrics line of the *native agent* pane's activity dock
 * (`agent-activity-dock.tsx`) — the prototype's `.hud` row (CSS ~197-224,
 * markup ~621-636), rendered as the dock's own *last* child rather than
 * standing on its own between the pane header and the conversation. Last, so
 * that this strip — always present, fixed height — is the thing pinned a fixed
 * distance above the composer, and the dock's transient groups grow upward
 * instead of shoving it around (#38; the dock's module doc has the full why).
 *
 * Deliberately a sibling of `<SessionHud/>` rather than a reuse of it, sharing
 * only `session-hud.module.css` so the two strips are visually identical. They
 * read different sources, and that is the whole point:
 *
 * * `<SessionHud/>` (shell panes) reports what the *sidecar* knows, assembled
 *   from Claude Code's hooks and keyed by `pane_id` through `agent_sessions` /
 *   `agent_runs`. An agent pane has no row in either table — `agent/mod.rs`
 *   never talks to the sidecar — so that strip would render empty here.
 * * This strip reports what the *wire* said: the same stream-json frames that
 *   drive the conversation, already reduced in `agent-session-store`. First
 *   party, in-process, and available from the session's first frame.
 *
 * The honesty contract is the same one `session-hud.tsx` documents and is
 * binding on every cell below: a cell renders a real value or it does not
 * render at all. No placeholder, no em dash, no zero standing in for unknown.
 * Concretely:
 *
 * - `ctx`/tokens appear only after a `result` frame has reported usage, and the
 *   percentage only when that frame also named a context window.
 * - `cost` is the CLI's own `total_cost_usd`. On a subscription that is notional
 *   pricing, not billing — the cell's `title` says so.
 * - elapsed times the *turn*: it counts while the pane is `running` and holds
 *   on the finished turn's own duration otherwise. A pane that has run nothing
 *   yet shows no elapsed cell (#40 — it used to count the session's age, so an
 *   `idle` pane read `10m 14s` and climbing).
 * - the thinking cell never renders on a dead session; claiming the model is
 *   mid-thought inside an exited process would be a lie (D11 in the
 *   session-state-hud plan, applied to this surface too).
 *
 * The live-tool, sub-agent and orchestration cells this file used to render
 * are now the dock's own Tools/Agents/Workflows groups — grouped, collapsible,
 * and (for Tools) reporting the whole run rather than one call. See
 * `agent-activity-dock.tsx` for that half; this file keeps only the always-on
 * metrics line.
 */

import { useEffect, useState, type ReactElement } from "react";
import { formatUSD } from "../../lib/format-helpers";
import { useGitPaneStatus } from "../../stores/session-hud-store";
import type { ConversationState } from "../../lib/agent-conversation";
import {
  elapsedSecondsSinceMs,
  formatContextPercent,
  formatElapsed,
  formatTokens,
} from "./session-hud-format";
import styles from "./session-hud.module.css";

interface AgentSessionHudProps {
  state: ConversationState;
  cwd: string | undefined;
}

export function AgentSessionHud({ state, cwd }: AgentSessionHudProps): ReactElement {
  const git = useGitPaneStatus(cwd);
  const exited = state.status === "exited";
  const dimmed = exited || state.status === "starting";

  // One interval for the elapsed cell, and only while a turn is actually in
  // flight — an idle pane's cell is a frozen duration, so re-rendering it every
  // second would only redraw the same string (#40).
  const ticking = state.status === "running" && state.turnStartedAt !== null;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [ticking]);

  const cells: ReactElement[] = [];

  // Status. The one cell that always renders once a session exists at all: it
  // is what the strip is *for*, and every value it can take is a fact the
  // reducer took off the wire.
  const statusLabel =
    state.status === "running"
      ? state.streaming
        ? "streaming"
        : "running"
      : state.status;
  cells.push(
    <div key="status" className={styles.cell} data-cell="status">
      <span
        className={`${styles.value} ${
          state.status === "running"
            ? styles.acc
            : state.status === "exited"
              ? styles.warn
              : styles.ok
        }`}
      >
        {statusLabel}
      </span>
    </div>,
  );

  if (state.usage !== null) {
    const { contextTokens } = state.usage;
    const { contextWindow } = state;
    if (contextWindow !== null) {
      const pct = Math.min(100, Math.round((contextTokens / contextWindow) * 100));
      cells.push(
        <div key="ctx" className={styles.cell} data-cell="ctx">
          <span className={styles.key}>ctx</span>
          <span className={styles.cbar}>
            <span className={styles.cbarFill} style={{ width: `${pct}%` }} />
          </span>
          <span className={`${styles.value} ${styles.ok}`}>
            {formatContextPercent(contextTokens, contextWindow)}
          </span>
        </div>,
      );
      cells.push(
        <div key="tokens" className={styles.cell} data-cell="tokens">
          <span className={`${styles.value} ${styles.pink}`}>
            {formatTokens(contextTokens)}/{formatTokens(contextWindow)}
          </span>
        </div>,
      );
    } else {
      // Usage without a window: tokens are still a fact, the percentage is not.
      cells.push(
        <div key="tokens" className={styles.cell} data-cell="tokens">
          <span className={styles.key}>ctx</span>
          <span className={`${styles.value} ${styles.pink}`}>
            {formatTokens(contextTokens)}
          </span>
        </div>,
      );
    }
  }

  if (state.lastResult?.costUsd != null) {
    cells.push(
      <div key="cost" className={styles.cell} data-cell="cost">
        <span
          className={`${styles.value} ${styles.warn}`}
          title="The CLI's own total_cost_usd for this session. On a subscription this is notional pricing, not billing."
        >
          {formatUSD(state.lastResult.costUsd)}
        </span>
      </div>,
    );
  }

  // Running: count from the turn's start. Otherwise: the last completed turn's
  // duration, frozen — and nothing at all before the first turn finishes, since
  // a `0s` beside `idle` would be a value the wire never reported.
  const turnSeconds =
    ticking && state.turnStartedAt !== null
      ? elapsedSecondsSinceMs(state.turnStartedAt)
      : state.lastTurnDurationMs !== null
        ? Math.floor(state.lastTurnDurationMs / 1000)
        : null;
  if (turnSeconds !== null) {
    cells.push(
      <div key="elapsed" className={styles.cell} data-cell="elapsed">
        <span className={styles.value}>{formatElapsed(turnSeconds)}</span>
      </div>,
    );
  }

  if (git !== null) {
    cells.push(
      <div key="git" className={styles.cell} data-cell="git">
        <span className={`${styles.value} ${styles.ok}`}>{git.branch}</span>
        {git.dirty ? (
          <span className={`${styles.value} ${styles.warn}`}>*</span>
        ) : null}
        {git.ahead != null && git.ahead > 0 ? (
          <span className={`${styles.value} ${styles.info}`}>+{git.ahead}</span>
        ) : null}
      </div>,
    );
  }

  if (state.thinking && !exited) {
    cells.push(
      <div key="thinking" className={styles.cell} data-cell="thinking">
        <span className={styles.think}>
          <span className={styles.thinkDot} />
          Thinking
          {state.thinkingTokens > 0 ? ` ${formatTokens(state.thinkingTokens)}` : ""}
        </span>
      </div>,
    );
  }

  if (state.permissions.length > 0) {
    cells.push(
      <div key="perm" className={styles.cell} data-cell="perm">
        <span className={`${styles.value} ${styles.warn}`}>
          {state.permissions.length} awaiting approval
        </span>
      </div>,
    );
  }

  return (
    <div
      className={
        dimmed
          ? `${styles.strip} ${styles.stripDocked} ${styles.dimmed}`
          : `${styles.strip} ${styles.stripDocked}`
      }
      data-testid="agent-session-hud"
      data-dimmed={dimmed ? "true" : "false"}
    >
      {cells}
    </div>
  );
}
