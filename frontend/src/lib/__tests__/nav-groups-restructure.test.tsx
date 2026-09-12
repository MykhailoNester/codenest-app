import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { NAV_GROUPS, NAV_ITEMS, FEATURES } from "../nav-items";

/**
 * #165 (epic #153) — the nav restructure.
 *
 * The group ids changed and one of them (`workspace`) was deleted outright.
 * `nav-group-store` persists open/closed overrides to localStorage keyed by
 * group id, so an existing user's browser holds a key for a group that no
 * longer exists. These pin the two things that could break quietly: a stale or
 * corrupt key must not crash the rail, and every item must still belong to a
 * declared group.
 */

const STORAGE_KEY = "codenest:nav-groups";

/**
 * The same fake the terminal-store tests install. jsdom's own localStorage in
 * this setup has no `clear`, so a test that assumes the real Storage API fails
 * for a reason that has nothing to do with what it is testing.
 */
function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const fake: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
  };
  vi.stubGlobal("localStorage", fake);
  return store;
}

describe("nav restructure (#165) — registry shape", () => {
  it("declares the attention-first group order", () => {
    expect(NAV_GROUPS.map((g) => g.id)).toEqual([
      "attention",
      "record",
      "agents",
      "knowledge",
      "tools",
      "system",
    ]);
  });

  it("has no `workspace` group left", () => {
    // `tsc` already proves this — `NavGroup` no longer contains "workspace",
    // so the comparison needs widening to compile at all. Kept as a runtime
    // check anyway: it is what would fail first if someone re-added the group
    // to NAV_GROUPS, before any of the ordering assertions above.
    const ids: readonly string[] = NAV_GROUPS.map((g) => g.id);
    expect(ids).not.toContain("workspace");
  });

  it("every nav item belongs to a declared group", () => {
    const declared = new Set<string>(NAV_GROUPS.map((g) => g.id));
    for (const item of NAV_ITEMS) {
      expect(
        declared.has(item.group),
        `${item.slug} is in undeclared group ${item.group}`,
      ).toBe(true);
    }
  });

  it("keeps every slug that existed before the restructure", () => {
    // The restructure is a reordering. Losing a page from the rail would be a
    // silent feature removal, so the count is pinned. 19 → 20 with #162's
    // `attention` row, which is the one addition the restructure anticipated;
    // 20 → 21 with #171's `hooks` row in the System group.
    expect(NAV_ITEMS).toHaveLength(21);
  });

  it("mission owns / and replaces the dashboard slug", () => {
    const slugs = NAV_ITEMS.map((i) => i.slug);
    expect(slugs).toContain("mission");
    expect(slugs).not.toContain("dashboard");
    const mission = NAV_ITEMS.find((i) => i.slug === "mission");
    expect(mission?.path).toBe("/");
    expect(mission?.group).toBe("attention");
    // Must be a key `icon.tsx` actually renders — it returns null for an
    // unknown name rather than throwing, so a typo is invisible in the UI.
    expect(mission?.icon).toBe("dashboard");
  });

  it("mission is not feature-gated", () => {
    // It owns `/`. Gating it would let the Features tab produce an app whose
    // landing route bounces off FeatureRoute. Same rule `dashboard` had.
    const gated = new Set<string>(Object.values(FEATURES).flat());
    expect(gated.has("mission")).toBe(false);
  });

  it("sessions keeps its slug and route but is relabelled to a verb", () => {
    const terminal = NAV_ITEMS.find((i) => i.slug === "terminal");
    expect(terminal?.label).toBe("Run a session");
    expect(terminal?.path).toBe("/terminal");
    expect(terminal?.group).toBe("agents");
  });
});

describe("nav restructure (#165) — persisted group overrides", () => {
  beforeEach(() => {
    cleanup();
    vi.resetModules();
  });

  it("ignores a stale group key without crashing, and still honours a live one", async () => {
    const store = installLocalStorage();
    // What an existing user's browser actually holds after the rename.
    store.set(STORAGE_KEY, JSON.stringify({ workspace: false, tools: true }));

    const { useNavGroups } = await import("../../stores/nav-group-store");
    // The store reads localStorage at module scope, so importing it after the
    // payload is in place is what exercises `readInitial`.
    expect(typeof useNavGroups).toBe("function");

    // `tools` defaults closed; the stored `true` must win. `workspace` is not
    // a group any more and must simply not participate.
    const { result } = renderHook(() => useNavGroups());
    const { isOpen } = result.current;
    expect(isOpen("tools", false)).toBe(true);
    expect(isOpen("attention", true)).toBe(true);
  });

  it("falls back to defaults on a corrupt payload", async () => {
    const store = installLocalStorage();
    store.set(STORAGE_KEY, "not json at all");

    const { useNavGroups } = await import("../../stores/nav-group-store");
    const { result } = renderHook(() => useNavGroups());
    const { isOpen } = result.current;
    // Nothing stored is usable, so every group reports its declared default.
    for (const g of NAV_GROUPS) {
      expect(isOpen(g.id, g.defaultOpen)).toBe(g.defaultOpen);
    }
  });

  it("falls back to defaults when the payload is a non-object", async () => {
    const store = installLocalStorage();
    store.set(STORAGE_KEY, JSON.stringify(42));

    const { useNavGroups } = await import("../../stores/nav-group-store");
    const { result } = renderHook(() => useNavGroups());
    const { isOpen } = result.current;
    expect(isOpen("attention", true)).toBe(true);
    expect(isOpen("system", false)).toBe(false);
  });
});
