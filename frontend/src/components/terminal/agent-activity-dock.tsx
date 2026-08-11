/**
 * Zone B of the native agent pane: the **activity dock**, pinned between
 * Zone A (`.viewport` — the transcript or a drilled-in sub-agent/workflow
 * view, `agent-pane.tsx`) and Zone C (`<AgentComposer/>`). B and C never move
 * when the user switches which agent Zone A shows; only A's own contents
 * change.
 *
 * Rendered as a **sibling of `.viewport` inside `.body`**, never its child —
 * `agent-pane.tsx`'s comment at the mount site states the same rule, because
 * a child would scroll away with the transcript the moment a session got
 * busy, which defeats the entire point of pulling this chrome down to where
 * the user's eyes already are.
 *
 * Contents, top to bottom:
 *
 * 1. **The metrics line** — `<AgentSessionHud/>`, unchanged in content and
 *    honesty contract (status, ctx, tokens, cost, elapsed, git, thinking,
 *    perm — a cell renders a real value or it does not render at all). That
 *    file now renders only this line; everything below used to be cells on
 *    it too.
 * 2. **Tools** — the live grouped tool run as one line ("Running 2 ToolSearch
 *    calls, fetching 1 page") with its elapsed and a "what now" row
 *    underneath. Built from `liveToolRun` (`lib/agent-dock.ts`, which reuses
 *    the transcript's own `groupTurnBlocks`) and `summarizeToolRun` /
 *    `toolRunHeadline` / `toolRunElapsedMs` (`lib/agent-conversation.ts`) —
 *    the same three the transcript's `ToolRunRow` uses, so the dock and the
 *    transcript can never disagree about what one run is.
 * 3. **Agents** and **Workflows** — group headers with a count/summary only.
 *    The named per-agent rows are a follow-up ticket (#21); this ticket ships
 *    the headers so the dock's shape is final and that ticket only has to
 *    fill in rows. Each group's *body*, for now, is the detail panel this
 *    pane already had before this change (the phase tree, the per-agent
 *    status pills, the Workflow Stop button) — relocated verbatim, not
 *    rewritten, so dropping this ticket's scope for named rows does not also
 *    drop a capability (the Stop button is this app's only way to end one
 *    `Workflow` run without killing the whole session).
 *
 * Renders `null` — no element at all, not an empty chrome bar — when
 * `dockHasContent` says the session has reported nothing yet (`lib/agent-dock.ts`).
 * Mounted unconditionally by the pane regardless, so its per-group collapse
 * state (plain `useState`, one `Record` per pane) survives every phase where
 * it currently has nothing to show and every re-render — it is lost only on a
 * genuine remount, the same lifetime `agent-pane.tsx`'s own `selectedView`
 * already has.
 *
 * Sizes to its own content and caps at a max height past which its group
 * stack — not the whole dock — scrolls internally (`agent-activity-dock.module.css`),
 * so a session with a large workflow can never push the composer off screen.
 */

import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { dockHasContent, liveToolRun, toolRunStartedAt } from "../../lib/agent-dock";
import {
  activeOrchestrations,
  activeSubagents,
  formatDuration,
  orchestrationCounts,
  orchestrationPhaseTree,
  summarizeToolRun,
  toolRunElapsedMs,
  toolRunHeadline,
  type ConversationState,
  type OrchestrationAgent,
  type OrchestrationRun,
  type OrchestrationStatus,
  type SubagentCall,
} from "../../lib/agent-conversation";
import { agentStopTask } from "../../lib/ipc";
import { agentStatusClass } from "../command-center/status-utils";
import { AgentSessionHud } from "./agent-session-hud";
import { elapsedSecondsSinceMs, formatElapsed, formatTokens } from "./session-hud-format";
import hud from "./session-hud.module.css";
import styles from "./agent-activity-dock.module.css";

interface AgentActivityDockProps {
  state: ConversationState;
  cwd: string | undefined;
  /** The pane whose stdin a workflow Stop must reach — the reason this prop is
   *  required, same argument as the metrics strip's old `paneId` doc before
   *  the Stop button moved here with it. */
  paneId: string;
}

// ---------------------------------------------------------------------------
// Helpers relocated from `agent-session-hud.tsx`, unchanged. `runningTool`
// (the old single-call "what's running" cell) is deliberately NOT among
// them: the Tools group below answers that question with `liveToolRun`
// instead (D3 in the plan), so the old walk has no caller left and pasting
// it unused would fail `noUnusedLocals`. Everything that *is* still called —
// the label/pill/count formatters for the Agents and Workflows groups — moves
// verbatim.
// ---------------------------------------------------------------------------

/** `"planner-agent"` for a single delegation, `"3 sub-agents"` for several.
 *  Either way the group's elapsed time is measured from `calls[0]` — the
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

/** `"N phases · M/K agents"`, honestly degraded: the phase clause is omitted
 *  for a phase-less run, never printed as `0 phases`, and the agents clause is
 *  omitted while a run has launched no agent yet, never printed as `0/0
 *  agents`. Never a percentage — `K` moves as later phases start, so a bar or
 *  a percent would imply a total the wire has not stated. */
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

/** Sums each active run's own counts — the multi-run header's number,
 *  mirroring `subagentLabel`'s "N sub-agents" collapse for several concurrent
 *  calls. */
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
 * The status-pill mapping for one `workflow_agent` row. Amber for `error` is
 * not a fudge: `parallel()`/`pipeline()` resolve a thrown agent to `null` and
 * the orchestration continues, so an agent error is a warning about one
 * branch, not a failure of the run — hence `idle` (amber), not a fourth,
 * red `d3-status` modifier.
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

/** Which of the dock's three groups a collapse toggle names. */
type DockGroupKey = "tools" | "agents" | "workflows";

/**
 * One collapsible group row: `[twisty] LABEL · summary · meta? · elapsed?`
 * (D8). `meta` is the Workflows-only counts clause; `elapsed` is omitted
 * (`null`) only when the caller has none to show, which in practice never
 * happens for a rendered group — every group here has a primary entity with a
 * `startedAt`.
 */
function DockGroup({
  id,
  label,
  summary,
  meta,
  elapsed,
  expanded,
  onToggle,
  children,
}: {
  id: DockGroupKey;
  label: string;
  summary: string;
  meta?: string;
  elapsed: string | null;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <section className={styles.group} data-testid={`dock-group-${id}`}>
      <button
        type="button"
        aria-expanded={expanded}
        className={styles.groupHead}
        onClick={onToggle}
      >
        <span className={styles.groupTwisty}>{expanded ? "▾" : "▸"}</span>
        <span className={styles.groupLabel}>{label}</span>
        <span className={styles.groupSummary}>{summary}</span>
        {meta !== undefined ? <span className={styles.groupMeta}>{meta}</span> : null}
        {elapsed !== null ? <span className={styles.groupMeta}>{elapsed}</span> : null}
      </button>
      {expanded ? <div className={styles.groupBody}>{children}</div> : null}
    </section>
  );
}

export function AgentActivityDock({
  state,
  cwd,
  paneId,
}: AgentActivityDockProps): ReactElement | null {
  const exited = state.status === "exited";

  // One interval, gated exactly as the metrics strip's own ticker is —
  // nothing here ticks on a dead pane either, and the sub-agent/orchestration
  // groups' elapsed figures ride this same tick rather than a second interval.
  const ticking = state.startedAt !== null && state.status !== "exited";
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [ticking]);

  // Per-pane, per-group collapse state (D5/D6): one `Record`, not a per-entity
  // id. "Expanded" used to mean "expanded *this* sub-agent/run" and derived
  // itself closed the moment that entity ended; the ticket asks for state
  // that survives re-render regardless of which entity is currently primary,
  // which per-entity keying cannot give by construction. Plain `useState`
  // rather than a module map or localStorage: the dock is mounted
  // unconditionally and returns `null` internally, so React keeps this state
  // through every empty phase and view switch; it resets only on a genuine
  // remount (a sibling pane closing), matching `selectedView`'s own lifetime.
  const [collapsed, setCollapsed] = useState<Record<DockGroupKey, boolean>>({
    tools: false,
    agents: true,
    workflows: true,
  });
  function toggle(id: DockGroupKey): void {
    setCollapsed((c) => ({ ...c, [id]: !c[id] }));
  }

  // Task ids with a Stop request in flight — disables the button and blocks a
  // double-send without an optimistic status change: the wire, not this set,
  // decides when the run actually stops.
  const [stoppingTaskIds, setStoppingTaskIds] = useState<readonly string[]>([]);

  // Every hook above runs unconditionally, before this early return — the
  // rule that makes it safe for the dock to render `null` on some renders and
  // an element on others without breaking React's hook-order contract.
  if (!dockHasContent(state)) return null;

  const groups: ReactElement[] = [];

  // Tools — the live grouped run, exactly as the transcript would group it
  // (`liveToolRun` already folds in the exited-session honesty rule).
  const toolRun = liveToolRun(state);
  if (toolRun.length > 0) {
    const runElapsedMs = toolRunElapsedMs(toolRun);
    const elapsed =
      runElapsedMs === null
        ? formatElapsed(elapsedSecondsSinceMs(toolRunStartedAt(toolRun) ?? 0))
        : formatDuration(runElapsedMs);
    const headline = toolRunHeadline(toolRun);
    groups.push(
      <DockGroup
        key="tools"
        id="tools"
        label="Tools"
        summary={summarizeToolRun(toolRun)}
        elapsed={elapsed}
        expanded={!collapsed.tools}
        onToggle={() => toggle("tools")}
      >
        {headline !== null ? (
          <div className={styles.toolHead} data-testid="dock-tool-run">
            <span className={styles.toolHeadTick}>└</span>
            <span>{headline.name}</span>
            <span>{headline.argSummary}</span>
          </div>
        ) : null}
      </DockGroup>,
    );
  }

  // Agents — every Task/Agent call still in flight, oldest first. `exited` is
  // checked again here even though `activeSubagents` already folds it in,
  // matching every other live-only reader on this pane.
  const activeCalls = exited ? [] : activeSubagents(state);
  const primarySubagent = activeCalls[0] ?? null;
  if (primarySubagent !== null) {
    groups.push(
      <DockGroup
        key="agents"
        id="agents"
        label="Agents"
        summary={subagentLabel(activeCalls)}
        elapsed={formatElapsed(elapsedSecondsSinceMs(primarySubagent.startedAt))}
        expanded={!collapsed.agents}
        onToggle={() => toggle("agents")}
      >
        <div className={hud.detail} data-testid="agent-subagent-detail">
          <div className={hud.detailRow}>
            <span className={hud.detailName}>
              {primarySubagent.subagentType ?? "sub-agent"}
            </span>
            <span className={`${hud.value} ${hud.violet}`}>running</span>
          </div>
          {primarySubagent.description !== null ? (
            <div className={hud.detailRow}>
              <span className={hud.detailText}>{primarySubagent.description}</span>
            </div>
          ) : null}
        </div>
      </DockGroup>,
    );
  }

  // Workflows — every Workflow-tool run this session has launched and not yet
  // heard the end of, oldest first. Not gated on `state.status === "running"`:
  // an orchestration outlives its turn, so the pane sits `idle` for most of a
  // run.
  const activeRuns = exited ? [] : activeOrchestrations(state);
  const primaryRun = activeRuns[0] ?? null;
  if (primaryRun !== null) {
    const run = primaryRun;
    const runPill = orchestrationRunPill(run.status);
    const runCounts = orchestrationCountsLabel(orchestrationCounts(run));
    const countsLabel = orchestrationCountsLabel(combinedOrchestrationCounts(activeRuns));
    const stopping = stoppingTaskIds.includes(run.taskId);
    groups.push(
      <DockGroup
        key="workflows"
        id="workflows"
        label="Workflows"
        summary={orchestrationLabel(activeRuns)}
        meta={countsLabel !== "" ? countsLabel : undefined}
        elapsed={formatElapsed(elapsedSecondsSinceMs(primaryRun.startedAt))}
        expanded={!collapsed.workflows}
        onToggle={() => toggle("workflows")}
      >
        <div className={hud.detail} data-testid="agent-orchestration-detail">
          <div className={hud.detailHead}>
            <span className={hud.detailName}>{run.name ?? "orchestration"}</span>
            {runCounts !== "" ? (
              <span className={`${hud.value} ${hud.muted}`}>{runCounts}</span>
            ) : null}
            {run.totalTokens !== null ? (
              <span className={`${hud.value} ${hud.pink}`}>
                {formatTokens(run.totalTokens)}
              </span>
            ) : null}
            <span className={runPill.className}>
              {runPill.pulse ? <span className="d3-status__pulse" /> : null}
              {runPill.label}
            </span>
            <button
              type="button"
              className={`d3-btn d3-btn--sm ${hud.detailStop}`}
              style={{ borderColor: "rgba(239,68,68,0.30)", color: "var(--err)" }}
              disabled={stopping}
              onClick={() => {
                setStoppingTaskIds((ids) =>
                  ids.includes(run.taskId) ? ids : [...ids, run.taskId],
                );
                // Not optimistic: the wire's own task_updated / task_notification
                // decides when the run's status actually flips to "stopped".
                void agentStopTask(paneId, run.taskId).catch((err: unknown) => {
                  console.error("agentStopTask failed", err);
                });
              }}
            >
              Stop
            </button>
          </div>
          {run.activity !== null ? (
            <div className={hud.detailRow}>
              <span className={hud.detailText}>{run.activity}</span>
            </div>
          ) : null}
          {orchestrationPhaseTree(run).map((group) => (
            <div key={group.phaseIndex ?? "unphased"} className={hud.detailPhase}>
              <span className={hud.detailPhaseTitle}>{group.title}</span>
              {group.agents.map((agent) => {
                const pill = orchestrationAgentPill(agent);
                return (
                  <div key={agent.index} className={hud.detailAgent}>
                    <span className={pill.className}>
                      {pill.pulse ? <span className="d3-status__pulse" /> : null}
                      {pill.label}
                    </span>
                    <span
                      className={`${hud.value} ${hud.detailAgentLabel}`}
                      title={agent.label}
                    >
                      {agent.label}
                    </span>
                    {agent.agentType !== null ? (
                      <span className={`${hud.value} ${hud.muted}`}>
                        {agent.agentType}
                      </span>
                    ) : null}
                    {agent.model !== null ? (
                      <span className={`${hud.value} ${hud.muted}`}>{agent.model}</span>
                    ) : null}
                    {agent.tokens !== null ? (
                      <span className={`${hud.value} ${hud.pink}`}>
                        {formatTokens(agent.tokens)}
                      </span>
                    ) : null}
                    {agent.toolCalls !== null ? (
                      <span className={`${hud.value} ${hud.muted}`}>
                        {agent.toolCalls} calls
                      </span>
                    ) : null}
                    {agent.durationMs !== null ? (
                      <span className={`${hud.value} ${hud.muted}`}>
                        {formatDuration(agent.durationMs)}
                      </span>
                    ) : null}
                    {agent.error !== null ? (
                      <span className={hud.detailText}>{agent.error}</span>
                    ) : agent.resultPreview !== null ? (
                      <span className={hud.detailText}>{agent.resultPreview}</span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </DockGroup>,
    );
  }

  return (
    <div className={styles.dock} data-testid="agent-activity-dock">
      <AgentSessionHud state={state} cwd={cwd} />
      {groups.length > 0 ? <div className={styles.groups}>{groups}</div> : null}
    </div>
  );
}
