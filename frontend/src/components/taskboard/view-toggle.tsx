import type { ReactElement } from "react";

export type ViewMode = "board" | "list";

export interface ViewToggleProps {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
}

/** First-class `tb-seg` segmented control, replacing the hand-rolled toggle. */
export function ViewToggle({ mode, onChange }: ViewToggleProps): ReactElement {
  return (
    <div className="tb-seg" role="tablist" aria-label="View">
      <button
        type="button"
        role="tab"
        aria-selected={mode === "board"}
        className={`tb-seg__btn${mode === "board" ? " tb-seg__btn--on" : ""}`}
        onClick={() => onChange("board")}
      >
        Board
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === "list"}
        className={`tb-seg__btn${mode === "list" ? " tb-seg__btn--on" : ""}`}
        onClick={() => onChange("list")}
      >
        List
      </button>
    </div>
  );
}
