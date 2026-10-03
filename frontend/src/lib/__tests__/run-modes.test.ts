import { describe, expect, it } from "vitest";

import { runModeOptions } from "../run-modes";

describe("runModeOptions", () => {
  it("offers only background for a new schedule", () => {
    const options = runModeOptions("background");
    expect(options.map((o) => o.value)).toEqual(["background"]);
  });

  it("never offers windowed as a choice a new schedule can make", () => {
    // The whole point of #44: the shell does not branch on run_mode, so
    // picking "Windowed" ran headless anyway. The picker must not offer it.
    expect(runModeOptions("background").some((o) => o.value === "windowed")).toBe(
      false,
    );
  });

  it("still shows windowed for a schedule already saved that way", () => {
    const options = runModeOptions("windowed");
    expect(options.map((o) => o.value)).toEqual(["background", "windowed"]);
  });

  it("labels a legacy windowed schedule with what it actually does", () => {
    const windowed = runModeOptions("windowed").find(
      (o) => o.value === "windowed",
    );
    expect(windowed?.label).toMatch(/headless/i);
    expect(windowed?.label).toMatch(/not built yet/i);
  });

  it("always lets a legacy windowed schedule switch to background", () => {
    expect(runModeOptions("windowed")[0]?.value).toBe("background");
  });
});
