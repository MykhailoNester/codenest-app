import { Suspense, useEffect } from "react";
import type { ReactElement } from "react";
import { Shell } from "../components/layout/shell";
import { TabBar } from "../components/terminal/tab-bar";
import { SplitContainer } from "../components/terminal/split-container";
import { useTerminalShortcuts } from "../hooks/use-terminal-shortcuts";
import { useTerminalFileDrop } from "../hooks/use-terminal-file-drop";
import { useTerminalStore } from "../stores/terminal-store";
import styles from "./terminal.module.css";

interface TerminalsLayoutProps {
  /**
   * When `true`, skip the `hydrateFromStorage` call on mount.  Used by
   * `TerminalWindowRoot` when a pending popout launch spec is queued so the
   * store starts empty and only the spec's tabs are inserted — no default
   * "Terminal 1" tab is created first.
   */
  skipHydration?: boolean;
  /**
   * Optional override for the tab-close action.  When provided it replaces the
   * default `closeTab` store action in `TabBar`.
   *
   * Used by `TerminalWindowRoot` (the detached "terminals" window) to supply a
   * no-reseed variant that allows the tab list to reach zero and then closes
   * the native window.  The embedded `TerminalPage` omits this prop so the
   * default re-seed-on-empty behaviour is preserved.
   */
  onCloseTab?: (tabId: string) => void;
}

/**
 * The terminals layout body — tab bar + active pane tree. Used inside the
 * main app shell (`TerminalPage`) and inside the detached popout window
 * (`TerminalWindowRoot`) without sidebar/topbar wrapping.
 */
export function TerminalsLayout({
  skipHydration = false,
  onCloseTab,
}: TerminalsLayoutProps): ReactElement {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const hydrated = useTerminalStore((s) => s.hydrated);
  const hydrateFromStorage = useTerminalStore((s) => s.hydrateFromStorage);

  useTerminalShortcuts();
  useTerminalFileDrop();

  const setHydrated = useTerminalStore((s) => s.setHydrated);

  useEffect(() => {
    if (hydrated) return;
    if (skipHydration) {
      // A programmatic launch is about to populate the store via
      // applyGridLayout — mark the store as hydrated immediately so the
      // persistence subscriber is active, but do not seed default tabs.
      setHydrated();
    } else {
      void hydrateFromStorage();
    }
  }, [hydrated, skipHydration, hydrateFromStorage, setHydrated]);

  return (
    <div className={styles.page}>
      <TabBar onCloseTab={onCloseTab} />
      <div className={styles.paneArea}>
        <Suspense fallback={null}>
          {tabs.length > 0 ? (
            tabs.map((tab) => (
              <div
                key={tab.id}
                className={styles.tabPane}
                data-tab-pane={tab.id}
                data-active={tab.id === activeTabId ? "true" : "false"}
              >
                <SplitContainer
                  node={tab.layout}
                  showHeader={tab.layout.type === "split"}
                  active={tab.id === activeTabId}
                />
              </div>
            ))
          ) : (
            <div className={styles.empty}>
              {hydrated ? "No terminals" : "Starting…"}
            </div>
          )}
        </Suspense>
      </div>
    </div>
  );
}

export function TerminalPage(): ReactElement {
  return (
    <Shell scrollable={false}>
      <TerminalsLayout />
    </Shell>
  );
}
