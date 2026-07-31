/**
 * Which window this bundle is running in.
 *
 * The detached terminals window and the screenshot ring share the main bundle
 * and are routed by hash fragment, so the fragment is the only thing that tells
 * them apart. Centralised here because the answer decides more than routing: a
 * pane launched in the detached window must be recorded with
 * `target: "popout"`, or the Command Center's Focus action would look for it in
 * the main window's tab list and find nothing.
 */

export const TERMINALS_WINDOW_HASH = "#/window/terminals";
export const SCREENSHOT_RING_WINDOW_HASH = "#/window/screenshot-ring";

function hash(): string {
  return typeof window === "undefined" ? "" : window.location.hash;
}

/** True inside the detached terminals window (`TerminalWindowRoot`). */
export function isTerminalsWindow(): boolean {
  return hash() === TERMINALS_WINDOW_HASH;
}

/** True inside the screenshot-ring window. */
export function isScreenshotRingWindow(): boolean {
  return hash() === SCREENSHOT_RING_WINDOW_HASH;
}

/**
 * The `agent_runs.target` value for a pane created in this window — what tells
 * the Command Center whether to raise the detached window or activate a tab in
 * the main one.
 */
export function currentPaneTarget(): "embedded" | "popout" {
  return isTerminalsWindow() ? "popout" : "embedded";
}
