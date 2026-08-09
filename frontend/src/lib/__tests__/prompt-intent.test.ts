import { describe, it, expect } from "vitest";
import {
  classifyIntent,
  parseLibraryRef,
  parseCommandLine,
  detectTrigger,
} from "../prompt-intent";

describe("prompt-intent module load", () => {
  it("has no imports and resolves cleanly on its own", async () => {
    // This module is deliberately zero-imports (so it can never participate
    // in an import cycle — the reason `module-load-order.test.ts` exists).
    // Importing it standalone, first, must never throw a TDZ error.
    const mod = await import("../prompt-intent");
    expect(typeof mod.classifyIntent).toBe("function");
  });
});

describe("classifyIntent", () => {
  // The move out of `api.ts` must be behaviour-preserving.
  it("keeps its five kinds", () => {
    expect(classifyIntent("").kind).toBe("command-palette");
    expect(classifyIntent("/x")).toEqual({ kind: "slash", payload: "x" });
    expect(classifyIntent("@x")).toEqual({ kind: "reference", payload: "x" });
    // `hi?` is only 3 characters, under the ≥4-length floor that keeps a
    // short "??" from reading as a prompt, so it is `search`; `wow?` clears
    // that floor and ends in `?`, so it is `prompt`.
    expect(classifyIntent("hi?")).toEqual({ kind: "search", payload: "hi?" });
    expect(classifyIntent("wow?")).toEqual({ kind: "prompt", payload: "wow?" });
    expect(classifyIntent("abc")).toEqual({ kind: "search", payload: "abc" });
  });
});

describe("parseLibraryRef", () => {
  it("resolves a valid slug", () => {
    expect(parseLibraryRef("library:api-notes")).toEqual({ ok: true, slug: "api-notes" });
  });

  it("reports an empty slug", () => {
    expect(parseLibraryRef("library:")).toEqual({ ok: false, reason: "empty", slug: "" });
  });

  it("reports an invalid slug", () => {
    expect(parseLibraryRef("library:!!!")).toEqual({
      ok: false,
      reason: "invalid",
      slug: "!!!",
    });
  });

  // Not `"library:Bad Slug!"`: the spec's own algorithm ("slug = everything
  // up to the first whitespace, lowercased") truncates at the space *before*
  // validating, so this resolves to the valid slug `"bad"` — exactly the
  // pre-existing omni-bar behaviour (`rest.split(/\s/, 1)[0]`) this
  // extraction must stay byte-identical to.
  it("truncates at the first whitespace before validating, matching the pre-existing omni-bar behaviour", () => {
    expect(parseLibraryRef("library:Bad Slug!")).toEqual({ ok: true, slug: "bad" });
  });

  it("is case-insensitive on the prefix", () => {
    expect(parseLibraryRef("Library:X")).toEqual({ ok: true, slug: "x" });
  });

  it("returns null for a non-library reference", () => {
    expect(parseLibraryRef("alice")).toBeNull();
  });
});

describe("parseCommandLine", () => {
  it("splits name and argument", () => {
    expect(parseCommandLine("/model opus")).toEqual({ start: 0, name: "model", arg: "opus" });
  });

  it("reads leading whitespace into `start`", () => {
    expect(parseCommandLine("  /clear")).toEqual({ start: 2, name: "clear", arg: "" });
  });

  it("keeps interior spaces in the argument", () => {
    expect(parseCommandLine("/compact focus on X")).toEqual({
      start: 0,
      name: "compact",
      arg: "focus on X",
    });
  });

  it("allows a bare slash with an empty name", () => {
    expect(parseCommandLine("/")).toEqual({ start: 0, name: "", arg: "" });
  });

  it("treats a trailing space with nothing after it as an empty argument", () => {
    expect(parseCommandLine("/model ")).toEqual({ start: 0, name: "model", arg: "" });
  });

  it("is null for plain prose", () => {
    expect(parseCommandLine("hi")).toBeNull();
  });

  it("is null when the slash is not at the start", () => {
    expect(parseCommandLine("hi /mo")).toBeNull();
  });

  // Round-1 gap 4: `^[ \t]*` and `[^\n]*` really do reject the newlines
  // Design decision 3 claims they do.
  it("rejects a newline inside the name", () => {
    expect(parseCommandLine("/model\nopus")).toBeNull();
  });

  it("rejects a newline inside the argument", () => {
    expect(parseCommandLine("/compact focus\nmore")).toBeNull();
  });

  it("rejects a newline after a complete command line — prose is never swallowed", () => {
    expect(parseCommandLine("/model opus\nplease explain")).toBeNull();
  });

  it("rejects a leading newline — a dropped/pasted line is never mistaken for a command", () => {
    expect(parseCommandLine("\n/clear")).toBeNull();
  });
});

describe("detectTrigger — slash", () => {
  it("triggers right after the command name", () => {
    expect(detectTrigger("/mo", 3)).toEqual({ kind: "slash", start: 0, query: "mo" });
  });

  it("reads `start` off the leading whitespace", () => {
    expect(detectTrigger("  /mo", 5)).toEqual({ kind: "slash", start: 2, query: "mo" });
  });

  it("survives the space after the command name — round-1 gap 1", () => {
    expect(detectTrigger("/model ", 7)).toEqual({ kind: "slash", start: 0, query: "model " });
  });

  it("keeps the argument query as the caret advances", () => {
    expect(detectTrigger("/model op", 9)).toEqual({ kind: "slash", start: 0, query: "model op" });
  });

  it("is a trigger with an empty query for a bare slash", () => {
    expect(detectTrigger("/", 1)).toEqual({ kind: "slash", start: 0, query: "" });
  });

  it("is null when the caret sits on the sigil itself", () => {
    expect(detectTrigger("/model", 0)).toBeNull();
  });

  it("is null when the slash is not at the start of the draft", () => {
    expect(detectTrigger("hi /mo", 6)).toBeNull();
  });

  it("triggers for a dropped absolute path — the menu is a completion aid, the registry decides what runs", () => {
    expect(detectTrigger("/Users/me/x.ts", 14)).toEqual({
      kind: "slash",
      start: 0,
      query: "Users/me/x.ts",
    });
  });

  it("never triggers across a newline — decision 3", () => {
    expect(detectTrigger("fix this\n/model opus", 20)).toBeNull();
  });
});

describe("detectTrigger — mention", () => {
  it("triggers right after the sigil", () => {
    expect(detectTrigger("@ali", 4)).toEqual({ kind: "mention", start: 0, query: "ali" });
  });

  it("stops at and includes a mid-word `@` — round-1 gap 2", () => {
    expect(detectTrigger("a@ali", 5)).toEqual({ kind: "mention", start: 1, query: "ali" });
  });

  it("treats `user@host` as a mention, not an email", () => {
    expect(detectTrigger("user@host", 9)).toEqual({ kind: "mention", start: 4, query: "host" });
  });

  it("is a trigger with an empty query for a bare `@`", () => {
    expect(detectTrigger("@", 1)).toEqual({ kind: "mention", start: 0, query: "" });
  });

  it("triggers with an empty query right after a fresh `@`", () => {
    expect(detectTrigger("hi @", 4)).toEqual({ kind: "mention", start: 3, query: "" });
  });

  it("is null when the caret sits before the `@`", () => {
    expect(detectTrigger("@ali", 0)).toBeNull();
  });

  it("keeps a `library:` payload as the query", () => {
    expect(detectTrigger("@library:api", 12)).toEqual({
      kind: "mention",
      start: 0,
      query: "library:api",
    });
  });
});

describe("detectTrigger — precedence", () => {
  it("prefers the caret-local mention over the draft-global slash", () => {
    expect(detectTrigger("/compact @ali", 13)).toEqual({
      kind: "mention",
      start: 9,
      query: "ali",
    });
  });
});
