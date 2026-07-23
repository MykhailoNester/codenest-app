import { describe, it, expect } from "vitest";
import {
  splitLeaf,
  closeLeaf,
  collectLeafIds,
  replaceLeafId,
  type PaneLeaf,
  type LayoutNode,
} from "../layout-tree";

function leaf(id: string, title = id): PaneLeaf {
  return { type: "leaf", terminalId: id, title };
}

describe("layout-tree", () => {
  describe("splitLeaf", () => {
    it("splits a single leaf into a horizontal split", () => {
      const root: LayoutNode = leaf("a");
      const newLeaf = leaf("b");
      const out = splitLeaf(root, "a", "h", newLeaf);

      expect(out).toEqual({
        type: "split",
        direction: "h",
        ratio: 0.5,
        children: [leaf("a"), leaf("b")],
      });
    });

    it("splits a single leaf into a vertical split", () => {
      const root: LayoutNode = leaf("a");
      const out = splitLeaf(root, "a", "v", leaf("b"));
      if (out.type !== "split") throw new Error("expected split");
      expect(out.direction).toBe("v");
    });

    it("splits a nested target leaf without affecting siblings", () => {
      const root: LayoutNode = {
        type: "split",
        direction: "h",
        ratio: 0.5,
        children: [leaf("a"), leaf("b")],
      };
      const out = splitLeaf(root, "b", "v", leaf("c"));
      expect(out.type).toBe("split");
      if (out.type !== "split") throw new Error("unreachable");
      expect(out.children[0]).toEqual(leaf("a"));
      expect(out.children[1]).toEqual({
        type: "split",
        direction: "v",
        ratio: 0.5,
        children: [leaf("b"), leaf("c")],
      });
    });

    it("returns the same root when target id is not found", () => {
      const root: LayoutNode = leaf("a");
      const out = splitLeaf(root, "missing", "h", leaf("b"));
      expect(out).toBe(root);
    });
  });

  describe("closeLeaf", () => {
    it("collapses a split to the surviving sibling when closing one child", () => {
      const root: LayoutNode = {
        type: "split",
        direction: "h",
        ratio: 0.5,
        children: [leaf("a"), leaf("b")],
      };
      const [newRoot, wasLast] = closeLeaf(root, "a");
      expect(wasLast).toBe(false);
      expect(newRoot).toEqual(leaf("b"));
    });

    it("returns wasLastLeaf=true when closing the only leaf", () => {
      const root: LayoutNode = leaf("only");
      const [newRoot, wasLast] = closeLeaf(root, "only");
      expect(wasLast).toBe(true);
      expect(newRoot).toEqual(leaf("only"));
    });

    it("collapses nested splits correctly", () => {
      // Tree: split(h, [a, split(v, [b, c])])
      const inner: LayoutNode = {
        type: "split",
        direction: "v",
        ratio: 0.5,
        children: [leaf("b"), leaf("c")],
      };
      const root: LayoutNode = {
        type: "split",
        direction: "h",
        ratio: 0.5,
        children: [leaf("a"), inner],
      };
      const [newRoot, wasLast] = closeLeaf(root, "b");
      expect(wasLast).toBe(false);
      // Inner split collapses to leaf("c"); outer becomes split(h, [a, c])
      expect(newRoot).toEqual({
        type: "split",
        direction: "h",
        ratio: 0.5,
        children: [leaf("a"), leaf("c")],
      });
    });

    it("is a no-op when target id is not in the tree", () => {
      const root: LayoutNode = {
        type: "split",
        direction: "h",
        ratio: 0.5,
        children: [leaf("a"), leaf("b")],
      };
      const [newRoot, wasLast] = closeLeaf(root, "missing");
      expect(newRoot).toBe(root);
      expect(wasLast).toBe(false);
    });
  });

  describe("collectLeafIds", () => {
    it("returns a single id for a leaf root", () => {
      expect(collectLeafIds(leaf("a"))).toEqual(["a"]);
    });

    it("returns all leaf ids for a nested tree in left-to-right order", () => {
      const root: LayoutNode = {
        type: "split",
        direction: "h",
        ratio: 0.5,
        children: [
          leaf("a"),
          {
            type: "split",
            direction: "v",
            ratio: 0.5,
            children: [leaf("b"), leaf("c")],
          },
        ],
      };
      expect(collectLeafIds(root)).toEqual(["a", "b", "c"]);
    });
  });

  describe("replaceLeafId", () => {
    it("replaces a matching leaf id and leaves others alone", () => {
      const root: LayoutNode = {
        type: "split",
        direction: "h",
        ratio: 0.5,
        children: [leaf("a"), leaf("b")],
      };
      const out = replaceLeafId(root, "a", "A");
      if (out.type !== "split") throw new Error("expected split");
      expect((out.children[0] as PaneLeaf).terminalId).toBe("A");
      expect((out.children[1] as PaneLeaf).terminalId).toBe("b");
    });
  });
});
