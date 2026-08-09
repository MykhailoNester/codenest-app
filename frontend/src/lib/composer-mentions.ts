/**
 * The `@`-mention menu — pure filtering/ordering logic over whatever the
 * composer already fetched (agents, open tasks, library snippets), plus the
 * draft-edit helper for accepting a suggestion. Kept separate from
 * `composer-commands.ts`: a mention picks *context*, a slash command *acts*.
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

export interface MentionSources {
  agents: readonly { name: string; role: string; agentFile: string | null }[];
  tasks: readonly { id: number; title: string; status: string; description: string | null }[];
  library: readonly { slug: string; title: string; body: string }[];
}

export type MentionRow =
  | { kind: "agent"; label: string; meta: string; insertText: string }
  | { kind: "task"; label: string; meta: string; taskId: number; title: string; description: string | null }
  | { kind: "library"; label: string; meta: string; slug: string; title: string; body: string }
  | { kind: "library-ref"; label: string; meta: string; slug: string };

const GROUP_CAP = 5;
const TOTAL_CAP = 12;

function pathBasename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/** `@agent-<slug>`: the `agentFile` stem when there is one, else the name
 *  lowercased with runs of non-`[a-z0-9]` collapsed to `-` and trimmed.
 *  `""` when nothing survives. */
export function agentMentionSlug(
  agent: MentionSources["agents"][number],
): string {
  if (agent.agentFile) {
    return pathBasename(agent.agentFile).replace(/\.md$/i, "");
  }
  return agent.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function matchingAgents(
  agents: MentionSources["agents"],
  needle: string,
): MentionRow[] {
  const rows: MentionRow[] = [];
  for (const agent of agents) {
    if (
      !agent.name.toLowerCase().includes(needle) &&
      !agent.role.toLowerCase().includes(needle)
    ) {
      continue;
    }
    const slug = agentMentionSlug(agent);
    if (slug.length === 0) continue;
    rows.push({
      kind: "agent",
      label: agent.name,
      meta: agent.role,
      insertText: `@agent-${slug}`,
    });
  }
  return rows;
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
 * prefix restricts to library rows. Otherwise: agents (name/role), tasks
 * (title or `#id`, ordered by `taskRank` then id desc), library (title/slug)
 * — each group capped at 5, total capped at 12.
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
  const agentRows = matchingAgents(sources.agents, needle).slice(0, GROUP_CAP);
  const taskRows = matchingTasks(sources.tasks, needle).slice(0, GROUP_CAP);
  const libraryRows = matchingLibrary(sources.library, needle).slice(0, GROUP_CAP);

  return [...agentRows, ...taskRows, ...libraryRows].slice(0, TOTAL_CAP);
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
