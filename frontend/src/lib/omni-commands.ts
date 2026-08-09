/**
 * The `/` command registry — pure data plus a pure filter/score function.
 * No React, no `navigate`, no `toast`; the bar owns executing a command,
 * this module only owns *which* commands exist and which of them match a
 * typed query.
 *
 * Imports only `FEATURES` and `NAV_ITEMS` from `./nav-items` (that module has
 * no imports of its own), so every navigable command is derived from the
 * app's real route table rather than hand-copied and left to drift.
 * Deliberately does **not** import `TERMINAL_ROUTE`: the Sessions nav item's
 * path already *is* `TERMINAL_ROUTE` (see `nav-items.ts`), so importing the
 * constant here too would be an unused local under `noUnusedLocals`.
 */
import { FEATURES, NAV_ITEMS } from "./nav-items";

export const OMNI_EVENT_OPEN_PALETTE = "omni:open-palette";
export const OMNI_EVENT_OPEN_LAUNCH = "omni:open-launch";

export type OmniActionId = "new-task" | "launch-project" | "open-palette";

export type OmniCommandTarget =
  | { kind: "navigate"; path: string }
  | { kind: "action"; action: OmniActionId };

export interface OmniCommand {
  /** `"action:new-task"` | `"nav:tasks"` | `"extra:/editor"` */
  id: string;
  title: string;
  /** Short subtitle shown right of the title — a path or a description. */
  hint: string;
  /** A key of `PATHS` in `components/icon.tsx`. */
  icon: string;
  keywords: readonly string[];
  /** Gating key (matched against `FEATURES`); `null` = never gated. */
  navSlug: string | null;
  target: OmniCommandTarget;
}

/** Shared by the bare-`/` window and the tests that pin its size. */
export const OMNI_COMMAND_LIMIT = 10;

// Registry order is load-bearing (see plan D5a): actions first, then
// nav-derived, then extras. The three actions are the only commands not
// already one sidebar click away, and the bare-`/` window is only
// `OMNI_COMMAND_LIMIT` rows — if nav-derived entries led, the 19-entry nav
// block would fill the whole window and the two named actions ("new task",
// "launch project") would only be reachable by already knowing to type them,
// which is exactly the discoverability failure this ticket removes.
const ACTIONS: readonly OmniCommand[] = [
  {
    id: "action:new-task",
    title: "New Task",
    hint: "opens the new-task form",
    icon: "tasks",
    keywords: ["new", "task", "create", "add", "todo"],
    navSlug: "tasks",
    target: { kind: "action", action: "new-task" },
  },
  {
    id: "action:launch-project",
    title: "Launch Project",
    hint: "opens the Launch dialog",
    icon: "zap",
    keywords: ["launch", "run", "start", "project", "agent"],
    navSlug: null,
    target: { kind: "action", action: "launch-project" },
  },
  {
    id: "action:open-palette",
    title: "Open Command Palette",
    hint: "⌘K",
    icon: "command",
    keywords: ["palette", "search", "command", "cmd+k"],
    navSlug: null,
    target: { kind: "action", action: "open-palette" },
  },
];

// Nav-derived commands. Keywords are the slug plus the path's last segment,
// so a query like "task" or "terminal" finds a nav item whose *label*
// doesn't contain the word — e.g. slug `tasks` / path `/tasks` -> label
// "Work Board", slug `terminal` / path `/terminal` -> label "Sessions".
const NAV_DERIVED: readonly OmniCommand[] = NAV_ITEMS.map((item) => ({
  id: `nav:${item.slug}`,
  title: item.label,
  hint: item.path,
  icon: item.icon,
  keywords: [item.slug, item.path.replace(/^\//, "")],
  navSlug: item.slug,
  target: { kind: "navigate", path: item.path },
}));

// Extras: routes worth commanding that have no sidebar nav item.
const EXTRAS: readonly OmniCommand[] = [
  {
    id: "extra:/in-progress",
    title: "In Progress",
    hint: "/in-progress",
    icon: "tasks",
    keywords: ["in-progress", "progress", "tasks"],
    navSlug: null,
    target: { kind: "navigate", path: "/in-progress" },
  },
  {
    id: "extra:/editor",
    title: "Markdown Editor",
    hint: "/editor",
    icon: "docs",
    keywords: ["editor", "markdown", "docs"],
    navSlug: null,
    target: { kind: "navigate", path: "/editor" },
  },
  {
    id: "extra:/parallel",
    title: "Parallel Runs",
    hint: "/parallel",
    icon: "parallel",
    keywords: ["parallel", "runs"],
    navSlug: "parallel",
    target: { kind: "navigate", path: "/parallel" },
  },
  {
    id: "extra:/settings/workspace",
    title: "Workspace Settings",
    hint: "/settings/workspace",
    icon: "settings",
    keywords: ["workspace", "settings"],
    navSlug: null,
    target: { kind: "navigate", path: "/settings/workspace" },
  },
];

export const OMNI_COMMANDS: readonly OmniCommand[] = [
  ...ACTIONS,
  ...NAV_DERIVED,
  ...EXTRAS,
];

/**
 * The first feature key (in `FEATURES`' own iteration order) whose slug list
 * contains `navSlug`, else `null` — the same lookup `FeatureRoute` in
 * `App.tsx` performs.
 */
export function featureForNavSlug(navSlug: string): string | null {
  for (const [feature, slugs] of Object.entries(FEATURES)) {
    if ((slugs as readonly string[]).includes(navSlug)) return feature;
  }
  return null;
}

/**
 * Filters `OMNI_COMMANDS` by the enabled-features map, then scores and
 * ranks them against `query`.
 *
 * Gating uses `enabledFeatures[feature] === false` — the exact predicate
 * `FeatureRoute` uses — so an unknown feature key keeps a command visible,
 * and a disabled feature can never produce a command that would bounce off
 * `FeatureRoute` to `/command`.
 */
export function buildCommandRows(
  query: string,
  enabledFeatures: Readonly<Record<string, boolean>>,
  limit: number = OMNI_COMMAND_LIMIT,
): OmniCommand[] {
  const visible = OMNI_COMMANDS.filter((command) => {
    if (command.navSlug === null) return true;
    const feature = featureForNavSlug(command.navSlug);
    if (feature === null) return true;
    return enabledFeatures[feature] !== false;
  });

  const q = query.trim().toLowerCase();
  if (!q) return visible.slice(0, limit);

  const scored: { command: OmniCommand; score: number; index: number }[] = [];
  visible.forEach((command, index) => {
    const title = command.title.toLowerCase();
    let score: number | null = null;
    if (title === q) score = 0;
    else if (title.startsWith(q)) score = 1;
    else if (title.includes(q)) score = 2;
    else if (
      command.hint.toLowerCase().includes(q) ||
      command.keywords.some((k) => k.toLowerCase().includes(q))
    )
      score = 3;
    if (score !== null) scored.push({ command, score, index });
  });
  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  return scored.slice(0, limit).map((s) => s.command);
}
