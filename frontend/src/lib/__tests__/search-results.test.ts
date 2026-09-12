import { describe, it, expect } from "vitest";
import type { SearchResult, SearchResultType } from "../api";
import {
  flattenGrouped,
  groupResults,
  projectContextRoute,
  resultMeta,
  routeForResult,
} from "../search-results";

function result(
  type: SearchResultType,
  id: number | string,
  overrides: Partial<SearchResult> = {},
): SearchResult {
  return { type, id, title: `${type}-${id}`, snippet: "", score: 1, ...overrides };
}

describe("routeForResult", () => {
  it("task -> /tasks/:id", () => {
    expect(routeForResult(result("task", 42))).toBe("/tasks/42");
  });

  it("project -> the #181 Context Map", () => {
    expect(routeForResult(result("project", 7))).toBe(projectContextRoute(7));
    expect(routeForResult(result("project", 7))).toBe("/projects/7/context");
  });

  it("doc -> /docs?id=:id", () => {
    expect(routeForResult(result("doc", 3))).toBe("/docs?id=3");
  });

  it("inbox -> /inbox?id=:id", () => {
    expect(routeForResult(result("inbox", 9))).toBe("/inbox?id=9");
  });

  it("event with session_id -> the #180 Session Inspector", () => {
    expect(routeForResult(result("event", 1, { session_id: "abc123" }))).toBe(
      "/sessions/abc123",
    );
  });

  it("event without session_id -> /command", () => {
    expect(routeForResult(result("event", 1))).toBe("/command");
  });

  it("session -> the Inspector, its text id encoded", () => {
    expect(routeForResult(result("session", "abc 123&x=1"))).toBe(
      "/sessions/abc%20123%26x%3D1",
    );
  });

  it("attention -> the attention queue", () => {
    expect(routeForResult(result("attention", 4))).toBe("/attention");
  });

  // Property pinned: no result type routes to a path the router does not
  // declare (App.tsx:384-479) — the defect that made Projects and Sessions
  // palette hits land on /command.
  it("every produced route matches a pattern the router actually declares", () => {
    const routePatterns = [
      /^\/tasks\/\d+$/,
      /^\/projects\/\d+\/context$/,
      /^\/docs\?id=\d+$/,
      /^\/inbox\?id=\d+$/,
      /^\/sessions\/.+$/,
      /^\/attention$/,
      /^\/command$/,
    ];
    const results: SearchResult[] = [
      result("task", 1),
      result("project", 2),
      result("doc", 3),
      result("inbox", 4),
      result("event", 5),
      result("event", 6, { session_id: "s-1" }),
      result("session", "s-2"),
      result("attention", 7),
    ];
    for (const r of results) {
      const route = routeForResult(r);
      expect(routePatterns.some((p) => p.test(route))).toBe(true);
    }
  });
});

describe("groupResults", () => {
  it("groupResults(undefined) -> every bucket present and empty", () => {
    const grouped = groupResults(undefined);
    expect(Object.keys(grouped).sort()).toEqual(
      ["attention", "doc", "event", "inbox", "project", "session", "task"].sort(),
    );
    for (const bucket of Object.values(grouped)) {
      expect(bucket).toEqual([]);
    }
  });

  it("preserves per-type input order", () => {
    const a = result("task", 1);
    const b = result("task", 2);
    const c = result("task", 3);
    const grouped = groupResults([b, c, a]);
    expect(grouped.task).toEqual([b, c, a]);
  });
});

describe("flattenGrouped", () => {
  it("emits GROUP_ORDER regardless of input order, attention first", () => {
    const event = result("event", 1);
    const task = result("task", 2);
    const inbox = result("inbox", 3);
    const doc = result("doc", 4);
    const project = result("project", 5);
    const session = result("session", "s-1");
    const attention = result("attention", 6);
    const grouped = groupResults([
      event,
      task,
      inbox,
      doc,
      project,
      session,
      attention,
    ]);
    expect(flattenGrouped(grouped)).toEqual([
      attention,
      task,
      project,
      doc,
      inbox,
      session,
      event,
    ]);
  });
});

describe("resultMeta", () => {
  it("names the lane only when the hit is lane evidence", () => {
    expect(
      resultMeta(
        result("event", 1, { lane: "A", surface: "session-inspector" }),
      ),
    ).toBe("Lane A · hooks · Session Inspector");
    expect(
      resultMeta(result("project", 2, { lane: null, surface: "project-context" })),
    ).toBe("Context Map");
  });
});
