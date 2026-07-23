import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCommandCenter,
  useAgentSessions,
  useAgentRuns,
  useProviders,
  useSessionReplay,
  useSidecarSSE,
  useLookups,
  useRecentEvents,
  useCleanupStaleSessions,
} from "../lib/api";
import { useProfileStore } from "../stores/profile-store";
import {
  useActiveProviderId,
  setActiveProvider,
} from "../stores/provider-store";
import { NO_PROFILES } from "../lib/profile-utils";
import { Shell } from "../components/layout/shell";
import {
  Constellation,
  type ConstellationWindow,
  type SessionSource,
} from "../components/command-center/constellation";
import { useConstellationLayout } from "../components/command-center/use-constellation-layout";
import { ConstellationOverlay } from "../components/command-center/constellation-overlay";
import { Icon } from "../components/icon";
import { MetricTile } from "../components/command-center/metric-tile";
import { AgentRunRow } from "../components/command-center/agent-run-row";
import { ReplayPanel } from "../components/command-center/replay-panel";
import { LiveActivity } from "../components/command-center/live-activity";
import { EndedHistory } from "../components/command-center/ended-history";
import type { AgentRun, AgentSession } from "../lib/api";
import { useNavigate } from "react-router-dom";
import { useTerminalStore } from "../stores/terminal-store";
import { collectLeaves } from "../lib/layout-tree";
import { openTerminalsWindow, emitFocusPaneToTerminals } from "../lib/ipc";

/** Cutoff ISO timestamp for a window string relative to now. */
function windowCutoff(mode: ConstellationWindow): string | null {
  const now = Date.now();
  if (mode === "1h") return new Date(now - 60 * 60 * 1000).toISOString();
  if (mode === "24h") return new Date(now - 24 * 60 * 60 * 1000).toISOString();
  if (mode === "7d")
    return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  return null; // "live" — no cutoff, filter by status instead
}

const WINDOW_OPTIONS: { label: string; value: ConstellationWindow }[] = [
  { label: "Live", value: "live" },
  { label: "1h", value: "1h" },
  { label: "24h", value: "24h" },
  { label: "7d", value: "7d" },
];

type AgentsPanelFilter = "" | "running" | "ended";

export function CommandCenterPage(): ReactElement {
  // ── Selection state ─────────────────────────────────────────────────────────
  // selectedId = the session_id of the agent whose drill-in panel is open.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [endedOpen, setEndedOpen] = useState(false);
  const [constellationWindow, setConstellationWindow] =
    useState<ConstellationWindow>("live");
  const [agentsFilter, setAgentsFilter] =
    useState<AgentsPanelFilter>("running");
  const [scheduledOnly, setScheduledOnly] = useState(false);
  const [agentsPage, setAgentsPage] = useState(0);
  const [agentsPageSize, setAgentsPageSize] = useState(10);

  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { tabs } = useTerminalStore();

  // ?session=<session_id> deep-link from notification bell click.
  const [searchParams] = useSearchParams();
  const sessionParam = searchParams.get("session");
  const sessionParamApplied = useRef(false);
  useEffect(() => {
    if (sessionParamApplied.current || !sessionParam) return;
    sessionParamApplied.current = true;
    setSelectedId(sessionParam);
  }, [sessionParam]);

  const { data: lookups } = useLookups();
  const { activeProfileId, setActiveProfile } = useProfileStore();
  const activeProviderId = useActiveProviderId();
  const profiles = lookups?.profiles ?? NO_PROFILES;
  const activeProfile = profiles.find((p) => p.id === activeProfileId);
  // Profile name string used for filtering the AGENTS panel and constellation.
  const profileFilter = activeProfile?.name ?? "";

  const { data: ccData } = useCommandCenter();

  // All sessions including ended for constellation historical windows.
  const { data: allSessions = [] } = useAgentSessions(
    profileFilter || undefined,
    undefined,
    true, // include_ended
    activeProviderId,
  );

  const { data: recentEvents = [] } = useRecentEvents(50, activeProviderId);

  // Unified Agents panel data: agent_runs + observe-only sessions.
  const { data: providers = [] } = useProviders(true);
  const { data: agentRuns = [] } = useAgentRuns(
    activeProviderId,
    agentsFilter || undefined,
    profileFilter || undefined, // profile filter (migration 051)
  );
  // Panel view: optionally narrow to scheduled runs (schedule_id set). Kept
  // separate from `agentRuns` so the running-count badge still reflects all.
  const agentRunsView = scheduledOnly
    ? agentRuns.filter((r) => r.schedule_id != null)
    : agentRuns;

  // Clamp page index if the result set shrinks (e.g. a session ends mid-view).
  // Computed at render time to avoid a setState-inside-effect lint violation.
  const totalAgentsPages = Math.max(
    1,
    Math.ceil(agentRunsView.length / agentsPageSize),
  );
  const clampedAgentsPage = Math.min(agentsPage, totalAgentsPages - 1);

  // ── Source attribution map derived from recent events ──────────────────────
  const sourcesBySession = useMemo((): ReadonlyMap<string, SessionSource> => {
    const m = new Map<string, SessionSource>();
    for (const ev of recentEvents) {
      if (m.has(ev.session_id)) continue;
      if (!ev.payload_json) continue;
      try {
        const parsed: unknown = JSON.parse(ev.payload_json);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "source_kind" in parsed &&
          "source_id" in parsed
        ) {
          const obj = parsed as Record<string, unknown>;
          const kind = obj["source_kind"];
          const id = obj["source_id"];
          if ((kind === "task" || kind === "inbox") && typeof id === "number") {
            m.set(ev.session_id, { kind, id });
          }
        }
      } catch {
        // malformed payload — skip
      }
    }
    return m;
  }, [recentEvents]);

  // ── Constellation session filter ────────────────────────────────────────────
  const constellationSessions = useMemo((): AgentSession[] => {
    if (constellationWindow === "live") {
      return allSessions.filter(
        (s) => s.status === "active" || s.status === "idle",
      );
    }
    const cutoff = windowCutoff(constellationWindow);
    if (!cutoff) return allSessions;
    return allSessions.filter((s) => {
      const ts = s.last_event_at ?? s.started_at;
      return ts >= cutoff;
    });
  }, [allSessions, constellationWindow]);

  // Drive the constellation simulation (lifted — shared by card + overlay).
  const {
    layoutRef,
    layoutVersion,
    reheat: constellationReheat,
    dragActiveRef: constellationDragRef,
    resetLayout: resetConstellationLayout,
  } = useConstellationLayout(
    constellationSessions,
    profiles,
    constellationWindow,
  );

  // Overlay open state + card canvas ref
  const [overlayOpen, setOverlayOpen] = useState(false);
  const cardCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const openOverlay = useCallback(() => setOverlayOpen(true), []);
  const closeOverlay = useCallback(() => setOverlayOpen(false), []);
  const [layoutMoved, setLayoutMoved] = useState(false);
  const handleLayoutMoved = useCallback(() => setLayoutMoved(true), []);
  void closeOverlay;
  void layoutMoved;
  void handleLayoutMoved;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        (e.key === "f" || e.key === "F") &&
        !overlayOpen &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        setOverlayOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlayOpen]);

  // ── SSE coalescer (250 ms trailing flush) ───────────────────────────────────
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
      }
      if (flags.recent) {
        void queryClient.invalidateQueries({ queryKey: ["recent-events"] });
      }
      if (flags.runs) {
        void queryClient.invalidateQueries({ queryKey: ["agent-runs"] });
      }
    }, 250);
  });

  const counts = ccData?.counts;
  const activeSessions = allSessions.filter((s) => s.status === "active");
  const activeCount = activeSessions.length;
  const activeProjects = new Set(
    activeSessions.map((s) => s.project_name ?? s.cwd ?? ""),
  ).size;

  // Agents panel derived stats
  const runningRuns = agentRuns.filter((r) => r.status === "running");
  const runningCount = runningRuns.length;
  const activeProviderIds = new Set(
    runningRuns
      .map((r) => r.provider_id)
      .filter((id): id is number => id != null),
  );
  const activeProviderNames = providers
    .filter((p) => activeProviderIds.has(p.id))
    .map((p) => p.display_name ?? p.name)
    .join(" · ");

  const clearSelected = useCallback(() => setSelectedId(null), []);

  // Focus handler: bring the pane's window into view and activate its tab.
  //
  // For embedded panes the tab lives in the main-window terminal store —
  // activate it and navigate to /terminals (existing behaviour).
  //
  // For popout panes the tab lives in the detached `terminals` window's own
  // JS context (separate Zustand store).  We call `open_terminals_window`
  // (unminimize + set_focus) and then emit a `focus-pane` Tauri event to that
  // window so it can select the correct tab itself.  We must NOT navigate the
  // main window in this case.
  const handleFocusPane = useCallback(
    (run: AgentRun) => {
      const paneId = run.pane_id;
      if (!paneId) return;

      if (run.target === "popout") {
        // Raise the detached window, then tell it to activate the right tab.
        void openTerminalsWindow().catch(() => undefined);
        void emitFocusPaneToTerminals(paneId).catch(() => undefined);
        return;
      }

      // Embedded (or legacy null target treated as embedded).
      const targetTab = tabs.find((tab) =>
        collectLeaves(tab.layout).some((l) => l.terminalId === paneId),
      );
      if (targetTab) {
        useTerminalStore.getState().setActiveTab(targetTab.id);
      }
      navigate("/terminals");
    },
    [navigate, tabs],
  );

  // Drill-in: open the per-agent replay/activity panel.
  const handleDrillIn = useCallback((sessionId: string) => {
    setSelectedId((prev) => (prev === sessionId ? null : sessionId));
  }, []);

  const cleanupStale = useCleanupStaleSessions();
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

  // Session replay data — fetched when a row is drilled into.
  const { data: replay } = useSessionReplay(selectedId ?? "");

  const handleEndedSelect = useCallback((sessionId: string) => {
    setSelectedId(sessionId);
    setEndedOpen(false);
  }, []);
  const closeEnded = useCallback(() => setEndedOpen(false), []);

  return (
    <Shell>
      {/* Hero — constellation + metrics */}
      <div className="d3-hero">
        <div className="d3-hero__net">
          <div className="d3-hero__chrome">
            <span className="d3-h">Live constellation</span>
            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              <div className="d3-hero__legend mono" style={{ minWidth: 0, overflow: "hidden" }}>
                {/* Provider filter */}
                <select
                  aria-label="Filter by provider"
                  value={activeProviderId ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    setActiveProvider(v === "" ? null : Number(v));
                  }}
                  style={{
                    background: "var(--bg-3)",
                    border: "1px solid var(--line-2)",
                    color: "var(--fg-2)",
                    borderRadius: "var(--r-2)",
                    fontSize: "10.5px",
                    padding: "2px 20px 2px 7px",
                    marginRight: 8,
                    appearance: "auto",
                  }}
                >
                  <option value="">All providers</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.display_name ?? p.name}
                    </option>
                  ))}
                </select>
                {/* Window selector */}
                <div
                  role="group"
                  aria-label="Constellation time window"
                  style={{ display: "flex", gap: 4, marginRight: 12 }}
                >
                  {WINDOW_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={`d3-tag${constellationWindow === opt.value ? " is-on" : ""}`}
                      aria-pressed={constellationWindow === opt.value}
                      onClick={() => setConstellationWindow(opt.value)}
                      style={{ fontSize: "10px", padding: "2px 7px" }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <span>
                  <span
                    className="d3-leg-dot"
                    style={{ background: "#22c55e" }}
                  />
                  active
                </span>
                <span>
                  <span
                    className="d3-leg-dot"
                    style={{ background: "#f59e0b" }}
                  />
                  idle
                </span>
                <span>
                  <span
                    className="d3-leg-dot"
                    style={{ background: "#7a8290" }}
                  />
                  ended
                </span>
                <button
                  type="button"
                  className="d3-tag"
                  onClick={handleReconcile}
                  disabled={cleanupStale.isPending}
                  title="Force-close any sessions still marked active/idle when they aren't really running."
                  style={{ marginLeft: 8, fontSize: "10px", padding: "2px 7px" }}
                >
                  {cleanupStale.isPending ? "Reconciling…" : "Reconcile"}
                </button>
              </div>
              {/* Expand button — kept outside the legend div so overflow:hidden on the
                  legend never clips it. It is flex-shrink:0 and always visible. */}
              <button
                type="button"
                title="Maximize constellation (F)"
                aria-label="Maximize constellation"
                onClick={openOverlay}
                style={{
                  flexShrink: 0,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  border: "1px solid var(--line-2)",
                  background: "rgba(255,255,255,.02)",
                  color: "var(--fg-2)",
                  cursor: "pointer",
                }}
              >
                <Icon name="maximize" size={14} />
              </button>
            </div>
          </div>
          <Constellation
            sessions={constellationSessions}
            activeId={selectedId}
            onPick={setSelectedId}
            profiles={profiles}
            windowMode={constellationWindow}
            sourcesBySession={sourcesBySession}
            layoutRef={layoutRef}
            layoutVersion={layoutVersion}
            onCanvasReady={(c) => {
              cardCanvasRef.current = c;
            }}
          />
        </div>

        <div className="d3-hero__metrics">
          <MetricTile
            label="Working"
            value={activeCount}
            delta={
              activeCount > 0
                ? `across ${activeProjects} project${activeProjects !== 1 ? "s" : ""}`
                : "no agents running"
            }
            deltaOk={activeCount > 0}
          />
          <MetricTile
            label="Active"
            value={counts?.active ?? 0}
            delta={counts?.active ? "agents working" : "none running"}
            deltaOk={(counts?.active ?? 0) > 0}
          />
          <MetricTile
            label="Idle"
            value={counts?.idle ?? 0}
            delta="awaiting input"
          />
          <MetricTile
            label="Ended"
            value={counts?.ended ?? 0}
            delta="this session"
          />
          <MetricTile
            label="Workboard"
            value={ccData?.inbox_count ?? 0}
            delta={
              (ccData?.inbox_count ?? 0) > 0 ? "to triage" : "all triaged"
            }
            deltaOk={(ccData?.inbox_count ?? 0) === 0}
          />
        </div>
      </div>

      {/* Content — unified AGENTS panel + per-agent drill-in panel */}
      <div className="d3-content">
        {/* ── AGENTS panel (single list: runs + observe-only sessions) ─────── */}
        <section className="d3-list">
          <div className="d3-list__head">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="d3-h">AGENTS</span>
              {runningCount > 0 && (
                <span
                  style={{
                    fontSize: "12px",
                    color: "var(--fg-3)",
                    fontWeight: 500,
                  }}
                >
                  {runningCount} running
                  {activeProviderNames ? ` · ${activeProviderNames}` : ""}
                </span>
              )}
            </div>
            <div
              className="d3-list__filters"
              role="group"
              aria-label="Agents filters"
            >
              {/* Status filter */}
              {(
                [
                  { label: "All", value: "" },
                  { label: "Running", value: "running" },
                  { label: "Ended", value: "ended" },
                ] as { label: string; value: AgentsPanelFilter }[]
              ).map((f) => (
                <button
                  key={f.value}
                  type="button"
                  className={`d3-tag${agentsFilter === f.value ? " is-on" : ""}`}
                  aria-pressed={agentsFilter === f.value}
                  onClick={() => {
                    setAgentsFilter(f.value);
                    setAgentsPage(0);
                  }}
                >
                  {f.label}
                </button>
              ))}
              <span style={{ width: 6 }} />
              {/* Scheduled-only toggle */}
              <button
                type="button"
                className={`d3-tag${scheduledOnly ? " is-on" : ""}`}
                aria-pressed={scheduledOnly}
                title="Show only scheduled runs"
                onClick={() => {
                  setScheduledOnly((v) => !v);
                  setAgentsPage(0);
                }}
              >
                ⏱ Scheduled
              </button>
              <span style={{ width: 6 }} />
              {/* Profile filter */}
              <button
                type="button"
                className={`d3-tag${activeProfileId === null ? " is-on" : ""}`}
                aria-pressed={activeProfileId === null}
                onClick={() => {
                  setActiveProfile(null);
                  setAgentsPage(0);
                }}
              >
                All
              </button>
              {profiles.map((p) => {
                const on = activeProfileId === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`d3-tag${on ? " is-on" : ""}`}
                    aria-pressed={on}
                    onClick={() => {
                      setActiveProfile(p.id);
                      setAgentsPage(0);
                    }}
                    style={
                      on
                        ? {
                            borderColor: p.color,
                            color: p.color,
                            background: `${p.color}22`,
                          }
                        : undefined
                    }
                  >
                    {p.name}
                  </button>
                );
              })}
              <span style={{ width: 6 }} />
              {/* Provider filter */}
              <select
                aria-label="Filter agents by provider"
                value={activeProviderId ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  setActiveProvider(v === "" ? null : Number(v));
                  setAgentsPage(0);
                }}
                style={{
                  appearance: "auto",
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid var(--line-2)",
                  borderRadius: "var(--r-2)",
                  color: "var(--fg-2)",
                  fontFamily: "var(--font-sans)",
                  fontSize: "11px",
                  padding: "3px 22px 3px 8px",
                  cursor: "pointer",
                }}
              >
                <option value="">All providers</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.display_name ?? p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {agentRunsView.length === 0 ? (
            <div
              style={{
                color: "var(--fg-4)",
                fontSize: "13px",
                padding: "24px 0",
                textAlign: "center",
              }}
            >
              {scheduledOnly ? (
                <>No scheduled runs in this window.</>
              ) : (
                <>
                  No agents yet.
                  <br />
                  Launch an agent from the Terminals page or start a Claude Code
                  session.
                </>
              )}
            </div>
          ) : (
            <>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {agentRunsView
                  .slice(
                    clampedAgentsPage * agentsPageSize,
                    (clampedAgentsPage + 1) * agentsPageSize,
                  )
                  .map((run, i) => (
                    <AgentRunRow
                      key={
                        run.id != null
                          ? `run-${run.id}`
                          : `obs-${run.session_id ?? clampedAgentsPage * agentsPageSize + i}`
                      }
                      run={run}
                      onFocus={handleFocusPane}
                      onDrillIn={run.session_id ? handleDrillIn : undefined}
                    />
                  ))}
              </div>
              {/* Pager */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginTop: 12,
                  paddingTop: 10,
                  borderTop: "1px solid var(--line-2)",
                }}
              >
                <span
                  style={{
                    fontSize: "11px",
                    color: "var(--fg-4)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {agentRunsView.length > 0
                    ? `${clampedAgentsPage * agentsPageSize + 1}–${Math.min((clampedAgentsPage + 1) * agentsPageSize, agentRunsView.length)} of ${agentRunsView.length}`
                    : "0 results"}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <select
                    aria-label="Page size"
                    value={agentsPageSize}
                    onChange={(e) => {
                      setAgentsPageSize(Number(e.target.value));
                      setAgentsPage(0);
                    }}
                    style={{
                      appearance: "auto",
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid var(--line-2)",
                      borderRadius: "var(--r-2)",
                      color: "var(--fg-2)",
                      fontFamily: "var(--font-sans)",
                      fontSize: "11px",
                      padding: "3px 22px 3px 8px",
                      cursor: "pointer",
                    }}
                  >
                    {[10, 20, 50].map((n) => (
                      <option key={n} value={n}>
                        {n} / page
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="d3-btn"
                    onClick={() => setAgentsPage((p) => Math.max(0, p - 1))}
                    disabled={clampedAgentsPage === 0}
                    aria-label="Previous page"
                  >
                    Prev
                  </button>
                  <span
                    style={{
                      fontSize: "11px",
                      color: "var(--fg-3)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {clampedAgentsPage + 1} / {totalAgentsPages}
                  </span>
                  <button
                    type="button"
                    className="d3-btn"
                    onClick={() => setAgentsPage((p) => p + 1)}
                    disabled={
                      (clampedAgentsPage + 1) * agentsPageSize >=
                      agentRunsView.length
                    }
                    aria-label="Next page"
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
          )}
        </section>

        {/* ── Per-agent drill-in: Replay (session selected) or Live Activity ── */}
        {selectedId && replay ? (
          <ReplayPanel
            session={replay.session}
            events={replay.events}
            profiles={profiles}
            onClose={clearSelected}
          />
        ) : (
          <LiveActivity
            events={recentEvents}
            profiles={profiles}
            onSelectSession={setSelectedId}
          />
        )}
      </div>

      {/* Ended sessions drawer (reachable from the Ended filter button) */}
      {endedOpen && (
        <EndedHistory
          profiles={profiles}
          onSelectSession={handleEndedSelect}
          onClose={closeEnded}
        />
      )}

      {/* Constellation overlay (Portal) */}
      <ConstellationOverlay
        open={overlayOpen}
        cardCanvasRef={cardCanvasRef}
        layoutRef={layoutRef}
        layoutVersion={layoutVersion}
        reheat={constellationReheat}
        dragActiveRef={constellationDragRef}
        resetLayout={resetConstellationLayout}
        sessions={constellationSessions}
        profiles={profiles}
        windowMode={constellationWindow}
        activeId={selectedId}
        onPick={setSelectedId}
        onWindowChange={setConstellationWindow}
        onClose={closeOverlay}
        onLayoutMoved={handleLayoutMoved}
      />
    </Shell>
  );
}
