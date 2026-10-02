import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactElement } from "react";
import { Group, Panel, Separator, type Layout } from "react-resizable-panels";
import type { LayoutNode } from "../../lib/layout-tree";
import { collectLeafIds, paneKind } from "../../lib/layout-tree";
import { useTerminalStore } from "../../stores/terminal-store";
import { TerminalPane } from "./terminal-pane";
import { EmptyPane } from "./empty-pane";
import { AgentPane } from "./agent-pane";

/* ── Local constants ─────────────────────────────────────────────────────
   Split geometry. Deck draws the pane area (`.dk-sess__panes`) and the
   sidebar's own grip (`.dk-side__rz`, absolutely positioned inside
   `.dk-side`); it has no separator between two resizable panels, and no
   maximised-leaf overlay. Declared here rather than in `components/deck/*` or
   `design/deck/*`, which #283 does not touch — the precedent is the composer's
   `EDITOR_*` constants and `pages/attention.tsx`'s `ATTENTION_COLS`.

   The Deck tokens resolve because every pane tree renders inside the sessions
   surface, which carries `.deck`. */

/** The drawn width of a grip. react-resizable-panels enlarges the *drag*
 *  target itself, so this is the hairline only, not the hit area. */
const HANDLE_THICKNESS_PX = 4;

const HANDLE_BASE_STYLE: CSSProperties = {
  background: "transparent",
  transition: "background 120ms ease",
};

const HANDLE_H_STYLE: CSSProperties = {
  ...HANDLE_BASE_STYLE,
  width: HANDLE_THICKNESS_PX,
  cursor: "col-resize",
};

const HANDLE_V_STYLE: CSSProperties = {
  ...HANDLE_BASE_STYLE,
  height: HANDLE_THICKNESS_PX,
  cursor: "row-resize",
};

/** Lit while the pointer is over the grip, or a drag is in flight. */
const HANDLE_LIT_BACKGROUND = "var(--line-2)";

/** A leaf fills its panel and clips; the pane inside owns its own chrome. */
const LEAF_STYLE: CSSProperties = {
  height: "100%",
  width: "100%",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  minHeight: 0,
  minWidth: 0,
};

/** Maximised: the leaf covers the whole pane area. Opaque, because the tree it
 *  hides stays mounted and keeps painting underneath. `.dk-scrim` is the
 *  nearest Deck surface and is the wrong one — it is `position: fixed` over the
 *  window with a dimmed backdrop, where this is an in-flow pane at full size. */
const LEAF_MAXIMIZED_STYLE: CSSProperties = {
  ...LEAF_STYLE,
  position: "absolute",
  inset: 0,
  zIndex: 50,
  background: "var(--bg)",
};

/**
 * react-resizable-panels' own grip state, which it documents as the hook for
 * custom hover/active styling (`data-separator`: `inactive` | `hover` |
 * `active` | `focus` | `disabled`). Read off the attribute rather than from
 * `onPointerEnter`, because a drag that travels past the 4px grip would
 * otherwise drop the highlight mid-resize.
 *
 * The pre-Deck stylesheet selected `[data-resize-handle-active]`, which v4 does
 * not emit at all — the active highlight has been dead since the v2→v4 upgrade
 * and comes back here.
 */
function useSeparatorState(el: HTMLDivElement | null): string {
  const [state, setState] = useState("inactive");
  useEffect(() => {
    if (el === null) return;
    const read = (): void =>
      setState(el.getAttribute("data-separator") ?? "inactive");
    read();
    const observer = new MutationObserver(read);
    observer.observe(el, {
      attributes: true,
      attributeFilter: ["data-separator"],
    });
    return () => observer.disconnect();
  }, [el]);
  return state;
}

function SplitSeparator({ horizontal }: { horizontal: boolean }): ReactElement {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const state = useSeparatorState(el);
  const lit = state === "hover" || state === "active";
  const base = horizontal ? HANDLE_H_STYLE : HANDLE_V_STYLE;
  return (
    <Separator
      elementRef={setEl}
      style={lit ? { ...base, background: HANDLE_LIT_BACKGROUND } : base}
    />
  );
}

interface SplitContainerProps {
  node: LayoutNode;
  showHeader?: boolean;
  /**
   * Whether this pane tree belongs to the currently-active tab. Required (no
   * default) so every recursion site must thread it through explicitly —
   * `TerminalPane` uses it to gate its `document.body` portals (context menu,
   * paste modal) while the tab is hidden, and `noUnusedLocals`/strict TS
   * catch an omission.
   */
  active: boolean;
}

export function SplitContainer({
  node,
  showHeader = true,
  active,
}: SplitContainerProps): ReactElement {
  const maximizedLeafId = useTerminalStore((s) => s.maximizedLeafId);

  if (node.type === "leaf") {
    const isMaximized = maximizedLeafId === node.terminalId;
    const leafStyle = isMaximized ? LEAF_MAXIMIZED_STYLE : LEAF_STYLE;
    if (node.empty === true) {
      return (
        <div style={leafStyle}>
          <EmptyPane
            leafId={node.terminalId}
            cwd={node.cwd}
            initCommand={node.initCommand}
          />
        </div>
      );
    }
    if (paneKind(node) === "agent") {
      return (
        <div style={leafStyle}>
          <AgentPane
            leafId={node.terminalId}
            title={node.title}
            {...(node.cwd !== undefined ? { cwd: node.cwd } : {})}
            {...(node.providerId !== undefined ? { providerId: node.providerId } : {})}
            {...(node.model !== undefined ? { model: node.model } : {})}
            {...(node.permissionMode !== undefined
              ? { permissionMode: node.permissionMode }
              : {})}
            {...(node.seed !== undefined ? { seed: node.seed } : {})}
            showHeader={showHeader || isMaximized}
            active={active}
          />
        </div>
      );
    }
    return (
      <div style={leafStyle}>
        <TerminalPane
          terminalId={node.terminalId}
          title={node.title}
          {...(node.cwd !== undefined ? { cwd: node.cwd } : {})}
          {...(node.profileId !== undefined
            ? { profileId: node.profileId }
            : {})}
          showHeader={showHeader || isMaximized}
          active={active}
        />
      </div>
    );
  }
  return <SplitNode node={node} active={active} />;
}

function SplitNode({
  node,
  active,
}: {
  node: Extract<LayoutNode, { type: "split" }>;
  active: boolean;
}): ReactElement {
  const updateRatio = useTerminalStore((s) => s.updateRatio);
  const debounceRef = useRef<number | null>(null);
  const orientation = node.direction === "h" ? "horizontal" : "vertical";

  // Use the first leaf id of each child as stable identities for Panel and
  // for the PanelGroup key so react-resizable-panels remounts cleanly when
  // the split structure changes (e.g. a sibling pane is closed).
  const leftLeafId = collectLeafIds(node.children[0])[0] ?? "";
  const rightLeafId = collectLeafIds(node.children[1])[0] ?? "";
  // Keep the existing updateRatio reference under its original name.
  const refLeafId = leftLeafId;
  // Encodes direction + both child leaf ids: changes when the subtree shape
  // changes, forcing PanelGroup to remount with a fresh size registry.
  const groupKey = `${node.direction}-${leftLeafId}-${rightLeafId}`;

  // v4 reports layout as a { [panelId]: size } map rather than an ordered
  // array. Derive the ratio from the two sibling sizes directly so it stays
  // correct regardless of the unit the library reports (px vs %).
  const handleLayout = (layout: Layout): void => {
    const left = layout[leftLeafId];
    const right = layout[rightLeafId];
    if (left === undefined || right === undefined) return;
    const total = left + right;
    if (total <= 0) return;
    const ratio = left / total;
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      updateRatio(refLeafId, ratio);
      debounceRef.current = null;
    }, 50);
  };

  const initialSize = Math.round(node.ratio * 100);

  return (
    <Group key={groupKey} orientation={orientation} onLayoutChange={handleLayout}>
      <Panel id={leftLeafId} defaultSize={`${initialSize}%`} minSize="5%">
        <SplitContainer node={node.children[0]} showHeader active={active} />
      </Panel>
      <SplitSeparator horizontal={orientation === "horizontal"} />
      <Panel id={rightLeafId} defaultSize={`${100 - initialSize}%`} minSize="5%">
        <SplitContainer node={node.children[1]} showHeader active={active} />
      </Panel>
    </Group>
  );
}
