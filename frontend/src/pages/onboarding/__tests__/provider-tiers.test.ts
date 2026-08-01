/**
 * `tiersFromModels` is the seed that decides whether onboarding writes a
 * provider's models at all.
 *
 * The bug it fixes: the step used to seed both `models` and `originalModels`
 * from DEFAULT_MODELS without ever asking what the provider actually had. The
 * commit loop only PUTs when the two differ, so a provider registered with an
 * empty `provider_models` table never got one written — the four tier inputs
 * showed Opus/Sonnet/Haiku/Fable, Next was clicked, and nothing was saved. The
 * agent pane then had no models to offer and its dropdown sat disabled on
 * "CLI default", unfixable from this screen no matter how many times it was
 * re-run.
 *
 * So the contract under test is: a null return means "treat as unsaved and
 * PUT", and it must be returned for every case where we do not positively know
 * a tier is persisted.
 */

import { describe, it, expect } from "vitest";
import { tiersFromModels } from "../provider-tiers";
import type { ProviderModel } from "../../../lib/api";

function row(overrides: Partial<ProviderModel>): ProviderModel {
  return {
    id: 1,
    provider_id: 1,
    model_name: "claude-opus-5",
    display_name: "Opus",
    is_default: true,
    is_enabled: true,
    ...overrides,
  };
}

describe("tiersFromModels", () => {
  it("returns null for a provider with no model rows — the case that must PUT", () => {
    expect(tiersFromModels([])).toBeNull();
  });

  it("returns null when the lookup failed, which is not the same as 'no models'", () => {
    expect(tiersFromModels(null)).toBeNull();
  });

  it("maps rows onto tiers by display_name and reports the default", () => {
    const seeded = tiersFromModels([
      row({ model_name: "claude-opus-5", display_name: "Opus", is_default: true }),
      row({ id: 2, model_name: "claude-sonnet-5", display_name: "Sonnet", is_default: false }),
    ]);
    expect(seeded).not.toBeNull();
    expect(seeded?.models["opus"]).toBe("claude-opus-5");
    expect(seeded?.models["sonnet"]).toBe("claude-sonnet-5");
    expect(seeded?.defaultTier).toBe("opus");
  });

  it("falls back to matching the model id when the label is not a tier name", () => {
    const seeded = tiersFromModels([
      row({ model_name: "claude-haiku-4-5", display_name: "cheap one", is_default: false }),
    ]);
    expect(seeded?.models["haiku"]).toBe("claude-haiku-4-5");
  });

  it("reports null when rows exist but none map onto a tier this screen offers", () => {
    expect(
      tiersFromModels([row({ model_name: "some-other-model", display_name: "Custom" })]),
    ).toBeNull();
  });

  it("marks an unpersisted tier as empty so the commit loop still writes it", () => {
    const seeded = tiersFromModels([
      row({ model_name: "claude-opus-5", display_name: "Opus", is_default: true }),
    ]);
    // The input shows a value the user can save…
    expect(seeded?.models["sonnet"]).toBe("claude-sonnet-5");
    // …but nothing claims it is already saved, so `modelsChanged` stays true.
    expect(seeded?.persisted["sonnet"]).toBe("");
    expect(seeded?.persisted["opus"]).toBe("claude-opus-5");
  });

  it("defaults the starred tier to opus when no row is marked default", () => {
    const seeded = tiersFromModels([
      row({ model_name: "claude-sonnet-5", display_name: "Sonnet", is_default: false }),
    ]);
    expect(seeded?.defaultTier).toBe("opus");
  });
});
