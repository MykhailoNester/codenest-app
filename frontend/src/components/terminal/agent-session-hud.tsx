/**
 * Per-pane status strip for the *native agent* pane — the prototype's `.hud`
 * row (CSS ~197-224, markup ~621-636), sitting between the pane header and the
 * conversation.
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
 * - elapsed counts from the `init` frame and freezes when the session exits.
 * - the live-tool and thinking cells never render on a dead session; claiming a
 *   tool is running inside an exited process would be a lie (D11 in the
 *   session-state-hud plan, applied to this surface too).
 */

import { useEffect, useState, type ReactElement } from "react";
import { formatUSD } from "../../lib/format-helpers";
import { useGitPaneStatus } from "../../stores/session-hud-store";
import {
  activeSubagents,
  isSubagentTool,
  type ConversationState,
  type ConvToolBlock,
  type SubagentCall,
} from "../../lib/agent-conversation";
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

/** The newest tool call still in flight, or `null` when nothing is running.
 *  A `Task`/`Agent` delegation is excluded — it owns the sub-agent cell
 *  below instead, never this one. */
function runningTool(state: ConversationState): ConvToolBlock | null {
  for (let i = state.turns.length - 1; i >= 0; i -= 1) {
    const turn = state.turns[i];
    if (!turn) continue;
    for (let j = turn.blocks.length - 1; j >= 0; j -= 1) {
      const block = turn.blocks[j];
      if (block?.type === "tool" && block.endedAt === null && !isSubagentTool(block.name)) {
        return block;
      }
    }
  }
  return null;
}

/** `"planner-agent"` for a single delegation, `"3 sub-agents"` for several.
 *  Either way the cell's elapsed time is measured from `calls[0]` — the
 *  oldest, per `activeSubagents`'s own ordering guarantee. */
function subagentLabel(calls: readonly SubagentCall[]): string {
  const primary = calls[0];
  if (calls.length === 1 && primary) return primary.subagentType ?? "sub-agent";
  return `${calls.length} sub-agents`;
}

export function AgentSessionHud({
  state,
  cwd,
}: AgentSessionHudProps): ReactElement | null {
  const git = useGitPaneStatus(cwd);
  const exited = state.status === "exited";
  const dimmed = exited || state.status === "starting";

  // One interval for the elapsed cell, and only while the session is live —
  // nothing ticks on a dead pane. The sub-agent cell's own elapsed time rides
  // this same tick rather than a second interval, since it can only ever be
  // live while the session is too.
  const ticking = state.startedAt !== null && !exited;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [ticking]);

  // Which in-flight delegation's detail panel is open, keyed by tool_use id
  // rather than a bare boolean so a second Task starting doesn't inherit the
  // first one's expanded state. Derived-closed (below) rather than cleared
  // here: once `expandedSubagentId` no longer names a call in `activeCalls`,
  // `subagentExpanded` goes false on its own.
  const [expandedSubagentId, setExpandedSubagentId] = useState<string | null>(null);

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
    const { contextTokens, contextWindow } = state.usage;
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

  if (state.startedAt !== null) {
    const seconds = elapsedSecondsSinceMs(state.startedAt);
    cells.push(
      <div key="elapsed" className={styles.cell} data-cell="elapsed">
        <span className={styles.value}>{formatElapsed(seconds)}</span>
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

  const tool = exited ? null : runningTool(state);
  if (tool !== null) {
    const toolSeconds = elapsedSecondsSinceMs(tool.startedAt);
    cells.push(
      <div key="tool" className={styles.cell} data-cell="tool">
        <span className={styles.spin}>⚙</span>
        <span className={`${styles.value} ${styles.info}`}>{tool.name}</span>
        <span className={`${styles.value} ${styles.muted}`}>
          {formatElapsed(toolSeconds)}
        </span>
      </div>,
    );
  }

  // Every Task/Agent call still in flight, oldest first. `[]` on an exited
  // session already (activeSubagents' own contract), but `exited` is checked
  // again here anyway, matching every other live-only cell on this strip.
  const activeCalls = exited ? [] : activeSubagents(state);
  const primarySubagent = activeCalls[0] ?? null;
  const subagentExpanded =
    expandedSubagentId !== null && activeCalls.some((c) => c.id === expandedSubagentId);
  if (primarySubagent !== null) {
    const subagentSeconds = elapsedSecondsSinceMs(primarySubagent.startedAt);
    cells.push(
      <div key="subagent" className={styles.cell} data-cell="subagent">
        <button
          type="button"
          className={styles.cellBtn}
          aria-expanded={subagentExpanded}
          onClick={() =>
            setExpandedSubagentId(subagentExpanded ? null : primarySubagent.id)
          }
        >
          <span className={`${styles.pulse} ${styles.violet}`}>◈</span>
          <span className={`${styles.value} ${styles.violet} ${styles.cellLabel}`}>
            {subagentLabel(activeCalls)}
          </span>
          <span className={`${styles.value} ${styles.muted}`}>
            {formatElapsed(subagentSeconds)}
          </span>
        </button>
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

  if (cells.length === 0) return null;

  return (
    <>
      <div
        className={dimmed ? `${styles.strip} ${styles.dimmed}` : styles.strip}
        data-testid="agent-session-hud"
        data-dimmed={dimmed ? "true" : "false"}
      >
        {cells}
      </div>
      {subagentExpanded && primarySubagent !== null ? (
        <div className={styles.detail} data-testid="agent-subagent-detail">
          <div className={styles.detailRow}>
            <span className={styles.detailName}>
              {primarySubagent.subagentType ?? "sub-agent"}
            </span>
            <span className={`${styles.value} ${styles.violet}`}>running</span>
          </div>
          {primarySubagent.description !== null ? (
            <div className={styles.detailRow}>
              <span className={styles.detailText}>{primarySubagent.description}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
