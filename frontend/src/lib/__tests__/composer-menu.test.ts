import { describe, it, expect } from "vitest";
import { slashRowToSuggest, mentionRowToSuggest } from "../composer-menu";
import { findCommand, type SlashRow } from "../composer-commands";
import type { MentionRow } from "../composer-mentions";

describe("slashRowToSuggest", () => {
  it("labels a command row `/name` and its meta the summary", () => {
    const compact = findCommand("compact");
    if (!compact) throw new Error("compact command missing from registry");
    const row: SlashRow = { kind: "command", command: compact };
    expect(slashRowToSuggest(row, 0)).toEqual({
      key: "command-compact",
      group: null,
      label: "/compact",
      meta: compact.summary,
    });
  });

  // No registered command declares a `complete` callback since `/model` and
  // `/mode` were removed, so the row is built by hand: this pins the mapping
  // for whichever command reintroduces argument completion.
  it("labels an arg row by the option value and its meta the label", () => {
    const compact = findCommand("compact");
    if (!compact) throw new Error("compact command missing from registry");
    const row: SlashRow = {
      kind: "arg",
      command: compact,
      option: { value: "claude-opus-4-6", label: "Opus 4.6" },
    };
    const suggest = slashRowToSuggest(row, 0);
    expect(suggest.label).toBe("claude-opus-4-6");
    expect(suggest.meta).toBe("Opus 4.6");
  });
});

describe("mentionRowToSuggest", () => {
  it("puts the group header only on the first row of each kind", () => {
    const rows: MentionRow[] = [
      { kind: "agent", label: "Alice", meta: "ops", insertText: "@agent-alice" },
      { kind: "agent", label: "Bob", meta: "ops", insertText: "@agent-bob" },
      { kind: "task", label: "Fix it", meta: "#1 · todo", taskId: 1, title: "Fix it", description: null },
      {
        kind: "library",
        label: "Notes",
        meta: "notes",
        slug: "notes",
        title: "Notes",
        body: "…",
      },
    ];

    const suggested = rows.map((_row, i) => mentionRowToSuggest(rows, i));

    expect(suggested.map((s) => s.group)).toEqual(["agents", null, "tasks", "snippets"]);
    expect(suggested.map((s) => s.label)).toEqual(["Alice", "Bob", "Fix it", "Notes"]);
  });
});
