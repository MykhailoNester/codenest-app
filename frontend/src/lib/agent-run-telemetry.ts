/**
 * The two `agent_runs` writes every launched agent produces, in one place.
 *
 * A run row is what the Command Center's AGENTS panel lists, and what its
 * Focus/Stop actions act on — so a pane that never posts here is invisible
 * there no matter how alive it is. Both surfaces that own panes report through
 * this module:
 *
 * * PTY provider panes (`stores/terminal-store.ts`'s `applyGridLayout`), whose
 *   pane id is the PTY handle and whose liveness sink is `pty-exited`.
 * * Agent panes (`components/terminal/agent-pane.tsx`), whose pane id is the
 *   leaf id and which have no PTY at all — their liveness comes from the
 *   session's own `exit` frame.
 *
 * Both calls are fire-and-forget by design: telemetry must never delay a launch
 * or block a teardown, and a sidecar that is still starting (or already gone)
 * must not turn either into a visible failure.
 */

import { fetchSidecar } from "./api";

/** Where the pane lives — mirrors `agent_runs.target`. */
export type PaneTarget = "embedded" | "popout";

export interface AgentLaunchPayload {
  /** PTY handle id for a provider pane, leaf id for an agent pane. */
  pane_id: string;
  /** `providers.id`, or a provider name the sidecar resolves. */
  provider?: number | string | null;
  /** The CLI session UUID, so Claude hooks enrich the right run. */
  session_id?: string | null;
  project_id?: number | null;
  /**
   * The pane's working directory. The sidecar resolves it to a project when no
   * `project_id` is supplied — an agent pane has a cwd but no project lookup.
   */
  cwd?: string | null;
  model?: string | null;
  target?: PaneTarget;
  prompt_preview?: string | null;
  source_kind?: string | null;
  source_id?: number | null;
  profile?: string | null;
  fanout_role?: "primary" | "secondary" | null;
  rows?: number;
  cols?: number;
  leaf_index?: number;
}

/**
 * Record a launched agent as a running `agent_runs` row.
 *
 * Also publishes the SSE `launch` message the Live Activity ticker renders, so
 * skipping this call costs a pane both its Command Center row and its ticker
 * entry.
 */
export function recordAgentLaunch(payload: AgentLaunchPayload): void {
  void fetchSidecar("/api/v1/agents/events/launch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => undefined);
}

/**
 * Transition a pane's running run row to `ended`.
 *
 * Idempotent at the sidecar (`mark_ended_by_pane` only touches rows that are
 * still `running`), which is what lets every path that can end a session report
 * without coordinating: the `exit` frame, an explicit teardown, and `pty-exited`
 * may all fire for the same pane.
 */
export function recordAgentExited(
  paneId: string,
  exitCode: number | null,
): void {
  void fetchSidecar("/api/v1/agents/runs/exited", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pane_id: paneId, exit_code: exitCode }),
  }).catch(() => undefined);
}
