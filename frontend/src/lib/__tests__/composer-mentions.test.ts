import { describe, it, expect } from "vitest";
import {
  buildMentionRows,
  agentMentionSlug,
  replaceRange,
  type MentionSources,
} from "../composer-mentions";

function sources(over: Partial<MentionSources> = {}): MentionSources {
  return { agents: [], tasks: [], library: [], ...over };
}

describe("buildMentionRows", () => {
  it("requires at least one character after the `@`", () => {
    expect(buildMentionRows(sources(), "")).toEqual([]);
  });

  it("matches an agent by name and a task by title, grouped agents then tasks then library", () => {
    const s = sources({
      agents: [{ name: "Alice Ops", role: "ops", agentFile: null }],
      tasks: [{ id: 1, title: "Fix aliasing bug", status: "todo", description: null }],
      library: [{ slug: "aliasing-notes", title: "Notes", body: "…" }],
    });
    const rows = buildMentionRows(s, "ali");
    expect(rows.map((r) => r.kind)).toEqual(["agent", "task", "library"]);
  });

  it("caps each group at 5 and the total at 12", () => {
    const agents = Array.from({ length: 8 }, (_, i) => ({
      name: `Ali ${i}`,
      role: "ops",
      agentFile: null,
    }));
    const tasks = Array.from({ length: 8 }, (_, i) => ({
      id: i,
      title: `Ali task ${i}`,
      status: "todo",
      description: null,
    }));
    const library = Array.from({ length: 8 }, (_, i) => ({
      slug: `ali-${i}`,
      title: `Ali doc ${i}`,
      body: "…",
    }));
    const rows = buildMentionRows(sources({ agents, tasks, library }), "ali");
    expect(rows.filter((r) => r.kind === "agent")).toHaveLength(5);
    expect(rows.filter((r) => r.kind === "task")).toHaveLength(5);
    expect(rows).toHaveLength(12);
  });

  it("orders tasks in-progress, blocked, todo, backlog and excludes done", () => {
    const tasks = [
      { id: 1, title: "todo one", status: "todo", description: null },
      { id: 2, title: "in progress one", status: "in-progress", description: null },
      { id: 3, title: "done one", status: "done", description: null },
      { id: 4, title: "blocked one", status: "blocked", description: null },
      { id: 5, title: "backlog one", status: "backlog", description: null },
    ];
    const rows = buildMentionRows(sources({ tasks }), "one");
    const titles = rows.filter((r) => r.kind === "task").map((r) => r.title);
    expect(titles).toEqual(["in progress one", "blocked one", "todo one", "backlog one"]);
  });

  it("matches a task by number, with or without the hash", () => {
    const tasks = [{ id: 4, title: "Ship the migration", status: "todo", description: null }];
    expect(buildMentionRows(sources({ tasks }), "#4").filter((r) => r.kind === "task")).toHaveLength(1);
    expect(buildMentionRows(sources({ tasks }), "4").filter((r) => r.kind === "task")).toHaveLength(1);
  });

  it("restricts to library rows for a `library:` query", () => {
    const s = sources({
      agents: [{ name: "api helper", role: "ops", agentFile: null }],
      tasks: [{ id: 1, title: "api work", status: "todo", description: null }],
      library: [{ slug: "api-notes", title: "API notes", body: "…" }],
    });
    const rows = buildMentionRows(s, "library:api");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("library");
  });

  it("offers a library-ref row for a valid slug with no local match", () => {
    const rows = buildMentionRows(sources(), "library:missing-one");
    expect(rows).toEqual([
      { kind: "library-ref", label: "@library:missing-one", meta: "fetch by slug", slug: "missing-one" },
    ]);
  });

  it("offers nothing for an invalid slug", () => {
    expect(buildMentionRows(sources(), "library:Bad!")).toEqual([]);
  });
});

describe("agentMentionSlug", () => {
  it("uses the agent-file stem when there is one", () => {
    expect(
      agentMentionSlug({ name: "Orion Ops", role: "ops", agentFile: "/w/.claude/agents/orion-ops.md" }),
    ).toBe("orion-ops");
  });

  it("slugifies the name when there is no agent file", () => {
    expect(agentMentionSlug({ name: "Vega Research", role: "ops", agentFile: null })).toBe(
      "vega-research",
    );
  });

  it("is empty for a name that is all punctuation", () => {
    expect(agentMentionSlug({ name: "!!!", role: "ops", agentFile: null })).toBe("");
  });

  it("drops an agent whose name slugifies to nothing, rather than inserting a bare @agent-", () => {
    const s = sources({ agents: [{ name: "!!!", role: "ops", agentFile: null }] });
    expect(buildMentionRows(s, "!!!")).toEqual([]);
  });
});

describe("replaceRange", () => {
  it("adds exactly one trailing space on insertion, never doubling one", () => {
    const noNextSpace = replaceRange("hi @a", 3, 5, "@agent-orion-ops");
    expect(noNextSpace).toEqual({ text: "hi @agent-orion-ops ", caret: 20 });

    const alreadySpaced = replaceRange("hi @a x", 3, 5, "@agent-orion-ops");
    expect(alreadySpaced.text).toBe("hi @agent-orion-ops x");
  });

  it("deletes the token with no double space left behind", () => {
    const result = replaceRange("hi @ali there", 3, 7, "");
    expect(result.text).toBe("hi there");
    expect(result.caret).toBe(3);
  });
});
