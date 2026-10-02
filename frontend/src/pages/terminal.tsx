import { Suspense, useCallback, useEffect } from "react";
import type { ReactElement } from "react";
import { useSearchParams } from "react-router-dom";
import { DeckShell } from "../components/deck/deck-shell";
import { RunsView } from "../components/sessions/runs-view";
import { TabBar } from "../components/terminal/tab-bar";
import { SplitContainer } from "../components/terminal/split-container";
import { WorkspaceNavigator } from "../components/explorer/workspace-navigator";
import { useTerminalShortcuts } from "../hooks/use-terminal-shortcuts";
import { useTerminalFileDrop } from "../hooks/use-terminal-file-drop";
import { useTerminalStore } from "../stores/terminal-store";

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
  /**
   * Whether this mount gets the 262 px workspace navigator panel at all.
   * `true` only for the main window (`TerminalPage`) — a popout is a focused
   * surface the panel would eat a third of, so `TerminalWindowRoot` omits this
   * and gets `<FindPaletteOverlay>` instead. Defaults to `false` so a bare
   * `render(<TerminalsLayout />)` (the persistence test) never renders it.
   */
  showNavigator?: boolean;
}

/**
 * The terminals layout body — tab bar + active pane tree. Used inside the
 * main app shell (`TerminalPage`) and inside the detached popout window
 * (`TerminalWindowRoot`) without sidebar/topbar wrapping.
 */
export function TerminalsLayout({
  skipHydration = false,
  onCloseTab,
  showNavigator = false,
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
      // applyPaneLayout — mark the store as hydrated immediately so the
      // persistence subscriber is active, but do not seed default tabs.
      setHydrated();
    } else {
      void hydrateFromStorage();
    }
  }, [hydrated, skipHydration, hydrateFromStorage, setHydrated]);

  const page = (
    <div className="dk-sess__main">
      <TabBar onCloseTab={onCloseTab} />
      <div className="dk-sess__panes">
        <Suspense fallback={null}>
          {tabs.length > 0 ? (
            tabs.map((tab) => (
              <div
                key={tab.id}
                className="dk-sess__tab"
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
            <div className="dk-sess__empty">
              {hydrated ? "No terminals" : "Starting…"}
            </div>
          )}
        </Suspense>
      </div>
    </div>
  );

  // Bare `page` when there is no navigator, rather than a row with the ⌘P
  // palette in the navigator's place. `TerminalsLayout` must stay renderable
  // with no `QueryClientProvider` — three test files render it directly — and
  // `<FindPaletteOverlay/>` is built on react-query, so the popout window
  // composes the palette itself (`TerminalWindowRoot`) instead of receiving it
  // from here. Same rendered result in the app, provider-free in a test.
  if (!showNavigator) return page;

  return (
    <div className="dk-sess">
      <WorkspaceNavigator />
      {page}
    </div>
  );
}

/**
 * The Sessions surface (#269). Two halves of the same thing, behind
 * `.dk-tabs`: **panes** is where a session runs, **runs** is the supervision
 * list the Command Center used to be — it listed the runs on one page and then
 * had to navigate here to act on one.
 *
 * The view lives in the query string (`?view=runs`, `?session=<id>`) so the
 * notification bell, search results and the deck home all keep a deep link
 * into a specific session.
 *
 * The panes stay mounted while the runs list is up, hidden with `visibility`
 * rather than `display`: an xterm that measures itself at zero gets its grid
 * wrong, and Focus has to land on a pane that is already the right size.
 */
export function TerminalPage(): ReactElement {
  const [params, setParams] = useSearchParams();
  const sessionId = params.get("session");
  const view = params.get("view") === "runs" || sessionId ? "runs" : "panes";

  const showPanes = useCallback(() => {
    const next = new URLSearchParams(params);
    next.delete("view");
    next.delete("session");
    setParams(next, { replace: true });
  }, [params, setParams]);

  const showRuns = useCallback(() => {
    const next = new URLSearchParams(params);
    next.set("view", "runs");
    setParams(next, { replace: true });
  }, [params, setParams]);

  const selectSession = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(params);
      next.set("view", "runs");
      if (id) next.set("session", id);
      else next.delete("session");
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  return (
    <DeckShell title="sessions" scrollable={false}>
      <div className="dk-tabs" role="tablist" aria-label="Sessions view">
        <button
          type="button"
          role="tab"
          aria-selected={view === "panes"}
          className={`dk-tab${view === "panes" ? " on" : ""}`}
          onClick={showPanes}
        >
          panes
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "runs"}
          className={`dk-tab${view === "runs" ? " on" : ""}`}
          onClick={showRuns}
        >
          runs
        </button>
      </div>

      <div
        style={{
          position: "relative",
          display: "flex",
          flex: "1 1 auto",
          minHeight: 0,
          minWidth: 0,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            visibility: view === "panes" ? "visible" : "hidden",
            pointerEvents: view === "panes" ? undefined : "none",
          }}
        >
          <TerminalsLayout showNavigator />
        </div>
        {view === "runs" && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              overflowY: "auto",
              background: "var(--bg)",
              padding: "var(--u6) var(--gut) var(--u8)",
            }}
          >
            <RunsView
              selectedId={sessionId}
              onSelect={selectSession}
              onShowPanes={showPanes}
            />
          </div>
        )}
      </div>
    </DeckShell>
  );
}
