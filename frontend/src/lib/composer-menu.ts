/**
 * The presentational row shape shared by the slash and mention menus, and
 * the two adapters that map a `SlashRow` / `MentionRow` onto it. Both clip their
 * meta through `clipMeta`: `.suggestMeta` is `flex: 0 0 auto` with no ellipsis,
 * so a paragraph-long description would squeeze the label out of the panel
 * rather than truncate itself. A `.ts`
 * module because `composer-suggest.tsx` may export components only
 * (`react-refresh/only-export-components` is an error in this repo's eslint
 * config) and the parent needs to name the type.
 */

import type { SlashRow } from "./composer-commands";
import { clipMeta, type MentionRow } from "./composer-mentions";

export interface SuggestRow {
  key: string;
  /** Group header rendered above this row, or null to continue the previous group. */
  group: string | null;
  label: string;
  meta: string;
}

const SLASH_GROUP: Record<"builtin" | "project", string> = {
  builtin: "commands",
  project: "project commands",
};

/**
 * A command row's label is `/name`, its meta the summary; an arg row's label is
 * the option value, its meta the label.
 *
 * Takes the whole ordered row list, like `mentionRowToSuggest` and for the same
 * reason: `buildSlashRows` keeps the built-in and discovered runs contiguous
 * (`matchCommands`), so the header goes on the first row of each run — and a
 * single row carries no information about whether it is the first of its kind.
 *
 * The label stays the `/name` form for a discovered command rather than the
 * catalog's `project:name` alias: in a slash menu the label is the text being
 * typed and matched, and the resolved stem already carries the project's slug
 * whenever two projects contest one name. Provenance rides on the meta, which
 * falls back to the owning project when the file declares no description.
 */
export function slashRowToSuggest(
  rows: readonly SlashRow[],
  index: number,
): SuggestRow {
  const row = rows[index];
  if (!row) return { key: `slash-${index}`, group: null, label: "", meta: "" };
  if (row.kind === "command") {
    const previous = rows[index - 1];
    const group =
      previous?.kind === "command" && previous.command.origin === row.command.origin
        ? null
        : SLASH_GROUP[row.command.origin];
    return {
      key: `command-${row.command.name}`,
      group,
      label: `/${row.command.name}`,
      meta: clipMeta(row.command.summary),
    };
  }
  // An arg row is never mixed with command rows (`buildSlashRows` returns one
  // kind or the other), so it needs no header of its own.
  return {
    key: `arg-${index}-${row.option.value}`,
    group: null,
    label: row.option.value,
    meta: clipMeta(row.option.label),
  };
}

const MENTION_GROUP: Record<MentionRow["kind"], string> = {
  agent: "agents",
  skill: "skills",
  task: "tasks",
  library: "snippets",
  "library-ref": "snippets",
};

/**
 * `rows` is the whole ordered mention-row list — agents, skills, tasks, then
 * library, always grouped contiguously (`buildMentionRows`) — so the header
 * can be placed on the first row of each run and omitted on the rest. Takes
 * the array rather than a single row (a deliberate, documented departure
 * from the plan's two-argument sketch): a single row carries no information
 * about whether it is the first of its kind.
 */
export function mentionRowToSuggest(
  rows: readonly MentionRow[],
  index: number,
): SuggestRow {
  const row = rows[index];
  if (!row) return { key: `mention-${index}`, group: null, label: "", meta: "" };
  const previous = rows[index - 1];
  const group = previous?.kind === row.kind ? null : MENTION_GROUP[row.kind];
  switch (row.kind) {
    case "agent":
      return { key: `agent-${row.insertText}`, group, label: row.label, meta: row.meta };
    case "skill":
      return { key: `skill-${row.insertText}`, group, label: row.label, meta: row.meta };
    case "task":
      return { key: `task-${row.taskId}`, group, label: row.label, meta: row.meta };
    case "library":
      return { key: `library-${row.slug}`, group, label: row.label, meta: row.meta };
    case "library-ref":
      return { key: `library-ref-${row.slug}`, group, label: row.label, meta: row.meta };
  }
}
