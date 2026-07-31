import { describe, it, expect } from "vitest";
import { NAV_ITEMS, TERMINAL_ROUTE } from "../nav-items";

// The Sessions page is reached from three places that have to agree on one
// path: the `<Route>` in `App.tsx`, the sidebar item below, and the Command
// Center's Focus action. They did not — Focus navigated to `/terminals`, which
// matches no route, so focusing an *embedded* pane silently did nothing while
// the popout path (which raises a window instead of navigating) worked fine.
// `TERMINAL_ROUTE` is now the single source; these assertions are what stop a
// re-typed literal from drifting away from it again.
describe("nav routes", () => {
  it("gives the terminal nav item the shared route constant", () => {
    const item = NAV_ITEMS.find((i) => i.slug === "terminal");
    expect(item).toBeDefined();
    expect(item?.path).toBe(TERMINAL_ROUTE);
  });

  it("keeps the route singular — `/terminals` matches no route", () => {
    expect(TERMINAL_ROUTE).toBe("/terminal");
  });

  it("has no two nav items claiming the same path", () => {
    const paths = NAV_ITEMS.map((i) => i.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
