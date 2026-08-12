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
 * 3. **Agents** and **Workflows** — one row per `Task`/`Agent` delegation and
 *    one row per orchestration run, running and finished alike: the most
 *    useful moment to read a sub-agent's or a run's result is right after it
 *    ends, so neither group empties itself the instant its last live entity
 *    finishes (#21). Rows are click targets that drive the pane's single
 *    `selectedView` — the same state the composer's picker drives, passed in
 *    as a prop pair rather than owned here, so the dock and the picker can
 *    never point at two different things. The Workflows group nests each
 *    run's phase tree, one row per phase agent, and keeps the Workflow Stop
 *    button next to its run: it is this app's only way to end one `Workflow`
 *    run without killing the whole session, so the move to named rows
 *    carries it along rather than dropping it.
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

import { Fragment, useEffect, useState, type ReactElement, type ReactNode } from "react";
import {
  combinedOrchestrationCounts,
  dockAgentRows,
  dockHasContent,
  dockWorkflowRows,
  liveToolRun,
  orchestrationCountsLabel,
  toolRunStartedAt,
  type DockRowStatus,
} from "../../lib/agent-dock";
import {
  activeOrchestrations,
  formatDuration,
  summarizeToolRun,
  toolRunElapsedMs,
  toolRunHeadline,
  type ConversationState,
  type OrchestrationRun,
} from "../../lib/agent-conversation";
import { sameView, viewKey, type AgentViewId } from "../../lib/agent-views";
import { agentStopTask } from "../../lib/ipc";
import { AgentSessionHud } from "./agent-session-hud";
import { elapsedSecondsSinceMs, formatElapsed, formatTokens } from "./session-hud-format";
import styles from "./agent-activity-dock.module.css";

interface AgentActivityDockProps {
  state: ConversationState;
  cwd: string | undefined;
  /** The pane whose stdin a workflow Stop must reach — the reason this prop is
   *  required, same argument as the metrics strip's old `paneId` doc before
   *  the Stop button moved here with it. */
  paneId: string;
  /** The pane's single selection, already resolved by `resolveView`
   *  (`agent-pane.tsx`) — the same value the composer picker receives.
   *  Required, not optional: a dock that could render without it would need
   *  a second, silently-diverging notion of "current". */
  selectedView: AgentViewId;
  /** `setSelectedView` itself, the same setter the picker and the
   *  transcript's delegation card call. */
  onSelectView: (id: AgentViewId) => void;
}

/** `${primaryRun.name ?? "orchestration"}` for one run, `"N orchestrations"`
 *  for several — the Workflows group header's single-vs-many idiom, now
 *  retargeted at every run this session has launched (D1), not just the live
 *  ones: a finished run still needs a name in the header when it is the only
 *  one. */
function orchestrationLabel(runs: readonly OrchestrationRun[]): string {
  const primary = runs[0];
  if (runs.length === 1 && primary) return primary.name ?? "orchestration";
  return `${runs.length} orchestrations`;
}

/** `["3 tools", null, "1.2k"]` → `["3 tools", "1.2k"]`. A type predicate, not
 *  a bare `Boolean` filter, because `Array.filter(Boolean)` does not narrow
 *  away the `null` in the result type. */
function present(values: readonly (string | null)[]): string[] {
  return values.filter((v): v is string => v !== null && v !== "");
}

/** The word a `DockRowStatus` reads as, for the dot's `title` and the row's
 *  `aria-label` — colour is never the only signal for status. `warn` reads
 *  "error": it is the wire's own `workflow_agent.state === "error"`, softened
 *  to an amber dot rather than a red one because the run continues past it
 *  (see `DockRowStatus`'s own doc comment), not softened in the word too. */
function statusWord(status: DockRowStatus): string {
  switch (status) {
    case "running":
      return "running";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "warn":
      return "error";
    case "ended":
      return "ended";
  }
}

/** `styles.dot<Status>` for a `DockRowStatus`. No explicit `string` return
 *  type: a CSS module's classes are typed through an index signature, which
 *  `noUncheckedIndexedAccess` widens to `string | undefined` on every read
 *  (dotted or not) — harmless here, since the only use is inside a template
 *  literal below, but an annotated `string` return would need a fallback
 *  that can never actually trigger. */
function dotClassName(status: DockRowStatus): string | undefined {
  switch (status) {
    case "running":
      return styles.dotRunning;
    case "done":
      return styles.dotDone;
    case "failed":
      return styles.dotFailed;
    case "warn":
      return styles.dotWarn;
    case "ended":
      return styles.dotEnded;
  }
}

/** A 6px dot carrying a row's status. `running` composes the global
 *  `.d3-status__pulse` class (`d3-creative.css`) rather than re-authoring the
 *  pulse ring: that class is already a `currentColor` dot with an animated
 *  `::after` ring, and every other status renders it plain. */
function StatusDot({ status, word }: { status: DockRowStatus; word: string }): ReactElement {
  const pulse = status === "running" ? " d3-status__pulse" : "";
  return <span className={`${styles.dot} ${dotClassName(status)}${pulse}`} title={word} />;
}

/** A row's elapsed column: the literal word `running` in flight, an exact
 *  `formatDuration` once both ends are known, and nothing at all otherwise —
 *  never a number frozen at the render that happened to catch a still-open
 *  call. */
function RowElapsed({
  ms,
  running,
}: {
  ms: number | null;
  running: boolean;
}): ReactElement | null {
  if (running) return <span className={styles.rowLive}>running</span>;
  if (ms === null) return null;
  return <span className={styles.rowElapsed}>{formatDuration(ms)}</span>;
}

/**
 * One dock row: `[dot] name · description · meta… · elapsed`, used for every
 * row kind (sub-agent, workflow run, workflow phase-agent) so the three can
 * never drift into three different shapes.
 *
 * `view === null` renders a non-interactive `<div>` — phase-agent rows have
 * no `AgentViewId` to select (`AgentViewId` has no fourth variant for one
 * orchestration agent; the run row above them is the click target for the
 * whole run). Otherwise the row's own body is a `<button>`, and `trailing`
 * (the Workflow Stop button) is its sibling, never its child — a `<button>`
 * nested inside a `<button>` is invalid HTML and breaks click handling.
 */
function DockRow(props: {
  view: AgentViewId | null;
  selected: boolean;
  onSelect: (id: AgentViewId) => void;
  status: DockRowStatus;
  statusWord: string;
  name: string;
  description: string | null;
  /** Already `present()`-filtered by the caller; joined with " · ". */
  meta: readonly string[];
  elapsedMs: number | null;
  running: boolean;
  indent?: boolean;
  trailing?: ReactNode;
  testId: string;
}): ReactElement {
  const {
    view,
    selected,
    onSelect,
    status,
    statusWord: word,
    name,
    description,
    meta,
    elapsedMs,
    running,
    indent,
    trailing,
    testId,
  } = props;
  const metaText = meta.join(" · ");
  const body = (
    <>
      <StatusDot status={status} word={word} />
      <span className={styles.rowName}>{name}</span>
      {description !== null ? <span className={styles.rowDesc}>{description}</span> : null}
      {metaText !== "" ? <span className={styles.rowMeta}>{metaText}</span> : null}
      <RowElapsed ms={elapsedMs} running={running} />
    </>
  );
  return (
    <div
      className={`${styles.row}${indent === true ? ` ${styles.rowIndent}` : ""}`}
      data-testid={testId}
      data-view-key={view === null ? undefined : viewKey(view)}
    >
      {view !== null ? (
        <button
          type="button"
          className={`${styles.rowMain}${selected ? ` ${styles.rowSelected}` : ""}`}
          aria-current={selected ? "true" : undefined}
          aria-label={`Show ${name} — ${word}`}
          onClick={() => onSelect(view)}
        >
          {body}
        </button>
      ) : (
        <div className={styles.rowMain}>{body}</div>
      )}
      {trailing ?? null}
    </div>
  );
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
  selectedView,
  onSelectView,
}: AgentActivityDockProps): ReactElement | null {
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

  // Agents — one row per Task/Agent delegation this session has made,
  // running and finished, oldest first (D1/D2). The header's own running
  // count and ticker origin stay live-only, which is the only place "counts
  // degrade to nothing as agents finish" applies — the rows themselves never
  // disappear.
  const agentRows = dockAgentRows(state);
  const runningAgents = agentRows.filter((r) => r.running);
  const oldestRunningAgent = runningAgents[0] ?? null;
  if (agentRows.length > 0) {
    const single = agentRows.length === 1 ? agentRows[0] ?? null : null;
    groups.push(
      <DockGroup
        key="agents"
        id="agents"
        label="Agents"
        summary={single !== null ? single.label : `${agentRows.length} sub-agents`}
        meta={runningAgents.length > 0 ? `${runningAgents.length} running` : undefined}
        elapsed={
          oldestRunningAgent === null
            ? null
            : formatElapsed(elapsedSecondsSinceMs(oldestRunningAgent.startedAt))
        }
        expanded={!collapsed.agents}
        onToggle={() => toggle("agents")}
      >
        <div className={styles.rows} data-testid="dock-agent-rows">
          {agentRows.map((row) => (
            <DockRow
              key={row.key}
              testId="dock-agent-row"
              view={row.view}
              selected={sameView(selectedView, row.view)}
              onSelect={onSelectView}
              status={row.status}
              statusWord={statusWord(row.status)}
              name={row.label}
              description={row.description}
              meta={present([row.toolCount > 0 ? `${row.toolCount} tools` : null])}
              elapsedMs={row.elapsedMs}
              running={row.running}
            />
          ))}
        </div>
      </DockGroup>,
    );
  }

  // Workflows — one row per orchestration run this session has launched,
  // terminal or not, oldest first, phases nested underneath with one row per
  // phase agent (D1/D2). Not gated on `state.status === "running"`: an
  // orchestration outlives its turn, so the pane sits `idle` for most of a
  // run. The header's counts sum *every* run (D1 — a finished run's tally
  // still belongs in the total), while its elapsed origin stays the oldest
  // *live* run, same reasoning as the Agents header above.
  const workflowRows = dockWorkflowRows(state);
  const liveRuns = activeOrchestrations(state);
  const oldestLiveRun = liveRuns[0] ?? null;
  if (workflowRows.length > 0) {
    const single = workflowRows.length === 1 ? workflowRows[0] ?? null : null;
    const countsLabel = orchestrationCountsLabel(combinedOrchestrationCounts(state.orchestrations));
    groups.push(
      <DockGroup
        key="workflows"
        id="workflows"
        label="Workflows"
        summary={single !== null ? single.label : orchestrationLabel(state.orchestrations)}
        meta={countsLabel !== "" ? countsLabel : undefined}
        elapsed={
          oldestLiveRun === null
            ? null
            : formatElapsed(elapsedSecondsSinceMs(oldestLiveRun.startedAt))
        }
        expanded={!collapsed.workflows}
        onToggle={() => toggle("workflows")}
      >
        <div className={styles.rows} data-testid="dock-workflow-rows">
          {workflowRows.map((row) => {
            const stopping = stoppingTaskIds.includes(row.taskId);
            return (
              <Fragment key={row.key}>
                <DockRow
                  testId="dock-workflow-row"
                  view={row.view}
                  selected={sameView(selectedView, row.view)}
                  onSelect={onSelectView}
                  status={row.status}
                  statusWord={statusWord(row.status)}
                  name={row.label}
                  description={row.description}
                  meta={present([
                    row.counts,
                    row.totalTokens !== null ? formatTokens(row.totalTokens) : null,
                    row.running ? null : row.wireStatus,
                  ])}
                  elapsedMs={row.elapsedMs}
                  running={row.running}
                  trailing={
                    row.running ? (
                      <button
                        type="button"
                        className={`d3-btn d3-btn--sm ${styles.rowStop}`}
                        style={{ borderColor: "rgba(239,68,68,0.30)", color: "var(--err)" }}
                        disabled={stopping}
                        onClick={() => {
                          setStoppingTaskIds((ids) =>
                            ids.includes(row.taskId) ? ids : [...ids, row.taskId],
                          );
                          // Not optimistic: the wire's own task_updated /
                          // task_notification decides when the run's status
                          // actually flips to "stopped".
                          void agentStopTask(paneId, row.taskId).catch((err: unknown) => {
                            console.error("agentStopTask failed", err);
                          });
                        }}
                      >
                        Stop
                      </button>
                    ) : null
                  }
                />
                {row.phases.map((phase) => (
                  <div className={styles.phase} key={phase.key}>
                    <span className={styles.phaseTitle}>{phase.title}</span>
                    {phase.agents.map((agent) => (
                      <DockRow
                        key={agent.key}
                        testId="dock-workflow-agent-row"
                        view={null}
                        indent
                        selected={false}
                        onSelect={onSelectView}
                        status={agent.status}
                        statusWord={statusWord(agent.status)}
                        name={agent.label}
                        description={agent.detail}
                        meta={present([
                          agent.agentType,
                          agent.cached ? "cached" : null,
                          agent.model,
                          agent.toolCalls !== null ? `${agent.toolCalls} calls` : null,
                          agent.tokens !== null ? formatTokens(agent.tokens) : null,
                        ])}
                        elapsedMs={agent.durationMs}
                        running={agent.running}
                      />
                    ))}
                  </div>
                ))}
              </Fragment>
            );
          })}
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
