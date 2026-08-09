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
  activeOrchestrations,
  activeSubagents,
  formatDuration,
  isSubagentTool,
  orchestrationCounts,
  orchestrationPhaseTree,
  type ConversationState,
  type ConvToolBlock,
  type OrchestrationAgent,
  type OrchestrationRun,
  type OrchestrationStatus,
  type SubagentCall,
} from "../../lib/agent-conversation";
import { agentStopTask } from "../../lib/ipc";
import { agentStatusClass } from "../command-center/status-utils";
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
  /** The pane whose stdin a Stop click must reach — the only prop this strip
   *  uses for a *write*, and the reason it is required rather than optional
   *  (D13): the strip's one production mount always has this in scope, and a
   *  Stop-less panel would be a silent capability regression if a future
   *  second mount forgot it. */
  paneId: string;
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

/** `${primaryRun.name ?? "orchestration"}` for one run, `"N orchestrations"`
 *  for several — the same single-vs-many idiom as `subagentLabel`. */
function orchestrationLabel(runs: readonly OrchestrationRun[]): string {
  const primary = runs[0];
  if (runs.length === 1 && primary) return primary.name ?? "orchestration";
  return `${runs.length} orchestrations`;
}

/** `"N phases · M/K agents"`, honestly degraded (D6/edge cases): the phase
 *  clause is omitted for a phase-less run, never printed as `0 phases`, and
 *  the agents clause is omitted while a run has launched no agent yet, never
 *  printed as `0/0 agents`. Never a percentage — `K` moves as later phases
 *  start, so a bar or a percent would imply a total the wire has not stated. */
function orchestrationCountsLabel(counts: {
  phases: number;
  agentsDone: number;
  agentsTotal: number;
}): string {
  const parts: string[] = [];
  if (counts.phases > 0) {
    parts.push(`${counts.phases} phase${counts.phases === 1 ? "" : "s"}`);
  }
  if (counts.agentsTotal > 0) {
    parts.push(`${counts.agentsDone}/${counts.agentsTotal} agents`);
  }
  return parts.join(" · ");
}

/** Sums each active run's own counts — the multi-run cell's number, mirroring
 *  `subagentLabel`'s "N sub-agents" collapse for several concurrent calls. */
function combinedOrchestrationCounts(
  runs: readonly OrchestrationRun[],
): { phases: number; agentsDone: number; agentsTotal: number } {
  return runs.reduce(
    (acc, run) => {
      const c = orchestrationCounts(run);
      return {
        phases: acc.phases + c.phases,
        agentsDone: acc.agentsDone + c.agentsDone,
        agentsTotal: acc.agentsTotal + c.agentsTotal,
      };
    },
    { phases: 0, agentsDone: 0, agentsTotal: 0 },
  );
}

/** D8's status-pill mapping for the run's own state. `running` pulses;
 *  nothing else does. */
function orchestrationRunPill(status: OrchestrationStatus): {
  className: string;
  pulse: boolean;
  label: string;
} {
  if (status === "running") return { className: agentStatusClass("active"), pulse: true, label: "running" };
  if (status === "completed") return { className: agentStatusClass("active"), pulse: false, label: "completed" };
  if (status === "failed") return { className: agentStatusClass("idle"), pulse: false, label: "failed" };
  return { className: agentStatusClass("ended"), pulse: false, label: "stopped" };
}

/**
 * D8's status-pill mapping for one `workflow_agent` row. Amber for `error` is
 * not a fudge: `parallel()`/`pipeline()` resolve a thrown agent to `null` and
 * the orchestration continues, so an agent error is a warning about one
 * branch, not a failure of the run — hence `idle` (amber), not a fourth,
 * red `d3-status` modifier this ticket does not add (D8).
 */
function orchestrationAgentPill(agent: OrchestrationAgent): {
  className: string;
  pulse: boolean;
  label: string;
} {
  if (agent.state === "error") return { className: agentStatusClass("idle"), pulse: false, label: "error" };
  if (agent.state === "done") {
    if (agent.cached) return { className: agentStatusClass("ended"), pulse: false, label: "cached" };
    return { className: agentStatusClass("active"), pulse: false, label: "done" };
  }
  // "start" or "progress" both read as "running" (OrchestrationAgentState's
  // own doc comment).
  return { className: agentStatusClass("active"), pulse: true, label: "running" };
}

export function AgentSessionHud({
  state,
  cwd,
  paneId,
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

  // Same derived-closed idiom, keyed by `task_id`: a run that leaves
  // `activeRuns` (finishes, fails, is stopped) collapses its own panel with
  // no reset effect required.
  const [expandedOrchestrationId, setExpandedOrchestrationId] = useState<string | null>(null);
  // Task ids with a Stop request in flight — disables the button and blocks a
  // double-send without an optimistic status change (D9): the wire, not this
  // set, decides when the run actually stops.
  const [stoppingTaskIds, setStoppingTaskIds] = useState<readonly string[]>([]);

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

  // Every `Workflow`-tool run this pane's session has launched and not yet
  // heard the end of, oldest first. Deliberately not gated on
  // `state.status === "running"` (D3): an orchestration outlives its turn,
  // so the pane sits `idle` for most of a run.
  const activeRuns = exited ? [] : activeOrchestrations(state);
  const primaryRun = activeRuns[0] ?? null;
  const orchestrationExpanded =
    expandedOrchestrationId !== null &&
    activeRuns.some((r) => r.taskId === expandedOrchestrationId);
  if (primaryRun !== null) {
    const runSeconds = elapsedSecondsSinceMs(primaryRun.startedAt);
    const countsLabel = orchestrationCountsLabel(combinedOrchestrationCounts(activeRuns));
    cells.push(
      <div key="orchestration" className={styles.cell} data-cell="orchestration">
        <button
          type="button"
          className={styles.cellBtn}
          aria-expanded={orchestrationExpanded}
          onClick={() =>
            setExpandedOrchestrationId(orchestrationExpanded ? null : primaryRun.taskId)
          }
        >
          <span className={`${styles.pulse} ${styles.acc}`}>◇</span>
          <span className={`${styles.value} ${styles.acc} ${styles.cellLabel}`}>
            {orchestrationLabel(activeRuns)}
          </span>
          {countsLabel !== "" ? (
            <span className={`${styles.value} ${styles.muted}`}>{countsLabel}</span>
          ) : null}
          <span className={`${styles.value} ${styles.muted}`}>
            {formatElapsed(runSeconds)}
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
      {orchestrationExpanded && primaryRun !== null
        ? (() => {
            const run = primaryRun;
            const runPill = orchestrationRunPill(run.status);
            const runCounts = orchestrationCountsLabel(orchestrationCounts(run));
            const stopping = stoppingTaskIds.includes(run.taskId);
            return (
              <div className={styles.detail} data-testid="agent-orchestration-detail">
                <div className={styles.detailHead}>
                  <span className={styles.detailName}>{run.name ?? "orchestration"}</span>
                  {runCounts !== "" ? (
                    <span className={`${styles.value} ${styles.muted}`}>{runCounts}</span>
                  ) : null}
                  {run.totalTokens !== null ? (
                    <span className={`${styles.value} ${styles.pink}`}>
                      {formatTokens(run.totalTokens)}
                    </span>
                  ) : null}
                  <span className={runPill.className}>
                    {runPill.pulse ? <span className="d3-status__pulse" /> : null}
                    {runPill.label}
                  </span>
                  <button
                    type="button"
                    className={`d3-btn d3-btn--sm ${styles.detailStop}`}
                    style={{ borderColor: "rgba(239,68,68,0.30)", color: "var(--err)" }}
                    disabled={stopping}
                    onClick={() => {
                      setStoppingTaskIds((ids) =>
                        ids.includes(run.taskId) ? ids : [...ids, run.taskId],
                      );
                      // Not optimistic (D9): the wire's own task_updated /
                      // task_notification decides when the run's status
                      // actually flips to "stopped".
                      void agentStopTask(paneId, run.taskId).catch((err: unknown) => {
                        console.error("agentStopTask failed", err);
                      });
                    }}
                  >
                    Stop
                  </button>
                </div>
                {run.activity !== null ? (
                  <div className={styles.detailRow}>
                    <span className={styles.detailText}>{run.activity}</span>
                  </div>
                ) : null}
                {orchestrationPhaseTree(run).map((group) => (
                  <div
                    key={group.phaseIndex ?? "unphased"}
                    className={styles.detailPhase}
                  >
                    <span className={styles.detailPhaseTitle}>{group.title}</span>
                    {group.agents.map((agent) => {
                      const pill = orchestrationAgentPill(agent);
                      return (
                        <div key={agent.index} className={styles.detailAgent}>
                          <span className={pill.className}>
                            {pill.pulse ? <span className="d3-status__pulse" /> : null}
                            {pill.label}
                          </span>
                          <span
                            className={`${styles.value} ${styles.detailAgentLabel}`}
                            title={agent.label}
                          >
                            {agent.label}
                          </span>
                          {agent.agentType !== null ? (
                            <span className={`${styles.value} ${styles.muted}`}>
                              {agent.agentType}
                            </span>
                          ) : null}
                          {agent.model !== null ? (
                            <span className={`${styles.value} ${styles.muted}`}>
                              {agent.model}
                            </span>
                          ) : null}
                          {agent.tokens !== null ? (
                            <span className={`${styles.value} ${styles.pink}`}>
                              {formatTokens(agent.tokens)}
                            </span>
                          ) : null}
                          {agent.toolCalls !== null ? (
                            <span className={`${styles.value} ${styles.muted}`}>
                              {agent.toolCalls} calls
                            </span>
                          ) : null}
                          {agent.durationMs !== null ? (
                            <span className={`${styles.value} ${styles.muted}`}>
                              {formatDuration(agent.durationMs)}
                            </span>
                          ) : null}
                          {agent.error !== null ? (
                            <span className={styles.detailText}>{agent.error}</span>
                          ) : agent.resultPreview !== null ? (
                            <span className={styles.detailText}>{agent.resultPreview}</span>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            );
          })()
        : null}
    </>
  );
}
