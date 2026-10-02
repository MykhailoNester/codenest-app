/**
 * The Sessions surface's supervision half (#269) — what the Command Center was
 * for, on the surface that already owns sessions.
 *
 * `pages/command-center.tsx` was a second session surface: it listed the runs,
 * then its only way to act on one was to send you to this page. Folding it here
 * removes the hop. What came across:
 *
 * - the unified runs list (`agent_runs` + observe-only hook sessions) with its
 *   status / scheduled / profile / provider filters and its pager,
 * - Focus (activate the run's pane) and Stop,
 * - the live hook-event feed (`ActivityGroup`),
 * - Reconcile — force-close sessions still marked active that are not,
 * - the startup `reconcileAgentRuns()` sweep and the 250 ms SSE coalescer,
 * - drill-in to a session, and
 * - the full-screen constellation, now opened from here instead of being a
 *   card on a page of its own.
 *
 * What did not: the metric tiles (deck home's stat row already carries
 * running / spend / queue) and the embedded constellation card.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAgentRuns,
  useAgentSessions,
  useCleanupStaleSessions,
  useCommandCenter,
  useLookups,
  useProviders,
  useRecentEvents,
  useSidecarSSE,
  type AgentRun,
} from "../../lib/api";
import { useProfileStore } from "../../stores/profile-store";
import {
  setActiveProvider,
  useActiveProviderId,
} from "../../stores/provider-store";
import { NO_PROFILES } from "../../lib/profile-utils";
import { reconcileAgentRuns } from "../../lib/agent-run-telemetry";
import { collectLeaves } from "../../lib/layout-tree";
import { emitFocusPaneToTerminals, openTerminalsWindow } from "../../lib/ipc";
import { useTerminalStore } from "../../stores/terminal-store";
import { DeckGrid, DeckGroup, DeckHead } from "../deck/deck-grid";
import { COLS_RUN, RUN_HEAD } from "./run-cols";
import { RunLine } from "./run-line";
import { ActivityGroup } from "./activity-group";
import { SessionDetail } from "./session-detail";
import { useConstellationLayout } from "../command-center/use-constellation-layout";
import type { ConstellationWindow } from "../command-center/use-constellation-layout";
import { ConstellationOverlay } from "../command-center/constellation-overlay";

type RunsFilter = "" | "running" | "ended";

const PAGE_SIZES = [10, 20, 50] as const;

/** Cutoff ISO timestamp for a window string relative to now. */
function windowCutoff(mode: ConstellationWindow): string | null {
  const now = Date.now();
  if (mode === "1h") return new Date(now - 60 * 60 * 1000).toISOString();
  if (mode === "24h") return new Date(now - 24 * 60 * 60 * 1000).toISOString();
  if (mode === "7d") return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  return null; // "live" — no cutoff, filter by status instead
}

export interface RunsViewProps {
  /** Session whose detail is open, if any. Driven by `?session=` on the page. */
  selectedId: string | null;
  onSelect: (sessionId: string | null) => void;
  /** Bring the panes view forward — Focus on an embedded run lands there. */
  onShowPanes: () => void;
}

export function RunsView({
  selectedId,
  onSelect,
  onShowPanes,
}: RunsViewProps): ReactElement {
  const queryClient = useQueryClient();

  const [filter, setFilter] = useState<RunsFilter>("running");
  const [scheduledOnly, setScheduledOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(10);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [windowMode, setWindowMode] = useState<ConstellationWindow>("live");

  const { data: lookups } = useLookups();
  const { activeProfileId, setActiveProfile } = useProfileStore();
  const activeProviderId = useActiveProviderId();
  const profiles = lookups?.profiles ?? NO_PROFILES;
  const activeProfile = profiles.find((p) => p.id === activeProfileId);
  const profileFilter = activeProfile?.name ?? "";

  const { data: ccData } = useCommandCenter();
  const { data: providers = [] } = useProviders(true);
  const { data: recentEvents = [] } = useRecentEvents(50, activeProviderId);
  const { data: allSessions = [] } = useAgentSessions(
    profileFilter || undefined,
    undefined,
    true, // include_ended — the constellation's historical windows need them
    activeProviderId,
  );
  const { data: agentRuns = [] } = useAgentRuns(
    activeProviderId,
    filter || undefined,
    profileFilter || undefined,
  );

  // Panel view: optionally narrow to scheduled runs (schedule_id set). Kept
  // separate from `agentRuns` so the running-count badge still reflects all.
  const runsView = scheduledOnly
    ? agentRuns.filter((r) => r.schedule_id != null)
    : agentRuns;

  // Clamp page index if the result set shrinks (e.g. a session ends mid-view).
  // Computed at render time to avoid a setState-inside-effect lint violation.
  const totalPages = Math.max(1, Math.ceil(runsView.length / pageSize));
  const clampedPage = Math.min(page, totalPages - 1);

  const runningRuns = agentRuns.filter((r) => r.status === "running");
  const activeProviderIds = new Set(
    runningRuns
      .map((r) => r.provider_id)
      .filter((id): id is number => id != null),
  );
  const activeProviderNames = providers
    .filter((p) => activeProviderIds.has(p.id))
    .map((p) => p.display_name ?? p.name)
    .join(" · ");

  // ── Constellation ─────────────────────────────────────────────────────────
  const constellationSessions = useMemo(() => {
    if (windowMode === "live") {
      return allSessions.filter(
        (s) => s.status === "active" || s.status === "idle",
      );
    }
    const cutoff = windowCutoff(windowMode);
    if (!cutoff) return allSessions;
    return allSessions.filter((s) => (s.last_event_at ?? s.started_at) >= cutoff);
  }, [allSessions, windowMode]);

  const {
    layoutRef,
    layoutVersion,
    reheat,
    dragActiveRef,
    resetLayout,
  } = useConstellationLayout(constellationSessions, profiles, windowMode);

  // There is no card to expand from any more, so the overlay's FLIP has no
  // source rect. It degrades to a plain fade, which is what a null ref means.
  const noCardRef = useRef<HTMLCanvasElement | null>(null);
  const noop = useCallback(() => undefined, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (overlayOpen || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "f" && e.key !== "F") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      setOverlayOpen(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlayOpen]);

  // ── SSE coalescer (250 ms trailing flush) ─────────────────────────────────
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingFlush = useRef({
    sessions: false,
    command: false,
    replay: false,
    recent: false,
    runs: false,
  });
  useEffect(
    () => () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
    },
    [],
  );
  useSidecarSSE("agent-hook", (data, name) => {
    const isLifecycle =
      name === "snapshot" ||
      name === "session_started" ||
      name === "session_ended" ||
      name === "session_removed" ||
      name === "prompt" ||
      name === "stop" ||
      name === "launch";
    if (isLifecycle) {
      pendingFlush.current.sessions = true;
      pendingFlush.current.command = true;
      pendingFlush.current.runs = true;
    }
    pendingFlush.current.recent = true;
    if (selectedId) {
      const sid =
        typeof data === "object" && data !== null && "session_id" in data
          ? (data as { session_id?: unknown }).session_id
          : undefined;
      if (sid === selectedId) pendingFlush.current.replay = true;
    }
    if (flushTimer.current) return;
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      const flags = pendingFlush.current;
      pendingFlush.current = {
        sessions: false,
        command: false,
        replay: false,
        recent: false,
        runs: false,
      };
      if (flags.sessions) {
        void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      }
      if (flags.command) {
        void queryClient.invalidateQueries({ queryKey: ["command-center"] });
      }
      if (flags.replay && selectedId) {
        void queryClient.invalidateQueries({
          queryKey: ["session-replay", selectedId],
        });
        void queryClient.invalidateQueries({
          queryKey: ["session-inspector", selectedId],
        });
      }
      if (flags.recent) {
        void queryClient.invalidateQueries({ queryKey: ["recent-events"] });
      }
      if (flags.runs) {
        void queryClient.invalidateQueries({ queryKey: ["agent-runs"] });
      }
    }, 250);
  });

  // Clear runs whose session died without its end ever being reported — a
  // popout window torn down mid-report, the app quitting or crashing, a sidecar
  // that was unreachable at that moment. Those rows sit at "running" forever,
  // offering a Focus and a Stop that act on nothing, and this list is the only
  // place the staleness is visible — so the sweep runs when it is opened,
  // against the shell's list of panes it still holds children for. Refetch the
  // list afterwards only when something actually changed.
  const reconciled = useRef(false);
  useEffect(() => {
    if (reconciled.current) return;
    reconciled.current = true;
    void reconcileAgentRuns().then((ended) => {
      if (ended !== null && ended > 0) {
        void queryClient.invalidateQueries({ queryKey: ["agent-runs"] });
        void queryClient.invalidateQueries({ queryKey: ["command-center"] });
      }
    });
  }, [queryClient]);

  // ── Focus ─────────────────────────────────────────────────────────────────
  //
  // For embedded panes the tab lives in this window's terminal store — show the
  // panes view and activate it. For popout panes the tab lives in the detached
  // window's own JS context (separate Zustand store), so we raise that window
  // and emit `focus-pane` to it instead, and must NOT touch this view.
  const handleFocusPane = useCallback(
    (run: AgentRun) => {
      const paneId = run.pane_id;
      if (!paneId) return;

      if (run.target === "popout") {
        void openTerminalsWindow().catch(() => undefined);
        void emitFocusPaneToTerminals(paneId).catch(() => undefined);
        return;
      }

      // Show the panes first so the layout is mounting while the tab is being
      // resolved. The store may hold no tabs at all yet: it is hydrated by
      // `TerminalsLayout`'s own effect, so a session started in a previous app
      // run — or in another window — is not in this store until that view has
      // mounted once. `hydrateFromStorage` is idempotent and guarded against
      // concurrent calls, so asking for it here just brings forward the work
      // the switch is about to trigger anyway.
      onShowPanes();
      void (async () => {
        const store = useTerminalStore.getState();
        await store.hydrateFromStorage();
        const fresh = useTerminalStore.getState();
        const targetTab = fresh.tabs.find((tab) =>
          collectLeaves(tab.layout).some((l) => l.terminalId === paneId),
        );
        if (!targetTab) return;
        // Order matters: `setActiveTab` focuses the tab's *first* leaf, so the
        // specific pane has to be focused after it. Without the second call a
        // split tab would open with the wrong pane focused — the popout path
        // has always done both (`terminal-window-root.tsx`).
        fresh.setActiveTab(targetTab.id);
        fresh.setFocusedLeaf(paneId);
      })();
    },
    [onShowPanes],
  );

  // ── Reconcile ─────────────────────────────────────────────────────────────
  const cleanupStale = useCleanupStaleSessions();
  const counts = ccData?.counts;
  const liveCount = (counts?.active ?? 0) + (counts?.idle ?? 0);
  const handleReconcile = useCallback(() => {
    if (cleanupStale.isPending) return;
    const msg =
      liveCount > 0
        ? `Mark ${liveCount} active/idle session${liveCount === 1 ? "" : "s"} as ended? ` +
          "Use this only when the dashboard's live list doesn't match reality."
        : "No active or idle sessions to reconcile. Run anyway to sweep stopped sessions?";
    if (!window.confirm(msg)) return;
    cleanupStale.mutate(undefined, {
      onSuccess: (res) => {
        if (res.closed === 0) {
          window.alert("Nothing to reconcile — no stale sessions found.");
        }
      },
      onError: (err) => {
        window.alert(`Reconcile failed: ${err.message}`);
      },
    });
  }, [cleanupStale, liveCount]);

  const handleDrillIn = useCallback(
    (sessionId: string) => {
      onSelect(selectedId === sessionId ? null : sessionId);
    },
    [onSelect, selectedId],
  );

  const shown = runsView.slice(
    clampedPage * pageSize,
    (clampedPage + 1) * pageSize,
  );

  return (
    <>
      <DeckGroup
        label="runs"
        count={runsView.length}
        note={
          runningRuns.length > 0
            ? `${runningRuns.length} running${activeProviderNames ? ` · ${activeProviderNames}` : ""}`
            : undefined
        }
        state="run"
        actions={
          <>
            <button
              type="button"
              className="dk-btn bare"
              onClick={() => setOverlayOpen(true)}
              title="Open the constellation (F)"
            >
              constellation
            </button>
            <button
              type="button"
              className="dk-btn bare"
              onClick={handleReconcile}
              disabled={cleanupStale.isPending}
              title="Force-close any sessions still marked active/idle when they aren't really running."
            >
              {cleanupStale.isPending ? "reconciling…" : "reconcile"}
            </button>
          </>
        }
      >
        <div className="dk-bigs" style={{ alignItems: "center", gap: "var(--u3)" }}>
          <div className="dk-seg" role="group" aria-label="Run status">
            {(
              [
                { label: "all", value: "" },
                { label: "running", value: "running" },
                { label: "ended", value: "ended" },
              ] as { label: string; value: RunsFilter }[]
            ).map((f) => (
              <button
                key={f.value}
                type="button"
                className={filter === f.value ? "on" : undefined}
                aria-pressed={filter === f.value}
                onClick={() => {
                  setFilter(f.value);
                  setPage(0);
                }}
              >
                {f.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            className={`dk-btn bare${scheduledOnly ? " pri" : ""}`}
            aria-pressed={scheduledOnly}
            title="Show only scheduled runs"
            onClick={() => {
              setScheduledOnly((v) => !v);
              setPage(0);
            }}
          >
            ⏱ scheduled
          </button>

          <div className="dk-seg" role="group" aria-label="Profile">
            <button
              type="button"
              className={activeProfileId === null ? "on" : undefined}
              aria-pressed={activeProfileId === null}
              onClick={() => {
                setActiveProfile(null);
                setPage(0);
              }}
            >
              all
            </button>
            {profiles.map((p) => (
              <button
                key={p.id}
                type="button"
                className={activeProfileId === p.id ? "on" : undefined}
                aria-pressed={activeProfileId === p.id}
                onClick={() => {
                  setActiveProfile(p.id);
                  setPage(0);
                }}
              >
                {p.name}
              </button>
            ))}
          </div>

          <select
            className="dk-ctl"
            style={{ width: 170 }}
            aria-label="Filter agents by provider"
            value={activeProviderId ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              setActiveProvider(v === "" ? null : Number(v));
              setPage(0);
            }}
          >
            <option value="">all providers</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.display_name ?? p.name}
              </option>
            ))}
          </select>
        </div>

        {runsView.length === 0 ? (
          <div className="dk-note sans">
            {scheduledOnly
              ? "No scheduled runs in this window."
              : "No agents yet. Open a pane on this page, or start a Claude Code session anywhere — hooks report it here."}
          </div>
        ) : (
          <>
            <DeckGrid cols={COLS_RUN} label="Agent runs">
              <DeckHead cells={RUN_HEAD} />
              {shown.map((run, i) => (
                <RunLine
                  key={
                    run.id != null
                      ? `run-${run.id}`
                      : `obs-${run.session_id ?? clampedPage * pageSize + i}`
                  }
                  run={run}
                  selected={
                    run.session_id != null && run.session_id === selectedId
                  }
                  onFocus={handleFocusPane}
                  onDrillIn={run.session_id ? handleDrillIn : undefined}
                />
              ))}
            </DeckGrid>

            <div
              className="dk-note"
              style={{ display: "flex", alignItems: "center", gap: "var(--u2)" }}
            >
              <span>
                {clampedPage * pageSize + 1}–
                {Math.min((clampedPage + 1) * pageSize, runsView.length)} of{" "}
                {runsView.length}
              </span>
              <span style={{ marginLeft: "auto" }} />
              <select
                className="dk-ctl"
                style={{ width: 96 }}
                aria-label="Page size"
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(0);
                }}
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n} / page
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="dk-btn bare"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={clampedPage === 0}
                aria-label="Previous page"
              >
                prev
              </button>
              <span>
                {clampedPage + 1} / {totalPages}
              </span>
              <button
                type="button"
                className="dk-btn bare"
                onClick={() => setPage((p) => p + 1)}
                disabled={(clampedPage + 1) * pageSize >= runsView.length}
                aria-label="Next page"
              >
                next
              </button>
            </div>
          </>
        )}
      </DeckGroup>

      {selectedId !== null && (
        <DeckGroup label="session" note={selectedId}>
          <SessionDetail sessionId={selectedId} onClose={() => onSelect(null)} />
        </DeckGroup>
      )}

      <ActivityGroup
        events={recentEvents}
        profiles={profiles}
        onSelectSession={onSelect}
      />

      <ConstellationOverlay
        open={overlayOpen}
        cardCanvasRef={noCardRef}
        layoutRef={layoutRef}
        layoutVersion={layoutVersion}
        reheat={reheat}
        dragActiveRef={dragActiveRef}
        resetLayout={resetLayout}
        sessions={constellationSessions}
        profiles={profiles}
        windowMode={windowMode}
        activeId={selectedId}
        onPick={onSelect}
        onWindowChange={setWindowMode}
        onClose={() => setOverlayOpen(false)}
        onLayoutMoved={noop}
      />
    </>
  );
}
