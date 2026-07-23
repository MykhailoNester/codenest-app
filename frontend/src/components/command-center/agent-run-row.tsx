/**
 * AgentRunRow — single row in the unified AGENTS panel.
 *
 * Renders an ``agent_runs`` row merged with optional ``agent_sessions``
 * enrichment.  Each row shows:
 *   - Provider color dot + badge
 *   - Project name
 *   - Status pill (running/ended + session status when enriched)
 *   - Model
 *   - Prompt preview
 *   - [Focus] (navigate to the pane/tab) + [Stop] (close_terminal) for owned
 *     panes; nothing interactive for ended or observe-only rows
 *     (hook-driven, row_kind='observe').
 *
 * Clicking anywhere on the row (outside action buttons) fires ``onDrillIn``
 * with the session_id so the parent can open the Replay panel.
 */

import { memo, type ReactElement } from "react";
import type { AgentRun } from "../../lib/api";
import { closeTerminal, emitStopAgentPaneToTerminals } from "../../lib/ipc";
import { useTerminalStore } from "../../stores/terminal-store";
import { formatElapsed } from "../../lib/format-helpers";
import { agentStatusClass } from "./status-utils";

interface AgentRunRowProps {
  run: AgentRun;
  /** Called when Focus is clicked — passes the full run so the handler can
   *  branch on `run.target` (embedded vs. popout). */
  onFocus: (run: AgentRun) => void;
  /** Called when the row body is clicked — opens the per-agent drill-in panel. */
  onDrillIn?: (sessionId: string) => void;
}

const fmtElapsed = formatElapsed;

function providerNameShort(run: AgentRun): string {
  return run.provider_display_name ?? run.provider_name ?? "unknown";
}

function statusLabel(run: AgentRun): string {
  if (run.status === "ended") {
    return "ended";
  }
  // Enrich with Claude session status when available
  if (run.session_status === "active") return "running";
  if (run.session_status === "idle") return "idle";
  return "running";
}

function statusCls(run: AgentRun): string {
  // Map "running" → "active" so agentStatusClass sees the canonical CSS key.
  const s = statusLabel(run);
  return agentStatusClass(s === "running" ? "active" : s);
}

function promptText(run: AgentRun): string {
  // Prefer the enriched session initial_prompt when available
  return run.session_initial_prompt ?? run.prompt_preview ?? "";
}

function AgentRunRowInner({
  run,
  onFocus,
  onDrillIn,
}: AgentRunRowProps): ReactElement {
  const color = run.provider_color ?? "#7a8290";
  const provName = providerNameShort(run);
  const project = run.project_name ?? "unknown";
  const elapsed = fmtElapsed(run.started_at, run.ended_at);
  const prompt = promptText(run);
  const statusStr = statusLabel(run);
  const isEnded = run.status === "ended";
  const hasPane = run.pane_id != null && run.pane_id !== "";
  // Observe-only: row_kind='observe' means this session came from hooks only
  // (Claude Code ran outside the dashboard) — no owned pane, no Focus/Stop.
  const isObserveOnly = run.row_kind === "observe";
  // A row is drillable when it has a linked session_id (replay available).
  const isDrillable = Boolean(run.session_id) && Boolean(onDrillIn);

  const dimmed = isEnded ? { opacity: 0.55 } : undefined;

  function handleStop(e: React.MouseEvent): void {
    e.stopPropagation();
    if (!run.pane_id) return;
    const paneId = run.pane_id;

    // Step 1: Kill the PTY.
    // The global pty-exited listener in terminal-store.ts picks this up and:
    //   (a) calls markLeafExited in whichever store owns the pane
    //   (b) posts /api/v1/agents/runs/exited so the DB row transitions to ended
    void closeTerminal(paneId).catch(() => undefined);

    if (run.target === "popout") {
      // Step 2a (popout): emit stop-agent-pane to the terminals window.
      // TerminalWindowRoot handles this by calling closePane(paneId) in its
      // own store, then closing the window if no panes remain.
      // This does NOT touch the main-window store — correct, because popout
      // panes live only in the terminals window's store.
      void emitStopAgentPaneToTerminals(paneId).catch(() => undefined);
    } else {
      // Step 2b (embedded): remove the pane from the main-window store.
      // closePane handles the last-leaf → close-tab cascade automatically.
      const store = useTerminalStore.getState();
      void store.closePane(paneId).catch(() => undefined);
    }
  }

  function handleFocus(e: React.MouseEvent): void {
    e.stopPropagation();
    onFocus(run);
  }

  function handleRowClick(): void {
    if (run.session_id && onDrillIn) {
      onDrillIn(run.session_id);
    }
  }

  return (
    <div
      role={isDrillable ? "button" : undefined}
      tabIndex={isDrillable ? 0 : undefined}
      onClick={isDrillable ? handleRowClick : undefined}
      onKeyDown={
        isDrillable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleRowClick();
              }
            }
          : undefined
      }
      className={`d3-agent-row${isEnded ? " d3-agent-row--ended" : ""}${isDrillable ? " d3-agent-row--drillable" : ""}`}
      style={
        {
          "--agent-color": color,
          cursor: isDrillable ? "pointer" : undefined,
        } as React.CSSProperties
      }
      title={isDrillable ? "Click to open session replay" : undefined}
    >
      <div className="d3-agent-row__head">
        <div className="d3-agent-row__meta">
          {/* Provider dot */}
          <span
            className="d3-agent-row__dot"
            style={{ background: color, ...dimmed }}
            aria-hidden="true"
          />
          {/* Provider badge */}
          <span
            className="d3-agent-row__badge"
            style={{
              background: `${color}22`,
              border: `1px solid ${color}44`,
              color,
              ...dimmed,
            }}
          >
            {provName}
          </span>
          {/* Project */}
          <span className="d3-agent-row__project" style={dimmed}>
            {project}
          </span>
          {/* Model */}
          {run.model && (
            <span className="d3-agent-row__model" style={dimmed}>
              {run.model.split("-").slice(0, 3).join("-")}
            </span>
          )}
          {/* Scheduled-run marker (correlated via session_id) */}
          {run.schedule_id != null && (
            <span
              className="d3-tag mono"
              style={{
                fontSize: "9.5px",
                color: "var(--accent)",
                border: "1px solid var(--accent-line)",
              }}
              title={
                run.schedule_name
                  ? `Scheduled: ${run.schedule_name}`
                  : "Scheduled run"
              }
            >
              ⏱ {run.schedule_name ?? "scheduled"}
            </span>
          )}
          {/* Observe-only marker */}
          {isObserveOnly && (
            <span
              className="d3-tag mono"
              style={{ fontSize: "9.5px", color: "var(--fg-4)" }}
            >
              external
            </span>
          )}
        </div>
        {/* Status pill */}
        <span className={statusCls(run)}>
          {(statusStr === "running" || statusStr === "idle") && (
            <span className="d3-status__pulse" />
          )}
          {statusStr}
        </span>
      </div>

      {/* Prompt preview */}
      {prompt && (
        <div className="d3-agent-row__prompt">&ldquo;{prompt}&rdquo;</div>
      )}

      {/* Footer: tags + actions */}
      <div className="d3-agent-row__foot">
        <div className="d3-agent-row__tags">
          {run.session_current_tool && (
            <span
              className="d3-tag mono"
              style={{ fontSize: "10.5px", color: "var(--warn)" }}
            >
              {run.session_current_tool}
            </span>
          )}
          {run.session_total_tool_calls != null &&
            run.session_total_tool_calls > 0 && (
              <span className="d3-tag mono" style={{ fontSize: "10.5px" }}>
                {run.session_total_tool_calls} calls
              </span>
            )}
          {elapsed && (
            <span
              className="d3-tag mono"
              style={{ fontSize: "10.5px", color: "var(--fg-3)" }}
            >
              {elapsed}
            </span>
          )}
          {run.session_cost_usd != null && run.session_cost_usd > 0 && (
            <span className="d3-tag mono" style={{ fontSize: "10.5px" }}>
              ${run.session_cost_usd.toFixed(3)}
            </span>
          )}
          {isObserveOnly && !run.session_current_tool && (
            <span
              className="d3-tag mono"
              style={{ fontSize: "10.5px", color: "var(--fg-4)" }}
            >
              process alive · no hooks
            </span>
          )}
        </div>

        {/* Actions */}
        {!isObserveOnly && (
          <div className="d3-agent-row__actions">
            {!isEnded && hasPane && (
              <button
                type="button"
                className="d3-btn d3-btn--sm"
                onClick={handleFocus}
              >
                Focus
              </button>
            )}
            {!isEnded && hasPane ? (
              <button
                type="button"
                className="d3-btn d3-btn--sm"
                style={{
                  borderColor: "rgba(239,68,68,0.30)",
                  color: "var(--err)",
                }}
                onClick={handleStop}
              >
                Stop
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function agentRunEqual(
  prev: AgentRunRowProps,
  next: AgentRunRowProps,
): boolean {
  const a = prev.run;
  const b = next.run;
  return (
    a.id === b.id &&
    a.row_kind === b.row_kind &&
    a.session_id === b.session_id &&
    a.status === b.status &&
    a.session_status === b.session_status &&
    a.session_current_tool === b.session_current_tool &&
    a.session_cost_usd === b.session_cost_usd &&
    a.session_total_tool_calls === b.session_total_tool_calls &&
    a.schedule_id === b.schedule_id &&
    prev.onFocus === next.onFocus &&
    prev.onDrillIn === next.onDrillIn
  );
}

export const AgentRunRow = memo(AgentRunRowInner, agentRunEqual);
