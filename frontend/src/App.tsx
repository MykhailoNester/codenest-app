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
  useParams,
} from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { useTerminalStore } from "./stores/terminal-store";
import * as pendingLaunchStore from "./stores/pending-launch-store";
import {
  useTerminalSettings,
  useEnabledFeatures,
  useOnboardingState,
} from "./lib/api";
import { FEATURES, TERMINAL_ROUTE } from "./lib/nav-items";
import { OMNI_EVENT_OPEN_PALETTE } from "./lib/omni-commands";
import { requestNotificationPermission, useSidecarState } from "./lib/ipc";

import { CatalogFeedHost } from "./components/catalog-feed-host";
import { CommandPalette } from "./components/command-palette";
import { StartupSplash } from "./components/startup-splash";
import { ToastHost } from "./components/toast-host";
import { DeckHomePage } from "./pages/deck-home";
import { AttentionPage } from "./pages/attention";
import { DeckPreviewPage } from "./pages/deck-preview";
import { TasksPage } from "./pages/tasks";
import { TaskDetailPage } from "./pages/task-detail";
import { TeamPage } from "./pages/team";
import { AgentDetailPage } from "./pages/agent-detail";
import { TerminalPage } from "./pages/terminal";
import { TerminalWindowRoot } from "./pages/terminal-window-root";
import { SettingsPage } from "./pages/settings";
import { ProjectsPage } from "./pages/projects";
import { HooksPage } from "./pages/hooks";
import { SchedulesPage } from "./pages/schedules";
import { BudgetsPage } from "./pages/budgets";
import { OnboardingPage } from "./pages/onboarding";
import { WorkspaceSettingsPage } from "./pages/settings/workspace-settings";
import { isTerminalsWindow as isTerminalsWindowHash } from "./lib/window-target";

// ---------------------------------------------------------------------------
/**
 * The landing route, or the browser path when one was deep-linked. Tauri serves
 * the app at "/" in dev and "/index.html" when packaged; both mean "no deep
 * link" and land on "/". No Tauri check is needed, and none would work anyway
 * since the web mock installs `__TAURI_INTERNALS__` itself.
 *
 * "/" is the landing route because it is the Deck home (#282). It used to
 * resolve to "/command", which made the landing page unreachable from a browser
 * URL — you could only get to it by clicking the rail.
 */
function deckInitialEntry(): string {
  if (typeof window === "undefined") return "/";
  const p = window.location.pathname;
  if (p.length <= 1 || p.startsWith("/index")) return "/";
  return p + window.location.search;
}

/**
 * `/sessions/:sessionId` → the session's `inspect` tab on the Sessions surface
 * (#271). A plain `<Navigate>` cannot do this: the target needs the path param,
 * which only resolves inside the route's element.
 */
function SessionRedirect(): ReactElement {
  const { sessionId = "" } = useParams<{ sessionId: string }>();
  return (
    <Navigate
      to={`/terminal?view=runs&session=${encodeURIComponent(sessionId)}&tab=inspect`}
      replace
    />
  );
}

/** `/projects/:projectId/context` → the project's detail on Projects (#273). */
function ProjectContextRedirect(): ReactElement {
  const { projectId = "" } = useParams<{ projectId: string }>();
  return (
    <Navigate
      to={`/projects?context=${encodeURIComponent(projectId)}`}
      replace
    />
  );
}

// FeatureRoute — hard-gate guard (Phase 1)
// ---------------------------------------------------------------------------

/**
 * Wraps a route's element.  When the feature that gates `navSlug` is
 * disabled, redirects to `/` (the Deck home).
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
        return <Navigate to="/" replace />;
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
        .applyPaneLayout(spec)
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

  // The OmniBar dispatches this when the user submits an empty input or
  // picks its "Open Command Palette" action; we open the existing palette.
  // (Slash commands execute inline in the bar now — see omni-commands.ts.)
  useEffect(() => {
    const open = () => setPaletteOpen(true);
    document.addEventListener(OMNI_EVENT_OPEN_PALETTE, open);
    return () => document.removeEventListener(OMNI_EVENT_OPEN_PALETTE, open);
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

  return (
    <OnboardingGate>
      <Routes>
        <Route path="/onboarding" element={<OnboardingPage />} />
        {/* #269 — the Command Center folded into Sessions. The path stays as a
            redirect: it is baked into notification routes, search results and
            the onboarding hand-off, the same way /inbox redirects to /tasks. */}
        <Route
          path="/command"
          element={<Navigate to="/terminal?view=runs" replace />}
        />
        {/* #282 — the Deck home screen. The old dashboard kept a comparison
            route of its own until the migration was signed off; #345 ended the
            split and deleted it, along with the `Shell` it was one of the last
            two pages on. No redirect: that route existed for a review that is
            over, and nothing links to it. */}
        <Route path="/" element={<DeckHomePage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        {/* #273 — the context map is a project's detail on the Projects
            surface. The old path stays as a redirect, carrying its param. */}
        <Route
          path="/projects/:projectId/context"
          element={<ProjectContextRedirect />}
        />
        {/* #280 — the Deck shell, reviewable beside the old one. Removed by #281/#282. */}
        <Route path="/deck" element={<DeckPreviewPage />} />
        <Route
          path="/attention"
          element={
            <FeatureRoute navSlug="attention">
              <AttentionPage />
            </FeatureRoute>
          }
        />
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
        {/* #272 — the In Progress page is a filter on Work plus a group on the
            deck home. The path stays as a redirect, like /inbox → /tasks. */}
        <Route
          path="/in-progress"
          element={<Navigate to="/tasks?status=in-progress" replace />}
        />
        {/* /inbox redirects to /tasks. The `inbox` slug and InboxPage are kept for
              redirect compat — existing bookmarks and rows that list `inbox` will
              gracefully land on the Work board.
              TODO: remove InboxPage import and this redirect when workflow_items
              is merged into tasks. */}
        <Route path="/inbox" element={<Navigate to="/tasks" replace />} />
        {/* #270 — /notifications is gone. Its unread queue is folded into
            Needs You (`attention_service._produce_notifications`) and the bell
            in the chrome keeps the history, so a bookmark lands on the queue
            rather than on a 404 that redirects to Command. */}
        <Route path="/notifications" element={<Navigate to="/attention" replace />} />
        {/* #271 — the Session Inspector is the `inspect` tab on the Sessions
            surface's session detail. The old path stays as a redirect so a
            bookmark and an older search result still resolve; `:sessionId` has
            to be re-read inside the element to carry it over. */}
        <Route path="/sessions/:sessionId" element={<SessionRedirect />} />
        {/* #274 — the Knowledge page is gone, but `/api/v1/documents` is not:
            the bundled Orion org-agent still registers deliverables through it,
            so `search_service` keeps returning `doc` hits and those route to
            `/docs?id=`. Nothing can display one any more, so the path lands on
            the Deck home rather than silently falling through `*`. Re-point it
            the day a document viewer comes back. */}
        <Route path="/docs" element={<Navigate to="/" replace />} />
        <Route path="/team" element={<TeamPage />} />
        <Route path="/team/:name" element={<AgentDetailPage />} />
        <Route
          path="/schedules"
          element={
            <FeatureRoute navSlug="schedules">
              <SchedulesPage />
            </FeatureRoute>
          }
        />
        <Route
          path="/budgets"
          element={
            <FeatureRoute navSlug="budgets">
              <BudgetsPage />
            </FeatureRoute>
          }
        />
        <Route
          path="/hooks"
          element={
            <FeatureRoute navSlug="hooks">
              <HooksPage />
            </FeatureRoute>
          }
        />
        <Route path={TERMINAL_ROUTE} element={<TerminalPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/workspace" element={<WorkspaceSettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <CommandPalette open={paletteOpen} onClose={closePalette} />
      <ToastHost />
    </OnboardingGate>
  );
}

export function App(): ReactElement {
  // Detached terminals window shares this Vite bundle and is
  // routed via a hash fragment. When that fragment is set we skip the full
  // app shell (the Deck rail, status row, MemoryRouter routes) and mount the
  // terminals-only root directly.
  const isTerminalsWindow = isTerminalsWindowHash();

  if (isTerminalsWindow) {
    return (
      <QueryClientProvider client={queryClient}>
        {/* Its own document, so its own query cache and its own connection:
            a composer here needs the catalog feed as much as the main
            window's does. */}
        <CatalogFeedHost />
        <TerminalWindowRoot />
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      {/* Keeps the invocables catalog live for as long as the window is open —
          a new agent/skill/command file has to reach an already-open composer
          without a restart (#48). */}
      <CatalogFeedHost />
      {/* MemoryRouter stays — Tauri has no URL bar. But outside Tauri the
          browser path is the only way to reach a route for review, so it seeds
          the initial entry. No effect in the packaged app. */}
      <MemoryRouter initialEntries={[deckInitialEntry()]}>
        <AppInner />
      </MemoryRouter>
      <Toaster theme="dark" position="bottom-right" richColors />
    </QueryClientProvider>
  );
}

export default App;
