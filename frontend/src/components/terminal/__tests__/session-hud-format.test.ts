import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  formatHudElapsed,
  formatToolElapsed,
  formatTokensShort,
  shortModelLabel,
  contextPercent,
  elapsedSecondsSince,
} from "../session-hud-format";

describe("formatHudElapsed", () => {
  it("renders bare seconds under a minute", () => {
    expect(formatHudElapsed(4)).toBe("4s");
  });

  it("zero-pads seconds in the minute tier (prototype parity)", () => {
    expect(formatHudElapsed(1084)).toBe("18m 04s");
  });

  it("switches to hours + zero-padded minutes past an hour", () => {
    expect(formatHudElapsed(3900)).toBe("1h 05m");
  });
});

describe("formatToolElapsed", () => {
  it("renders bare seconds for a fresh tool call", () => {
    expect(formatToolElapsed(1)).toBe("1s");
  });

  it("stays bare seconds up to two digits", () => {
    expect(formatToolElapsed(95)).toBe("95s");
  });

  it("switches to minutes + zero-padded seconds beyond that", () => {
    expect(formatToolElapsed(192)).toBe("3m 12s");
  });
});

describe("formatTokensShort", () => {
  it("passes small counts through verbatim", () => {
    expect(formatTokensShort(842)).toBe("842");
  });

  it("abbreviates thousands with a k suffix", () => {
    expect(formatTokensShort(76_000)).toBe("76k");
  });

  it("abbreviates millions with one decimal and an M suffix", () => {
    expect(formatTokensShort(1_240_000)).toBe("1.2M");
  });
});

describe("shortModelLabel", () => {
  it("strips a leading claude- and a trailing release date", () => {
    expect(shortModelLabel("claude-opus-4-5-20251101")).toBe("opus-4-5");
  });

  it("strips claude- but leaves a non-date suffix untouched", () => {
    expect(shortModelLabel("claude-opus-5[1m]")).toBe("opus-5[1m]");
  });

  it("passes an unrecognized vendor id through verbatim", () => {
    expect(shortModelLabel("gpt-5")).toBe("gpt-5");
  });
});

describe("contextPercent", () => {
  it("computes a rounded percentage", () => {
    expect(contextPercent(76_000, 200_000)).toBe(38);
  });

  it("guards against a zero window", () => {
    expect(contextPercent(1000, 0)).toBe(0);
  });

  it("clamps to 100 when tokens exceed the window", () => {
    expect(contextPercent(250_000, 200_000)).toBe(100);
  });
});

describe("elapsedSecondsSince", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:05:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("computes whole seconds against a naive-UTC timestamp", () => {
    // 4 minutes before the faked "now" — the sidecar emits this without a
    // trailing Z (naive UTC); parseUtcMs appends one.
    expect(elapsedSecondsSince("2026-01-01T00:01:00")).toBe(240);
  });

  it("accepts a space-separated timestamp (DEFAULT CURRENT_TIMESTAMP rows)", () => {
    expect(elapsedSecondsSince("2026-01-01 00:01:00")).toBe(240);
  });

  it("returns null, never 0 or NaN, for nullish or malformed input", () => {
    expect(elapsedSecondsSince(null)).toBeNull();
    expect(elapsedSecondsSince(undefined)).toBeNull();
    expect(elapsedSecondsSince("")).toBeNull();
    expect(elapsedSecondsSince("not-a-date")).toBeNull();
  });
});
