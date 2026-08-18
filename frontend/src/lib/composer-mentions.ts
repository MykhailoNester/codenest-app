/**
 * The `@`-mention menu — pure filtering/ordering logic over whatever the
 * composer already fetched (the invocables catalog, open tasks, library
 * snippets), plus the draft-edit helper for accepting a suggestion. Kept
 * separate from `composer-commands.ts`: a mention picks *context*, a slash
 * command *acts*.
 *
 * Agents and skills arrive as `InvocableSource` rows carrying the token to
 * insert. This module never derives that token: an agent resolves by the
 * `name:` in its frontmatter (rewritten to `<project>--<name>` when two
 * projects ship one name — see the sidecar's `agent_alias_service`), a skill by
 * its directory segment, and neither is recoverable from a display name. It
 * used to guess, with an `agentMentionSlug` over the hand-curated `members`
 * table, which is why `@debugger` matched nothing on an install whose workspace
 * had `debugger.md` linked into it all along.
 */

import { parseLibraryRef } from "./prompt-intent";

/**
 * Statuses a task can be attached from, most actionable first.
 *
 * The picker used to ask the API for `status: "in-progress"` alone, which is
 * why a workspace with real work in it still showed "No tasks": a task is
 * `todo` until you start it, and attaching one as context is usually how you
 * start it. `done` is left out — the list exists to point the agent at work
 * that remains.
 */
export const PICKABLE_TASK_STATUSES = [
  "in-progress",
  "blocked",
  "todo",
  "backlog",
] as const;

export function taskRank(status: string): number {
  const i = PICKABLE_TASK_STATUSES.indexOf(
    status as (typeof PICKABLE_TASK_STATUSES)[number],
  );
  return i === -1 ? PICKABLE_TASK_STATUSES.length : i;
}

/**
 * One invocable the menu can offer — the composer's projection of a catalog row
 * (`InvocableItem`, `lib/api.ts`). Deliberately not that type: this module is
 * pure and must not reach into the query layer, and a menu needs only what to
 * show, what to insert, and what to match.
 */
export interface InvocableSource {
  /** The name the CLI resolves — matched first, and ranked highest. */
  name: string;
  /** Row label: `project:name`, or the bare name for an app-owned/built-in item. */
  label: string;
  /** Exactly what a pick inserts (`@agent-…`, `/…`), straight from the catalog. */
  insertText: string;
  /** Owning project, or null for an org agent or the built-in skill. */
  projectName: string | null;
  description: string | null;
}

export interface MentionSources {
  agents: readonly InvocableSource[];
  skills: readonly InvocableSource[];
  tasks: readonly { id: number; title: string; status: string; description: string | null }[];
  library: readonly { slug: string; title: string; body: string }[];
}

export type MentionRow =
  | { kind: "agent"; label: string; meta: string; insertText: string }
  | { kind: "skill"; label: string; meta: string; insertText: string; name: string }
  | { kind: "task"; label: string; meta: string; taskId: number; title: string; description: string | null }
  | { kind: "library"; label: string; meta: string; slug: string; title: string; body: string }
  | { kind: "library-ref"; label: string; meta: string; slug: string };

// Raised from 5/12 with the catalog wired in: one install already has 23 agents
// and 9 skills, so the old per-group 5 hid most of a matching set. The panel
// scrolls (`.suggest` is `max-height: 240px; overflow-y: auto`) and rows are
// ranked best-match-first, so a taller list costs nothing but a scroll.
const GROUP_CAP = 8;
const TOTAL_CAP = 20;

/** Longest meta a row can carry before it is clipped. */
const META_LIMIT = 72;

/**
 * A one-line meta for an invocable row.
 *
 * Catalog descriptions are whole paragraphs — some carry literal `\n` escapes
 * from the frontmatter scan — and the row is one line of a 260-420px panel, so
 * everything past the first clause is noise. Falls back to the owning project,
 * the next most useful thing to say about a row whose file has no description.
 */
export function invocableMeta(item: InvocableSource): string {
  const flat = (item.description ?? "").replace(/\\n|\s+/g, " ").trim();
  if (flat.length === 0) return item.projectName ?? "";
  return flat.length > META_LIMIT ? `${flat.slice(0, META_LIMIT - 1)}…` : flat;
}

/**
 * How well `item` answers `needle`, lower being better, or `null` for no match.
 *
 * A prefix of the resolved name wins outright, so `@debug` puts `debugger`
 * first among the dozens of rows whose description happens to mention debugging.
 * The label is matched too, which is what makes `@mira` narrow to miragold's
 * agents: the label is `project:name`. Descriptions are deliberately *not*
 * matched — they are long enough that every needle would hit something.
 */
function invocableRank(item: InvocableSource, needle: string): number | null {
  const name = item.name.toLowerCase();
  if (name.startsWith(needle)) return 0;
  if (name.includes(needle)) return 1;
  if (item.label.toLowerCase().includes(needle)) return 2;
  return null;
}

function invocableRows(
  items: readonly InvocableSource[],
  needle: string,
  kind: "agent" | "skill",
): MentionRow[] {
  return items
    .map((item) => ({ item, rank: invocableRank(item, needle) }))
    .filter((scored): scored is { item: InvocableSource; rank: number } => scored.rank !== null)
    // Stable, so equal ranks keep catalog order: org agents first, then by
    // project, which is the order the sidecar links them in.
    .sort((a, b) => a.rank - b.rank)
    .slice(0, GROUP_CAP)
    .map(({ item }) =>
      kind === "agent"
        ? {
            kind: "agent" as const,
            label: item.label,
            meta: invocableMeta(item),
            insertText: item.insertText,
          }
        : {
            kind: "skill" as const,
            label: item.label,
            meta: invocableMeta(item),
            insertText: item.insertText,
            name: item.name,
          },
    );
}

function matchingTasks(
  tasks: MentionSources["tasks"],
  needle: string,
): MentionRow[] {
  return tasks
    .filter((t) => taskRank(t.status) < PICKABLE_TASK_STATUSES.length)
    .filter(
      (t) =>
        t.title.toLowerCase().includes(needle) ||
        `#${t.id}`.includes(needle) ||
        String(t.id) === needle,
    )
    .sort((a, b) => taskRank(a.status) - taskRank(b.status) || b.id - a.id)
    .map((t) => ({
      kind: "task" as const,
      label: t.title,
      meta: `#${t.id} · ${t.status}`,
      taskId: t.id,
      title: t.title,
      description: t.description,
    }));
}

function libraryRow(item: MentionSources["library"][number]): MentionRow {
  return {
    kind: "library",
    label: item.title,
    meta: item.slug,
    slug: item.slug,
    title: item.title,
    body: item.body,
  };
}

function matchingLibrary(
  library: MentionSources["library"],
  needle: string,
): MentionRow[] {
  return library
    .filter(
      (item) =>
        item.title.toLowerCase().includes(needle) ||
        item.slug.toLowerCase().includes(needle),
    )
    .map(libraryRow);
}

/** The `library:<slug>` branch of the `@` menu — restricted to library rows,
 *  with one `library-ref` row (to fetch on pick) when a syntactically valid
 *  slug has no local match in the loaded page. */
function libraryRefRows(sources: MentionSources, query: string): MentionRow[] {
  const ref = parseLibraryRef(query);
  if (ref === null || !ref.ok) return [];
  const matches = matchingLibrary(sources.library, ref.slug).slice(0, GROUP_CAP);
  if (matches.length > 0) return matches;
  return [
    {
      kind: "library-ref",
      label: `@library:${ref.slug}`,
      meta: "fetch by slug",
      slug: ref.slug,
    },
  ];
}

/**
 * Rows for the `@` menu. Empty query → `[]` (one character is required after
 * `@`, mirroring the omni-bar's own reference suggestions). A `library:`
 * prefix restricts to library rows. Otherwise: agents, skills (both by resolved
 * name then label, best match first), tasks (title or `#id`, ordered by
 * `taskRank` then id desc), library (title/slug) — each group capped at 8,
 * total capped at 20.
 *
 * The groups stay contiguous, which is what lets `mentionRowToSuggest` place one
 * header per run. Provenance rides on every row's label (`project:name`) rather
 * than in a per-project header: with a needle in hand, best-match-first ordering
 * is worth more than rows sorted into project blocks.
 */
export function buildMentionRows(
  sources: MentionSources,
  query: string,
): MentionRow[] {
  if (query.length === 0) return [];
  if (query.toLowerCase().startsWith("library:")) {
    return libraryRefRows(sources, query);
  }

  const needle = query.toLowerCase();
  const agentRows = invocableRows(sources.agents, needle, "agent");
  const skillRows = invocableRows(sources.skills, needle, "skill");
  const taskRows = matchingTasks(sources.tasks, needle).slice(0, GROUP_CAP);
  const libraryRows = matchingLibrary(sources.library, needle).slice(0, GROUP_CAP);

  return [...agentRows, ...skillRows, ...taskRows, ...libraryRows].slice(0, TOTAL_CAP);
}

/**
 * Draft edit for accepting a suggestion. Returns the new text and where the
 * caret goes. `insert: ""` is how a token is deleted (a task/library pick
 * attaches a pill instead of inserting text) — collapsing an adjacent space
 * on each side down to one, the same "never double a space" rule
 * `insertPathsIntoDraft` uses for a non-empty insertion.
 */
export function replaceRange(
  text: string,
  start: number,
  end: number,
  insert: string,
): { text: string; caret: number } {
  const before = text.slice(0, start);
  let after = text.slice(end);
  if (insert.length === 0 && /\s$/.test(before) && /^\s/.test(after)) {
    after = after.replace(/^\s+/, "");
  }
  const trail = insert.length > 0 && !/^\s/.test(after) ? " " : "";
  const nextText = `${before}${insert}${trail}${after}`;
  return { text: nextText, caret: before.length + insert.length + trail.length };
}
