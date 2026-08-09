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
import type { SearchResult, SearchResultType } from "./api";

/** `/tasks?project_id=<id>` — the app's own board-scoped project view. */
export function projectRoute(projectId: number): string {
  return `/tasks?project_id=${projectId}`;
}

/**
 * Maps a search result to its in-app destination.
 *
 * Two corrections versus the palette's original inline copy (see plan D4):
 * `project` now resolves through `projectRoute` (there is no `/projects/:id`
 * route — the old destination was unroutable) and `event` resolves to the
 * Command Center's session deep link (there is no dedicated sessions route
 * in the router either).
 * The exhaustive `switch` with no `default` means a sixth `SearchResultType`
 * fails the build (`noFallthroughCasesInSwitch` + the union) rather than
 * silently falling through.
 */
export function routeForResult(result: SearchResult): string {
  switch (result.type) {
    case "task":
      return `/tasks/${result.id}`;
    case "project":
      return projectRoute(result.id);
    case "doc":
      return `/docs?id=${result.id}`;
    case "inbox":
      return `/inbox?id=${result.id}`;
    case "event":
      return result.session_id
        ? `/command?session=${encodeURIComponent(result.session_id)}`
        : "/command";
  }
}

export const GROUP_ORDER: readonly SearchResultType[] = [
  "task",
  "project",
  "doc",
  "inbox",
  "event",
];

export const GROUP_LABELS: Record<SearchResultType, string> = {
  task: "Tasks",
  project: "Projects",
  doc: "Knowledge",
  inbox: "Inbox",
  event: "Sessions",
};

export function typeIcon(type: SearchResultType | "member"): string {
  if (type === "task") return "tasks";
  if (type === "project") return "projects";
  if (type === "doc") return "docs";
  if (type === "inbox") return "inbox";
  if (type === "event") return "agents";
  return "team";
}

export function typeColor(type: SearchResultType | "member"): string {
  if (type === "task") return "#60a5fa";
  if (type === "project") return "#a855f7";
  if (type === "doc") return "#f59e0b";
  if (type === "inbox") return "#ec4899";
  if (type === "event") return "#10b981";
  return "#22c55e";
}

function emptyGroups(): Record<SearchResultType, SearchResult[]> {
  return { task: [], project: [], doc: [], inbox: [], event: [] };
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
