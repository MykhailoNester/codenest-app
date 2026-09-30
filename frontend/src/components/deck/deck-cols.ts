import type { DeckState } from "./deck-grid";

/** Column templates, so a list's shape is named rather than inlined. */
export const DECK_COLS = {
  default: "14px minmax(0, 1fr) 110px 150px 62px 96px",
  tasks: "14px 50px minmax(0, 1fr) 100px 118px 52px 80px",
  simple: "14px minmax(0, 1fr) 90px",
  wide: "14px minmax(0, 1fr) 118px 68px 80px 90px",
  /** The navigator tree: state, indented name, whatever the row trails with. */
  tree: "14px minmax(0, 1fr) auto",
} as const;

/** Task status slug → the ramp. Anything unknown stays inert rather than guessing. */
export function taskState(status: string): DeckState {
  switch (status) {
    case "blocked":
      return "block";
    case "in-progress":
      return "run";
    case "todo":
      return "todo";
    case "done":
      return "done";
    default:
      return "idle";
  }
}

export const COLS_TASK = "14px 54px minmax(0, 1fr) 150px 120px 90px auto";
