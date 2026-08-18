import { describe, it, expect } from "vitest";
import {
  buildMentionRows,
  invocableMeta,
  replaceRange,
  type InvocableSource,
  type MentionSources,
} from "../composer-mentions";

function sources(over: Partial<MentionSources> = {}): MentionSources {
  return { agents: [], skills: [], tasks: [], library: [], ...over };
}

/** A catalog row as the probe projects it — the token is given, never derived. */
function invocable(over: Partial<InvocableSource> & { name: string }): InvocableSource {
  return {
    label: over.name,
    insertText: `@agent-${over.name}`,
    projectName: null,
    description: null,
    ...over,
  };
}

function agent(name: string, project?: string): InvocableSource {
  return invocable({
    name,
    label: project ? `${project}:${name}` : name,
    insertText: `@agent-${name}`,
    projectName: project ?? null,
  });
}

function skill(name: string, project?: string): InvocableSource {
  return invocable({
    name,
    label: project ? `${project}:${name}` : name,
    insertText: `/${name}`,
    projectName: project ?? null,
  });
}

describe("buildMentionRows", () => {
  it("requires at least one character after the `@`", () => {
    expect(buildMentionRows(sources(), "")).toEqual([]);
  });

  it("groups agents, then skills, then tasks, then library", () => {
    const s = sources({
      agents: [agent("aliasing-agent")],
      skills: [skill("aliasing-skill")],
      tasks: [{ id: 1, title: "Fix aliasing bug", status: "todo", description: null }],
      library: [{ slug: "aliasing-notes", title: "Notes", body: "…" }],
    });
    expect(buildMentionRows(s, "alias").map((r) => r.kind)).toEqual([
      "agent",
      "skill",
      "task",
      "library",
    ]);
  });

  it("inserts the catalog's own token, including a materialized alias", () => {
    const s = sources({
      agents: [
        {
          name: "miragold--code-reviewer",
          label: "miragold:code-reviewer",
          insertText: "@agent-miragold--code-reviewer",
          projectName: "miragold",
          description: null,
        },
      ],
    });
    const [row] = buildMentionRows(s, "code-rev");
    expect(row).toEqual({
      kind: "agent",
      label: "miragold:code-reviewer",
      meta: "miragold",
      insertText: "@agent-miragold--code-reviewer",
    });
  });

  it("distinguishes each project's variant of one duplicated name", () => {
    const s = sources({
      agents: [
        agent("codenest-app--code-reviewer", "codenest-app"),
        agent("networa--code-reviewer", "Networa"),
        agent("miragold--code-reviewer", "miragold"),
      ],
    });
    const rows = buildMentionRows(s, "code-rev");
    expect(rows.map((r) => r.kind === "agent" && r.insertText)).toEqual([
      "@agent-codenest-app--code-reviewer",
      "@agent-networa--code-reviewer",
      "@agent-miragold--code-reviewer",
    ]);
  });

  it("ranks a name prefix above a name substring above a project match", () => {
    const s = sources({
      agents: [
        agent("test-engineer", "miragold"),
        agent("planner", "debug-tools"),
        agent("api-debugger", "miragold"),
        agent("debugger", "miragold"),
      ],
    });
    expect(buildMentionRows(s, "debug").map((r) => r.label)).toEqual([
      "miragold:debugger",
      "miragold:api-debugger",
      "debug-tools:planner",
    ]);
  });

  it("narrows to a project by name, because the label carries it", () => {
    const s = sources({
      agents: [agent("debugger", "miragold"), agent("coder-agent", "codenest-app")],
    });
    expect(buildMentionRows(s, "mira").map((r) => r.label)).toEqual([
      "miragold:debugger",
    ]);
  });

  it("does not match on the description — every needle would hit one", () => {
    const s = sources({
      agents: [
        invocable({
          name: "planner",
          description: "Use when you need to debug a failing build",
        }),
      ],
    });
    expect(buildMentionRows(s, "debug")).toEqual([]);
  });

  it("caps each group at 8 and the total at 20", () => {
    const many = (make: (n: string) => InvocableSource) =>
      Array.from({ length: 12 }, (_, i) => make(`ali-${i}`));
    const rows = buildMentionRows(
      sources({
        agents: many(agent),
        skills: many(skill),
        tasks: Array.from({ length: 12 }, (_, i) => ({
          id: i,
          title: `Ali task ${i}`,
          status: "todo",
          description: null,
        })),
        library: Array.from({ length: 12 }, (_, i) => ({
          slug: `ali-${i}`,
          title: `Ali doc ${i}`,
          body: "…",
        })),
      }),
      "ali",
    );
    expect(rows.filter((r) => r.kind === "agent")).toHaveLength(8);
    expect(rows.filter((r) => r.kind === "skill")).toHaveLength(8);
    expect(rows).toHaveLength(20);
  });

  it("carries a skill's name beside its `/` token, for the mid-sentence case", () => {
    const rows = buildMentionRows(
      sources({ skills: [skill("frontend-design", "miragold")] }),
      "front",
    );
    expect(rows[0]).toEqual({
      kind: "skill",
      label: "miragold:frontend-design",
      meta: "miragold",
      insertText: "/frontend-design",
      name: "frontend-design",
    });
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
      agents: [agent("api-helper")],
      skills: [skill("api-skill")],
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

  it("offers nothing when the catalog is empty — a failed fetch is not an error state", () => {
    expect(buildMentionRows(sources(), "debug")).toEqual([]);
  });
});

describe("invocableMeta", () => {
  it("flattens a description onto one line and clips it", () => {
    const long = invocable({
      name: "debugger",
      description: "Diagnoses bugs.\n\nUse it for stack traces, crash logs, memory leaks and race conditions.",
    });
    const meta = invocableMeta(long);
    expect(meta).not.toContain("\n");
    expect(meta.length).toBeLessThanOrEqual(72);
    expect(meta.endsWith("…")).toBe(true);
  });

  it("flattens the literal `\\n` escapes the frontmatter scan leaves behind", () => {
    const meta = invocableMeta(
      invocable({ name: "x", description: "First line.\\nSecond line." }),
    );
    expect(meta).toBe("First line. Second line.");
  });

  it("falls back to the project when a file carries no description", () => {
    expect(invocableMeta(agent("debugger", "miragold"))).toBe("miragold");
    expect(invocableMeta(agent("orion-ops"))).toBe("");
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
