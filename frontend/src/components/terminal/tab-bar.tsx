import { useState } from "react";
import type { ReactElement, MouseEvent, KeyboardEvent } from "react";
import { useTerminalStore } from "../../stores/terminal-store";
import { collectLeaves } from "../../lib/layout-tree";
import styles from "./tab-bar.module.css";
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
    <div className={styles.bar} role="tablist">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const isEditing = editing?.tabId === tab.id;
        const hasExited = collectLeaves(tab.layout).some(
          (l) => l.exited === true,
        );
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={[
              styles.tab,
              isActive ? styles.tabActive : "",
              hasExited && !isActive ? styles.tabExited : "",
            ].join(" ")}
            onClick={() => setActiveTab(tab.id)}
            onDoubleClick={() => beginEdit(tab.id, tab.title)}
          >
            {isEditing ? (
              <input
                className={styles.titleInput}
                autoFocus
                value={editing.draft}
                onChange={(e) =>
                  setEditing({ tabId: tab.id, draft: e.target.value })
                }
                onBlur={commitEdit}
                onKeyDown={onKey}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className={styles.title}>{tab.title}</span>
            )}
            <span
              className={styles.close}
              onClick={(e) => onCloseClick(e, tab.id)}
              role="button"
              aria-label={`Close ${tab.title}`}
            >
              ×
            </span>
          </button>
        );
      })}
      <button
        type="button"
        className={styles.add}
        onClick={() => void addTab()}
        aria-label="New tab"
      >
        +
      </button>
      <ShortcutsHint />
    </div>
  );
}
