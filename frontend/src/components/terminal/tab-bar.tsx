import { useState } from "react";
import type { ReactElement, MouseEvent, KeyboardEvent } from "react";
import { useTerminalStore } from "../../stores/terminal-store";
import { collectLeaves, paneKind, type PaneKind } from "../../lib/layout-tree";
import type { DeckState } from "../deck/deck-grid";
import { Icon } from "../icon";
import { ShortcutsHint } from "./shortcuts-hint";

interface EditState {
  tabId: string;
  draft: string;
}

interface TabBarProps {
  /**
   * Optional override for the tab-close action.  When provided it replaces the
   * default `closeTab` store action.
   *
   * The detached "terminals" window passes a handler that calls
   * `closeTabNoReSeed` and closes the native window when the last tab is
   * removed.  The embedded terminal page omits this prop so the default
   * re-seed-on-empty behaviour is preserved.
   */
  onCloseTab?: (tabId: string) => void;
}

/**
 * The tab's state glyph, which replaces the old violet-square/grey-circle kind
 * dot. It carries the same information plus one the dot never did: a tab whose
 * pane has exited now says so in column one instead of only going dim.
 */
function tabState(kind: PaneKind, exited: boolean): DeckState {
  if (exited) return "fail";
  return kind === "shell" ? "idle" : "run";
}

export function TabBar({ onCloseTab }: TabBarProps): ReactElement {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const addTab = useTerminalStore((s) => s.addTab);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const setLeafTitle = useTerminalStore((s) => s.setLeafTitle);
  const renameTab = useTerminalStore((s) => s.renameTab);

  const [editing, setEditing] = useState<EditState | null>(null);

  const beginEdit = (tabId: string, currentTitle: string): void => {
    setEditing({ tabId, draft: currentTitle });
  };

  const commitEdit = (): void => {
    if (!editing) return;
    const tab = tabs.find((t) => t.id === editing.tabId);
    const trimmed = editing.draft.trim();
    if (tab && trimmed) {
      // Update the tab strip label — works for both single-pane and split tabs.
      renameTab(editing.tabId, trimmed);
      // For single-pane tabs also update the leaf with manual=true so OSC 0/2
      // sequences from the shell do not overwrite the user's label.
      if (tab.layout.type === "leaf") {
        setLeafTitle(tab.layout.terminalId, trimmed, true);
      }
    }
    setEditing(null);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") commitEdit();
    if (e.key === "Escape") setEditing(null);
  };

  const onCloseClick = (e: MouseEvent, tabId: string): void => {
    e.stopPropagation();
    if (onCloseTab) {
      onCloseTab(tabId);
    } else {
      void closeTab(tabId);
    }
  };

  return (
    <div className="dk-tabs" role="tablist">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const isEditing = editing?.tabId === tab.id;
        const leaves = collectLeaves(tab.layout);
        const hasExited = leaves.some((l) => l.exited === true);
        // A tab holds an agent pane, a shell pane, or a split of both. The
        // glyph reports what it *leads* with, so the strip is scannable now
        // that both kinds are routine.
        const leadKind =
          leaves[0] !== undefined ? paneKind(leaves[0]) : "shell";
        const state = tabState(leadKind, hasExited && !isActive);
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={isActive ? "dk-tab on" : "dk-tab"}
            onClick={() => setActiveTab(tab.id)}
            onDoubleClick={() => beginEdit(tab.id, tab.title)}
          >
            <span
              className="dk-s"
              role="img"
              aria-label={`${leadKind} pane`}
              data-s={state}
            />
            {isEditing ? (
              <span className="dk-field" style={{ height: 20 }}>
                <input
                  autoFocus
                  value={editing.draft}
                  onChange={(e) =>
                    setEditing({ tabId: tab.id, draft: e.target.value })
                  }
                  onBlur={commitEdit}
                  onKeyDown={onKey}
                  onClick={(e) => e.stopPropagation()}
                  style={{ width: "8rem" }}
                />
              </span>
            ) : (
              <span className="trunc" style={{ maxWidth: "12rem" }}>
                {tab.title}
              </span>
            )}
            <span
              className="dim"
              onClick={(e) => onCloseClick(e, tab.id)}
              role="button"
              aria-label={`Close ${tab.title}`}
            >
              ×
            </span>
          </button>
        );
      })}
      {/* `+` opens the default surface — an agent pane. The shell button beside
          it is the explicit opt-in, so a PTY stays one click away without being
          what a new tab gives you. */}
      <button
        type="button"
        className="dk-tab"
        onClick={() => void addTab()}
        aria-label="New agent tab"
        title="New agent tab (⌘T)"
      >
        +
      </button>
      <button
        type="button"
        className="dk-tab"
        onClick={() => void addTab({ kind: "shell" })}
        aria-label="New shell tab"
        title="New shell tab (⌥⌘T)"
      >
        <Icon name="terminal" size={12} stroke={1.7} />
      </button>
      <ShortcutsHint />
    </div>
  );
}
