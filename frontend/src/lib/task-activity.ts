/**
 * Honest derivation layer for the task detail Activity tab.
 *
 * Every phrase below is justified by exactly what `task_service` writes
 * into `activity_log.old_value` / `.new_value` — nothing here guesses at a
 * sentence for a value the sidecar never sends. `TASK_ACTIVITY_ACTIONS` is
 * pinned against the sidecar by `app/tests/test_task_activity_actions.py`
 * (an AST walk over `app/services/*.py`), so a newly logged `task` action
 * with no phrase added here fails that test rather than silently rendering
 * a guessed sentence — a wrong sentence about an audit trail is worse than
 * a terse one (see the plan's design decision 7).
 */
import type { ActivityEntry } from "./api"; // type-only: erased, no cycle
import { parseUtcMs } from "./format-helpers";

export const TASK_ACTIVITY_ACTIONS = [
  "created",
  "status_changed",
  "deleted",
  "blocker_added",
  "label_added",
  "label_removed",
  "labels_set",
] as const;

export type TaskActivityAction = (typeof TASK_ACTIVITY_ACTIONS)[number];

function isTaskActivityAction(action: string): action is TaskActivityAction {
  return (TASK_ACTIVITY_ACTIONS as readonly string[]).includes(action);
}

export interface TaskActivityVocab {
  /** status slug -> display label, from `lookups.workflow_task_statuses`. */
  statusLabels?: Readonly<Record<string, string>>;
}

/** "in-progress" -> "In progress". A reformat of the stored slug, never an
 * invented label — used only when the slug isn't in the caller's vocab. */
export function humanizeSlug(slug: string): string {
  const spaced = slug.replace(/[-_]+/g, " ").trim();
  if (spaced === "") return slug;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function statusLabel(slug: string, vocab: TaskActivityVocab | undefined): string {
  const known = vocab?.statusLabels?.[slug];
  return known ?? humanizeSlug(slug);
}

type ActivityValues = Pick<ActivityEntry, "action" | "old_value" | "new_value">;

/**
 * Maps `action` + `old_value`/`new_value` to a phrase, or returns the raw
 * `action` verbatim when the action is unmapped, or mapped but missing the
 * value it needs. One rule, not two (design decision 7) — never throws.
 */
export function taskActivityPhrase(
  entry: ActivityValues,
  vocab?: TaskActivityVocab,
): string {
  const { action, old_value: oldValue, new_value: newValue } = entry;
  if (!isTaskActivityAction(action)) return action;

  switch (action) {
    case "created":
      return "created this task";
    case "deleted":
      return "deleted this task";
    case "status_changed":
      if (newValue == null) return action;
      return `moved this task to ${statusLabel(newValue, vocab)}`;
    case "blocker_added":
      if (newValue == null) return action;
      return `added blocker #${newValue}`;
    case "label_added":
      if (newValue == null) return action;
      return `added label "${newValue}"`;
    case "label_removed":
      if (oldValue == null) return action;
      return `removed label "${oldValue}"`;
    case "labels_set":
      if (newValue == null) return action;
      if (newValue === "") return "cleared all labels";
      return `set labels to ${newValue.split(",").join(", ")}`;
  }
}

const GLYPHS: Record<TaskActivityAction, string> = {
  created: "+",
  status_changed: "→",
  deleted: "×",
  blocker_added: "!",
  label_added: "#",
  label_removed: "#",
  labels_set: "#",
};

/** Plain glyphs only (`task-detail.tsx` already uses ←, ✓, — elsewhere) —
 * no emoji. Unknown action -> a neutral bullet. */
export function taskActivityGlyph(action: string): string {
  if (!isTaskActivityAction(action)) return "•";
  return GLYPHS[action];
}

/** Naive-UTC `created_at` -> epoch millis, read as UTC (the sidecar sends no
 * trailing "Z"). Re-exported name for readability at call sites. */
export function activityStampMs(iso: string): number {
  return parseUtcMs(iso);
}

export const ACTIVITY_STAMP_OPTIONS: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

/** Renders a naive-UTC sidecar stamp in the viewer's local time. */
export function formatActivityStamp(iso: string): string {
  return new Date(activityStampMs(iso)).toLocaleString(
    undefined,
    ACTIVITY_STAMP_OPTIONS,
  );
}

/** Null/blank actor -> the literal "Someone" — never a fabricated identity
 * (never the assignee, never "system" substituted in). Any other actor,
 * including the cascade's "cascade from task #N", renders verbatim. */
export function activityActorName(actor: string | null): string {
  const trimmed = actor?.trim();
  return trimmed ? trimmed : "Someone";
}
