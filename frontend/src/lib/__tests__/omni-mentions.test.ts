import { describe, it, expect } from "vitest";
import { buildMentionRows, type MentionSources } from "../omni-mentions";

function sources(overrides: Partial<MentionSources> = {}): MentionSources {
  return { projects: [], members: [], library: [], ...overrides };
}

describe("buildMentionRows — zero case", () => {
  it('"" -> [] (a bare @ must not list the whole workspace)', () => {
    expect(
      buildMentionRows(
        sources({
          projects: [{ id: 1, name: "Anything" }],
          members: [{ name: "Alice", type: "human" }],
        }),
        "",
      ),
    ).toEqual([]);
  });
});

describe("buildMentionRows — members", () => {
  it('"ali" matches a human member -> meta "human"', () => {
    const rows = buildMentionRows(
      sources({ members: [{ name: "Alice", type: "human" }] }),
      "ali",
    );
    expect(rows).toEqual([
      { kind: "member", label: "Alice", meta: "human", name: "Alice" },
    ]);
  });

  it('an agent member -> meta "agent"', () => {
    const rows = buildMentionRows(
      sources({ members: [{ name: "Alice", type: "agent" }] }),
      "ali",
    );
    expect(rows[0]?.meta).toBe("agent");
  });
});

describe("buildMentionRows — projects", () => {
  it("a project match returns kind:project with the right projectId", () => {
    const rows = buildMentionRows(
      sources({ projects: [{ id: 42, name: "Codenest" }] }),
      "code",
    );
    expect(rows).toEqual([
      {
        kind: "project",
        label: "Codenest",
        meta: "project",
        projectId: 42,
      },
    ]);
  });
});

describe("buildMentionRows — @library:<slug>", () => {
  it('"library:dep" with a loaded dep-scan -> one library row, no library-ref', () => {
    const rows = buildMentionRows(
      sources({ library: [{ slug: "dep-scan", title: "Dependency Scan" }] }),
      "library:dep",
    );
    expect(rows).toEqual([
      {
        kind: "library",
        label: "Dependency Scan",
        meta: "dep-scan",
        slug: "dep-scan",
      },
    ]);
  });

  it('"library:not-loaded" -> exactly one library-ref row with that slug', () => {
    const rows = buildMentionRows(
      sources({ library: [{ slug: "dep-scan", title: "Dependency Scan" }] }),
      "library:not-loaded",
    );
    expect(rows).toEqual([
      {
        kind: "library-ref",
        label: "@library:not-loaded",
        meta: "fetch by slug",
        slug: "not-loaded",
      },
    ]);
  });

  it('"library:" (empty slug) -> all loaded library rows, no library-ref', () => {
    const rows = buildMentionRows(
      sources({
        library: [
          { slug: "dep-scan", title: "Dependency Scan" },
          { slug: "release-notes", title: "Release Notes" },
        ],
      }),
      "library:",
    );
    expect(rows).toEqual([
      {
        kind: "library",
        label: "Dependency Scan",
        meta: "dep-scan",
        slug: "dep-scan",
      },
      {
        kind: "library",
        label: "Release Notes",
        meta: "release-notes",
        slug: "release-notes",
      },
    ]);
  });

  it('"library:" with an empty library source -> []', () => {
    expect(buildMentionRows(sources(), "library:")).toEqual([]);
  });

  it('"library:-bad" -> []', () => {
    expect(
      buildMentionRows(
        sources({ library: [{ slug: "dep-scan", title: "Dependency Scan" }] }),
        "library:-bad",
      ),
    ).toEqual([]);
  });
});

describe("buildMentionRows — caps", () => {
  it("caps 7 matching projects + 7 matching members to 5 + 5, overall <= limit", () => {
    const projects = Array.from({ length: 7 }, (_, i) => ({
      id: i,
      name: `Match Project ${i}`,
    }));
    const members = Array.from({ length: 7 }, (_, i) => ({
      name: `Match Member ${i}`,
      type: "human",
    }));
    const rows = buildMentionRows(sources({ projects, members }), "match");
    const projectRows = rows.filter((r) => r.kind === "project");
    const memberRows = rows.filter((r) => r.kind === "member");
    expect(projectRows.length).toBe(5);
    expect(memberRows.length).toBe(5);
    expect(rows.length).toBeLessThanOrEqual(10);
  });
});
