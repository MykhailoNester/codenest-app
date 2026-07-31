import { describe, it, expect } from "vitest";
import { FEATURE_DEFAULTS, KNOWN_FEATURES_ORDERED, FEATURES } from "../nav-items";

// The `composer` (native agent pane) and `explorer` (workspace navigator)
// surfaces are unconditional parts of the Terminal page — they used to be
// toggleable, and this file is what stops them being reintroduced as gates on
// one side of the mirror only. The sidecar half is
// `tests/sidecar/test_composer_feature_toggle.py`.
describe("nav-items — retired feature slugs", () => {
  const retired = ["composer", "explorer"] as const;

  it("does not carry them in FEATURE_DEFAULTS", () => {
    for (const slug of retired) {
      expect(Object.prototype.hasOwnProperty.call(FEATURE_DEFAULTS, slug)).toBe(
        false,
      );
    }
  });

  it("does not list them in KNOWN_FEATURES_ORDERED", () => {
    for (const slug of retired) {
      expect(KNOWN_FEATURES_ORDERED).not.toContain(slug);
    }
  });

  it("does not gate any nav slug on them", () => {
    for (const slug of retired) {
      expect(Object.prototype.hasOwnProperty.call(FEATURES, slug)).toBe(false);
    }
  });

  it("keeps every FEATURES key toggleable via KNOWN_FEATURES_ORDERED", () => {
    // The mirror rule in AGENTS.md: a slug that gates nav items but is missing
    // from the ordered list can never be switched on, so a removal must not
    // leave one behind.
    for (const slug of Object.keys(FEATURES)) {
      expect(KNOWN_FEATURES_ORDERED).toContain(slug);
    }
  });
});
