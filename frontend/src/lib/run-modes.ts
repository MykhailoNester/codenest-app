import type { RunMode } from "./api";

export interface RunModeOption {
  value: RunMode;
  label: string;
}

/**
 * The run modes a schedule may be set to.
 *
 * `windowed` is deliberately absent. The Rust shell reads `run_mode` off the
 * dispatch payload and never branches on it — every scheduled run spawns
 * headless `claude --print` with piped stdio, so picking "Windowed" produced a
 * toast and an otherwise identical headless run. Launching a real in-app pane
 * is a cross-layer feature (an interactive process does not exit on its own,
 * so the run lifecycle, the token/cost source and the pane plumbing all differ)
 * and has its own ticket; until it lands the picker must not offer it.
 */
const BACKGROUND_OPTION: RunModeOption = {
  value: "background",
  label: "Background (headless)",
};

/**
 * Options to render for a schedule currently set to `current`.
 *
 * A schedule saved as `windowed` before the option was withdrawn keeps its
 * value and is shown it, labelled with what it actually does, so editing such a
 * schedule neither hides its state nor silently rewrites it. New schedules can
 * only choose `background`.
 */
export function runModeOptions(current: RunMode): RunModeOption[] {
  if (current === "windowed") {
    return [
      BACKGROUND_OPTION,
      {
        value: "windowed",
        label: "Windowed — not built yet, runs headless",
      },
    ];
  }
  return [BACKGROUND_OPTION];
}
