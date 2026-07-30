import { describe, it, expect } from "vitest";
import { findFileStatus, gitStatusTone, gsClassFor } from "../git-status";
import type { GitFileStatus, GitRootStatus } from "../../ipc";

function fileStatus(overrides: Partial<GitFileStatus> & { path: string }): GitFileStatus {
  return {
    status: "M",
    staged: false,
    added: null,
    removed: null,
    origPath: null,
    ...overrides,
  };
}

function rootStatus(
  overrides: Partial<GitRootStatus> = {},
): GitRootStatus {
  return {
    root: "/repo",
    repoRoot: "/repo",
    isRepo: true,
    branch: "main",
    detached: false,
    dirty: true,
    ahead: null,
    behind: null,
    files: [],
    truncated: false,
    error: null,
    ...overrides,
  };
}

describe("gitStatusTone", () => {
  it("maps A and C (copied) to the addition tone", () => {
    expect(gitStatusTone("A")).toBe("a");
    expect(gitStatusTone("C")).toBe("a");
  });

  it("maps D to the deletion tone", () => {
    expect(gitStatusTone("D")).toBe("d");
  });

  it("maps ? (untracked) and U (unmerged) to the unknown tone", () => {
    expect(gitStatusTone("?")).toBe("u");
    expect(gitStatusTone("U")).toBe("u");
  });

  it("maps M, R (renamed) and T (type change) to the modified tone", () => {
    expect(gitStatusTone("M")).toBe("m");
    expect(gitStatusTone("R")).toBe("m");
    expect(gitStatusTone("T")).toBe("m");
  });

  it("falls back to the modified tone for an unrecognised letter", () => {
    expect(gitStatusTone("Q")).toBe("m");
  });
});

describe("findFileStatus", () => {
  it("joins repoRoot + '/' + file.path to match an absolute path", () => {
    // GitFileStatus.path is repo-relative, NOT relative to the requested
    // root (git.rs:258-259) — this is the join both Workspace mode's `.gs`
    // letter and Changed mode's row must agree on.
    const git = rootStatus({
      repoRoot: "/repo",
      files: [fileStatus({ path: "src/a.ts", status: "M" })],
    });
    const found = findFileStatus(git, "/repo/src/a.ts");
    expect(found).toEqual(fileStatus({ path: "src/a.ts", status: "M" }));
  });

  it("returns undefined for a path outside the repo root", () => {
    const git = rootStatus({
      repoRoot: "/repo",
      files: [fileStatus({ path: "src/a.ts" })],
    });
    expect(findFileStatus(git, "/elsewhere/src/a.ts")).toBeUndefined();
  });

  it("returns undefined for a path git doesn't consider changed", () => {
    const git = rootStatus({
      repoRoot: "/repo",
      files: [fileStatus({ path: "src/a.ts" })],
    });
    expect(findFileStatus(git, "/repo/src/untouched.ts")).toBeUndefined();
  });

  it("returns undefined for a non-repo root (repoRoot null)", () => {
    const git = rootStatus({ repoRoot: null, isRepo: false, files: [] });
    expect(findFileStatus(git, "/repo/src/a.ts")).toBeUndefined();
  });

  it("returns undefined when git status hasn't resolved yet", () => {
    expect(findFileStatus(undefined, "/repo/src/a.ts")).toBeUndefined();
  });

  it("does not false-positive on a sibling directory sharing a path prefix", () => {
    // "/repo-other/x" starts with "/repo" but not with the "/repo/" prefix
    // the join requires — a naive startsWith(repoRoot) without the
    // trailing slash would wrongly match this.
    const git = rootStatus({
      repoRoot: "/repo",
      files: [fileStatus({ path: "x", status: "M" })],
    });
    expect(findFileStatus(git, "/repo-other/x")).toBeUndefined();
  });
});

describe("gsClassFor", () => {
  const classes = { gsA: "gsA", gsD: "gsD", gsU: "gsU", gsM: "gsM" };

  it("resolves each tone to its own class, from one shared implementation", () => {
    expect(gsClassFor("A", classes)).toBe("gsA");
    expect(gsClassFor("D", classes)).toBe("gsD");
    expect(gsClassFor("?", classes)).toBe("gsU");
    expect(gsClassFor("M", classes)).toBe("gsM");
  });

  it("falls back to an empty string for a class map missing the key", () => {
    expect(gsClassFor("A", {})).toBe("");
  });
});
