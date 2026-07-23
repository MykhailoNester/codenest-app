// `slug` is the canonical identifier for a sidebar entry. Nav visibility is
// governed solely by the Features toggles (see FEATURES below); workspace
// templates were removed.

/**
 * Client-side mirror of `_FEATURES_DEFAULT` in
 * `app/services/settings_service.py`.
 *
 * MUST stay in sync with _FEATURES_DEFAULT in app/services/settings_service.py.
 *
 * A `true` value means the feature is ON by default; `false` means OFF.
 * This is the authoritative fallback used before the sidecar has responded
 * so the sidebar never renders in an "all features visible" state.
 */
export const FEATURE_DEFAULTS: Readonly<Record<string, boolean>> = {
  work: true,
  notifications: true,
  parallel: true,
  preview: true,
  budgets: true,
  schedules: true,
  snippets: false,
  gallery: false,
  feed: false,
  mcp: false,
  integrations: false,
  plugins: false,
  sync: false,
} as const;
//
// `group` is a UI-only concern (which sidebar section the item renders in).
// Items are ordered so each group's entries are contiguous, matching
// `NAV_GROUPS` order below.
//
// FEATURES — global hard gate.
// Maps a feature slug (matches KNOWN_FEATURES in settings_service.py) to the
// set of nav slugs it controls.  Nav slugs NOT listed here belong to no gated
// feature and are NEVER disableable (command, settings, dashboard, projects,
// team, docs).
//
// Feature → nav slug taxonomy:
//   work          → Work board kanban (slugs: tasks, inbox).
//                   `inbox` stays in this set for redirect compat — it
//                   redirects to /tasks in the router.
//   notifications → Notifications page (slug: notifications).
//
// TODO: when the workflow_items and tasks tables are merged into one,
// remove `inbox` from the `work` slug set and drop it from KNOWN_NAV_SLUGS.
export const FEATURES: Readonly<Record<string, readonly string[]>> = {
  work: ["tasks", "inbox"],
  notifications: ["notifications"],
  schedules: ["schedules"],
  parallel: ["parallel"],
  preview: ["preview"],
  feed: ["feed"],
  budgets: ["budgets"],
  sync: ["sync"],
  snippets: ["library"],
  gallery: ["marketplace"],
  mcp: ["mcp"],
  integrations: ["integrations"],
  plugins: ["plugins"],
} as const;

/**
 * Stable ordered list of all known feature slugs.  Matches KNOWN_FEATURES in
 * `app/services/settings_service.py`.  Used by FeaturesTab to render in a
 * deterministic order without needing to sort at runtime.
 */
export const KNOWN_FEATURES_ORDERED: readonly string[] = [
  "work",
  "notifications",
  "schedules",
  "parallel",
  "preview",
  "feed",
  "budgets",
  "sync",
  "snippets",
  "gallery",
  "mcp",
  "integrations",
  "plugins",
] as const;

export const NAV_GROUPS = [
  { id: "workspace", label: "Workspace", defaultOpen: true },
  { id: "agents", label: "Agents", defaultOpen: false },
  { id: "knowledge", label: "Knowledge", defaultOpen: false },
  { id: "tools", label: "Tools", defaultOpen: false },
  { id: "system", label: "System", defaultOpen: false },
] as const;

export type NavGroup = (typeof NAV_GROUPS)[number]["id"];

export const NAV_ITEMS = [
  // Workspace — the daily work surface
  {
    slug: "command",
    label: "Command",
    icon: "command",
    path: "/command",
    group: "workspace",
  },
  {
    slug: "dashboard",
    label: "Overview",
    icon: "dashboard",
    path: "/",
    group: "workspace",
  },
  {
    slug: "projects",
    label: "Projects",
    icon: "projects",
    path: "/projects",
    group: "workspace",
  },
  {
    slug: "tasks",
    label: "Work Board",
    icon: "tasks",
    path: "/tasks",
    group: "workspace",
  },
  // `inbox` is intentionally absent from NAV_ITEMS — the router redirects
  // /inbox → /tasks. A future workflow_items/tasks table merge will clean up
  // the DB rows.
  {
    slug: "notifications",
    label: "Notifications",
    icon: "bell",
    path: "/notifications",
    group: "workspace",
  },
  // Agents — the agent execution surface
  {
    slug: "team",
    label: "Agents",
    icon: "team",
    path: "/team",
    group: "agents",
  },
  // parallel intentionally omitted from NAV_ITEMS.
  // The route, page, and service are intact for future repurposing.
  {
    slug: "schedules",
    label: "Schedules",
    icon: "schedules",
    path: "/schedules",
    group: "agents",
  },
  {
    slug: "terminal",
    label: "Terminal",
    icon: "terminal",
    path: "/terminal",
    group: "agents",
  },
  // Knowledge — repositories of stuff
  {
    slug: "docs",
    label: "Knowledge",
    icon: "docs",
    path: "/docs",
    group: "knowledge",
  },
  {
    slug: "library",
    label: "Snippets",
    icon: "library",
    path: "/library",
    group: "knowledge",
  },
  {
    slug: "marketplace",
    label: "Gallery",
    icon: "marketplace",
    path: "/marketplace",
    group: "knowledge",
  },
  {
    slug: "feed",
    label: "Feed",
    icon: "feed",
    path: "/feed",
    group: "knowledge",
  },
  // Tools
  {
    slug: "preview",
    label: "Preview",
    icon: "preview",
    path: "/preview",
    group: "tools",
  },
  // System — configuration & observability
  { slug: "mcp", label: "MCP", icon: "mcp", path: "/mcp", group: "system" },
  {
    slug: "integrations",
    label: "Integrations",
    icon: "integration",
    path: "/integrations",
    group: "system",
  },
  {
    slug: "plugins",
    label: "Plugins",
    icon: "plugin",
    path: "/plugins",
    group: "system",
  },
  { slug: "sync", label: "Sync", icon: "sync", path: "/sync", group: "system" },
  {
    slug: "budgets",
    label: "Budgets",
    icon: "budget",
    path: "/budgets",
    group: "system",
  },
  {
    slug: "settings",
    label: "Settings",
    icon: "settings",
    path: "/settings",
    group: "system",
  },
] as const;
