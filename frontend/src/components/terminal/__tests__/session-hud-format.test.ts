import { describe, it, expect } from "vitest";
import {
  formatContextPercent,
  formatElapsed,
  formatModelLabel,
  formatTokens,
} from "../session-hud-format";

describe("formatModelLabel", () => {
  it("strips claude- and joins the numeric segments after a leading family token", () => {
    expect(formatModelLabel("claude-opus-4-8")).toBe("Opus 4.8");
  });

  it("title-cases a different family token", () => {
    expect(formatModelLabel("claude-sonnet-4-6")).toBe("Sonnet 4.6");
  });

  it("strips a trailing release date and finds a family token after leading numbers", () => {
    expect(formatModelLabel("claude-3-5-haiku-20241022")).toBe("Haiku 3.5");
  });

  it("returns an unrecognized vendor id completely unchanged", () => {
    expect(formatModelLabel("gpt-5")).toBe("gpt-5");
  });
});

describe("formatTokens", () => {
  it("passes small counts through verbatim", () => {
    expect(formatTokens(812)).toBe("812");
  });

  it("rounds to the nearest thousand above 1k", () => {
    expect(formatTokens(76_321)).toBe("76k");
  });

  it("formats a round window size", () => {
    expect(formatTokens(200_000)).toBe("200k");
  });
});

describe("formatElapsed", () => {
  it("renders bare seconds under a minute", () => {
    expect(formatElapsed(42)).toBe("42s");
  });

  it("zero-pads seconds in the minute tier (prototype parity)", () => {
    expect(formatElapsed(1084)).toBe("18m 04s");
  });

  it("switches to hours + zero-padded minutes past an hour", () => {
    expect(formatElapsed(7500)).toBe("2h 05m");
  });
});

describe("formatContextPercent", () => {
  it("computes a rounded percentage", () => {
    expect(formatContextPercent(76_000, 200_000)).toBe("38%");
  });

  it("guards against a zero window", () => {
    expect(formatContextPercent(1000, 0)).toBe("0%");
  });

  it("clamps to 100% when tokens exceed the window", () => {
    expect(formatContextPercent(250_000, 200_000)).toBe("100%");
  });
});
