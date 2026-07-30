import { describe, it, expect } from "vitest";
import { FEATURE_DEFAULTS, KNOWN_FEATURES_ORDERED, FEATURES } from "../nav-items";

// A distinct filename so the sibling task inserting a different slug after
// `feed` in this same run cannot collide on the same test file.
describe("nav-items — composer feature mirror", () => {
  it("defaults composer to off", () => {
    expect(FEATURE_DEFAULTS["composer"]).toBe(false);
  });

  it("lists composer immediately after budgets in KNOWN_FEATURES_ORDERED", () => {
    const budgetsIndex = KNOWN_FEATURES_ORDERED.indexOf("budgets");
    expect(budgetsIndex).toBeGreaterThanOrEqual(0);
    expect(KNOWN_FEATURES_ORDERED[budgetsIndex + 1]).toBe("composer");
  });

  it("has no composer entry in FEATURES — it gates pane chrome, not a nav slug", () => {
    expect(Object.prototype.hasOwnProperty.call(FEATURES, "composer")).toBe(
      false,
    );
  });
});
