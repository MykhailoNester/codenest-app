import { describe, it, expect } from "vitest";
import { FEATURE_DEFAULTS, NAV_ITEMS, TERMINAL_ROUTE } from "../nav-items";
import {
  buildCommandRows,
  OMNI_COMMAND_LIMIT,
  OMNI_COMMANDS,
  OMNI_EVENT_OPEN_PALETTE,
} from "../omni-commands";

// icon.tsx renders `null` for an unknown `name` rather than throwing (see
// icon.tsx:223), so this allowlist is the only thing that catches a typo'd
// icon key in the registry.
const KNOWN_ICONS = new Set([
  "dashboard",
  "command",
  "projects",
  "tasks",
  "sprint",
  "inbox",
  "team",
  "docs",
  "terminal",
  "search",
  "bell",
  "camera",
  "zap",
  "check-circle",
  "chevronLeft",
  "chevronRight",
  "play",
  "pause",
  "expand",
  "maximize",
  "minimize",
  "popout",
  "settings",
  "marketplace",
  "parallel",
  "review",
  "mcp",
  "schedules",
  "preview",
  "library",
  "budget",
  "feed",
  "plugin",
  "integration",
  "sync",
]);

const EXTRA_PATHS = [
  "/in-progress",
  "/editor",
  "/parallel",
  "/settings/workspace",
];

describe("OMNI_COMMANDS shape", () => {
  it("has exactly 26 entries", () => {
    expect(OMNI_COMMANDS.length).toBe(26);
  });

  it("has unique ids", () => {
    const ids = OMNI_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every title is non-empty", () => {
    for (const c of OMNI_COMMANDS) {
      expect(c.title.length).toBeGreaterThan(0);
    }
  });

  it("every icon is a known icon.tsx key", () => {
    for (const c of OMNI_COMMANDS) {
      expect(KNOWN_ICONS.has(c.icon)).toBe(true);
    }
  });
});

describe("OMNI_COMMANDS order (D5a)", () => {
  it("the three actions lead the registry", () => {
    expect(OMNI_COMMANDS.slice(0, 3).map((c) => c.id)).toEqual([
      "action:new-task",
      "action:launch-project",
      "action:open-palette",
    ]);
  });

  it("nav-derived entries start right after the actions", () => {
    expect(OMNI_COMMANDS[3]?.id).toBe("nav:command");
  });

  it("the last four ids are all extras", () => {
    for (const c of OMNI_COMMANDS.slice(-4)) {
      expect(c.id.startsWith("extra:")).toBe(true);
    }
  });

  // Property pinned: the actions lead the registry, which is what puts them
  // in the bare-`/` window.
});

describe("buildCommandRows — bare `/` surfaces the named actions", () => {
  it("under FEATURE_DEFAULTS, the window is exactly 10 rows", () => {
    const rows = buildCommandRows("", FEATURE_DEFAULTS);
    expect(rows.length).toBe(10);
  });

  it("the three actions occupy the first three slots", () => {
    const rows = buildCommandRows("", FEATURE_DEFAULTS);
    expect(rows.map((r) => r.id).slice(0, 3)).toEqual([
      "action:new-task",
      "action:launch-project",
      "action:open-palette",
    ]);
  });

  it("contains nav:command and nav:tasks", () => {
    const ids = buildCommandRows("", FEATURE_DEFAULTS).map((r) => r.id);
    expect(ids).toContain("nav:command");
    expect(ids).toContain("nav:tasks");
  });

  it("does not contain nav:library (snippets: false by default)", () => {
    const ids = buildCommandRows("", FEATURE_DEFAULTS).map((r) => r.id);
    expect(ids).not.toContain("nav:library");
  });

  // Property pinned: scope item 3's two named actions are visible without
  // typing, under the app's real default feature set.
});

describe("buildCommandRows — limit", () => {
  it("defaults to OMNI_COMMAND_LIMIT", () => {
    expect(buildCommandRows("", { work: true }).length).toBe(
      OMNI_COMMAND_LIMIT,
    );
    expect(OMNI_COMMAND_LIMIT).toBe(10);
  });
});

describe("buildCommandRows — gating", () => {
  it("work:false hides both nav:tasks and action:new-task", () => {
    const ids = buildCommandRows("", { work: false }, 100).map((r) => r.id);
    expect(ids).not.toContain("nav:tasks");
    expect(ids).not.toContain("action:new-task");
  });

  it("work:true shows both", () => {
    const ids = buildCommandRows("", { work: true }, 100).map((r) => r.id);
    expect(ids).toContain("nav:tasks");
    expect(ids).toContain("action:new-task");
  });

  it("snippets:false omits nav:library; snippets:true includes it", () => {
    const off = buildCommandRows("", { snippets: false }, 100).map(
      (r) => r.id,
    );
    expect(off).not.toContain("nav:library");
    const on = buildCommandRows("", { snippets: true }, 100).map((r) => r.id);
    expect(on).toContain("nav:library");
  });

  it("an unknown feature map hides nothing", () => {
    expect(buildCommandRows("", {}, 100).length).toBe(26);
  });

  // Property pinned: a disabled feature can never yield a command that
  // bounces off FeatureRoute to /command.
});

describe("buildCommandRows — navigate-path integrity", () => {
  it("every navigate target is a NAV_ITEMS path, TERMINAL_ROUTE, or a documented extra", () => {
    const navPaths = new Set<string>(NAV_ITEMS.map((n) => n.path));
    navPaths.add(TERMINAL_ROUTE);
    for (const extra of EXTRA_PATHS) navPaths.add(extra);

    for (const command of OMNI_COMMANDS) {
      if (command.target.kind === "navigate") {
        expect(navPaths.has(command.target.path)).toBe(true);
      }
    }
  });

  // Property pinned: the registry cannot drift off the nav table into a
  // fabricated route (the only guard for that — nav-routes.test.ts does not
  // check paths against the route table).
});

describe("buildCommandRows — filtering and order", () => {
  it('"sched" -> nav:schedules first', () => {
    const rows = buildCommandRows("sched", {}, 100);
    expect(rows[0]?.id).toBe("nav:schedules");
  });

  it('"work" matches nav:tasks ("Work Board")', () => {
    const ids = buildCommandRows("work", {}, 100).map((r) => r.id);
    expect(ids).toContain("nav:tasks");
  });

  it('"task" matches nav:tasks via keywords even though the title has no "task"', () => {
    const ids = buildCommandRows("task", {}, 100).map((r) => r.id);
    expect(ids).toContain("nav:tasks");
  });

  it('"new task" -> action:new-task first (exact title, score 0)', () => {
    const rows = buildCommandRows("new task", {}, 100);
    expect(rows[0]?.id).toBe("action:new-task");
  });

  it('"launch" -> action:launch-project', () => {
    const rows = buildCommandRows("launch", {}, 100);
    expect(rows[0]?.id).toBe("action:launch-project");
  });

  it('"zzzz" -> []', () => {
    expect(buildCommandRows("zzzz", {}, 100)).toEqual([]);
  });
});

describe("OMNI_EVENT_OPEN_PALETTE", () => {
  it('is exactly "omni:open-palette" (App.tsx listener contract)', () => {
    expect(OMNI_EVENT_OPEN_PALETTE).toBe("omni:open-palette");
  });
});
