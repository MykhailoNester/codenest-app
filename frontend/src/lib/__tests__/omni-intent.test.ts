// Deliberately NOT named `prompt-intent.test.ts` — the sibling branch
// `feature/composer-slash-commands` adds a file by that name; a different
// filename turns what would be an add/add conflict into two coexisting
// suites (see the OmniBar plan's "Merge reconciliation" section).
import { describe, it, expect } from "vitest";
import { classifyIntent, parseLibraryRef } from "../prompt-intent";

describe("classifyIntent", () => {
  it('"" -> command-palette', () => {
    expect(classifyIntent("")).toEqual({ kind: "command-palette", payload: "" });
  });

  it('"  " -> command-palette', () => {
    expect(classifyIntent("  ")).toEqual({
      kind: "command-palette",
      payload: "",
    });
  });

  it('"/sched" -> slash payload "sched"', () => {
    expect(classifyIntent("/sched")).toEqual({ kind: "slash", payload: "sched" });
  });

  it('"  /x  " -> slash (trim before dispatch)', () => {
    expect(classifyIntent("  /x  ")).toEqual({ kind: "slash", payload: "x" });
  });

  it('"@ali" -> reference payload "ali"', () => {
    expect(classifyIntent("@ali")).toEqual({
      kind: "reference",
      payload: "ali",
    });
  });

  it('"docs" -> search', () => {
    expect(classifyIntent("docs")).toEqual({ kind: "search", payload: "docs" });
  });

  it('"how do I ship?" -> prompt', () => {
    expect(classifyIntent("how do I ship?")).toEqual({
      kind: "prompt",
      payload: "how do I ship?",
    });
  });

  it('"ab?" -> search (below the 4-char floor)', () => {
    expect(classifyIntent("ab?")).toEqual({ kind: "search", payload: "ab?" });
  });

  it('"a b" -> search (3 chars)', () => {
    expect(classifyIntent("a b")).toEqual({ kind: "search", payload: "a b" });
  });

  // Property pinned: the classifier survived the move byte-identically, so
  // app/services/intent_service.py:26-47 remains a true mirror. This suite
  // pins the TS half's exact input/output pairs; the Python half is tested
  // independently (see plan Follow-ups).
});

describe("parseLibraryRef", () => {
  it('"ali" -> null (not a library reference)', () => {
    expect(parseLibraryRef("ali")).toBeNull();
  });

  it('"library:dep-scan" -> {ok:true, slug:"dep-scan"}', () => {
    expect(parseLibraryRef("library:dep-scan")).toEqual({
      ok: true,
      slug: "dep-scan",
    });
  });

  it('"LIBRARY:Foo" -> {ok:true, slug:"foo"} (case folding)', () => {
    expect(parseLibraryRef("LIBRARY:Foo")).toEqual({ ok: true, slug: "foo" });
  });

  it('"library:" -> {ok:false, reason:"empty"}', () => {
    expect(parseLibraryRef("library:")).toEqual({
      ok: false,
      reason: "empty",
      slug: "",
    });
  });

  it('"library:-bad" -> {ok:false, reason:"invalid"}', () => {
    expect(parseLibraryRef("library:-bad")).toEqual({
      ok: false,
      reason: "invalid",
      slug: "-bad",
    });
  });

  it('"library:ok rest" -> slug "ok" (stops at whitespace)', () => {
    expect(parseLibraryRef("library:ok rest")).toEqual({
      ok: true,
      slug: "ok",
    });
  });
});
