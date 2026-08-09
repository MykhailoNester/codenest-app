/**
 * Shared shapes between the Work Board page and the `taskboard/` component
 * set. Kept out of `pages/tasks.tsx` so a component never has to import a
 * type from a page (a type-only cycle that would erase, but inverts the
 * intended dependency direction for no gain).
 */

/** Per-card / per-picker vocabulary resolved from the live taxonomy lookups. */
export interface TaskBoardVocab {
  priorityColors: Record<string, string>;
  priorityLabels: Record<string, string>;
  statusLabels: Record<string, string>;
  /** slug -> index in the active ordered task_priority vocabulary. */
  priorityRank: Record<string, number>;
  /** Length of that vocabulary; 0 when lookups have not resolved yet. */
  priorityCount: number;
}

/** One selectable row in a `ChipPicker` / filter-bar picker. */
export interface ChipOption {
  /** "" means "none / clear". */
  value: string;
  label: string;
  color?: string | null;
  /** Section heading, e.g. "Humans" / "Agents". Rendered in first-appearance order. */
  group?: string;
  /** Explanatory line rendered under the option (`.tb-pop__hint`). */
  hint?: string;
}

/** One board column: a task-status taxonomy row, resolved with a fallback. */
export interface BoardColumnDef {
  /** task-status slug */
  id: string;
  label: string;
  color: string;
}
