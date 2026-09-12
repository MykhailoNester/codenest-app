/**
 * Search-result routing, grouping and presentation — extracted from
 * `command-palette.tsx` so the OmniBar's inline dropdown and the ⌘K palette
 * share one implementation instead of drifting on grouping order, on result
 * routing, or on which result types exist.
 *
 * Type-only import from `./api` — `verbatimModuleSyntax` erases it at
 * runtime, so this module carries no runtime edge back to the sidecar layer
 * (same pattern as `./notification-route`). Pure; no React, no fetch.
 */
import type { SearchResult, SearchResultType, SearchSurface } from "./api";

/** `/tasks?project_id=<id>` — the app's own board-scoped project view. */
export function projectRoute(projectId: number): string {
  return `/tasks?project_id=${projectId}`;
}

/** `/projects/:projectId/context` — the #181 Project Context Map. */
export function projectContextRoute(projectId: number | string): string {
  return `/projects/${projectId}/context`;
}

/** `/sessions/:sessionId` — the #180 Session Inspector. */
export function sessionRoute(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}`;
}

/**
 * Maps a search result to its in-app destination.
 *
 * The exhaustive `switch` with no `default` means a new `SearchResultType`
 * fails the build (`noFallthroughCasesInSwitch` + the union) rather than
 * silently falling through.
 */
export function routeForResult(result: SearchResult): string {
  switch (result.type) {
    case "task":
      return `/tasks/${result.id}`;
    case "project":
      return projectContextRoute(result.id);
    case "doc":
      return `/docs?id=${result.id}`;
    case "inbox":
      return `/inbox?id=${result.id}`;
    case "event":
      return result.session_id ? sessionRoute(result.session_id) : "/command";
    case "session":
      return sessionRoute(String(result.id));
    case "attention":
      return "/attention";
  }
}

export const GROUP_ORDER: readonly SearchResultType[] = [
  "attention",
  "task",
  "project",
  "doc",
  "inbox",
  "session",
  "event",
];

export const GROUP_LABELS: Record<SearchResultType, string> = {
  task: "Tasks",
  project: "Projects",
  doc: "Knowledge",
  inbox: "Inbox",
  event: "Session activity",
  session: "Sessions",
  attention: "Needs attention",
};

/** Where the hit will land, shown on the row next to its lane. */
export const SURFACE_LABELS: Record<SearchSurface, string> = {
  tasks: "Work",
  "project-context": "Context Map",
  docs: "Knowledge",
  inbox: "Inbox",
  "session-inspector": "Session Inspector",
  attention: "Attention",
};

const LANE_LABELS: Record<"A" | "B" | "C", string> = {
  A: "Lane A · hooks",
  B: "Lane B · OTLP",
  C: "Lane C · transcript",
};

/**
 * The row's provenance line: the lane the hit is evidence from, plus the
 * surface it opens. Lane is omitted when the hit is not lane data — a project
 * or a task was never observed by an ingest lane, and a session row is written
 * field-by-field by all three, which the Session Inspector shows properly.
 */
export function resultMeta(result: SearchResult): string {
  const surface = result.surface ? SURFACE_LABELS[result.surface] : result.type;
  const lane = result.lane ? LANE_LABELS[result.lane] : null;
  return lane ? `${lane} · ${surface}` : surface;
}

export function typeIcon(type: SearchResultType | "member"): string {
  if (type === "task") return "tasks";
  if (type === "project") return "projects";
  if (type === "doc") return "docs";
  if (type === "inbox") return "inbox";
  if (type === "event") return "agents";
  if (type === "session") return "terminal";
  if (type === "attention") return "bell";
  return "team";
}

export function typeColor(type: SearchResultType | "member"): string {
  if (type === "task") return "#60a5fa";
  if (type === "project") return "#a855f7";
  if (type === "doc") return "#f59e0b";
  if (type === "inbox") return "#ec4899";
  if (type === "event") return "#10b981";
  if (type === "session") return "#14b8a6";
  if (type === "attention") return "#ef4444";
  return "#22c55e";
}

function emptyGroups(): Record<SearchResultType, SearchResult[]> {
  return {
    task: [],
    project: [],
    doc: [],
    inbox: [],
    event: [],
    session: [],
    attention: [],
  };
}

/** Buckets results by type, preserving each bucket's input order. */
export function groupResults(
  results: readonly SearchResult[] | undefined,
): Record<SearchResultType, SearchResult[]> {
  const grouped = emptyGroups();
  if (!results) return grouped;
  for (const r of results) {
    grouped[r.type].push(r);
  }
  return grouped;
}

/** Flattens a grouped map back to a single list in `GROUP_ORDER`. */
export function flattenGrouped(
  grouped: Record<SearchResultType, SearchResult[]>,
): SearchResult[] {
  return GROUP_ORDER.flatMap((t) => grouped[t]);
}
