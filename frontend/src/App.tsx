import {
  useCallback,
  useState,
  useEffect,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  MemoryRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { useTerminalStore } from "./stores/terminal-store";
import * as pendingLaunchStore from "./stores/pending-launch-store";
import {
  useTerminalSettings,
  useEnabledFeatures,
  useOnboardingState,
  SCREENSHOT_HOTKEY_DEFAULT,
} from "./lib/api";
import { FEATURES, TERMINAL_ROUTE } from "./lib/nav-items";
import {
  isRegistered as isShortcutRegistered,
  register as registerShortcut,
  unregister as unregisterShortcut,
} from "@tauri-apps/plugin-global-shortcut";
import {
  openScreenshotRing,
  requestNotificationPermission,
  useSidecarState,
} from "./lib/ipc";

import { CommandPalette } from "./components/command-palette";
import { StartupSplash } from "./components/startup-splash";
import { ToastHost } from "./components/toast-host";
import { CommandCenterPage } from "./pages/command-center";
import { DashboardPage } from "./pages/dashboard";
import { TasksPage } from "./pages/tasks";
import { TaskDetailPage } from "./pages/task-detail";
import { InProgressPage } from "./pages/in-progress";
// InboxPage is kept in the codebase for a future workflow_items/tasks table merge.
// The /inbox route now redirects to /tasks; InboxPage is no longer mounted.
// TODO: remove InboxPage and its import once workflow_items is merged into tasks.
import { TeamPage } from "./pages/team";
import { AgentDetailPage } from "./pages/agent-detail";
import { DocsPage } from "./pages/docs";
import { TerminalPage } from "./pages/terminal";
import { TerminalWindowRoot } from "./pages/terminal-window-root";
import { ScreenshotRingPage } from "./pages/screenshot-ring";
import { SettingsPage } from "./pages/settings";
import { ProjectsPage } from "./pages/projects";
import { MarkdownEditorPage } from "./pages/markdown-editor";
import { MarketplacePage } from "./pages/marketplace";
import { ParallelRunsPage } from "./pages/parallel-runs";
import { McpServersPage } from "./pages/mcp-servers";
import { SchedulesPage } from "./pages/schedules";
import { PreviewPage } from "./pages/preview";
import { LibraryPage } from "./pages/library";
import { BudgetsPage } from "./pages/budgets";
import { FeedPage } from "./pages/feed";
import { PluginsPage } from "./pages/plugins";
import { IntegrationsPage } from "./pages/integrations";
import { SyncPage } from "./pages/sync";
import { NotificationsPage } from "./pages/notifications";
import { OnboardingPage } from "./pages/onboarding";
import { WorkspaceSettingsPage } from "./pages/settings/workspace-settings";
import {
  isTerminalsWindow as isTerminalsWindowHash,
  isScreenshotRingWindow as isScreenshotRingWindowHash,
} from "./lib/window-target";

// ---------------------------------------------------------------------------
// FeatureRoute — hard-gate guard (Phase 1)
// ---------------------------------------------------------------------------

/**
 * Wraps a route's element.  When the feature that gates `navSlug` is
 * disabled, redirects to `/command`.
 *
 * Uses `useEnabledFeatures()` which is always complete (live > cache >
 * FEATURE_DEFAULTS), so the gate is deterministic from the very first
 * render — no need to hold children while lookups is loading.
 *
 * Usage:
 *   <FeatureRoute navSlug="tasks"><TasksPage /></FeatureRoute>
 */
function FeatureRoute({
  navSlug,
  children,
}: {
  navSlug: string;
  children: ReactNode;
}): ReactElement {
  const resolvedFeatures = useEnabledFeatures();

  // Find the feature(s) that gate this slug.
  for (const [feature, slugs] of Object.entries(FEATURES)) {
    if ((slugs as readonly string[]).includes(navSlug)) {
      if (resolvedFeatures[feature] === false) {
        return <Navigate to="/command" replace />;
      }
    }
  }

  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// OnboardingGate — Command Center first-run onboarding (after wizard)
// ---------------------------------------------------------------------------

/**
 * Full-screen branded splash shown while the onboarding state is still
 * unknown (sidecar starting, onboarding query in flight, or sidecar
 * crashed/unavailable). Rendering this instead of `children` is what keeps
 * the main Command Center from flashing for ~5 s on a fresh install before
 * the redirect to /onboarding fires — and equally prevents a returning user
 * from being sent back through onboarding when the sidecar is slow to start.
 */
function GateSplash({
  slow,
  onRetry,
}: {
  slow?: boolean;
  onRetry?: () => void;
}): ReactElement {
  return <StartupSplash slow={slow} onRetry={onRetry} />;
}

/**
 * Soft deadline (ms): how long the gate holds the plain splash before
 * surfacing a visible "still starting / Retry" affordance. The readiness poll
 * keeps running underneath — this only changes what the user sees, never the
 * routing decision.
 */
const SIDECAR_SLOW_DEADLINE_MS = 13_000;

/**
 * Sole first-run gate: redirects to `/onboarding` until the user finishes the
 * Command Center setup flow (`onboarding_completed`).
 *
 * Contract:
 * - The sidecar DB (`workspace_state.onboarding_completed`) is the SOLE source
 *   of truth. We never cache completion in localStorage: it survives a
 *   reinstall/DB-wipe and would desync from the DB, skipping onboarding on a
 *   genuinely fresh install.
 * - Redirect to `/onboarding` ONLY on a definitive DB answer of
 *   `completed: false`. A fresh install always sees onboarding.
 * - "Not yet known" — sidecar starting/crashed, query in flight, or query
 *   errored — is NEVER treated as a decision. We hold on the branded splash, so
 *   a slow/crashed sidecar can't wrongly bounce a returning user into
 *   onboarding (the original onboarding-bounce bug). Critically, we never
 *   coerce an errored onboarding read into `false` — that would re-onboard a
 *   completed user on a transient blip.
 * - Readiness comes from `useSidecarState`, which now POLLS the sidecar (it no
 *   longer dead-ends on a missed `sidecar_ready` event), so the splash always
 *   eventually resolves instead of hanging forever on a warm reopen.
 * - If the answer is still unknown after `SIDECAR_SLOW_DEADLINE_MS`, the splash
 *   shows a visible "still starting / Retry" affordance instead of an
 *   indefinite silent hold.
 */
function OnboardingGate({ children }: { children: ReactNode }): ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  const sidecarState = useSidecarState();
  const onboarding = useOnboardingState(sidecarState === "ready");

  // DB is the sole source of truth. `undefined` = not yet known (sidecar
  // starting/crashed, or query in flight/errored) — never coerced into a
  // decision.
  const dbCompleted: boolean | undefined = onboarding.isSuccess
    ? onboarding.data.completed
    : undefined;

  const onOnboarding = location.pathname === "/onboarding";

  // We have a definitive answer (or the onboarding page renders itself).
  const resolved = onOnboarding || dbCompleted !== undefined;

  // Soft deadline: surface the "still starting / Retry" affordance if we
  // haven't resolved in time. Never auto-redirects — purely cosmetic. The
  // timer arms only while unresolved-and-not-yet-slow, so resolving clears it
  // and a Retry (which sets `slow` back to false) re-arms it.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (resolved || slow) return;
    const t = setTimeout(() => setSlow(true), SIDECAR_SLOW_DEADLINE_MS);
    return () => clearTimeout(t);
  }, [resolved, slow]);

  // Redirect ONLY on a definitive "not onboarded" from the DB. Every other
  // state (starting, crashed, in-flight, errored) is unknown → the splash
  // below holds and we wait, never assuming first-run.
  useEffect(() => {
    if (dbCompleted === false && !onOnboarding) {
      navigate("/onboarding", { replace: true });
    }
  }, [dbCompleted, onOnboarding, navigate]);

  const handleRetry = useCallback(() => {
    setSlow(false);
    void onboarding.refetch();
  }, [onboarding]);

  // On the onboarding page → let it render. Confirmed onboarded → app shell.
  if (onOnboarding) return <>{children}</>;
  if (dbCompleted === true) return <>{children}</>;

  // dbCompleted === false (mid-redirect to /onboarding) OR undefined (unknown,
  // sidecar not ready yet) → hold on the splash; never paint the app shell.
  return <GateSplash slow={slow} onRetry={handleRetry} />;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: false,
      staleTime: 30_000,
      gcTime: 5 * 60_000,
    },
  },
});

function AppInner(): ReactElement {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const navigate = useNavigate();
  const terminalStore = useTerminalStore();
  // Track whether the on-mount embedded-spec consume has already run.
  const embeddedConsumed = useRef(false);

  // Bootstrap terminal settings into the module-level cache on first load
  // so panes opened before the user visits Settings → Terminal use the
  // persisted values rather than hardcoded defaults.
  const { data: terminalSettingsData } = useTerminalSettings();
  // Read the persisted screenshot hotkey; fall back to the default constant
  // while the query is still loading or if the setting has never been saved.
  const screenshotHotkey =
    terminalSettingsData?.screenshot_hotkey ?? SCREENSHOT_HOTKEY_DEFAULT;
  useEffect(() => {
    if (terminalSettingsData) {
      document.dispatchEvent(
        new CustomEvent("terminal:settings-changed", {
          detail: terminalSettingsData,
        }),
      );
    }
  }, [terminalSettingsData]);

  // On first launch: request macOS notification permission so the OS registers
  // the app as a notification sender before the first real notification fires.
  // Tracked in localStorage so we prompt at most once per install.
  useEffect(() => {
    const STORAGE_KEY = "notif_permission_requested";
    if (localStorage.getItem(STORAGE_KEY)) return;
    void requestNotificationPermission()
      .then((state) => {
        localStorage.setItem(STORAGE_KEY, state);
      })
      .catch(() => {
        // Ignore — non-fatal; emitNativeNotification already catches permission errors.
      });
  }, []);

  // On mount: consume any queued embedded launch spec (covers the case where
  // the user submitted an embedded launch and then refreshed before navigation).
  useEffect(() => {
    if (embeddedConsumed.current) return;
    embeddedConsumed.current = true;
    const spec = pendingLaunchStore.consume("embedded");
    if (spec) {
      void terminalStore
        .applyGridLayout(spec)
        .then(() => navigate("/terminal"))
        .catch(() => undefined);
    }
    // terminalStore and navigate are stable references; omit from deps intentionally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Universal Prompt Bar dispatches this when the user submits
  // a slash command or an empty input; we open the existing palette.
  useEffect(() => {
    const open = () => setPaletteOpen(true);
    document.addEventListener("omni:open-palette", open);
    return () => document.removeEventListener("omni:open-palette", open);
  }, []);

  useEffect(() => {
    const sync = () => {
      document.documentElement.dataset.appHidden = document.hidden
        ? "true"
        : "false";
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  const closePalette = useCallback(() => setPaletteOpen(false), []);

  // ---------------------------------------------------------------------------
  // Global screenshot-ring hotkey
  //
  // The hotkey accelerator comes from the sidecar setting "screenshot.hotkey"
  // (default: SCREENSHOT_HOTKEY_DEFAULT = "Ctrl+Shift+2").  The effect
  // re-runs whenever screenshotHotkey changes — i.e. after the user saves a
  // new binding in Settings > Terminal > Screenshot.
  //
  // Registration lives in the main window because global shortcuts must be
  // registered while the app is running; the ring window is too short-lived.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let registered = false;
    let registeredHotkey = "";

    void isShortcutRegistered(screenshotHotkey)
      .then((alreadyRegistered) => {
        // Guard against StrictMode/HMR double-registration.
        if (alreadyRegistered) {
          registered = true;
          registeredHotkey = screenshotHotkey;
          return;
        }
        return registerShortcut(screenshotHotkey, (event) => {
          if (event.state === "Pressed") {
            void openScreenshotRing().catch((err) => {
              console.error("open_screenshot_ring failed:", err);
            });
          }
        }).then(() => {
          registered = true;
          registeredHotkey = screenshotHotkey;
        });
      })
      .catch((err) => {
        // Registration failed — shortcut taken by another app, or the
        // accelerator string is malformed.  Dispatch a custom DOM event so
        // the Settings > Terminal > Screenshot card can display the error
        // inline (settings.tsx listens via a useEffect on "screenshot:hotkey-error").
        const msg =
          err instanceof Error
            ? err.message
            : "That shortcut is unavailable — it may be in use by another app.";
        console.warn(
          `Failed to register screenshot hotkey "${screenshotHotkey}":`,
          err,
        );
        document.dispatchEvent(
          new CustomEvent("screenshot:hotkey-error", { detail: msg }),
        );
      });

    return () => {
      if (registered && registeredHotkey) {
        // Targeted unregister — allow-unregister is granted in
        // capabilities/default.json.  allow-unregister-all is NOT granted.
        void unregisterShortcut(registeredHotkey).catch(() => undefined);
      }
    };
  }, [screenshotHotkey]);

  return (
    <OnboardingGate>
      <Routes>
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/command" element={<CommandCenterPage />} />
        <Route path="/" element={<DashboardPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route
          path="/tasks"
          element={
            <FeatureRoute navSlug="tasks">
              <TasksPage />
            </FeatureRoute>
          }
        />
        <Route
          path="/tasks/:id"
          element={
            <FeatureRoute navSlug="tasks">
              <TaskDetailPage />
            </FeatureRoute>
          }
        />
        <Route path="/in-progress" element={<InProgressPage />} />
        {/* /inbox redirects to /tasks. The `inbox` slug and InboxPage are kept for
              redirect compat — existing bookmarks and rows that list `inbox` will
              gracefully land on the Work board.
              TODO: remove InboxPage import and this redirect when workflow_items
              is merged into tasks. */}
        <Route path="/inbox" element={<Navigate to="/tasks" replace />} />
        <Route
          path="/notifications"
          element={
            <FeatureRoute navSlug="notifications">
              <NotificationsPage />
            </FeatureRoute>
          }
        />
        <Route path="/team" element={<TeamPage />} />
        <Route path="/team/:name" element={<AgentDetailPage />} />
        <Route path="/docs" element={<DocsPage />} />
        <Route path="/editor" element={<MarkdownEditorPage />} />
        <Route path="/marketplace" element={<MarketplacePage />} />
        <Route
          path="/parallel"
          element={
            <FeatureRoute navSlug="parallel">
              <ParallelRunsPage />
            </FeatureRoute>
          }
        />
        <Route path="/mcp" element={<McpServersPage />} />
        <Route
          path="/schedules"
          element={
            <FeatureRoute navSlug="schedules">
              <SchedulesPage />
            </FeatureRoute>
          }
        />
        <Route
          path="/preview"
          element={
            <FeatureRoute navSlug="preview">
              <PreviewPage />
            </FeatureRoute>
          }
        />
        <Route path="/library" element={<LibraryPage />} />
        <Route
          path="/budgets"
          element={
            <FeatureRoute navSlug="budgets">
              <BudgetsPage />
            </FeatureRoute>
          }
        />
        <Route
          path="/feed"
          element={
            <FeatureRoute navSlug="feed">
              <FeedPage />
            </FeatureRoute>
          }
        />
        <Route path="/plugins" element={<PluginsPage />} />
        <Route path="/integrations" element={<IntegrationsPage />} />
        <Route
          path="/sync"
          element={
            <FeatureRoute navSlug="sync">
              <SyncPage />
            </FeatureRoute>
          }
        />
        <Route path={TERMINAL_ROUTE} element={<TerminalPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/workspace" element={<WorkspaceSettingsPage />} />
        <Route path="*" element={<Navigate to="/command" replace />} />
      </Routes>
      <CommandPalette open={paletteOpen} onClose={closePalette} />
      <ToastHost />
    </OnboardingGate>
  );
}

export function App(): ReactElement {
  // Detached terminals window shares this Vite bundle and is
  // routed via a hash fragment. When that fragment is set we skip the full
  // app shell (sidebar, topbar, MemoryRouter routes) and mount the
  // terminals-only root directly.
  const isTerminalsWindow = isTerminalsWindowHash();
  const isScreenshotRingWindow = isScreenshotRingWindowHash();

  if (isTerminalsWindow) {
    return (
      <QueryClientProvider client={queryClient}>
        <TerminalWindowRoot />
      </QueryClientProvider>
    );
  }

  if (isScreenshotRingWindow) {
    // Ring overlay (ring → drag thumbnail) — minimal frameless popup.
    return <ScreenshotRingPage />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/command"]}>
        <AppInner />
      </MemoryRouter>
      <Toaster theme="dark" position="bottom-right" richColors />
    </QueryClientProvider>
  );
}

export default App;
