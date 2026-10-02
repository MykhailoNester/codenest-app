/**
 * One agent run, as a Deck line (#269).
 *
 * Replaces `components/command-center/agent-run-row.tsx`, which drew a card.
 * Everything that card carried is still here — provider, project, model,
 * scheduled marker, observe-only marker, prompt, current tool, call count,
 * elapsed, cost, Focus and Stop — laid out as columns instead of a box.
 *
 * `handleStop` is unchanged: a run row does not record *which kind* of pane it
 * came from, and the two kinds are killed by different commands, so it issues
 * both and branches on `target` for the popout window.
 */

import { memo, type ReactElement } from "react";
import type { AgentRun } from "../../lib/api";
import {
  agentStop,
  closeTerminal,
  emitStopAgentPaneToTerminals,
} from "../../lib/ipc";
import { useTerminalStore } from "../../stores/terminal-store";
import { formatElapsed } from "../../lib/format-helpers";
import { DeckLine, type DeckState } from "../deck/deck-grid";

interface RunLineProps {
  run: AgentRun;
  selected?: boolean;
  /** Called when Focus is clicked — passes the full run so the handler can
   *  branch on `run.target` (embedded vs. popout). */
  onFocus: (run: AgentRun) => void;
  /** Called when the row is opened — shows the per-session detail. */
  onDrillIn?: (sessionId: string) => void;
}

function providerNameShort(run: AgentRun): string {
  return run.provider_display_name ?? run.provider_name ?? "unknown";
}

function runStatusLabel(run: AgentRun): string {
  if (run.status === "ended") return "ended";
  if (run.session_status === "active") return "running";
  if (run.session_status === "idle") return "idle";
  return "running";
}

function runState(run: AgentRun): DeckState {
  const s = runStatusLabel(run);
  if (s === "ended") return "done";
  if (s === "idle") return "idle";
  return "run";
}

function promptText(run: AgentRun): string {
  return run.session_initial_prompt ?? run.prompt_preview ?? "";
}

function RunLineInner({
  run,
  selected,
  onFocus,
  onDrillIn,
}: RunLineProps): ReactElement {
  const provName = providerNameShort(run);
  const elapsed = formatElapsed(run.started_at, run.ended_at);
  const prompt = promptText(run);
  const statusStr = runStatusLabel(run);
  const state = runState(run);
  const isEnded = run.status === "ended";
  const hasPane = run.pane_id != null && run.pane_id !== "";
  // Observe-only: row_kind='observe' means this session came from hooks only
  // (Claude Code ran outside the dashboard) — no owned pane, no Focus/Stop.
  const isObserveOnly = run.row_kind === "observe";
  const isDrillable = Boolean(run.session_id) && Boolean(onDrillIn);

  function handleStop(e: React.MouseEvent): void {
    e.stopPropagation();
    if (!run.pane_id) return;
    const paneId = run.pane_id;

    // Step 1: Kill the child. A run row does not record *which kind* of pane it
    // came from, and the two kinds are killed by different commands: a provider
    // pane is a PTY (`close_terminal`), an agent pane is a duplex `claude`
    // child with no PTY at all (`agent_stop`). Both are idempotent for an id
    // they do not know — `PtyManager::close_terminal` (`pty/mod.rs:305-316`)
    // and `AgentManager::stop` both return Ok — and the two id namespaces never
    // overlap, so issuing both is what makes one Stop button correct for both
    // kinds without a schema column to branch on.
    //
    // Each command's own exit path reports the run as ended: `pty-exited` for
    // the PTY (the listener in `terminal-store.ts`), the session's `exit` frame
    // for the agent pane (`agent-pane.tsx`). Neither needs prompting here.
    void closeTerminal(paneId).catch(() => undefined);
    void agentStop(paneId).catch(() => undefined);

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

  const tags: ReactElement[] = [];
  if (run.schedule_id != null) {
    tags.push(
      <span
        key="sched"
        className="dk-tag"
        data-s="wait"
        title={
          run.schedule_name ? `Scheduled: ${run.schedule_name}` : "Scheduled run"
        }
      >
        ⏱ {run.schedule_name ?? "scheduled"}
      </span>,
    );
  }
  if (isObserveOnly) {
    tags.push(
      <span key="ext" className="dk-tag" title="Ran outside the dashboard">
        external
      </span>,
    );
  }

  const doing = run.session_current_tool ? (
    <>
      <span className="dk-tag" data-s={state}>
        {statusStr}
      </span>{" "}
      {run.session_current_tool}
    </>
  ) : (
    <>
      <span className="dk-tag" data-s={state}>
        {statusStr}
      </span>
      {run.session_total_tool_calls != null &&
      run.session_total_tool_calls > 0 ? (
        <span className="dim"> · {run.session_total_tool_calls} calls</span>
      ) : isObserveOnly ? (
        <span className="dim"> · no hooks</span>
      ) : null}
    </>
  );

  return (
    <DeckLine
      state={state}
      selected={selected}
      done={isEnded}
      onOpen={
        isDrillable && run.session_id
          ? () => onDrillIn?.(run.session_id as string)
          : undefined
      }
      cells={[
        {
          v: (
            <>
              {prompt || <span className="dim">no prompt recorded</span>}
              {tags.length > 0 && " "}
              {tags}
            </>
          ),
          cls: "sub",
          title: prompt || undefined,
        },
        { v: run.project_name ?? "unknown" },
        {
          v: `${provName}${run.model ? ` · ${run.model.split("-").slice(0, 3).join("-")}` : ""}`,
        },
        { v: doing },
        { v: elapsed || "—", cls: "r" },
        {
          v:
            run.session_cost_usd != null && run.session_cost_usd > 0
              ? `$${run.session_cost_usd.toFixed(3)}`
              : "—",
          cls: "r",
        },
        {
          v: (
            <span className="acts" onClick={(e) => e.stopPropagation()}>
              {!isObserveOnly && !isEnded && hasPane && (
                <>
                  <button
                    type="button"
                    className="dk-btn bare"
                    onClick={(e) => {
                      e.stopPropagation();
                      onFocus(run);
                    }}
                  >
                    focus
                  </button>
                  <button
                    type="button"
                    className="dk-btn bare danger"
                    onClick={handleStop}
                  >
                    stop
                  </button>
                </>
              )}
            </span>
          ),
          cls: "r",
        },
      ]}
    />
  );
}

function runEqual(prev: RunLineProps, next: RunLineProps): boolean {
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
    prev.selected === next.selected &&
    prev.onFocus === next.onFocus &&
    prev.onDrillIn === next.onDrillIn
  );
}

export const RunLine = memo(RunLineInner, runEqual);
