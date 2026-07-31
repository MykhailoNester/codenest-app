import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { TerminalsLayout } from "./terminal";
import { FindPaletteOverlay } from "../components/explorer/find-palette-overlay";
import { useEvent, closeTerminal, agentStop } from "../lib/ipc";
import {
  useTerminalStore,
  TERMINAL_STORAGE_KEY,
} from "../stores/terminal-store";
import { collectLeaves, paneKind } from "../lib/layout-tree";
import { recordAgentExitedAndWait } from "../lib/agent-run-telemetry";
import { useAgentSessionStore } from "../stores/agent-session-store";
import * as pendingLaunchStore from "../stores/pending-launch-store";
import styles from "./terminal-window-root.module.css";
import { listen } from "@tauri-apps/api/event";

/**
 * Root of the detached "terminals" window. Mounted when
 * `window.location.hash === "#/window/terminals"`. Renders the terminals
 * layout full-screen (no sidebar, no topbar) and owns the sidecar-crash
 * overlay.
 *
 * The close-confirmation dialog has been removed. Closing the popout window
 * immediately kills every PTY that was opened in it — the WebView is being
 * torn down anyway so there is nothing left to "keep running". This matches
 * the actual cleanup behaviour and avoids showing a misleading count that
 * included zombie handles for shells that had already exited.
 */
export function TerminalWindowRoot(): ReactElement {
  // Peek synchronously at render time (before any child effects fire) so we
  // can pass `skipHydration` to TerminalsLayout.  React runs child effects
  // before parent effects on mount, so the TerminalsLayout hydrateFromStorage
  // useEffect would otherwise create a default "Terminal 1" tab before our
  // own effect runs and calls applyGridLayout with the launch spec.
  const hasPendingLaunch = pendingLaunchStore.hasPendingPopoutLaunch();

  const [sidecarDown, setSidecarDown] = useState(false);
  const closeUnlistenRef = useRef<UnlistenFn | null>(null);
  const terminalStore = useTerminalStore();
  // The detached window gets the workspace navigator as well as the ⌘P palette.
  // This deliberately supersedes the original popout rule ("a detached window
  // never gets the 262 px panel, only the palette"): a popped-out pane is where
  // real work happens, and having to come back to the main window to browse the
  // tree — or to drag a file into the composer — was the thing that made the
  // popout feel like a lesser surface. Both windows now compose the same
  // navigator against the same store.

  // Tab-close handler for the detached window.  Uses `closeTabNoReSeed` so
  // that removing the last tab does not spawn a replacement shell — instead the
  // window closes itself.
  //
  // We call `destroy()` rather than `close()` here.  In Tauri 2, `close()`
  // fires a `WINDOW_CLOSE_REQUESTED` event to the JS listener registered via
  // `onCloseRequested`, which is expected to call `destroy()` after finishing
  // its async PTY cleanup.  That roundtrip is unreliable when the store has
  // already been emptied (zero tabs) and the tab-close/pty-exited event chain
  // is still settling.  Because `closeTabNoReSeed` already killed every PTY
  // before returning, the `onCloseRequested` cleanup work is already done and
  // `destroy()` is safe to call directly.
  const handleCloseTab = useCallback((tabId: string) => {
    void useTerminalStore
      .getState()
      .closeTabNoReSeed(tabId)
      .then((wentEmpty) => {
        if (wentEmpty) {
          void getCurrentWindow()
            .destroy()
            .catch((e) => {
              console.error("[TerminalWindowRoot] destroy() failed", e);
            });
        }
      });
  }, []);

  // Subscribe to sidecar lifecycle. Both events broadcast app-wide so the
  // popout window receives them without any routing changes in the shell.
  useEvent<unknown>("sidecar_crashed", () => setSidecarDown(true));
  useEvent<unknown>("sidecar_ready", () => setSidecarDown(false));

  // Consume any pending popout launch on mount, then subscribe to future ones.
  useEffect(() => {
    const spec = pendingLaunchStore.consume("popout");
    if (spec) {
      // A fresh launch is queued: wipe any stale persisted terminal state so
      // TerminalsLayout's hydrateFromStorage doesn't race against applyGridLayout
      // by replaying old initCommands into the same PTY stream (Bug A fix).
      try {
        localStorage.removeItem(TERMINAL_STORAGE_KEY);
      } catch {
        // ignore — localStorage unavailable in this WebView context
      }
      void terminalStore.applyGridLayout(spec).catch(() => undefined);
    }
    const unsub = pendingLaunchStore.subscribe("popout", (incoming) => {
      void terminalStore.applyGridLayout(incoming).catch(() => undefined);
    });
    return unsub;
    // terminalStore reference is stable from Zustand; omitting from deps is safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    const win = getCurrentWindow();

    void win
      .onCloseRequested(async () => {
        // Kill every child this window started so neither the Rust PtyManager
        // nor the AgentManager accumulates handles after the WebView is torn
        // down. Errors from individual calls are silenced — the window is
        // closing regardless.
        //
        // Agent leaves need `agentStop`, not `closeTerminal`: they have no PTY,
        // and `<AgentPane/>`'s unmount cleanup deliberately does not stop a
        // session whose leaf still exists (that is what keeps a session alive
        // across a sibling-close remount), so a closing popout must stop them
        // explicitly here. Both calls are idempotent for an unknown id, so the
        // split by kind is a clarity measure rather than a correctness one.
        const { tabs } = useTerminalStore.getState();
        const leaves = tabs.flatMap((t) => collectLeaves(t.layout));
        await Promise.allSettled(
          leaves.map((leaf) =>
            paneKind(leaf) === "agent"
              ? agentStop(leaf.terminalId)
              : closeTerminal(leaf.terminalId),
          ),
        );
        // Report the runs ended *before* the webview goes away, and await it.
        // The frame-driven report cannot fire here: the page that owns the
        // listener is being torn down, so the Command Center would keep showing
        // these sessions as live until something else swept them up. Awaiting a
        // loopback POST costs milliseconds against a window that is closing
        // anyway, and `reconcileAgentRuns` remains the backstop for the paths
        // that get no chance to report at all (a crash, or the app quitting).
        await Promise.allSettled(
          leaves.map((leaf) =>
            paneKind(leaf) === "agent"
              ? recordAgentExitedAndWait(
                  leaf.terminalId,
                  null,
                  useAgentSessionStore.getState().panes[leaf.terminalId]
                    ?.sessionId ?? null,
                )
              : Promise.resolve(),
          ),
        );
        // Allow the native close to proceed (no event.preventDefault()).
      })
      .then((dispose) => {
        if (cancelled) {
          dispose();
        } else {
          closeUnlistenRef.current = dispose;
        }
      });

    return () => {
      cancelled = true;
      closeUnlistenRef.current?.();
      closeUnlistenRef.current = null;
    };
  }, []);

  // focus-pane: raised by the main window's AGENTS panel Focus action for
  // popout agents.  Activates the tab that contains the named pane.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void listen<string>("focus-pane", (raw) => {
      const paneId = raw.payload;
      const store = useTerminalStore.getState();
      const owningTab = store.tabs.find((tab) =>
        collectLeaves(tab.layout).some((l) => l.terminalId === paneId),
      );
      if (owningTab) {
        store.setActiveTab(owningTab.id);
        store.setFocusedLeaf(paneId);
      }
    }).then((dispose) => {
      if (cancelled) dispose();
      else unlisten = dispose;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // stop-agent-pane: raised by the main window's AGENTS panel Stop action for
  // popout agents.  Removes the pane from this window's layout (searching all
  // tabs, not just the active one) and closes the window when no real panes
  // remain.
  //
  // Uses `closePaneForStop` instead of `closePane` so that removing the last
  // pane in the last tab does NOT trigger the re-seed logic in `closeTab`
  // (which would open a new PTY shell and keep the window alive).  The caller
  // (`AgentRunRow.handleStop`) already killed the PTY via `close_terminal`
  // before emitting this event.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void listen<string>("stop-agent-pane", (raw) => {
      const paneId = raw.payload;
      const store = useTerminalStore.getState();

      const removed = store.closePaneForStop(paneId);
      if (!removed) return;

      // After removal: if no real (non-empty-placeholder) panes remain across
      // all tabs, close the window.
      const remaining = useTerminalStore.getState().tabs;
      const anyPanes = remaining.some((tab) =>
        collectLeaves(tab.layout).some((l) => !l.empty),
      );
      if (!anyPanes) {
        void getCurrentWindow()
          .close()
          .catch(() => undefined);
      }
    }).then((dispose) => {
      if (cancelled) dispose();
      else unlisten = dispose;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className={styles.root}>
      {sidecarDown && (
        <div className={styles.banner} role="alert">
          <span className={styles.bannerDot} aria-hidden="true" />
          <span>
            Backend unavailable — active terminal sessions remain functional.
          </span>
        </div>
      )}
      <div className={styles.body}>
        {/* The palette is mounted here rather than inside `TerminalsLayout` so
            that component stays renderable without a `QueryClientProvider`
            (the palette needs one; three test files render the layout bare).
            `showNavigator` is safe for the same reason in reverse — this window
            is wrapped in a provider by `App`. */}
        <FindPaletteOverlay />
        <TerminalsLayout
          skipHydration={hasPendingLaunch}
          onCloseTab={handleCloseTab}
          showNavigator
        />
      </div>
    </div>
  );
}
