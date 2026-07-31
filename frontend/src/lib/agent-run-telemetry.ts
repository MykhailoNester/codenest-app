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
import { isTauriAvailable, listLivePanes } from "./ipc";

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
 *
 * `sessionId` names *which* run ended. A pane keeps its id across a restart, so
 * without it a report about the session that just ended could also end the
 * replacement started moments later — these calls are fire-and-forget and
 * therefore unordered. Pass it whenever it is known; the PTY path's
 * `pty-exited` event carries no session id and correctly omits it.
 */
export function recordAgentExited(
  paneId: string,
  exitCode: number | null,
  sessionId?: string | null,
): void {
  void recordAgentExitedAndWait(paneId, exitCode, sessionId);
}

/**
 * `recordAgentExited`, but awaitable — for the one caller that cannot afford
 * fire-and-forget: a window handling its own close must get the report out
 * before the webview (and with it the pending fetch) is torn down. Never
 * rejects, so it is safe inside a `Promise.allSettled` on a teardown path.
 */
export async function recordAgentExitedAndWait(
  paneId: string,
  exitCode: number | null,
  sessionId?: string | null,
): Promise<void> {
  try {
    await fetchSidecar("/api/v1/agents/runs/exited", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        exit_code: exitCode,
        ...(sessionId ? { session_id: sessionId } : {}),
      }),
    });
  } catch {
    // Telemetry never surfaces as a failure — see the module doc.
  }
}

/**
 * End every `running` run whose pane the shell no longer has a child for.
 *
 * The self-heal for the leak the per-event reports cannot cover. `recordAgentExited`
 * is a fetch from the webview that noticed the death, so it is lost exactly when
 * that webview is going away — closing a popout window kills its panes and then
 * tears down the page that was going to report them — and equally when the app
 * quits, when it crashes, or when the sidecar happens to be unreachable. The row
 * then claims a session is live forever, with a Focus and a Stop that act on
 * nothing.
 *
 * Resolves to the number of rows ended, or `null` when the sweep could not run
 * (no Tauri backend, or an unreachable sidecar). Callers treat `null` as "no
 * information", never as "nothing was stale".
 */
export async function reconcileAgentRuns(): Promise<number | null> {
  if (!isTauriAvailable()) return null;
  try {
    const livePaneIds = await listLivePanes();
    const result = await fetchSidecar<{ ended: number }>(
      "/api/v1/agents/runs/reconcile",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ live_pane_ids: livePaneIds }),
      },
    );
    return result.ended;
  } catch {
    return null;
  }
}
