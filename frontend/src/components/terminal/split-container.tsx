import { useRef } from "react";
import type { ReactElement } from "react";
import { Group, Panel, Separator, type Layout } from "react-resizable-panels";
import type { LayoutNode } from "../../lib/layout-tree";
import { collectLeafIds, paneKind } from "../../lib/layout-tree";
import { useTerminalStore } from "../../stores/terminal-store";
import { TerminalPane } from "./terminal-pane";
import { EmptyPane } from "./empty-pane";
import { AgentPane, AgentPaneDisabled } from "./agent-pane";
import styles from "./split-container.module.css";

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
  /**
   * Whether the `composer` feature is on. Resolved once in `TerminalsLayout`
   * via `useComposerFeature()` and threaded through every recursion (the
   * same discipline `active` already documents above) rather than read here
   * — that would put a `useSyncExternalStore` subscription in a component
   * rendered per pane-tree node for no benefit, since the value is identical
   * across the whole tree.
   */
  composerEnabled: boolean;
}

export function SplitContainer({
  node,
  showHeader = true,
  active,
  composerEnabled,
}: SplitContainerProps): ReactElement {
  const maximizedLeafId = useTerminalStore((s) => s.maximizedLeafId);

  if (node.type === "leaf") {
    const isMaximized = maximizedLeafId === node.terminalId;
    const leafClass = isMaximized
      ? `${styles.leaf} ${styles.leafMaximized}`
      : styles.leaf;
    if (node.empty === true) {
      return (
        <div className={leafClass}>
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
        <div className={leafClass}>
          {composerEnabled ? (
            <AgentPane
              leafId={node.terminalId}
              title={node.title}
              {...(node.cwd !== undefined ? { cwd: node.cwd } : {})}
              showHeader={showHeader || isMaximized}
              active={active}
            />
          ) : (
            <AgentPaneDisabled leafId={node.terminalId} />
          )}
        </div>
      );
    }
    return (
      <div className={leafClass}>
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
  return <SplitNode node={node} active={active} composerEnabled={composerEnabled} />;
}

function SplitNode({
  node,
  active,
  composerEnabled,
}: {
  node: Extract<LayoutNode, { type: "split" }>;
  active: boolean;
  composerEnabled: boolean;
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
        <SplitContainer
          node={node.children[0]}
          showHeader
          active={active}
          composerEnabled={composerEnabled}
        />
      </Panel>
      <Separator
        className={
          orientation === "horizontal" ? styles.handleH : styles.handleV
        }
      />
      <Panel id={rightLeafId} defaultSize={`${100 - initialSize}%`} minSize="5%">
        <SplitContainer
          node={node.children[1]}
          showHeader
          active={active}
          composerEnabled={composerEnabled}
        />
      </Panel>
    </Group>
  );
}
