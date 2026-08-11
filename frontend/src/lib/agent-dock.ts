/**
 * Pure selectors for the agent pane's activity dock (`agent-activity-dock.tsx`,
 * Zone B of the three-zone pane) — the same "pure, UI-shaped selectors over
 * `ConversationState`, in their own module" idiom `lib/agent-views.ts`
 * establishes for the view picker. No React here: `only-export-components`
 * (`session-hud-format.ts:1-13`) forbids exporting a non-component from a
 * `.tsx`, so anything the dock needs that isn't a component lives here.
 *
 * The dock's Tools group deliberately does not walk the transcript on its
 * own. `liveToolRun` below reuses `groupTurnBlocks` — the exact grouping the
 * transcript renders — so the dock's headline can never disagree with what
 * the transcript shows for the same run, and a `Task`/`Agent` delegation is
 * excluded for free (it is already its own `delegation` group there).
 */

import {
  childToolCount,
  groupTurnBlocks,
  activeOrchestrations,
  activeSubagents,
  orchestrationCounts,
  orchestrationPhaseTree,
  type ConversationState,
  type ConvToolBlock,
  type OrchestrationAgent,
  type OrchestrationRun,
  type OrchestrationStatus,
} from "./agent-conversation";
import {
  subagentBlocks,
  subagentDescription,
  subagentLabel,
  viewKey,
  type AgentViewId,
} from "./agent-views";

/**
 * The run of consecutive tool calls currently in flight, in transcript order —
 * `[]` when nothing is running. Walks `state.turns` newest-first and, within
 * each turn, that turn's own `groupTurnBlocks` groups last-first, so the most
 * recently started activity is found first without needing a second pass or a
 * timestamp comparison across turns.
 *
 * A group qualifies when it is a `toolRun` (or a lone tool `block`) that
 * contains at least one still-open call (`endedAt === null`) — a finished run
 * further back in the same turn is skipped in favour of an open one, and a
 * `delegation` group never qualifies at all: that is the Agents group's
 * entity, not this one's, exactly as the transcript keeps a `Task` card
 * separate from the tool rows around it.
 *
 * `[]` on an exited session — same honesty fold-in as `activeSubagents`
 * (`agent-conversation.ts:481-484`): a dead process cannot have a call in
 * flight, so claiming one would be the same lie the metrics strip already
 * refuses to tell.
 *
 * Returns a mutable `ConvToolBlock[]`, not `readonly`, so the result passes
 * straight into `summarizeToolRun`/`toolRunHeadline`/`toolRunElapsedMs`,
 * whose parameters are all `ConvToolBlock[]`.
 */
export function liveToolRun(state: ConversationState): ConvToolBlock[] {
  if (state.status === "exited") return [];
  for (let i = state.turns.length - 1; i >= 0; i -= 1) {
    const turn = state.turns[i];
    if (turn === undefined) continue;
    const groups = groupTurnBlocks(turn.blocks);
    for (let j = groups.length - 1; j >= 0; j -= 1) {
      const group = groups[j];
      if (group === undefined) continue;
      if (group.kind === "toolRun" && group.blocks.some((b) => b.endedAt === null)) {
        return [...group.blocks];
      }
      if (
        group.kind === "block" &&
        group.block.type === "tool" &&
        group.block.endedAt === null
      ) {
        return [group.block];
      }
    }
  }
  return [];
}

/**
 * The earliest `startedAt` among `blocks`, or `null` for an empty run. The
 * live ticker's origin: `toolRunElapsedMs` is `null` by design while any call
 * in the run is still open (it would otherwise report a span that is wrong
 * the instant it paints), so the dock needs this instead to render a live
 * "Ns" figure for a run that has not finished yet.
 *
 * Written as an explicit loop rather than `Math.min(...blocks.map(...))` or
 * `blocks[0]!` — the former is what `toolRunElapsedMs` itself already does
 * for a *closed* run, but this needs no such spread, and the latter is
 * exactly what `noUncheckedIndexedAccess` forbids.
 */
export function toolRunStartedAt(blocks: ConvToolBlock[]): number | null {
  let earliest: number | null = null;
  for (const block of blocks) {
    if (earliest === null || block.startedAt < earliest) earliest = block.startedAt;
  }
  return earliest;
}

/**
 * Whether the dock has anything at all to show — the honesty contract applied
 * to the dock as a whole, not just to one cell. `false` renders no dock
 * element (no empty chrome bar); `true` renders at least the dimmed metrics
 * strip.
 *
 * Every disjunct is a fact the wire has reported, in the same order the
 * metrics strip itself checks them:
 *
 * - `startedAt !== null` — the session has seen its `init` frame.
 * - `usage !== null` — a `result` frame has reported token accounting.
 * - `lastResult !== null` — a turn has finished (so `cost`/`elapsed` may show).
 * - `permissions.length > 0` — a tool call is waiting on the user.
 * - `thinking` — the model is mid-thought right now.
 * - `liveToolRun(state)` non-empty — a tool call is in flight.
 * - `activeSubagents(state)` non-empty — a `Task`/`Agent` delegation is open.
 * - `activeOrchestrations(state)` non-empty — a `Workflow` run is open.
 *
 * Deliberately **not** a disjunct: the git branch. It is ambient context
 * available from the moment the pane opens (`useGitPaneStatus` needs only
 * `cwd`, not a session frame), so including it would make "renders nothing at
 * all for an idle fresh session" unreachable in any repo — every pane would
 * show a dock the instant it mounted. The accepted, documented consequence:
 * between mount and the `init` frame (sub-second normally; indefinite if the
 * spawn fails, where `agent-pane.tsx`'s `startError` bar carries the news
 * instead) the branch name is not shown anywhere.
 */
export function dockHasContent(state: ConversationState): boolean {
  return (
    state.startedAt !== null ||
    state.usage !== null ||
    state.lastResult !== null ||
    state.permissions.length > 0 ||
    state.thinking ||
    liveToolRun(state).length > 0 ||
    activeSubagents(state).length > 0 ||
    activeOrchestrations(state).length > 0
  );
}

// ---------------------------------------------------------------------------
// Dock rows — the Agents and Workflows group bodies (#21). `subagentBlocks`
// and `state.orchestrations` are the sources, not `activeSubagents` /
// `activeOrchestrations`: those two are live-only by design (see their own
// doc comments), but a finished delegation or a terminal run must still get
// a row — the most useful moment to read a sub-agent's result is right after
// it ends. The *live* helpers stay in use for the group headers' running
// counts and ticker origin, which is the only place "counts degrade as
// things finish" applies.
// ---------------------------------------------------------------------------

/** How a dock row's leading dot reads. `ended` is the honest fourth state for
 *  work whose end the wire never reported because the session died first;
 *  `warn` is the workflow-agent `error` case (a branch warning, not a run
 *  failure — `parallel()`/`pipeline()` resolve a thrown agent to `null` and
 *  the orchestration continues, the same reasoning `agent-activity-dock.tsx`
 *  used to carry in `orchestrationAgentPill`). */
export type DockRowStatus = "running" | "done" | "failed" | "warn" | "ended";

export interface DockAgentRow {
  /** `viewKey({kind:"subagent", id})` — React key and the dock's own
   *  "is this the selection" comparison. */
  key: string;
  view: AgentViewId;
  status: DockRowStatus;
  /** `subagentLabel(block)` — unchanged semantics, never a placeholder. */
  label: string;
  /** `subagentDescription(block)` — the *second* field, never folded into
   *  `label` (that would silently corrupt `<DelegationCard/>` and the
   *  composer picker, which both already import the same function). */
  description: string | null;
  /** `childToolCount(block)`; `0` means the row shows no tool clause. */
  toolCount: number;
  /** Exact span, or `null` while running / when either end is unknown. */
  elapsedMs: number | null;
  running: boolean;
  /** `block.startedAt`, epoch ms. The group header's live ticker measures
   *  from the oldest *running* row's value; rows themselves never tick —
   *  a per-row clock would be exactly the "number frozen at last paint" the
   *  ticket forbids. */
  startedAt: number;
}

/**
 * `running` while the call is open on a live session; `ended` for a call
 * still open when the session has exited — the wire never reported an end
 * for it, so calling it `done` (as `<DelegationCard/>`'s three-way status
 * word would) reports something the wire never said. Otherwise `done` or
 * `failed`, from the matching `tool_result`'s `is_error`.
 */
export function subagentRowStatus(
  block: ConvToolBlock,
  sessionExited: boolean,
): DockRowStatus {
  if (block.endedAt === null) return sessionExited ? "ended" : "running";
  return block.isError ? "failed" : "done";
}

/** One row per `Task`/`Agent` delegation this session made, oldest first —
 *  `subagentBlocks`' own order, which is already start order by
 *  construction, so no sort is applied here either. */
export function dockAgentRows(state: ConversationState): DockAgentRow[] {
  const sessionExited = state.status === "exited";
  return subagentBlocks(state).map((block) => {
    const status = subagentRowStatus(block, sessionExited);
    return {
      key: viewKey({ kind: "subagent", id: block.id }),
      view: { kind: "subagent", id: block.id },
      status,
      label: subagentLabel(block),
      description: subagentDescription(block),
      toolCount: childToolCount(block),
      elapsedMs: block.endedAt === null ? null : Math.max(0, block.endedAt - block.startedAt),
      running: status === "running",
      startedAt: block.startedAt,
    };
  });
}

export interface DockWorkflowAgentRow {
  /** `String(agent.index)` — the CLI's stable per-run key. */
  key: string;
  status: DockRowStatus;
  label: string;
  agentType: string | null;
  model: string | null;
  tokens: number | null;
  toolCalls: number | null;
  durationMs: number | null;
  /** `agent.error ?? agent.resultPreview` — the row's own one-line detail. */
  detail: string | null;
  running: boolean;
  cached: boolean;
}

export interface DockWorkflowPhase {
  /** `String(phaseIndex)`, or `"unphased"` for the one group
   *  `orchestrationPhaseTree` returns when no agent carries a phase. */
  key: string;
  title: string;
  agents: DockWorkflowAgentRow[];
}

export interface DockWorkflowRow {
  /** `viewKey({kind:"workflow", taskId})`. */
  key: string;
  view: AgentViewId;
  taskId: string;
  status: DockRowStatus;
  /** The wire's own word — rendered in the meta clause only once the run is
   *  terminal (a running run's word is redundant with its dot and its live
   *  elapsed clause). */
  wireStatus: OrchestrationStatus;
  /** `run.name ?? "orchestration"`. */
  label: string;
  /** `run.activity ?? run.description`. */
  description: string | null;
  /** `orchestrationCountsLabel(orchestrationCounts(run))`; `""` when both
   *  clauses degrade away. */
  counts: string;
  totalTokens: number | null;
  /** `run.endedAt - run.startedAt`, or `null` while the run is still going. */
  elapsedMs: number | null;
  running: boolean;
  /** `run.startedAt` — the header ticker's origin, as above. */
  startedAt: number;
  phases: DockWorkflowPhase[];
}

/** `error → "warn"` (a branch warning, not a run failure); `done && cached →
 *  "ended"` (a resume served this agent from the journal, no model call —
 *  distinct from an agent that actually ran to completion this session);
 *  `done → "done"`; `start`/`progress` → `"running"`, or `"ended"` on an
 *  exited session, mirroring `subagentRowStatus`. */
function workflowAgentRowStatus(
  agent: OrchestrationAgent,
  sessionExited: boolean,
): DockRowStatus {
  if (agent.state === "error") return "warn";
  if (agent.state === "done") return agent.cached ? "ended" : "done";
  return sessionExited ? "ended" : "running";
}

function dockWorkflowAgentRow(
  agent: OrchestrationAgent,
  sessionExited: boolean,
): DockWorkflowAgentRow {
  const status = workflowAgentRowStatus(agent, sessionExited);
  return {
    key: String(agent.index),
    status,
    label: agent.label,
    agentType: agent.agentType,
    model: agent.model,
    tokens: agent.tokens,
    toolCalls: agent.toolCalls,
    durationMs: agent.durationMs,
    detail: agent.error ?? agent.resultPreview,
    running: status === "running",
    cached: agent.cached,
  };
}

/** `running → "running"`, or `"ended"` on an exited session — the wire still
 *  calling a run "running" after the process died is exactly the case
 *  `activeOrchestrations` already refuses for the header count, so the row
 *  refuses it too; `completed → "done"`; `failed → "failed"`; `stopped →
 *  "ended"` (a user-requested stop, not a failure). */
function orchestrationRunRowStatus(
  status: OrchestrationStatus,
  sessionExited: boolean,
): DockRowStatus {
  if (status === "running") return sessionExited ? "ended" : "running";
  if (status === "completed") return "done";
  if (status === "failed") return "failed";
  return "ended"; // "stopped"
}

/** One row per orchestration run this session has launched, terminal or not,
 *  oldest first — `state.orchestrations`' own order, no sort (same reasoning
 *  as `dockAgentRows`). Phases come from `orchestrationPhaseTree`, so a run
 *  the CLI never assigned phases still gets its one `"agents"` group rather
 *  than an empty phase list. */
export function dockWorkflowRows(state: ConversationState): DockWorkflowRow[] {
  const sessionExited = state.status === "exited";
  return state.orchestrations.map((run) => {
    const running = run.status === "running" && !sessionExited;
    return {
      key: viewKey({ kind: "workflow", taskId: run.taskId }),
      view: { kind: "workflow", taskId: run.taskId },
      taskId: run.taskId,
      status: orchestrationRunRowStatus(run.status, sessionExited),
      wireStatus: run.status,
      label: run.name ?? "orchestration",
      description: run.activity ?? run.description,
      counts: orchestrationCountsLabel(orchestrationCounts(run)),
      totalTokens: run.totalTokens,
      elapsedMs: run.endedAt === null ? null : Math.max(0, run.endedAt - run.startedAt),
      running,
      startedAt: run.startedAt,
      phases: orchestrationPhaseTree(run).map((group) => ({
        key: group.phaseIndex === null ? "unphased" : String(group.phaseIndex),
        title: group.title,
        agents: group.agents.map((agent) => dockWorkflowAgentRow(agent, sessionExited)),
      })),
    };
  });
}

/** `"N phases · M/K agents"`, honestly degraded: the phase clause is omitted
 *  for a phase-less run, never printed as `0 phases`, and the agents clause is
 *  omitted while a run has launched no agent yet, never printed as `0/0
 *  agents`. Never a percentage — `K` moves as later phases start, so a bar or
 *  a percent would imply a total the wire has not stated.
 *
 *  Moved here verbatim from `agent-activity-dock.tsx` (D7): the group header
 *  and the run rows both need this label, and two copies would drift. */
export function orchestrationCountsLabel(counts: {
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

/** Sums each run's own counts — the multi-run header's number, mirroring the
 *  Agents group's "N sub-agents" collapse for several delegations. Moved
 *  here verbatim from `agent-activity-dock.tsx` (D7), same reasoning as
 *  `orchestrationCountsLabel` above. */
export function combinedOrchestrationCounts(
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
