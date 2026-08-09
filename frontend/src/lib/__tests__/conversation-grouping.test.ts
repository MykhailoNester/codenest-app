// Transcript grouping: consecutive tool calls collapse into one summary line
// instead of one full-width row each, which is what made a session with a
// few hundred bash calls unreadable.

import { describe, it, expect } from "vitest";
import {
  groupTurnBlocks,
  summarizeToolRun,
  toolRunElapsedMs,
  toolRunErrorCount,
  toolRunHeadline,
  type ConvBlock,
  type ConvToolBlock,
} from "../agent-conversation";

function tool(over: Partial<ConvToolBlock> = {}): ConvToolBlock {
  return {
    type: "tool",
    id: over.id ?? `t${Math.round((over.startedAt ?? 0) * 1000)}`,
    name: "Bash",
    argSummary: "ls -la",
    diffstat: null,
    output: null,
    startedAt: 0,
    endedAt: 100,
    isError: false,
    ...over,
  } as ConvToolBlock;
}

const text = (t: string): ConvBlock => ({ type: "text", text: t }) as ConvBlock;

describe("groupTurnBlocks", () => {
  it("collapses a run of consecutive tool calls into one group", () => {
    const groups = groupTurnBlocks([
      tool({ id: "a" }),
      tool({ id: "b" }),
      tool({ id: "c" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe("toolRun");
  });

  it("leaves a lone tool call as its own row — its arguments earn the width", () => {
    const groups = groupTurnBlocks([tool({ id: "a" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe("block");
  });

  it("never reorders: a run stays between the prose around it", () => {
    const groups = groupTurnBlocks([
      text("before"),
      tool({ id: "a" }),
      tool({ id: "b" }),
      text("after"),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(["block", "toolRun", "block"]);
  });

  it("splits runs that prose interrupts rather than merging across it", () => {
    const groups = groupTurnBlocks([
      tool({ id: "a" }),
      tool({ id: "b" }),
      text("thinking out loud"),
      tool({ id: "c" }),
      tool({ id: "d" }),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(["toolRun", "block", "toolRun"]);
  });

  it("is a no-op on an empty turn", () => {
    expect(groupTurnBlocks([])).toEqual([]);
  });

  it("gives every group a stable distinct key", () => {
    const groups = groupTurnBlocks([tool({ id: "a" }), tool({ id: "b" }), text("x")]);
    const keys = groups.map((g) => g.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("summarizeToolRun", () => {
  it("counts per tool kind with the right plural", () => {
    expect(summarizeToolRun([tool(), tool(), tool()])).toBe("Running 3 commands");
    expect(summarizeToolRun([tool({ name: "Read" }), tool({ name: "Read" })])).toBe(
      "Reading 2 files",
    );
  });

  it("joins kinds in first-appearance order, not by count", () => {
    const summary = summarizeToolRun([
      tool({ name: "Read" }),
      tool({ name: "Bash" }),
      tool({ name: "Bash" }),
      tool({ name: "Bash" }),
    ]);
    expect(summary).toBe("Reading 1 file, running 3 commands");
  });

  it("names an unknown tool rather than dropping it from the count", () => {
    expect(summarizeToolRun([tool({ name: "Frobnicate" }), tool({ name: "Frobnicate" })])).toBe(
      "Running 2 Frobnicate calls",
    );
  });

  it("stops listing after three kinds and totals the rest", () => {
    const summary = summarizeToolRun([
      tool({ name: "Bash" }),
      tool({ name: "Read" }),
      tool({ name: "Edit" }),
      tool({ name: "Glob" }),
      tool({ name: "WebFetch" }),
    ]);
    expect(summary).toContain("and 2 more");
  });
});

describe("toolRunElapsedMs", () => {
  it("measures the wall-clock span, so parallel calls are not summed", () => {
    // Two calls that overlap completely: 100ms elapsed, not 200ms.
    expect(
      toolRunElapsedMs([
        tool({ startedAt: 1000, endedAt: 1100 }),
        tool({ startedAt: 1000, endedAt: 1100 }),
      ]),
    ).toBe(100);
  });

  it("is null while anything is still running", () => {
    expect(toolRunElapsedMs([tool({ endedAt: 100 }), tool({ endedAt: null })])).toBeNull();
  });
});

describe("toolRunHeadline", () => {
  it("prefers whatever is still running — what is it doing *now*", () => {
    const live = tool({ id: "live", endedAt: null });
    expect(toolRunHeadline([tool({ id: "done" }), live])?.id).toBe("live");
  });

  it("falls back to the last finished call once the run is over", () => {
    expect(toolRunHeadline([tool({ id: "a" }), tool({ id: "b" })])?.id).toBe("b");
  });
});

describe("toolRunErrorCount", () => {
  it("counts failures so an error cannot hide inside a folded run", () => {
    expect(toolRunErrorCount([tool(), tool({ isError: true }), tool({ isError: true })])).toBe(2);
  });
});
