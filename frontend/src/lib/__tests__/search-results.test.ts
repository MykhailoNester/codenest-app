import { describe, it, expect } from "vitest";
import type { SearchResult, SearchResultType } from "../api";
import {
  flattenGrouped,
  groupResults,
  projectRoute,
  routeForResult,
} from "../search-results";

function result(
  type: SearchResultType,
  id: number,
  overrides: Partial<SearchResult> = {},
): SearchResult {
  return { type, id, title: `${type}-${id}`, snippet: "", score: 1, ...overrides };
}

describe("routeForResult", () => {
  it("task -> /tasks/:id", () => {
    expect(routeForResult(result("task", 42))).toBe("/tasks/42");
  });

  it("project -> projectRoute(id) (/tasks?project_id=:id)", () => {
    expect(routeForResult(result("project", 7))).toBe(projectRoute(7));
    expect(routeForResult(result("project", 7))).toBe("/tasks?project_id=7");
  });

  it("doc -> /docs?id=:id", () => {
    expect(routeForResult(result("doc", 3))).toBe("/docs?id=3");
  });

  it("inbox -> /inbox?id=:id", () => {
    expect(routeForResult(result("inbox", 9))).toBe("/inbox?id=9");
  });

  it("event with session_id -> /command?session=<id>", () => {
    expect(routeForResult(result("event", 1, { session_id: "abc123" }))).toBe(
      "/command?session=abc123",
    );
  });

  it("event without session_id -> /command", () => {
    expect(routeForResult(result("event", 1))).toBe("/command");
  });

  it("event session_id with & and space is encoded", () => {
    expect(
      routeForResult(result("event", 1, { session_id: "abc 123&x=1" })),
    ).toBe("/command?session=abc%20123%26x%3D1");
  });

  // Property pinned: no result type routes to a path the router does not
  // declare (App.tsx:384-479) — the defect that made Projects and Sessions
  // palette hits land on /command.
  it("every produced route matches a pattern the router actually declares", () => {
    const routePatterns = [
      /^\/tasks\/\d+$/,
      /^\/tasks\?project_id=\d+$/,
      /^\/docs\?id=\d+$/,
      /^\/inbox\?id=\d+$/,
      /^\/command(\?session=.+)?$/,
    ];
    const results: SearchResult[] = [
      result("task", 1),
      result("project", 2),
      result("doc", 3),
      result("inbox", 4),
      result("event", 5),
      result("event", 6, { session_id: "s-1" }),
    ];
    for (const r of results) {
      const route = routeForResult(r);
      expect(routePatterns.some((p) => p.test(route))).toBe(true);
    }
  });
});

describe("groupResults", () => {
  it("groupResults(undefined) -> all five buckets present and empty", () => {
    const grouped = groupResults(undefined);
    expect(Object.keys(grouped).sort()).toEqual(
      ["doc", "event", "inbox", "project", "task"].sort(),
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
  it("emits task, project, doc, inbox, event order regardless of input order", () => {
    const event = result("event", 1);
    const task = result("task", 2);
    const inbox = result("inbox", 3);
    const doc = result("doc", 4);
    const project = result("project", 5);
    const grouped = groupResults([event, task, inbox, doc, project]);
    expect(flattenGrouped(grouped)).toEqual([task, project, doc, inbox, event]);
  });
});
