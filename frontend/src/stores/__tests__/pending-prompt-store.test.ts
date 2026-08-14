import { describe, it, expect, beforeEach } from "vitest";
import {
  MAX_PENDING_PROMPTS,
  clearPendingPrompts,
  consumePendingPrompt,
  pendingPromptCount,
  stagePendingPrompt,
} from "../pending-prompt-store";

describe("pending-prompt-store", () => {
  beforeEach(() => {
    clearPendingPrompts();
  });

  it("stage then consume returns the prompt exactly once", () => {
    stagePendingPrompt("leaf-1", "do the thing");
    expect(consumePendingPrompt("leaf-1")).toBe("do the thing");
    // The acceptance criterion's core property: a second read is empty.
    expect(consumePendingPrompt("leaf-1")).toBeNull();
  });

  it("consume for a leaf id that was never staged returns null", () => {
    stagePendingPrompt("leaf-1", "for leaf-1 only");
    expect(consumePendingPrompt("leaf-unrelated")).toBeNull();
    // The staged entry is untouched by the unrelated read.
    expect(consumePendingPrompt("leaf-1")).toBe("for leaf-1 only");
  });

  it("a prompt with newlines, backticks and a fenced code block round-trips byte-for-byte", () => {
    const prompt = [
      "Fix the bug below:",
      "",
      "```ts",
      'const x = `hi ${1 + 1}`;',
      "```",
      "",
      "Thanks!",
    ].join("\n");
    stagePendingPrompt("leaf-1", prompt);
    expect(consumePendingPrompt("leaf-1")).toBe(prompt);
  });

  it("staging twice for one leaf keeps the second prompt", () => {
    stagePendingPrompt("leaf-1", "first");
    stagePendingPrompt("leaf-1", "second");
    expect(consumePendingPrompt("leaf-1")).toBe("second");
  });

  it("an empty prompt is never staged", () => {
    stagePendingPrompt("leaf-1", "");
    expect(pendingPromptCount()).toBe(0);
    expect(consumePendingPrompt("leaf-1")).toBeNull();
  });

  it("the registry is bounded: staging past MAX_PENDING_PROMPTS evicts the oldest entry", () => {
    const ids = Array.from(
      { length: MAX_PENDING_PROMPTS + 1 },
      (_, i) => `leaf-${i}`,
    );
    for (const id of ids) {
      stagePendingPrompt(id, `prompt for ${id}`);
    }
    expect(pendingPromptCount()).toBe(MAX_PENDING_PROMPTS);

    const oldest = ids[0];
    const newest = ids[ids.length - 1];
    if (oldest === undefined || newest === undefined) {
      throw new Error("expected at least two staged ids");
    }
    expect(consumePendingPrompt(oldest)).toBeNull();
    expect(consumePendingPrompt(newest)).toBe(`prompt for ${newest}`);
  });
});
