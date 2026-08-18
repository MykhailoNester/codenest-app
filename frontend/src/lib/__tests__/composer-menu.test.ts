import { describe, it, expect } from "vitest";
import { slashRowToSuggest, mentionRowToSuggest } from "../composer-menu";
import {
  buildSlashRows,
  findCommand,
  projectCommand,
  type SlashRow,
} from "../composer-commands";
import type { MentionRow } from "../composer-mentions";

function builtin(name: string) {
  const command = findCommand(name, []);
  if (!command) throw new Error(`${name} command missing from registry`);
  return command;
}

describe("slashRowToSuggest", () => {
  it("labels a command row `/name` and its meta the summary", () => {
    const compact = builtin("compact");
    const rows: SlashRow[] = [{ kind: "command", command: compact }];
    expect(slashRowToSuggest(rows, 0)).toEqual({
      key: "command-compact",
      group: "commands",
      label: "/compact",
      meta: compact.summary,
    });
  });

  // No *built-in* declares a `complete` callback since `/model` and `/mode`
  // were removed; a discovered command with an `argument-hint` does, and this
  // pins the mapping for both.
  it("labels an arg row by the option value and its meta the label", () => {
    const compact = builtin("compact");
    const rows: SlashRow[] = [
      {
        kind: "arg",
        command: compact,
        option: { value: "claude-opus-4-6", label: "Opus 4.6" },
      },
    ];
    const suggest = slashRowToSuggest(rows, 0);
    expect(suggest.label).toBe("claude-opus-4-6");
    expect(suggest.meta).toBe("Opus 4.6");
    // An arg row is never mixed with command rows, so it carries no header.
    expect(suggest.group).toBeNull();
  });

  it("puts one header on each of the two groups, and only on its first row", () => {
    const rows = buildSlashRows("", {
      live: true,
      commands: [
        {
          name: "ship",
          label: "codenest-app:ship",
          insertText: "/ship",
          projectName: "codenest-app",
          description: "Autonomous delivery pipeline.",
          argHint: "<#24>",
        },
        {
          name: "commit-message",
          label: "codenest-app:commit-message",
          insertText: "/commit-message",
          projectName: "codenest-app",
          description: null,
          argHint: null,
        },
      ],
    });
    expect(rows.map((_row, i) => slashRowToSuggest(rows, i))).toEqual([
      { key: "command-clear", group: "commands", label: "/clear", meta: builtin("clear").summary },
      { key: "command-compact", group: null, label: "/compact", meta: builtin("compact").summary },
      { key: "command-help", group: null, label: "/help", meta: builtin("help").summary },
      {
        key: "command-ship",
        group: "project commands",
        label: "/ship",
        meta: "Autonomous delivery pipeline.",
      },
      {
        key: "command-commit-message",
        group: null,
        label: "/commit-message",
        // No description in the file, so the row says where it came from.
        meta: "command from codenest-app",
      },
    ]);
  });

  it("clips a paragraph-long description to one row's worth", () => {
    const command = projectCommand({
      name: "ship",
      label: "codenest-app:ship",
      insertText: "/ship",
      projectName: "codenest-app",
      description: "x".repeat(200),
      argHint: null,
    });
    const meta = slashRowToSuggest([{ kind: "command", command }], 0).meta;
    expect(meta).toHaveLength(72);
    expect(meta.endsWith("…")).toBe(true);
  });
});

describe("mentionRowToSuggest", () => {
  it("puts the group header only on the first row of each kind", () => {
    const rows: MentionRow[] = [
      { kind: "agent", label: "Alice", meta: "ops", insertText: "@agent-alice" },
      { kind: "agent", label: "Bob", meta: "ops", insertText: "@agent-bob" },
      {
        kind: "skill",
        label: "miragold:frontend-design",
        meta: "miragold",
        insertText: "/frontend-design",
        name: "frontend-design",
      },
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

    expect(suggested.map((s) => s.group)).toEqual([
      "agents",
      null,
      "skills",
      "tasks",
      "snippets",
    ]);
    expect(suggested.map((s) => s.label)).toEqual([
      "Alice",
      "Bob",
      "miragold:frontend-design",
      "Fix it",
      "Notes",
    ]);
  });
});
