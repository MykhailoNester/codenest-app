/**
 * The presentational row shape shared by the slash and mention menus, and
 * the two adapters that map a `SlashRow` / `MentionRow` onto it. A `.ts`
 * module because `composer-suggest.tsx` may export components only
 * (`react-refresh/only-export-components` is an error in this repo's eslint
 * config) and the parent needs to name the type.
 */

import type { SlashRow } from "./composer-commands";
import type { MentionRow } from "./composer-mentions";

export interface SuggestRow {
  key: string;
  /** Group header rendered above this row, or null to continue the previous group. */
  group: string | null;
  label: string;
  meta: string;
}

/** A command row's label is `/name`, its meta the summary; an arg row's
 *  label is the option value, its meta the label. */
export function slashRowToSuggest(row: SlashRow, index: number): SuggestRow {
  if (row.kind === "command") {
    return {
      key: `command-${row.command.name}`,
      group: null,
      label: `/${row.command.name}`,
      meta: row.command.summary,
    };
  }
  return {
    key: `arg-${index}-${row.option.value}`,
    group: null,
    label: row.option.value,
    meta: row.option.label,
  };
}

const MENTION_GROUP: Record<MentionRow["kind"], string> = {
  agent: "agents",
  task: "tasks",
  library: "snippets",
  "library-ref": "snippets",
};

/**
 * `rows` is the whole ordered mention-row list — agents, then tasks, then
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
    case "task":
      return { key: `task-${row.taskId}`, group, label: row.label, meta: row.meta };
    case "library":
      return { key: `library-${row.slug}`, group, label: row.label, meta: row.meta };
    case "library-ref":
      return { key: `library-ref-${row.slug}`, group, label: row.label, meta: row.meta };
  }
}
