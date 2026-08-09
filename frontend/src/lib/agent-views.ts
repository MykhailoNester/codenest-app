/**
 * The pane's view router: which "agent" the conversation area is currently
 * showing, and the list of the ones it could show.
 *
 * A session is not one agent. It is the main agent, every `Task`/`Agent`
 * sub-agent it delegates to, and every `Workflow` orchestration it launches
 * (which spawns sub-agents of its own). All of that used to render as one flat
 * stream, so a delegated task's output arrived interleaved with the parent's
 * and there was no way to ask "what is *that* sub-agent doing".
 *
 * This module is the pure half of the fix: it derives the selectable views and
 * their timings from `ConversationState`, and nothing else. No React, no
 * stores, no IPC — the component layer picks one of these and renders it.
 *
 * Everything here reads state the pane already has. Sub-agents come from the
 * `Task`/`Agent` tool blocks in the transcript; orchestrations come from
 * `state.orchestrations`, which the reducer already builds from the CLI's
 * `task_*` frames. No new wire format and no new storage.
 */

import {
  isSubagentTool,
  orchestrationCounts,
  type ConversationState,
  type ConvToolBlock,
  type OrchestrationRun,
} from "./agent-conversation";

/** Which view the pane is showing. `main` is the ordinary transcript. */
export type AgentViewId =
  | { kind: "main" }
  | { kind: "subagent"; id: string }
  | { kind: "workflow"; taskId: string };

export const MAIN_VIEW: AgentViewId = { kind: "main" };

/** One row in the picker. `key` is both the React key and the value the
 *  picker round-trips, so the component never has to serialise `AgentViewId`
 *  itself. */
export interface AgentViewOption {
  key: string;
  id: AgentViewId;
  /** What the picker shows: "Main agent", the sub-agent's type, the run name. */
  label: string;
  /** The second line — a task description, or a phase/agent tally. */
  detail: string | null;
  running: boolean;
  /** When this entity started, epoch ms — the list's sort key. `null` for a
   *  session that has not reported `init` yet. */
  startedAt: number | null;
  /** How long this entity ran, in milliseconds — exact, from its own start
   *  and end. `null` while it is still going, and for anything whose end the
   *  wire never reported.
   *
   *  Deliberately not a live figure measured against `Date.now()`. That would
   *  need a clock ticking in render (impure, and rejected by the compiler's
   *  purity rule) or a once-a-second interval re-rendering the whole pane, to
   *  produce a number that is stale the instant it paints. Callers render
   *  "running" for these instead, which is both cheaper and more honest. */
  elapsedMs: number | null;
}

/** `key` for a view id — the picker's `<option value>` and React key. */
export function viewKey(id: AgentViewId): string {
  switch (id.kind) {
    case "main":
      return "main";
    case "subagent":
      return `sub:${id.id}`;
    case "workflow":
      return `wf:${id.taskId}`;
  }
}

/** Parses a `key` produced by `viewKey` back into an id. Unknown input falls
 *  back to `main` rather than throwing: the picker is chrome, and a stale key
 *  (a sub-agent that finished and aged out) must degrade to the transcript
 *  instead of taking the pane down. */
export function parseViewKey(key: string): AgentViewId {
  if (key.startsWith("sub:")) return { kind: "subagent", id: key.slice(4) };
  if (key.startsWith("wf:")) return { kind: "workflow", taskId: key.slice(3) };
  return MAIN_VIEW;
}

export function sameView(a: AgentViewId, b: AgentViewId): boolean {
  return viewKey(a) === viewKey(b);
}

/** Every `Task`/`Agent` tool block in the transcript, finished or not —
 *  unlike `activeSubagents`, which is deliberately in-flight only because its
 *  consumers are live indicators. The picker needs the finished ones too: the
 *  most useful moment to read a sub-agent's result is right after it ends. */
export function subagentBlocks(state: ConversationState): ConvToolBlock[] {
  const blocks: ConvToolBlock[] = [];
  for (const turn of state.turns) {
    for (const block of turn.blocks) {
      if (block.type === "tool" && isSubagentTool(block.name)) blocks.push(block);
    }
  }
  return blocks;
}

/** A sub-agent's display name: its declared type, else the tool's own name.
 *  Never a placeholder — `subagent_type` is genuinely absent for a default
 *  agent, and "general-purpose" would be an invention. */
export function subagentLabel(block: ConvToolBlock): string {
  const input = block.input as Record<string, unknown> | null | undefined;
  const type = typeof input?.["subagent_type"] === "string" ? input["subagent_type"] : "";
  return type.length > 0 ? type : block.name;
}

function subagentDescription(block: ConvToolBlock): string | null {
  const input = block.input as Record<string, unknown> | null | undefined;
  const desc = typeof input?.["description"] === "string" ? input["description"] : "";
  return desc.length > 0 ? desc : (block.argSummary || null);
}

/** Exact duration, or `null` when either end of it is unknown. */
function span(startedAt: number | null, endedAt: number | null): number | null {
  if (startedAt === null || endedAt === null) return null;
  return Math.max(0, endedAt - startedAt);
}

/**
 * The picker's rows: the main agent first, then sub-agents and orchestrations
 * in the order they started.
 *
 * Running entities are *not* floated to the top. The list is a map of what the
 * session did, and an order that reshuffles itself as things finish is one the
 * user cannot build a habit around — the row they were about to click would
 * move out from under them.
 */
export function listAgentViews(state: ConversationState): AgentViewOption[] {
  const main: AgentViewOption = {
    key: "main",
    id: MAIN_VIEW,
    label: "Main agent",
    detail: state.model,
    running: state.status === "running",
    startedAt: state.startedAt,
    // A session reports no end time on the wire at all, so there is never an
    // exact lifetime to show for the main agent.
    elapsedMs: null,
  };

  const subs = subagentBlocks(state).map<AgentViewOption>((block) => ({
    key: viewKey({ kind: "subagent", id: block.id }),
    id: { kind: "subagent", id: block.id },
    label: subagentLabel(block),
    detail: subagentDescription(block),
    running: block.endedAt === null && state.status !== "exited",
    startedAt: block.startedAt,
    elapsedMs: span(block.startedAt, block.endedAt),
  }));

  const runs = state.orchestrations.map<AgentViewOption>((run) => {
    const { phases, agentsDone, agentsTotal } = orchestrationCounts(run);
    const tally = `${agentsDone}/${agentsTotal} agents`;
    return {
      key: viewKey({ kind: "workflow", taskId: run.taskId }),
      id: { kind: "workflow", taskId: run.taskId },
      label: run.name ?? "Workflow",
      detail: phases > 0 ? `${phases} phases · ${tally}` : tally,
      running: run.status === "running",
      startedAt: run.startedAt,
      elapsedMs: span(run.startedAt, run.endedAt),
    };
  });

  const rest = [...subs, ...runs].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  return [main, ...rest];
}

/** The sub-agent block a `subagent` view names, or `null` if it has gone. */
export function findSubagent(state: ConversationState, id: string): ConvToolBlock | null {
  return subagentBlocks(state).find((b) => b.id === id) ?? null;
}

/** The run a `workflow` view names, or `null` if it has gone. */
export function findOrchestration(
  state: ConversationState,
  taskId: string,
): OrchestrationRun | null {
  return state.orchestrations.find((r) => r.taskId === taskId) ?? null;
}

/**
 * Resolves the *effective* view: the selection, unless whatever it named is no
 * longer in the state, in which case the transcript.
 *
 * A pane can be looking at a sub-agent when `/clear` empties the transcript,
 * or at an orchestration on a session that restarts. Falling back here — one
 * place, derived on every render — is what stops the pane rendering an empty
 * panel for something that no longer exists.
 */
export function resolveView(state: ConversationState, selected: AgentViewId): AgentViewId {
  if (selected.kind === "subagent" && findSubagent(state, selected.id) === null) return MAIN_VIEW;
  if (selected.kind === "workflow" && findOrchestration(state, selected.taskId) === null) {
    return MAIN_VIEW;
  }
  return selected;
}
