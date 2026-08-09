/**
 * The `@` typed-suggestion list — pure data shaping, no React.
 *
 * Imports only `parseLibraryRef` from `./prompt-intent` so the
 * `@library:<slug>` branch shares its parsing with the rest of the bar
 * instead of re-inlining the regex.
 */
import { parseLibraryRef } from "./prompt-intent";

export interface MentionSources {
  projects: readonly { id: number; name: string }[];
  members: readonly { name: string; type: string }[];
  library: readonly { slug: string; title: string }[];
}

export type OmniMentionRow =
  | { kind: "project"; label: string; meta: string; projectId: number }
  | { kind: "member"; label: string; meta: string; name: string }
  | { kind: "library"; label: string; meta: string; slug: string }
  | { kind: "library-ref"; label: string; meta: string; slug: string };

const DEFAULT_LIMIT = 10;
/** Per-group cap in the mixed (non-`library:`) suggestion list. */
const PER_GROUP_CAP = 5;

function libraryRow(item: { slug: string; title: string }): OmniMentionRow {
  return { kind: "library", label: item.title, meta: item.slug, slug: item.slug };
}

/**
 * Builds the `@` suggestion rows for `query` (the text after `@`, i.e.
 * `IntentResult.payload` for a `"reference"`-kind result).
 *
 * A bare `@` (`query === ""`) must not dump every project and member, so
 * that case returns `[]` unconditionally — the caller is expected to prompt
 * the user to keep typing instead.
 */
export function buildMentionRows(
  sources: MentionSources,
  query: string,
  limit: number = DEFAULT_LIMIT,
): OmniMentionRow[] {
  if (query.length === 0) return [];

  const libraryRef = parseLibraryRef(query);
  if (libraryRef) {
    if (libraryRef.ok) {
      const needle = libraryRef.slug;
      const matches = sources.library.filter(
        (item) =>
          item.slug.toLowerCase().includes(needle) ||
          item.title.toLowerCase().includes(needle),
      );
      if (matches.length > 0) {
        return matches.slice(0, limit).map(libraryRow);
      }
      // No local match — one row lets Enter still resolve by fetching the
      // slug directly (e.g. an item outside the list endpoint's window).
      return [
        {
          kind: "library-ref",
          label: `@library:${needle}`,
          meta: "fetch by slug",
          slug: needle,
        },
      ];
    }
    if (libraryRef.reason === "empty") {
      // A bare `@library:` lists every loaded snippet — there is no slug yet
      // to filter by, and listing them is the point of a typed suggestion
      // list.
      return sources.library.slice(0, limit).map(libraryRow);
    }
    // reason === "invalid" — Enter toasts instead of showing a row.
    return [];
  }

  const needle = query.toLowerCase();

  const projectRows: OmniMentionRow[] = sources.projects
    .filter((p) => p.name.toLowerCase().includes(needle))
    .slice(0, PER_GROUP_CAP)
    .map((p) => ({
      kind: "project",
      label: p.name,
      meta: "project",
      projectId: p.id,
    }));

  const memberRows: OmniMentionRow[] = sources.members
    .filter((m) => m.name.toLowerCase().includes(needle))
    .slice(0, PER_GROUP_CAP)
    .map((m) => ({
      kind: "member",
      label: m.name,
      meta: m.type === "agent" ? "agent" : "human",
      name: m.name,
    }));

  const libraryRows: OmniMentionRow[] = sources.library
    .filter(
      (item) =>
        item.title.toLowerCase().includes(needle) ||
        item.slug.toLowerCase().includes(needle),
    )
    .slice(0, PER_GROUP_CAP)
    .map(libraryRow);

  return [...projectRows, ...memberRows, ...libraryRows].slice(0, limit);
}
