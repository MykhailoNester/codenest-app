import { describe, it, expect } from "vitest";
import { slashRowToSuggest, mentionRowToSuggest } from "../composer-menu";
import { findCommand, type SlashRow } from "../composer-commands";
import type { MentionRow } from "../composer-mentions";

describe("slashRowToSuggest", () => {
  it("labels a command row `/name` and its meta the summary", () => {
    const model = findCommand("model");
    if (!model) throw new Error("model command missing from registry");
    const row: SlashRow = { kind: "command", command: model };
    expect(slashRowToSuggest(row, 0)).toEqual({
      key: "command-model",
      group: null,
      label: "/model",
      meta: model.summary,
    });
  });

  it("labels an arg row by the option value and its meta the label", () => {
    const model = findCommand("model");
    if (!model) throw new Error("model command missing from registry");
    const row: SlashRow = {
      kind: "arg",
      command: model,
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
