// Pure data transformations on the recursive terminal layout tree.
// No React, no Zustand, no IPC.

export type Direction = "h" | "v";

export interface PaneLeaf {
  type: "leaf";
  terminalId: string;
  title: string;
  cwd?: string;
  profileId?: string;
  /**
   * Command written to the PTY stdin after the shell is ready (e.g. a
   * provider CLI invocation from `applyGridLayout`).  Held in the in-memory
   * store for reference but intentionally stripped by `persistToStorage` before
   * the layout is written to localStorage, so the command is NOT re-issued when
   * the embedded Terminal page rehydrates on next open.
   */
  initCommand?: string;
  /**
   * When true this leaf has no backing PTY yet.  `<SplitContainer>` renders
   * `<EmptyPane />` instead of `<TerminalPane />`.  The `terminalId` field
   * holds a placeholder value (`pending-N`); it is replaced with a real PTY
   * id when the user clicks "Open shell here".
   */
  empty?: boolean;
  /**
   * When true the title was set by the user via the double-click rename flow.
   * OSC 0 / OSC 2 handlers skip the leaf so the manual name is preserved even
   * if the shell emits a new title sequence.
   */
  manualTitle?: boolean;
  /**
   * Set to true when the backing PTY process exits naturally (the reader
   * thread fires `pty-exited`).  The pane remains visible so the user can
   * read final output; the tab strip shows a subtle dim indicator.
   */
  exited?: boolean;
}

export interface Split {
  type: "split";
  direction: Direction;
  children: [LayoutNode, LayoutNode];
  ratio: number;
}

export type LayoutNode = PaneLeaf | Split;

export function splitLeaf(
  root: LayoutNode,
  targetId: string,
  direction: Direction,
  newLeaf: PaneLeaf,
): LayoutNode {
  if (root.type === "leaf") {
    if (root.terminalId !== targetId) return root;
    return {
      type: "split",
      direction,
      children: [root, newLeaf],
      ratio: 0.5,
    };
  }
  const [left, right] = root.children;
  return {
    ...root,
    children: [
      splitLeaf(left, targetId, direction, newLeaf),
      splitLeaf(right, targetId, direction, newLeaf),
    ],
  };
}

/**
 * Remove the leaf with `targetId` from the tree. The sibling of the removed
 * leaf collapses to take its parent split's place.
 *
 * Returns `[newRoot, wasLastLeaf]`. When `wasLastLeaf` is true the caller
 * should drop the tab entirely; the returned `newRoot` is the original root
 * (effectively unchanged) since there is nothing meaningful to keep.
 */
export function closeLeaf(
  root: LayoutNode,
  targetId: string,
): [LayoutNode, boolean] {
  if (root.type === "leaf") {
    if (root.terminalId === targetId) return [root, true];
    return [root, false];
  }
  const [left, right] = root.children;
  if (left.type === "leaf" && left.terminalId === targetId) {
    return [right, false];
  }
  if (right.type === "leaf" && right.terminalId === targetId) {
    return [left, false];
  }
  const [newLeft, leftWasLast] = closeLeaf(left, targetId);
  if (newLeft !== left) {
    if (leftWasLast) return [right, false];
    return [{ ...root, children: [newLeft, right] }, false];
  }
  const [newRight, rightWasLast] = closeLeaf(right, targetId);
  if (newRight !== right) {
    if (rightWasLast) return [left, false];
    return [{ ...root, children: [left, newRight] }, false];
  }
  return [root, false];
}

export function collectLeafIds(root: LayoutNode): string[] {
  if (root.type === "leaf") return [root.terminalId];
  return [
    ...collectLeafIds(root.children[0]),
    ...collectLeafIds(root.children[1]),
  ];
}

export function collectLeaves(root: LayoutNode): PaneLeaf[] {
  if (root.type === "leaf") return [root];
  return [
    ...collectLeaves(root.children[0]),
    ...collectLeaves(root.children[1]),
  ];
}

export function replaceLeafId(
  root: LayoutNode,
  oldId: string,
  newId: string,
): LayoutNode {
  if (root.type === "leaf") {
    if (root.terminalId !== oldId) return root;
    return { ...root, terminalId: newId };
  }
  return {
    ...root,
    children: [
      replaceLeafId(root.children[0], oldId, newId),
      replaceLeafId(root.children[1], oldId, newId),
    ],
  };
}

export function findLeaf(root: LayoutNode, targetId: string): PaneLeaf | null {
  if (root.type === "leaf") {
    return root.terminalId === targetId ? root : null;
  }
  return (
    findLeaf(root.children[0], targetId) ?? findLeaf(root.children[1], targetId)
  );
}

export function updateLeafTitle(
  root: LayoutNode,
  targetId: string,
  title: string,
  manual?: boolean,
): LayoutNode {
  if (root.type === "leaf") {
    if (root.terminalId !== targetId) return root;
    return {
      ...root,
      title,
      ...(manual === true ? { manualTitle: true } : {}),
    };
  }
  return {
    ...root,
    children: [
      updateLeafTitle(root.children[0], targetId, title, manual),
      updateLeafTitle(root.children[1], targetId, title, manual),
    ],
  };
}

export function updateLeafCwd(
  root: LayoutNode,
  targetId: string,
  cwd: string,
): LayoutNode {
  if (root.type === "leaf") {
    if (root.terminalId !== targetId) return root;
    return { ...root, cwd };
  }
  return {
    ...root,
    children: [
      updateLeafCwd(root.children[0], targetId, cwd),
      updateLeafCwd(root.children[1], targetId, cwd),
    ],
  };
}

/**
 * Recursively clamp every `Split.ratio` in the tree to `[min, max]`.
 *
 * Used on the hydration path to prevent a corrupted localStorage value from
 * producing a near-zero pane that visually escapes the panel bounds.
 * `react-resizable-panels` enforces `minSize={5}` for live drags but not for
 * the initial layout restore.
 */
export function clampSplitRatios(
  root: LayoutNode,
  min = 0.05,
  max = 0.95,
): LayoutNode {
  if (root.type === "leaf") return root;
  const ratio = Math.min(max, Math.max(min, root.ratio));
  return {
    ...root,
    ratio,
    children: [
      clampSplitRatios(root.children[0], min, max),
      clampSplitRatios(root.children[1], min, max),
    ],
  };
}

/**
 * Walk the tree and update the ratio of the first split that has a child
 * (direct or indirect) leaf matching `targetId`. The most natural use is to
 * pass the focused leaf id and the new ratio observed from the panel-group
 * layout callback.
 */
export function updateSplitRatio(
  root: LayoutNode,
  splitContainsId: string,
  ratio: number,
): LayoutNode {
  if (root.type === "leaf") return root;
  const leftIds = collectLeafIds(root.children[0]);
  if (leftIds.includes(splitContainsId)) {
    return { ...root, ratio, children: root.children };
  }
  const rightIds = collectLeafIds(root.children[1]);
  if (rightIds.includes(splitContainsId)) {
    return { ...root, ratio, children: root.children };
  }
  return root;
}

/**
 * Mark the leaf matching `targetId` as exited (or clear the flag).
 * A no-op if the leaf is not found.
 */
export function markLeafExited(
  root: LayoutNode,
  targetId: string,
  exited: boolean,
): LayoutNode {
  if (root.type === "leaf") {
    if (root.terminalId !== targetId) return root;
    return { ...root, exited };
  }
  return {
    ...root,
    children: [
      markLeafExited(root.children[0], targetId, exited),
      markLeafExited(root.children[1], targetId, exited),
    ],
  };
}
