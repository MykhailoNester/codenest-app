/**
 * Which window this bundle is running in.
 *
 * The detached terminals window shares the main bundle and is routed by hash
 * fragment, so the fragment is the only thing that tells it apart. Centralised
 * here because the answer decides more than routing: a pane launched in the
 * detached window must be recorded with `target: "popout"`, or the Command
 * Center's Focus action would look for it in the main window's tab list and
 * find nothing.
 */

export const TERMINALS_WINDOW_HASH = "#/window/terminals";

function hash(): string {
  return typeof window === "undefined" ? "" : window.location.hash;
}

/** True inside the detached terminals window (`TerminalWindowRoot`). */
export function isTerminalsWindow(): boolean {
  return hash() === TERMINALS_WINDOW_HASH;
}

/**
 * The `agent_runs.target` value for a pane created in this window — what tells
 * the Command Center whether to raise the detached window or activate a tab in
 * the main one.
 */
export function currentPaneTarget(): "embedded" | "popout" {
  return isTerminalsWindow() ? "popout" : "embedded";
}
