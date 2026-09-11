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
  attention: true,
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

/**
 * Cache key used to persist the resolved `enabled_features` map across cold
 * relaunches so the sidebar is correct on the very first paint before the
 * sidecar has responded. Declared here rather than in `api.ts` (which used to
 * own it) so a non-react-query consumer can read it without importing the
 * query layer. This module has no imports and must keep it that way.
 */
export const FEATURE_CACHE_KEY = "enabled_features_cache";

/**
 * Dispatched on `window` after the enabled-features cache is refreshed, so
 * non-react-query consumers can re-read it without a QueryClient.
 */
export const FEATURE_CACHE_EVENT = "codenest:enabled-features";
//
// `group` is a UI-only concern (which sidebar section the item renders in).
// Items are ordered so each group's entries are contiguous, matching
// `NAV_GROUPS` order below.
//
// FEATURES — global hard gate.
// Maps a feature slug (matches KNOWN_FEATURES in settings_service.py) to the
// set of nav slugs it controls.  Nav slugs NOT listed here belong to no gated
// feature and are NEVER disableable (command, settings, mission, projects,
// team, docs).
//
// `mission` is on that never-disableable list for the same reason `dashboard`
// (the slug it replaces) was: it owns `/`, so gating it would let the Features
// tab produce an app whose landing route bounces off `FeatureRoute`. It is
// therefore deliberately absent from FEATURE_DEFAULTS, from this map and from
// KNOWN_FEATURES_ORDERED, and `settings_service.py` needs no mirror entry for
// it. Do not "fix" that by adding one.
//
// The Terminal page's own two surfaces — the native agent pane + composer and
// the workspace navigator beside it — used to live here as the `composer` and
// `explorer` slugs. Both are now unconditional (`_RETIRED_FEATURES` in
// `settings_service.py`), so neither appears in this map, in FEATURE_DEFAULTS,
// or in KNOWN_FEATURES_ORDERED. Do not re-add them as gates.
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
  attention: ["attention"],
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
  "attention",
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

/**
 * The Sessions page's route. Exported because three places need to agree on it
 * — the `<Route>`, the nav item below, and the Command Center's Focus action —
 * and they did not: Focus navigated to `/terminals`, a path no route matches, so
 * focusing an embedded pane silently did nothing while the popout path (which
 * never navigates) worked. A constant makes that class of drift impossible.
 */
export const TERMINAL_ROUTE = "/terminal";

// Attention first, then the record, then the places you act (#165, epic #153).
//
// `workspace` is gone as a group id. It was the catch-all that made Command the
// first thing in the rail and Overview a secondary page; the pivot inverts
// that. Nothing needs to migrate: `nav-group-store` keys its persisted
// open/closed overrides by group id and falls back to `defaultOpen` for any id
// it does not recognise, so a user's stored `{"workspace": false}` is simply
// ignored from here on.
export const NAV_GROUPS = [
  { id: "attention", label: "Attention", defaultOpen: true },
  { id: "record", label: "Record", defaultOpen: true },
  { id: "agents", label: "Agents", defaultOpen: false },
  { id: "knowledge", label: "Knowledge", defaultOpen: false },
  { id: "tools", label: "Tools", defaultOpen: false },
  { id: "system", label: "System", defaultOpen: false },
] as const;

export type NavGroup = (typeof NAV_GROUPS)[number]["id"];

export const NAV_ITEMS = [
  // Attention — things that want a human
  {
    // Replaces the `dashboard` slug, which owned `/` and was labelled
    // "Overview". The route is unchanged; the page behind it is rebuilt by
    // #166. Icon key stays `dashboard` because that key exists in `icon.tsx`
    // and `Icon` renders `null` for an unknown name rather than throwing, so a
    // freshly invented key would silently render nothing.
    slug: "mission",
    label: "Mission Control",
    icon: "dashboard",
    path: "/",
    group: "attention",
  },
  {
    // The Needs You page (#162). Second in the rail, directly under Mission
    // Control, because the design's whole argument is that the first two
    // things in the window answer "is anything waiting on me?" — and this is
    // the one that answers it with a list you can act on. Its rail count is
    // the queue's open count, wired in `sidebar.tsx`.
    //
    // Icon `review` rather than `bell`: `bell` already belongs to
    // Notifications, and two rail rows wearing the same glyph is exactly the
    // confusion this page exists to remove.
    slug: "attention",
    label: "Needs You",
    icon: "review",
    path: "/attention",
    group: "attention",
  },
  {
    slug: "tasks",
    label: "Work Board",
    icon: "tasks",
    path: "/tasks",
    group: "attention",
  },
  // `inbox` is intentionally absent from NAV_ITEMS — the router redirects
  // /inbox → /tasks. A future workflow_items/tasks table merge will clean up
  // the DB rows.

  // Record — what already happened
  {
    slug: "projects",
    label: "Projects",
    icon: "projects",
    path: "/projects",
    group: "record",
  },
  {
    slug: "notifications",
    label: "Notifications",
    icon: "bell",
    path: "/notifications",
    group: "record",
  },
  // The design's After rail also shows "Sessions Log" here. It is deliberately
  // absent: the Session Inspector it would open is P4, and a nav entry with no
  // page behind it is worse than no entry.

  // Agents — the places you act
  {
    // Command keeps its place in the rail. The design's After sketch omits it,
    // but removing a working page from the nav is not the "reordering, which
    // costs nothing" that section describes — so it moves into the group that
    // matches what it is (the agent command surface) rather than disappearing.
    slug: "command",
    label: "Command",
    icon: "command",
    path: "/command",
    group: "agents",
  },
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
    // "Sessions", not "Terminal": the default surface on this page is a native
    // agent conversation, and a shell is one of the two pane kinds it can hold.
    // ("Agents" was not available — the `team` item above owns that label.)
    //
    // The `slug` and `path` stay `terminal` on purpose: the slug is the key
    // persisted in settings and referenced by KNOWN_NAV_SLUGS, and the path is
    // baked into deep links, the popout window's hash route and localStorage
    // keys. Renaming those would be a migration; renaming the label is not.
    // Relabelled again by #165: "Run a session" is a verb, because after the
    // pivot this page is what you come here to *do* rather than where you
    // live. Owner decision (a): it keeps its route, its slug and its page, and
    // stays in the nav enabled by default — it simply stops being the landing
    // page.
    slug: "terminal",
    label: "Run a session",
    icon: "terminal",
    path: TERMINAL_ROUTE,
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
