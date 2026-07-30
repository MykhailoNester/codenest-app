import { describe, it, expect } from "vitest";
import { fuzzyMatch, fuzzyRank } from "../fuzzy";

/** Reconstruct the substring a match's ranges cover, for asserting the
 *  highlight is derived rather than guessed. */
function highlighted(candidate: string, ranges: [number, number][]): string {
  return ranges.map(([start, end]) => candidate.slice(start, end)).join("");
}

describe("fuzzyMatch", () => {
  it("matches a subsequence and reports the matched ranges", () => {
    const match = fuzzyMatch("useterm", "hooks/use-terminal-shortcuts.ts");
    expect(match).not.toBeNull();
    // The hyphen inside "use-terminal" is not part of the query, so it is
    // never covered by a range — only "use" and "term" are highlighted.
    expect(highlighted("hooks/use-terminal-shortcuts.ts", match!.ranges)).toBe(
      "useterm",
    );
  });

  it("rejects a non-subsequence", () => {
    expect(fuzzyMatch("zzz", "hooks/use-terminal.ts")).toBeNull();
  });

  it("ranks a basename hit above a directory hit", () => {
    const inBasename = fuzzyMatch("terminal", "terminal-pane.tsx");
    const inDirectory = fuzzyMatch("terminal", "terminal/other.ts");
    expect(inBasename).not.toBeNull();
    expect(inDirectory).not.toBeNull();
    expect(inBasename!.score).toBeGreaterThan(inDirectory!.score);
  });

  it("ranks a contiguous run above a scattered one", () => {
    const contiguous = fuzzyMatch("term", "terminal.ts");
    const scattered = fuzzyMatch("term", "the-early-return-map.ts");
    expect(contiguous).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(contiguous!.score).toBeGreaterThan(scattered!.score);
  });

  it("smart case: a lowercase query is case-insensitive", () => {
    expect(fuzzyMatch("term", "Terminal.ts")).not.toBeNull();
  });

  it("smart case: an uppercase query is case-sensitive", () => {
    expect(fuzzyMatch("Term", "terminal.ts")).toBeNull();
    expect(fuzzyMatch("Term", "Terminal.ts")).not.toBeNull();
  });

  it("an empty query matches everything with no ranges", () => {
    const match = fuzzyMatch("", "anything.ts");
    expect(match).toEqual({ index: 0, score: 0, ranges: [] });
  });
});

describe("fuzzyRank", () => {
  it("respects the limit", () => {
    const candidates = Array.from(
      { length: 10_000 },
      (_, i) => `src/module-${i}/file-term-${i}.ts`,
    );
    const ranked = fuzzyRank("term", candidates, (s) => s, 50);
    expect(ranked).toHaveLength(50);
  });

  it("orders results by score, best match first", () => {
    const candidates = ["terminal/other.ts", "terminal-pane.tsx"];
    const ranked = fuzzyRank("terminal", candidates, (s) => s, 10);
    expect(ranked.map((r) => r.item)).toEqual([
      "terminal-pane.tsx",
      "terminal/other.ts",
    ]);
  });

  it("excludes items that do not match at all", () => {
    const ranked = fuzzyRank("zzz", ["a.ts", "b.ts"], (s) => s, 10);
    expect(ranked).toHaveLength(0);
  });
});
