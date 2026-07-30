import { describe, it, expect } from "vitest";
import {
  nodeFromEntry,
  insertSorted,
  setChildren,
  patchTree,
  collectLoadedDirs,
  type TreeNode,
} from "../tree-model";
import type { DirEntryInfo, FsChange } from "../../ipc";

function entry(
  overrides: Partial<DirEntryInfo> & { name: string; path: string },
): DirEntryInfo {
  return {
    isDir: false,
    isSymlink: false,
    childCount: null,
    ...overrides,
  };
}

function change(
  overrides: Partial<FsChange> & { kind: FsChange["kind"]; path: string },
): FsChange {
  return {
    root: "/repo",
    fromPath: null,
    isDir: false,
    ...overrides,
  };
}

function makeTree(): TreeNode {
  // /repo
  //   src/          (loaded)
  //     a.ts        (loaded, no children — it's a file)
  //   README.md     (loaded, sibling used for the "pure" identity check)
  const aTs: TreeNode = {
    path: "/repo/src/a.ts",
    name: "a.ts",
    isDir: false,
    isSymlink: false,
    childCount: null,
    children: null,
  };
  const src: TreeNode = {
    path: "/repo/src",
    name: "src",
    isDir: true,
    isSymlink: false,
    childCount: 1,
    children: [aTs],
  };
  const readme: TreeNode = {
    path: "/repo/README.md",
    name: "README.md",
    isDir: false,
    isSymlink: false,
    childCount: null,
    children: null,
  };
  return {
    path: "/repo",
    name: "repo",
    isDir: true,
    isSymlink: false,
    childCount: 2,
    children: [src, readme],
  };
}

describe("nodeFromEntry", () => {
  it("maps a DirEntryInfo to an unloaded TreeNode", () => {
    const node = nodeFromEntry(
      entry({ name: "sub", path: "/repo/sub", isDir: true, childCount: 3 }),
    );
    expect(node).toEqual({
      path: "/repo/sub",
      name: "sub",
      isDir: true,
      isSymlink: false,
      childCount: 3,
      children: null,
    });
  });
});

describe("insertSorted", () => {
  it("puts dirs before files, then sorts case-insensitively", () => {
    const zeta: TreeNode = {
      ...nodeFromEntry(entry({ name: "Zeta", path: "/r/Zeta", isDir: true })),
    };
    const alpha: TreeNode = {
      ...nodeFromEntry(entry({ name: "alpha", path: "/r/alpha", isDir: true })),
    };
    const appleTxt: TreeNode = nodeFromEntry(
      entry({ name: "apple.txt", path: "/r/apple.txt" }),
    );

    let children: TreeNode[] = [];
    children = insertSorted(children, zeta);
    children = insertSorted(children, appleTxt);
    children = insertSorted(children, alpha);

    expect(children.map((c) => c.name)).toEqual(["alpha", "Zeta", "apple.txt"]);
  });
});

describe("setChildren", () => {
  it("caches a directory listing at the matching path", () => {
    const tree = makeTree();
    const next = setChildren(tree, "/repo", [
      entry({ name: "new.ts", path: "/repo/new.ts" }),
    ]);
    // Re-listing /repo itself replaces its children wholesale.
    expect(next.children?.map((c) => c.name)).toEqual(["new.ts"]);
  });
});

describe("patchTree", () => {
  it("pairs a rename into one moved node", () => {
    const tree = makeTree();
    const changes: FsChange[] = [
      change({
        kind: "moved",
        path: "/repo/src/b.ts",
        fromPath: "/repo/src/a.ts",
      }),
    ];

    const patched = patchTree(tree, changes, 1_000);
    const src = patched.children?.find((c) => c.name === "src");
    expect(src?.children?.some((c) => c.name === "a.ts")).toBe(false);
    const bTs = src?.children?.find((c) => c.name === "b.ts");
    expect(bTs).toBeDefined();
    expect(src?.children).toHaveLength(1);
    expect(bTs?.movedUntil).toBeGreaterThan(1_000);
  });

  it("keeps a moved directory's loaded children and expansion", () => {
    const tree = makeTree();
    // Move `src` itself (a loaded directory with a loaded child) to `lib`.
    const changes: FsChange[] = [
      change({
        kind: "moved",
        path: "/repo/lib",
        fromPath: "/repo/src",
        isDir: true,
      }),
    ];
    const patched = patchTree(tree, changes, 1_000);
    const lib = patched.children?.find((c) => c.name === "lib");
    expect(lib?.children).not.toBeNull();
    expect(lib?.children?.map((c) => c.name)).toEqual(["a.ts"]);
  });

  it("inserts a created file in the shell's sort order", () => {
    const tree = makeTree();
    const changes: FsChange[] = [
      change({ kind: "created", path: "/repo/AGENTS.md" }),
    ];
    const patched = patchTree(tree, changes, 1_000);
    // dirs (src) first, then case-insensitive name: AGENTS.md, README.md.
    expect(patched.children?.map((c) => c.name)).toEqual([
      "src",
      "AGENTS.md",
      "README.md",
    ]);
  });

  it("ignores a change under an unloaded parent but bumps its childCount", () => {
    const tree = makeTree();
    // `src/a.ts` has children: null (it's a file) — patch a "created" whose
    // parent is a collapsed, unloaded directory instead.
    const collapsed: TreeNode = {
      path: "/repo/docs",
      name: "docs",
      isDir: true,
      isSymlink: false,
      childCount: 2,
      children: null,
    };
    const withCollapsed: TreeNode = {
      ...tree,
      children: [...(tree.children ?? []), collapsed],
    };

    const patched = patchTree(
      withCollapsed,
      [change({ kind: "created", path: "/repo/docs/new.md" })],
      1_000,
    );
    const docs = patched.children?.find((c) => c.name === "docs");
    expect(docs?.children).toBeNull();
    expect(docs?.childCount).toBe(3);
  });

  it("drops the subtree on removed", () => {
    const tree = makeTree();
    const patched = patchTree(
      tree,
      [change({ kind: "removed", path: "/repo/src/a.ts" })],
      1_000,
    );
    const src = patched.children?.find((c) => c.name === "src");
    expect(src?.children).toHaveLength(0);
  });

  it("stamps changedAt on modified", () => {
    const tree = makeTree();
    const patched = patchTree(
      tree,
      [change({ kind: "modified", path: "/repo/README.md" })],
      42_000,
    );
    const readme = patched.children?.find((c) => c.name === "README.md");
    expect(readme?.changedAt).toBe(42_000);
  });

  it("is pure — an untouched sibling branch keeps its identity", () => {
    const tree = makeTree();
    const readmeBefore = tree.children?.find((c) => c.name === "README.md");
    const patched = patchTree(
      tree,
      [change({ kind: "modified", path: "/repo/src/a.ts" })],
      1_000,
    );
    const readmeAfter = patched.children?.find((c) => c.name === "README.md");
    expect(readmeAfter).toBe(readmeBefore);
    // The input tree itself was never mutated.
    const srcBefore = tree.children?.find((c) => c.name === "src");
    expect(srcBefore?.children?.[0]?.changedAt).toBeUndefined();
  });

  it("degrades a moved node with no known source to a created node", () => {
    const tree = makeTree();
    const patched = patchTree(
      tree,
      [
        change({
          kind: "moved",
          path: "/repo/arrived.ts",
          fromPath: "/repo/never-loaded.ts",
        }),
      ],
      1_000,
    );
    expect(patched.children?.some((c) => c.name === "arrived.ts")).toBe(true);
  });

  it("degrades a moved node with no loaded destination parent to removed", () => {
    const tree = makeTree();
    const patched = patchTree(
      tree,
      [
        change({
          kind: "moved",
          path: "/repo/unloaded-dir/b.ts",
          fromPath: "/repo/src/a.ts",
        }),
      ],
      1_000,
    );
    const src = patched.children?.find((c) => c.name === "src");
    expect(src?.children).toHaveLength(0);
    expect(patched.children?.some((c) => c.name === "unloaded-dir")).toBe(
      false,
    );
  });
});

describe("collectLoadedDirs", () => {
  it("returns every expanded directory", () => {
    const tree = makeTree();
    expect(collectLoadedDirs(tree).sort()).toEqual(
      ["/repo", "/repo/src"].sort(),
    );
  });
});
