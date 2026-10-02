/**
 * Schedules — the cron-to-session spine, on Deck.
 *
 * A schedule is the only thing in the app that turns a chosen time into a
 * running agent session, so the page is built around that one sentence: the
 * list says when each one next fires and how the last one went, the detail
 * says what it launches and what the launch produced.
 *
 *   SchedulesPage        — DeckShell, stats, active/paused groups, detail
 *     ScheduleRow        — one DeckLine per schedule
 *     ScheduleDetail     — properties, run history, adaptive output pane
 *       RunHistory       — one DeckLine per run
 *       AdaptiveRunPane  — picks the renderer from what the run produced
 *     ScheduleFormModal  — cadence builder + launch spec + advanced
 *     RetentionModal     — transcript retention
 *
 * Empty is the normal first state — nothing is configured on a fresh install —
 * so the empty state is written rather than left over: it says what a schedule
 * does, names the one thing that must exist first (a provider), and offers
 * three seeded starters next to the primary.
 */

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type ReactElement,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { toast } from "sonner";
import {
  useSchedules,
  useScheduleRuns,
  useScheduleRun,
  useScheduleRunTranscript,
  useCreateSchedule,
  useUpdateSchedule,
  useDeleteSchedule,
  useFireScheduleManual,
  useCronPreview,
  useProviders,
  useProviderModels,
  useProjects,
  useConfiguredAgents,
  useScheduleRetention,
  useSetScheduleRetention,
  type Schedule,
  type ScheduleRun,
  type RunMode,
  type ResultKind,
  type NotifyPolicy,
  type CronPreviewInput,
  type CronPreview,
  type ScheduleCreateInput,
  type SchedulePatch,
} from "../lib/api";
import {
  useTerminalOutput,
  getScheduleRunPtyId,
  useScheduleRunStarted,
  useScheduleRunFinished,
  type ScheduleRunStartedPayload,
  type ScheduleRunFinishedPayload,
} from "../lib/ipc";
import { DeckShell } from "../components/deck/deck-shell";
import {
  DeckGrid,
  DeckGroup,
  DeckHead,
  DeckLine,
  type DeckState,
} from "../components/deck/deck-grid";
import { DeckMenu, type DeckMenuItem } from "../components/deck/deck-menu";
import { useDebounce } from "../hooks/use-debounce";
import {
  relativeTime as fmtRelTime,
  formatDurationMs as fmtDurationMs,
  formatCount,
} from "../lib/format-helpers";
import styles from "./schedules.module.css";

/** CSS-module values are `string | undefined` under noUncheckedIndexedAccess. */
function sx(...parts: (string | undefined | false)[]): string {
  return parts.filter(Boolean).join(" ");
}

// ─── Run status → Deck state ──────────────────────────────────────────────────

/**
 * The glyph column is the only carrier of state that survives colour being off,
 * so every run status has to land on one of the eight. `missed` is a stall (the
 * window passed and nothing ran), `timed_out` is a failure, and the statuses
 * that produced nothing at all (cancelled, skipped) are inert rather than green.
 */
const RUN_STATE: Record<string, DeckState> = {
  succeeded: "done",
  failed: "fail",
  timed_out: "fail",
  running: "run",
  queued: "todo",
  scheduled: "todo",
  missed: "stall",
  cancelled: "idle",
  skipped: "idle",
};

const RUN_WORD: Record<string, string> = {
  succeeded: "succeeded",
  failed: "failed",
  timed_out: "timed out",
  running: "running",
  queued: "queued",
  scheduled: "scheduled",
  missed: "missed",
  cancelled: "cancelled",
  skipped: "skipped",
};

function runState(status: string): DeckState {
  return RUN_STATE[status] ?? "idle";
}

function runWord(status: string): string {
  return RUN_WORD[status] ?? status;
}

/**
 * A schedule's own state. Disabled is inert whatever its history says — it is
 * not going to fire — and an enabled schedule that has never run is queued,
 * not unknown.
 */
function scheduleState(s: Schedule, lastRun: ScheduleRun | null): DeckState {
  if (!s.enabled) return "idle";
  if (lastRun) return runState(lastRun.status);
  return "todo";
}

/** Last 8 runs, newest first, as the same glyphs the rows use. */
function HealthStrip({ runs }: { runs: ScheduleRun[] }): ReactElement {
  return (
    <span className="dk-actions" style={{ gap: 3 }}>
      {runs.slice(0, 8).map((r) => (
        <span
          key={r.id}
          className="dk-s"
          data-s={runState(r.status)}
          role="img"
          aria-label={`${runWord(r.status)} ${fmtRelTime(r.fired_at)}`}
          title={`${runWord(r.status)} — ${fmtRelTime(r.fired_at)}`}
        />
      ))}
    </span>
  );
}

// ─── Time formatting ──────────────────────────────────────────────────────────

function fmtAbsTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// A run is "in flight" only while queued or running; every other status is
// terminal. Live, second-by-second relative timers are reserved for in-flight
// runs so a finished run's "started" cell freezes at a static start time
// instead of counting up forever.
function isRunInFlight(status: string): boolean {
  return status === "running" || status === "queued";
}

// ─── Shared relative-time ticker ────────────────────────────────────────────
//
// A single module-level 1 s interval drives every live relative time on the
// page (started / next run / last run), instead of each component spinning its
// own timer. It is paused whenever the window/tab is hidden so an idle, hidden
// Schedules page costs zero CPU.

const _tickSubs = new Set<() => void>();
let _tickTimer: ReturnType<typeof setInterval> | null = null;
let _visibilityBound = false;

function _startTicker(): void {
  if (_tickTimer != null) return;
  if (typeof document !== "undefined" && document.hidden) return;
  _tickTimer = setInterval(() => {
    for (const fn of _tickSubs) fn();
  }, 1000);
}

function _stopTicker(): void {
  if (_tickTimer != null) {
    clearInterval(_tickTimer);
    _tickTimer = null;
  }
}

function _bindVisibility(): void {
  if (_visibilityBound || typeof document === "undefined") return;
  _visibilityBound = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) _stopTicker();
    else if (_tickSubs.size > 0) _startTicker();
  });
}

/** Re-render once per second (paused when hidden) so relative times stay live. */
function useNow(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    _bindVisibility();
    const cb = (): void => setTick((n) => (n + 1) % 1_000_000);
    _tickSubs.add(cb);
    _startTicker();
    return () => {
      _tickSubs.delete(cb);
      if (_tickSubs.size === 0) _stopTicker();
    };
  }, []);
}

/** Human label for an interval schedule's cadence (e.g. "every 2 hours"). */
function describeInterval(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return "interval";
  if (seconds % 3600 === 0) {
    const h = seconds / 3600;
    return `every ${h} hour${h === 1 ? "" : "s"}`;
  }
  if (seconds % 60 === 0) {
    const m = seconds / 60;
    return `every ${m} minute${m === 1 ? "" : "s"}`;
  }
  return `every ${seconds}s`;
}

/**
 * Cadence label for a schedule of any kind. `cronLabel` is the cron-preview
 * description (resolved async for cron schedules); interval/event kinds are
 * described synchronously from their own fields.
 */
function cadenceLabel(s: Schedule, cronLabel?: string | null): string {
  if (s.kind === "interval") return describeInterval(s.interval_seconds);
  if (s.kind === "event") return s.event_name ? `on "${s.event_name}"` : "event";
  return cronLabel || s.cron_expr || "—";
}

// ─── Result kind ──────────────────────────────────────────────────────────────

const RESULT_KIND_LABELS: Record<ResultKind, string> = {
  transcript: "transcript",
  artifact: "artifact",
  summary: "summary",
  notification: "notification",
};

function resultKindLabel(kind: ResultKind): string {
  return RESULT_KIND_LABELS[kind] ?? kind;
}

/** Tool access, said in words rather than in the API's camelCase. */
function permissionLabel(mode: string): string {
  if (mode === "bypassPermissions") return "full access";
  if (mode === "dontAsk") return "allowed tools only";
  return mode;
}

// ─── Live xterm attach for running scheduled runs ────────────────────────────

/**
 * Thin xterm.js wrapper that subscribes to `terminal_output:{ptyId}` events.
 *
 * 1. On mount: replays the already-received transcript (pre-run) then tails live.
 * 2. On `ptyId` change (new run selected): clears and re-subscribes.
 * 3. Closing the view does NOT kill the run — the scheduler owns the PTY.
 */
interface LiveRunTerminalProps {
  ptyId: string;
  /** UTF-8 text already written to the transcript file (for replay). */
  preloadContent: string | null;
}

function LiveRunTerminal({ ptyId, preloadContent }: LiveRunTerminalProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  // Create/destroy xterm on ptyId change.
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      rows: 24,
      cols: 120,
      scrollback: 5000,
      disableStdin: true, // read-only — detach does not kill the run
      theme: {
        background: "transparent",
        foreground:
          getComputedStyle(document.documentElement)
            .getPropertyValue("--fg-2")
            .trim() || "#a8abaf",
      },
      fontSize: 12,
      fontFamily: "Menlo, 'Courier New', monospace",
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    // Replay transcript (best-effort: content may be partial or empty).
    if (preloadContent) {
      term.write(preloadContent);
    }

    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyId]);

  // Live output: write each base64 chunk to the terminal.
  const handleChunk = useCallback((chunk: string) => {
    if (!termRef.current) return;
    try {
      // Chunks are base64-encoded UTF-8 bytes.
      const binary = atob(chunk);
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      termRef.current.write(bytes);
    } catch {
      // Ignore decode errors; the transcript file is the authoritative record.
    }
  }, []);

  useTerminalOutput(ptyId, handleChunk);

  return (
    <div
      ref={containerRef}
      className={styles.liveTerm}
      aria-label="Live run output"
    />
  );
}

// ─── Adaptive per-run output pane ────────────────────────────────────────────

/** The output pane frame: Deck's terminal shell, used for every renderer. */
function OutPane({
  label,
  head,
  children,
}: {
  label: string;
  head?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <div className={styles.out}>
      <div className="dk-term__h">
        <span>{label}</span>
        {head}
      </div>
      {children}
    </div>
  );
}

function OutBody({ children }: { children: ReactNode }): ReactElement {
  return <div className={sx("dk-term__b", styles.outBody)}>{children}</div>;
}

type TranscriptQuery = ReturnType<typeof useScheduleRunTranscript>;

/** Truncated session-id chip shown in output-pane headers. */
function SessionChip({ sessionId }: { sessionId: string | null }): ReactElement | null {
  if (!sessionId) return null;
  return <span className="dk-tag">session {sessionId.slice(0, 8)}…</span>;
}

/** PASS/FAIL derived from a finished run's exit code. Shared by the failed-run
 *  branch and the summary/notification result kinds. */
function SummaryCard({ run }: { run: ScheduleRun }): ReactElement {
  const passed = run.exit_code === 0;
  return (
    <OutPane
      label="result"
      head={
        <span className="dk-tag" data-s={passed ? "done" : "fail"}>
          {passed ? "pass" : "fail"}
        </span>
      }
    >
      <OutBody>
        <span className="dk-actions" style={{ marginBottom: "var(--u2)" }}>
          {run.exit_code != null && <span className="dim">exit {run.exit_code}</span>}
          <span className="dim">{fmtDurationMs(run.duration_ms)}</span>
          {run.tokens_in != null && (
            <span className="dim">
              {formatCount(run.tokens_in + (run.tokens_out ?? 0))} tokens
            </span>
          )}
          {run.cost_usd != null && <span className="dim">${run.cost_usd.toFixed(4)}</span>}
        </span>
        {run.summary_text ? `\n${run.summary_text}` : ""}
      </OutBody>
    </OutPane>
  );
}

/** Terminal runs that produced no result (cancelled / missed / skipped /
 *  reaped) — distinct from a real PASS/FAIL outcome. */
function NoResultCard({ run }: { run: ScheduleRun }): ReactElement {
  return (
    <OutPane
      label="result"
      head={
        <span className="dk-tag" data-s={runState(run.status)}>
          {runWord(run.status)}
        </span>
      }
    >
      <OutBody>
        <span className="dim">no result produced</span>
        {run.detail || run.summary_text ? `\n${run.detail ?? run.summary_text}` : ""}
      </OutBody>
    </OutPane>
  );
}

/** Transcript pane: header + loading/content/empty states. `notice` renders an
 *  optional line above the transcript (artifact-fallback case). */
function TranscriptPane({
  q,
  sessionId,
  notice,
}: {
  q: TranscriptQuery;
  sessionId: string | null;
  notice?: string;
}): ReactElement {
  return (
    <OutPane label="transcript" head={<SessionChip sessionId={sessionId} />}>
      <OutBody>
        {notice && <div className="dim">{notice}</div>}
        {q.isPending ? (
          <span className="dim">Loading transcript…</span>
        ) : q.data?.content ? (
          q.data.content
        ) : (
          <span className="dim">No transcript recorded.</span>
        )}
      </OutBody>
    </OutPane>
  );
}

/** Loads and renders a markdown/text artifact file via the transcript endpoint. */
function ArtifactBody({ runId, path }: { runId: number; path: string }): ReactElement {
  const q = useScheduleRunTranscript(runId);
  if (q.isPending) return <OutBody><span className="dim">Loading artifact…</span></OutBody>;
  if (!q.data?.content) {
    return (
      <OutBody>
        <span className="dim">File not readable or empty: {path}</span>
      </OutBody>
    );
  }
  return <OutBody>{q.data.content}</OutBody>;
}

function AdaptiveRunPane({
  run,
  resultKind,
}: {
  run: ScheduleRun;
  resultKind: ResultKind;
}): ReactElement {
  // Live attach state: only populated for running runs. The result of the IPC
  // call is stored so "not yet checked" is distinguishable from "checked and no
  // active PTY". Keyed by run.id so switching runs resets.
  const [liveState, setLiveState] = useState<{
    runId: number;
    ptyId: string | null;
    checked: boolean;
  }>({ runId: -1, ptyId: null, checked: false });

  const isRunning = isRunInFlight(run.status);
  const hasFailed = !isRunning && run.exit_code != null && run.exit_code !== 0;

  // Fetch the transcript only when a transcript view will actually render: a
  // succeeded transcript-kind run, or a succeeded artifact-kind run that
  // produced no file (fallback view). NOT gated on summary_text — the executor
  // always sets summary_text on success, so gating on it left transcript views
  // stuck on "Loading…". Also fetch while running so the live terminal preloads.
  const showsTranscript =
    !isRunning &&
    run.status === "succeeded" &&
    (resultKind === "transcript" ||
      (resultKind === "artifact" && run.artifact_path == null));
  const transcriptQ = useScheduleRunTranscript(
    isRunning || showsTranscript ? run.id : undefined,
  );

  // For running runs: ask the shell which pty_id is active.
  useEffect(() => {
    if (!isRunning) return;
    if (liveState.runId === run.id && liveState.checked) return;
    let cancelled = false;
    void getScheduleRunPtyId(run.id).then((info) => {
      if (cancelled) return;
      setLiveState({ runId: run.id, ptyId: info.pty_id ?? null, checked: true });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id, isRunning]);

  const ptyId = isRunning && liveState.runId === run.id ? liveState.ptyId : null;
  const attachChecked = isRunning && liveState.runId === run.id ? liveState.checked : false;

  // 1. Live attach for running runs.
  if (isRunning) {
    return (
      <OutPane
        label="live output"
        head={
          <>
            <span className="dk-s" data-s="run" role="img" aria-label="running" />
            <SessionChip sessionId={run.session_id} />
            <span className="dim">viewing only — closing does not stop the run</span>
          </>
        }
      >
        {!attachChecked ? (
          <OutBody>
            <span className="dim">Attaching…</span>
          </OutBody>
        ) : ptyId != null ? (
          <LiveRunTerminal ptyId={ptyId} preloadContent={transcriptQ.data?.content ?? null} />
        ) : (
          <OutBody>
            <span className="dim">Run is starting, output will appear shortly…</span>
          </OutBody>
        )}
      </OutPane>
    );
  }

  // 2. Failed run (non-zero exit) — always show the FAIL card so auth/other
  //    errors are visible regardless of the declared result type.
  if (hasFailed) {
    return <SummaryCard run={run} />;
  }

  // 3. Terminal but produced no result (cancelled / missed / skipped / reaped
  //    with a null exit code) — a neutral card, not a misleading PASS/artifact.
  if (run.status !== "succeeded" && run.exit_code == null) {
    return <NoResultCard run={run} />;
  }

  // 4. Succeeded — render by the declared result kind.
  if (resultKind === "artifact") {
    if (run.artifact_path) {
      return (
        <OutPane
          label="artifact"
          head={
            <a
              className="dk-btn bare"
              href={`file://${run.artifact_path}`}
              target="_blank"
              rel="noreferrer"
              title={run.artifact_path}
            >
              {run.artifact_path}
            </a>
          }
        >
          <ArtifactBody runId={run.id} path={run.artifact_path} />
        </OutPane>
      );
    }
    return (
      <TranscriptPane
        q={transcriptQ}
        sessionId={run.session_id}
        notice="No artifact file was produced — showing transcript"
      />
    );
  }

  if (resultKind === "summary" || resultKind === "notification") {
    return <SummaryCard run={run} />;
  }

  // Default branch: resultKind === "transcript".
  return <TranscriptPane q={transcriptQ} sessionId={run.session_id} />;
}

// ─── Run history ──────────────────────────────────────────────────────────────

const COLS_RUN = "14px 100px 92px minmax(0, 1fr) 88px 84px";

function RunHistory({
  runs,
  selectedRunId,
  onSelectRun,
}: {
  runs: ScheduleRun[];
  selectedRunId: number | null;
  onSelectRun: (id: number) => void;
}): ReactElement {
  useNow(); // keep in-flight "started" times ticking live
  if (runs.length === 0) {
    return <div className="dk-note">No runs yet.</div>;
  }
  return (
    <DeckGrid cols={COLS_RUN} label="Run history">
      <DeckHead cells={["status", "trigger", "started", "r duration", "r cost"]} />
      {runs.map((r) => (
        <DeckLine
          key={r.id}
          state={runState(r.status)}
          selected={selectedRunId === r.id}
          onOpen={() => onSelectRun(r.id)}
          cells={[
            { v: runWord(r.status), cls: "sub" },
            r.trigger ?? r.trigger_kind,
            {
              v: isRunInFlight(r.status)
                ? fmtRelTime(r.started_at ?? r.fired_at)
                : fmtAbsTime(r.started_at ?? r.fired_at),
              title: fmtAbsTime(r.started_at ?? r.fired_at),
            },
            { v: fmtDurationMs(r.duration_ms), cls: "r" },
            { v: r.cost_usd != null ? `$${r.cost_usd.toFixed(4)}` : "—", cls: "r" },
          ]}
        />
      ))}
    </DeckGrid>
  );
}

// ─── Schedule detail ──────────────────────────────────────────────────────────

interface ScheduleDetailProps {
  schedule: Schedule;
  humanSchedule: string;
  projectName: string | null;
  onEdit: () => void;
  onClose: () => void;
}

function ScheduleDetail({
  schedule,
  humanSchedule,
  projectName,
  onEdit,
  onClose,
}: ScheduleDetailProps): ReactElement {
  useNow(); // keep the "next run" relative time ticking live
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const runsQ = useScheduleRuns(schedule.id);
  const update = useUpdateSchedule();
  const remove = useDeleteSchedule();
  const fire = useFireScheduleManual();

  const runs = runsQ.data?.runs ?? [];

  // Derive the effective selected run id: explicit selection, else the most
  // recent run (avoids setState-in-effect).
  const effectiveRunId = selectedRunId ?? runs[0]?.id ?? null;
  const selectedRunQ = useScheduleRun(effectiveRunId ?? undefined);

  function handleToggle(): void {
    update.mutate(
      { id: schedule.id, patch: { enabled: !schedule.enabled } },
      { onError: (e) => toast.error(`Toggle failed: ${e.message}`) },
    );
  }

  function handleFire(): void {
    fire.mutate(schedule.id, {
      onSuccess: () => {
        toast.success(`Fired ${schedule.name}`);
        void runsQ.refetch();
      },
      onError: (e) => toast.error(`Fire failed: ${e.message}`),
    });
  }

  function handleDelete(): void {
    if (!confirm(`Delete schedule "${schedule.name}"?`)) return;
    remove.mutate(schedule.id, {
      onSuccess: () => onClose(),
      onError: (e) => toast.error(`Delete failed: ${e.message}`),
    });
  }

  const selectedRun =
    selectedRunQ.data ?? runs.find((r) => r.id === effectiveRunId) ?? null;

  const kv: Array<[string, ReactNode]> = [
    ["agent", schedule.agent_name || <span className="dim">none</span>],
    ["project", projectName ?? <span className="dim">workspace</span>],
    ["model", schedule.model || <span className="dim">provider default</span>],
    ["run mode", schedule.run_mode],
    ["result", resultKindLabel(schedule.result_kind)],
    [
      "tool access",
      schedule.permission_mode === "bypassPermissions" ? (
        <span style={{ color: "var(--warn)" }}>{permissionLabel(schedule.permission_mode)}</span>
      ) : (
        permissionLabel(schedule.permission_mode)
      ),
    ],
    ["tools", schedule.allowed_tools || <span className="dim">all</span>],
    [
      "budget",
      schedule.max_budget_usd != null ? (
        `$${schedule.max_budget_usd.toFixed(2)}`
      ) : (
        <span className="dim">no limit</span>
      ),
    ],
    [
      "runtime",
      schedule.max_runtime_sec != null ? (
        `${schedule.max_runtime_sec}s`
      ) : (
        <span className="dim">no limit</span>
      ),
    ],
    ["notify", schedule.notify_policy],
  ];

  if (schedule.result_kind === "artifact") {
    kv.push([
      "output",
      schedule.artifact_dir ?? <span className="dim">workspace default</span>,
    ]);
  }

  return (
    <>
      <div className="dk-bar">
        <span className="dk-bar__ref">#{schedule.id}</span>
        <span style={{ color: "var(--fg)" }}>{schedule.name}</span>
        <span className="dk-tag" data-s={schedule.enabled ? "run" : undefined}>
          {schedule.enabled ? "enabled" : "disabled"}
        </span>
        <span className="dk-tag">{resultKindLabel(schedule.result_kind)}</span>
        <span className="dim" title={schedule.cron_expr ?? ""}>
          {humanSchedule}
        </span>
        {schedule.enabled && schedule.next_fire_at && (
          <span className="dim" title={fmtAbsTime(schedule.next_fire_at)}>
            next {fmtRelTime(schedule.next_fire_at)}
          </span>
        )}
        <span className="sp" />
        <span className="dk-actions">
          <button
            type="button"
            className="dk-btn"
            onClick={handleFire}
            disabled={fire.isPending}
            title="Run now (manual fire)"
          >
            {fire.isPending ? "firing…" : "run now"}
          </button>
          <button type="button" className="dk-btn" onClick={onEdit}>
            edit
          </button>
          <DeckMenu
            label={`Actions for ${schedule.name}`}
            items={[
              {
                label: schedule.enabled ? "Disable schedule" : "Enable schedule",
                disabled: update.isPending,
                onSelect: handleToggle,
              },
              {
                label: "Delete schedule",
                danger: true,
                separated: true,
                disabled: remove.isPending,
                onSelect: handleDelete,
              },
            ]}
          />
          <button
            type="button"
            className="dk-btn bare icon"
            onClick={onClose}
            aria-label="Close detail"
          >
            ×
          </button>
        </span>
      </div>

      <div className="dk-detail">
        <div>
          {schedule.prompt && (
            <DeckGroup label="prompt" collapsible defaultOpen={false}>
              <div className={styles.out}>
                <OutBody>{schedule.prompt}</OutBody>
              </div>
            </DeckGroup>
          )}

          <DeckGroup
            label="runs"
            count={runs.length}
            note={runs.length > 0 ? <HealthStrip runs={runs} /> : undefined}
          >
            {runsQ.isPending ? (
              <div className="dk-note">Loading…</div>
            ) : (
              <RunHistory
                runs={runs}
                selectedRunId={effectiveRunId}
                onSelectRun={setSelectedRunId}
              />
            )}
          </DeckGroup>

          {selectedRun != null ? (
            <AdaptiveRunPane run={selectedRun} resultKind={schedule.result_kind} />
          ) : (
            runs.length > 0 && <div className="dk-note">Select a run to view its output.</div>
          )}
        </div>

        <div>
          <h2 className="dk-group__h">launch spec</h2>
          {kv.map(([k, v]) => (
            <div className="dk-kv" key={k}>
              <span>{k}</span>
              <span>{v}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ─── Cron builder ─────────────────────────────────────────────────────────────

type PresetKind =
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthly"
  | "every_n_hours"
  | "custom";

const PRESET_LABELS: Record<PresetKind, string> = {
  daily: "Every day",
  weekdays: "Weekdays (Mon–Fri)",
  weekly: "Weekly",
  monthly: "Monthly",
  every_n_hours: "Every N hours",
  custom: "Custom (raw cron)",
};

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const N_HOURS_OPTIONS = [1, 2, 3, 4, 6, 8, 12, 24];

interface CronBuilderProps {
  preset: PresetKind;
  hour: number;
  minute: number;
  weekdays: number[];
  dayOfMonth: number;
  everyNHours: number;
  customCron: string;
  onPresetChange: (p: PresetKind) => void;
  onHourChange: (h: number) => void;
  onMinuteChange: (m: number) => void;
  onWeekdaysChange: (w: number[]) => void;
  onDayOfMonthChange: (d: number) => void;
  onEveryNHoursChange: (n: number) => void;
  onCustomCronChange: (s: string) => void;
}

function CronBuilder({
  preset,
  hour,
  minute,
  weekdays,
  dayOfMonth,
  everyNHours,
  customCron,
  onPresetChange,
  onHourChange,
  onMinuteChange,
  onWeekdaysChange,
  onDayOfMonthChange,
  onEveryNHoursChange,
  onCustomCronChange,
}: CronBuilderProps): ReactElement {
  const showTime =
    preset === "daily" ||
    preset === "weekdays" ||
    preset === "weekly" ||
    preset === "monthly";

  const amPm = hour < 12 ? "AM" : "PM";
  const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;

  function handleAmPm(val: string): void {
    if (val === "AM" && hour >= 12) onHourChange(hour - 12);
    else if (val === "PM" && hour < 12) onHourChange(hour + 12);
  }

  function toggleWeekday(d: number): void {
    if (weekdays.includes(d)) {
      onWeekdaysChange(weekdays.filter((x) => x !== d));
    } else {
      onWeekdaysChange([...weekdays, d].sort((a, b) => a - b));
    }
  }

  return (
    <div className={styles.grid}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="cb-preset">
          repeat
        </label>
        <select
          id="cb-preset"
          className={styles.ctl}
          value={preset}
          onChange={(e) => onPresetChange(e.target.value as PresetKind)}
        >
          {(Object.keys(PRESET_LABELS) as PresetKind[]).map((k) => (
            <option key={k} value={k}>
              {PRESET_LABELS[k]}
            </option>
          ))}
        </select>
      </div>

      {showTime && (
        <div className={styles.field}>
          <span className={styles.label}>time</span>
          <div className={styles.row}>
            <select
              className={sx(styles.ctl, styles.narrowCtl)}
              value={displayHour}
              onChange={(e) => {
                const h12 = Number(e.target.value);
                const base =
                  amPm === "PM" ? (h12 === 12 ? 12 : h12 + 12) : h12 === 12 ? 0 : h12;
                onHourChange(base);
              }}
              aria-label="Hour"
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, "0")}
                </option>
              ))}
            </select>
            <span className="dim">:</span>
            <select
              className={sx(styles.ctl, styles.narrowCtl)}
              value={minute}
              onChange={(e) => onMinuteChange(Number(e.target.value))}
              aria-label="Minute"
            >
              {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => (
                <option key={m} value={m}>
                  {String(m).padStart(2, "0")}
                </option>
              ))}
            </select>
            <select
              className={sx(styles.ctl, styles.narrowCtl)}
              value={amPm}
              onChange={(e) => handleAmPm(e.target.value)}
              aria-label="AM/PM"
            >
              <option value="AM">AM</option>
              <option value="PM">PM</option>
            </select>
          </div>
        </div>
      )}

      {preset === "weekly" && (
        <div className={sx(styles.field, styles.full)}>
          <span className={styles.label}>on</span>
          <div className="dk-actions">
            {WEEKDAY_LABELS.map((label, idx) => (
              <button
                key={idx}
                type="button"
                className={sx("dk-btn", weekdays.includes(idx) && "pri")}
                aria-pressed={weekdays.includes(idx)}
                onClick={() => toggleWeekday(idx)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {preset === "monthly" && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor="cb-dom">
            day
          </label>
          <div className={styles.row}>
            <select
              id="cb-dom"
              className={sx(styles.ctl, styles.narrowCtl)}
              value={dayOfMonth}
              onChange={(e) => onDayOfMonthChange(Number(e.target.value))}
            >
              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <span className={styles.help}>of each month (max 28)</span>
          </div>
        </div>
      )}

      {preset === "every_n_hours" && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor="cb-nhours">
            every
          </label>
          <div className={styles.row}>
            <select
              id="cb-nhours"
              className={sx(styles.ctl, styles.narrowCtl)}
              value={everyNHours}
              onChange={(e) => onEveryNHoursChange(Number(e.target.value))}
            >
              {N_HOURS_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span className={styles.help}>hour(s)</span>
          </div>
        </div>
      )}

      {preset === "custom" && (
        <div className={sx(styles.field, styles.full)}>
          <label className={styles.label} htmlFor="cb-custom">
            cron
          </label>
          <input
            id="cb-custom"
            className={styles.ctl}
            value={customCron}
            onChange={(e) => onCustomCronChange(e.target.value)}
            placeholder="0 9 * * *"
            spellCheck={false}
          />
        </div>
      )}
    </div>
  );
}

/** Live preview — calls the cron-preview endpoint and shows the description
 *  plus the next three fires. */
function CronPreviewBar({ previewInput }: { previewInput: CronPreviewInput }): ReactElement {
  const preview = useCronPreview();
  // Debounce a STABLE serialized key, not the object. previewInput is recreated
  // by the parent on every render (e.g. each prompt keystroke); debouncing the
  // object reference re-fires the mutation on unrelated edits and makes the bar
  // blink. Keying on the JSON string only re-fires when the schedule changes.
  const inputKey = useDebounce(JSON.stringify(previewInput), 400);

  // Retain the last good result so a legitimate refetch (e.g. editing the cron)
  // doesn't flash the bar to "Calculating…".
  const [lastData, setLastData] = useState<CronPreview | null>(null);

  useEffect(() => {
    const input = JSON.parse(inputKey) as CronPreviewInput;
    const hasContent =
      input.preset_kind != null ||
      (typeof input.cron_expr === "string" && input.cron_expr.trim().length > 0);
    if (!hasContent) return;
    preview.mutate(input, { onSuccess: (data) => setLastData(data) });
    // preview.mutate intentionally not in deps — mutation fn is stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputKey]);

  const data = preview.data ?? lastData;
  if (!data && !preview.isPending) return <></>;

  return (
    <div className="dk-note" style={{ padding: "var(--u2) var(--u3)" }}>
      {!data && preview.isPending ? (
        "Calculating…"
      ) : !data && preview.isError ? (
        <span style={{ color: "var(--err)" }}>Invalid cron expression</span>
      ) : data ? (
        <span className={styles.row}>
          <span className="dk-s" data-s="todo" role="img" aria-label="queued" />
          <span style={{ color: "var(--fg-2)" }}>{data.description}</span>
          {data.cron_expr && <span className="dk-tag">{data.cron_expr}</span>}
          <span>
            next {data.next_fires.slice(0, 3).map((f) => fmtAbsTime(f)).join(" · ")}
          </span>
        </span>
      ) : null}
    </div>
  );
}

// ─── Form state ───────────────────────────────────────────────────────────────

interface FormState {
  name: string;
  preset: PresetKind;
  hour: number;
  minute: number;
  weekdays: number[];
  dayOfMonth: number;
  everyNHours: number;
  customCron: string;
  projectId: number | "";
  providerId: number | "";
  model: string;
  agentName: string;
  prompt: string;
  runMode: RunMode;
  resultKind: ResultKind;
  artifactDir: string;
  // Advanced
  permissionMode: string;
  allowedTools: string;
  maxBudgetUsd: string;
  maxRuntimeSec: string;
  notifyPolicy: NotifyPolicy;
}

function defaultForm(): FormState {
  return {
    name: "",
    preset: "daily",
    hour: 9,
    minute: 0,
    weekdays: [1],
    dayOfMonth: 1,
    everyNHours: 4,
    customCron: "",
    projectId: "",
    providerId: "",
    model: "",
    agentName: "",
    prompt: "",
    runMode: "background",
    resultKind: "transcript",
    artifactDir: "",
    permissionMode: "dontAsk",
    allowedTools: "",
    maxBudgetUsd: "",
    maxRuntimeSec: "",
    notifyPolicy: "on_failure",
  };
}

function scheduleToForm(s: Schedule): FormState {
  // Interval schedules edit through the "Every N hours" preset; cron schedules
  // open as raw cron (Custom) so the exact expression is always visible.
  const isInterval = s.kind === "interval";
  return {
    ...defaultForm(),
    name: s.name,
    preset: isInterval ? "every_n_hours" : "custom",
    everyNHours:
      isInterval && s.interval_seconds
        ? Math.max(1, Math.round(s.interval_seconds / 3600))
        : 4,
    customCron: s.cron_expr ?? "",
    projectId: s.project_id ?? "",
    providerId: s.provider_id ?? "",
    model: s.model ?? "",
    agentName: s.agent_name ?? "",
    prompt: s.prompt ?? "",
    runMode: s.run_mode,
    resultKind: s.result_kind,
    artifactDir: s.artifact_dir ?? "",
    permissionMode: s.permission_mode,
    allowedTools: s.allowed_tools ?? "",
    maxBudgetUsd: s.max_budget_usd != null ? String(s.max_budget_usd) : "",
    maxRuntimeSec: s.max_runtime_sec != null ? String(s.max_runtime_sec) : "",
    notifyPolicy: s.notify_policy,
  };
}

function formToPreviewInput(f: FormState): CronPreviewInput {
  if (f.preset === "custom") {
    return { cron_expr: f.customCron.trim() };
  }
  return {
    preset_kind: f.preset,
    hour: f.hour,
    minute: f.minute,
    weekdays: f.preset === "weekly" ? f.weekdays : undefined,
    day_of_month: f.preset === "monthly" ? f.dayOfMonth : undefined,
    every_n_hours: f.preset === "every_n_hours" ? f.everyNHours : undefined,
    count: 3,
  };
}

/**
 * Mirrors `_cron_helpers.preset_to_cron` for the create/edit path so we can
 * pass a concrete cron_expr to the API without an extra round-trip.
 */
function encodedPresetCron(f: FormState): string {
  const h = String(f.hour).padStart(2, "0");
  const m = String(f.minute).padStart(2, "0");
  switch (f.preset) {
    case "daily":
      return `${f.minute} ${f.hour} * * *`;
    case "weekdays":
      return `${f.minute} ${f.hour} * * 1-5`;
    case "weekly": {
      const days = f.weekdays.length > 0 ? f.weekdays.join(",") : "1";
      return `${f.minute} ${f.hour} * * ${days}`;
    }
    case "monthly":
      return `${f.minute} ${f.hour} ${f.dayOfMonth} * *`;
    case "every_n_hours":
      return `0 */${f.everyNHours} * * *`;
    case "custom":
      return f.customCron.trim();
    default:
      return `${m} ${h} * * *`;
  }
}

// ─── Modal shell ──────────────────────────────────────────────────────────────

/** Escape closes, as it does for `DeckMenu`; click-through on the scrim closes. */
function Modal({
  title,
  onClose,
  narrow,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  narrow?: boolean;
  children: ReactNode;
  footer: ReactNode;
}): ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className={styles.scrim}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={sx(styles.modal, narrow && styles.narrow)}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className={styles.modalHead}>
          <h2>{title}</h2>
          <span className={styles.spacer} />
          <button
            type="button"
            className="dk-btn bare icon"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className={styles.modalBody}>{children}</div>
        <div className={styles.modalFoot}>{footer}</div>
      </div>
    </div>
  );
}

// ─── Schedule form ────────────────────────────────────────────────────────────

interface ScheduleFormModalProps {
  /** When non-null, we are editing an existing schedule. */
  editing: Schedule | null;
  /** Starter values for a new schedule (empty-state shortcuts). */
  seed?: Partial<FormState> | null;
  onClose: () => void;
}

function ScheduleFormModal({ editing, seed, onClose }: ScheduleFormModalProps): ReactElement {
  const [form, setForm] = useState<FormState>(
    editing != null ? scheduleToForm(editing) : { ...defaultForm(), ...seed },
  );
  const [showAdvanced, setShowAdvanced] = useState(false);

  const providersQ = useProviders();
  const providerModelsQ = useProviderModels(form.providerId !== "" ? form.providerId : null);
  const projectsQ = useProjects();
  const configuredAgentsQ = useConfiguredAgents();

  const create = useCreateSchedule();
  const update = useUpdateSchedule();

  // Track previous providerId so we only auto-fill model when the provider
  // actually changes (avoids setState-in-effect cascading render warning).
  const prevProviderIdRef = useRef<number | "">(form.providerId);

  function patch<K extends keyof FormState>(key: K, val: FormState[K]): void {
    if (key === "providerId" && val !== prevProviderIdRef.current) {
      prevProviderIdRef.current = val as number | "";
      // Auto-fill the provider's default model when switching providers.
      const prov = (providersQ.data ?? []).find((p) => p.id === Number(val));
      setForm((f) => ({ ...f, [key]: val, model: prov?.default_model ?? "" }));
      return;
    }
    setForm((f) => ({ ...f, [key]: val }));
  }

  const allAgents = [...(configuredAgentsQ.data?.shared ?? [])];

  // Auto-select first provider when creating a new schedule and providers load.
  useEffect(() => {
    if (editing != null) return;
    if (form.providerId !== "") return;
    const first = (providersQ.data ?? [])[0];
    if (first != null) {
      patch("providerId", first.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providersQ.data]);

  function buildCreateInput(): ScheduleCreateInput | null {
    if (!form.name.trim()) {
      toast.error("Name is required");
      return null;
    }
    if (form.providerId === "") {
      toast.error("Provider is required");
      return null;
    }
    const isCustom = form.preset === "custom";
    if (isCustom && !form.customCron.trim()) {
      toast.error("Cron expression is required for Custom preset");
      return null;
    }

    const base: ScheduleCreateInput = {
      name: form.name.trim(),
      kind: "cron",
      agent_name: form.agentName.trim() || "",
      prompt: form.prompt.trim(),
      enabled: true,
      project_id: form.projectId !== "" ? Number(form.projectId) : null,
      provider_id: Number(form.providerId),
      model: form.model.trim() || null,
      run_mode: form.runMode,
      result_kind: form.resultKind,
      artifact_dir: form.artifactDir.trim() || null,
      permission_mode: form.permissionMode,
      allowed_tools: form.allowedTools.trim() || null,
      max_budget_usd: form.maxBudgetUsd !== "" ? Number(form.maxBudgetUsd) : null,
      max_runtime_sec: form.maxRuntimeSec !== "" ? Number(form.maxRuntimeSec) : null,
      notify_policy: form.notifyPolicy,
    };

    if (form.preset === "every_n_hours") {
      // "Every N hours" is an interval schedule anchored to creation time, so
      // the next run is N hours from now (not the next even-hour cron boundary).
      base.kind = "interval";
      base.interval_seconds = Math.max(1, form.everyNHours) * 3600;
    } else if (isCustom) {
      base.cron_expr = form.customCron.trim();
    } else {
      // Time-of-day presets map to a concrete cron expression client-side
      // (mirrors the backend preset_to_cron) so create needs no extra round-trip.
      base.cron_expr = encodedPresetCron(form);
    }

    return base;
  }

  function buildPatch(): SchedulePatch {
    // Interval vs cron are mutually exclusive: the backend rejects cron_expr on
    // an interval schedule (and vice-versa), so send only the relevant cadence.
    const cadence: SchedulePatch =
      form.preset === "every_n_hours"
        ? { interval_seconds: Math.max(1, form.everyNHours) * 3600 }
        : {
            cron_expr:
              form.preset === "custom" ? form.customCron.trim() || null : encodedPresetCron(form),
          };
    return {
      name: form.name.trim(),
      ...cadence,
      agent_name: form.agentName.trim() || "",
      prompt: form.prompt.trim(),
      project_id: form.projectId !== "" ? Number(form.projectId) : null,
      provider_id: form.providerId !== "" ? Number(form.providerId) : null,
      model: form.model.trim() || null,
      run_mode: form.runMode,
      result_kind: form.resultKind,
      artifact_dir: form.artifactDir.trim() || null,
      permission_mode: form.permissionMode,
      allowed_tools: form.allowedTools.trim() || null,
      max_budget_usd: form.maxBudgetUsd !== "" ? Number(form.maxBudgetUsd) : null,
      max_runtime_sec: form.maxRuntimeSec !== "" ? Number(form.maxRuntimeSec) : null,
      notify_policy: form.notifyPolicy,
    };
  }

  function handleSubmit(): void {
    if (editing != null) {
      if (form.providerId === "") {
        toast.error("Provider is required");
        return;
      }
      update.mutate(
        { id: editing.id, patch: buildPatch() },
        {
          onSuccess: () => {
            toast.success("Saved");
            onClose();
          },
          onError: (e) => toast.error(`Save failed: ${e.message}`),
        },
      );
    } else {
      const input = buildCreateInput();
      if (!input) return;
      create.mutate(input, {
        onSuccess: () => {
          toast.success("Schedule created");
          onClose();
        },
        onError: (e) => toast.error(`Create failed: ${e.message}`),
      });
    }
  }

  const previewInput = formToPreviewInput(form);
  const isPending = create.isPending || update.isPending;

  const providers = providersQ.data ?? [];
  const projects = (projectsQ.data ?? []).filter((p) => !p.is_workspace);
  const providerModels = providerModelsQ.data ?? [];

  return (
    <Modal
      title={editing != null ? "edit schedule" : "new schedule"}
      onClose={onClose}
      footer={
        <>
          <span className={styles.spacer} />
          <span className="dk-actions">
            <button type="button" className="dk-btn" onClick={onClose} disabled={isPending}>
              cancel
            </button>
            <button
              type="button"
              className="dk-btn pri"
              onClick={handleSubmit}
              disabled={isPending}
            >
              {isPending
                ? editing != null
                  ? "saving…"
                  : "creating…"
                : editing != null
                  ? "save changes"
                  : "create schedule"}
            </button>
          </span>
        </>
      }
    >
      <div className={styles.field}>
        <label className={styles.label} htmlFor="sf-name">
          name
        </label>
        <input
          id="sf-name"
          className={styles.ctl}
          value={form.name}
          onChange={(e) => patch("name", e.target.value)}
          placeholder="Daily digest"
          autoFocus
        />
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>when it fires</div>
        <CronBuilder
          preset={form.preset}
          hour={form.hour}
          minute={form.minute}
          weekdays={form.weekdays}
          dayOfMonth={form.dayOfMonth}
          everyNHours={form.everyNHours}
          customCron={form.customCron}
          onPresetChange={(p) => patch("preset", p)}
          onHourChange={(h) => patch("hour", h)}
          onMinuteChange={(m) => patch("minute", m)}
          onWeekdaysChange={(w) => patch("weekdays", w)}
          onDayOfMonthChange={(d) => patch("dayOfMonth", d)}
          onEveryNHoursChange={(n) => patch("everyNHours", n)}
          onCustomCronChange={(s) => patch("customCron", s)}
        />
        <CronPreviewBar previewInput={previewInput} />
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>what it launches</div>
        <div className={styles.grid}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="sf-project">
              project
            </label>
            <select
              id="sf-project"
              className={styles.ctl}
              value={form.projectId}
              onChange={(e) =>
                patch("projectId", e.target.value === "" ? "" : Number(e.target.value))
              }
            >
              <option value="">Workspace / none</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="sf-provider">
              provider
            </label>
            <select
              id="sf-provider"
              className={styles.ctl}
              value={form.providerId}
              onChange={(e) =>
                patch("providerId", e.target.value === "" ? "" : Number(e.target.value))
              }
            >
              <option value="" disabled>
                Select a provider…
              </option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name}
                </option>
              ))}
            </select>
            {providers.length === 0 && (
              <span className={styles.help}>
                No providers configured yet — add one in Settings before a schedule can run.
              </span>
            )}
          </div>

          {form.providerId !== "" && (
            <div className={styles.field}>
              <label className={styles.label} htmlFor="sf-model">
                model
              </label>
              <select
                id="sf-model"
                className={styles.ctl}
                value={form.model}
                onChange={(e) => patch("model", e.target.value)}
              >
                <option value="">Provider default</option>
                {providerModels.map((m) => (
                  <option key={m.id} value={m.model_name}>
                    {m.display_name}
                  </option>
                ))}
                {/* Fallback: provider.models list if no provider_models rows */}
                {providerModels.length === 0 &&
                  (providers.find((p) => p.id === Number(form.providerId))?.models ?? []).map(
                    (m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ),
                  )}
              </select>
            </div>
          )}

          <div className={styles.field}>
            <label className={styles.label} htmlFor="sf-agent">
              agent
            </label>
            <select
              id="sf-agent"
              className={styles.ctl}
              value={form.agentName}
              onChange={(e) => patch("agentName", e.target.value)}
            >
              <option value="">None (no specific agent)</option>
              {allAgents.map((a) => (
                <option key={a.id} value={a.name}>
                  {a.display_name ?? a.name}
                  {a.kind === "org" ? " (org)" : ""}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="sf-runmode">
              run mode
            </label>
            <select
              id="sf-runmode"
              className={styles.ctl}
              value={form.runMode}
              onChange={(e) => patch("runMode", e.target.value as RunMode)}
            >
              <option value="background">Background (headless)</option>
              <option value="windowed">Windowed (terminal opens)</option>
            </select>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="sf-resultkind">
              result type
            </label>
            <select
              id="sf-resultkind"
              className={styles.ctl}
              value={form.resultKind}
              onChange={(e) => patch("resultKind", e.target.value as ResultKind)}
            >
              <option value="transcript">Transcript</option>
              <option value="artifact">Artifact (file output)</option>
              <option value="summary">Summary (PASS/FAIL)</option>
              <option value="notification">Notification</option>
            </select>
          </div>

          {form.resultKind === "artifact" && (
            <div className={sx(styles.field, styles.full)}>
              <label className={styles.label} htmlFor="sf-artifactdir">
                output path
              </label>
              <div className={styles.row}>
                <input
                  id="sf-artifactdir"
                  className={styles.ctl}
                  style={{ flex: "1 1 auto", width: "auto" }}
                  value={form.artifactDir}
                  onChange={(e) => patch("artifactDir", e.target.value)}
                  placeholder="Default: workspace/schedule-artifacts/<name>"
                />
                <button
                  type="button"
                  className="dk-btn"
                  onClick={() => {
                    void (async () => {
                      const { open } = await import("@tauri-apps/plugin-dialog");
                      const result = await open({
                        directory: true,
                        multiple: false,
                        title: "Choose artifact output folder",
                      });
                      if (typeof result === "string") {
                        patch("artifactDir", result);
                      }
                    })();
                  }}
                >
                  browse…
                </button>
              </div>
              <span className={styles.help}>
                Where the agent saves its file. Leave empty to use the workspace default. The
                exact file path is appended to the prompt so the run can capture it.
              </span>
            </div>
          )}

          <div className={sx(styles.field, styles.full)}>
            <label className={styles.label} htmlFor="sf-prompt">
              prompt
            </label>
            <textarea
              id="sf-prompt"
              className={styles.ctl}
              value={form.prompt}
              onChange={(e) => patch("prompt", e.target.value)}
              placeholder="Describe what the agent should do…"
              rows={4}
            />
          </div>
        </div>
      </div>

      <details
        open={showAdvanced}
        onToggle={(e) => setShowAdvanced((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary className={styles.sectionHead} style={{ cursor: "pointer" }}>
          advanced
        </summary>
        <div className={styles.grid} style={{ marginTop: "var(--u3)" }}>
          {/* Permission mode — only the two modes that are safe for an
              unattended run are offered. 'default'/'plan'/'auto' would block on
              an interactive prompt that no one can answer (and stall the run),
              so they are intentionally not selectable; a legacy value already
              stored on the schedule is preserved. */}
          <div className={styles.field}>
            <label className={styles.label} htmlFor="sf-perm">
              tool access
            </label>
            <select
              id="sf-perm"
              className={styles.ctl}
              value={form.permissionMode}
              onChange={(e) => patch("permissionMode", e.target.value)}
            >
              <option value="dontAsk">Allowed tools only (safe default)</option>
              <option value="bypassPermissions">Full access — runs any tool autonomously</option>
              {!["dontAsk", "bypassPermissions"].includes(form.permissionMode) && (
                <option value={form.permissionMode}>{form.permissionMode} (advanced)</option>
              )}
            </select>
            <span className={styles.help}>
              {form.permissionMode === "bypassPermissions"
                ? "Unattended runs may use any tool (web, shell, file edits) without asking."
                : "Only the tools listed below run; anything else is denied — the run never stalls."}
            </span>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="sf-notify">
              notifications
            </label>
            <select
              id="sf-notify"
              className={styles.ctl}
              value={form.notifyPolicy}
              onChange={(e) => patch("notifyPolicy", e.target.value as NotifyPolicy)}
            >
              <option value="on_failure">On failure only</option>
              <option value="every_run">Every run</option>
              <option value="never">Never</option>
            </select>
          </div>

          <div className={sx(styles.field, styles.full)}>
            <label className={styles.label} htmlFor="sf-tools">
              allowed tools
            </label>
            <input
              id="sf-tools"
              className={styles.ctl}
              value={form.allowedTools}
              onChange={(e) => patch("allowedTools", e.target.value)}
              placeholder="Read,Bash,Edit"
            />
            <span className={styles.help}>
              Comma-separated tool names. Leave empty to allow all tools.
            </span>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="sf-budget">
              max budget
            </label>
            <input
              id="sf-budget"
              className={styles.ctl}
              type="number"
              min="0"
              step="0.01"
              value={form.maxBudgetUsd}
              onChange={(e) => patch("maxBudgetUsd", e.target.value)}
              placeholder="e.g. 1.00"
            />
            <span className={styles.help}>USD. Leave empty for no limit.</span>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="sf-runtime">
              max runtime
            </label>
            <input
              id="sf-runtime"
              className={styles.ctl}
              type="number"
              min="0"
              step="60"
              value={form.maxRuntimeSec}
              onChange={(e) => patch("maxRuntimeSec", e.target.value)}
              placeholder="e.g. 3600"
            />
            <span className={styles.help}>Seconds. Leave empty for no limit.</span>
          </div>
        </div>
      </details>
    </Modal>
  );
}

// ─── Retention ────────────────────────────────────────────────────────────────

function RetentionModal({ onClose }: { onClose: () => void }): ReactElement {
  const retentionQ = useScheduleRetention();
  const setRetention = useSetScheduleRetention();
  // Retain the draft separately; the displayed value is the draft if it was
  // touched, otherwise the server value (no setState-in-effect).
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? (retentionQ.data != null ? String(retentionQ.data.retention_days) : "30");

  function handleSave(): void {
    const days = Number(value);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      toast.error("Retention must be 1–365 days");
      return;
    }
    setRetention.mutate(days, {
      onSuccess: () => toast.success("Retention setting saved"),
      onError: (e) => toast.error(`Save failed: ${e.message}`),
    });
  }

  return (
    <Modal
      title="transcript retention"
      onClose={onClose}
      narrow
      footer={
        <>
          <span className={styles.spacer} />
          <span className="dk-actions">
            <button type="button" className="dk-btn" onClick={onClose}>
              cancel
            </button>
            <button
              type="button"
              className="dk-btn pri"
              onClick={handleSave}
              disabled={setRetention.isPending}
            >
              {setRetention.isPending ? "saving…" : "save"}
            </button>
          </span>
        </>
      }
    >
      <div className="dk-note sans">
        Run metadata and artifact files are kept. Internal run transcripts (raw logs) are deleted
        after this many days to reclaim disk space. The prune runs on startup and then once per
        day.
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="ret-days">
          keep transcripts for (days)
        </label>
        <input
          id="ret-days"
          className={styles.ctl}
          type="number"
          min="1"
          max="365"
          value={value}
          onChange={(e) => setDraft(e.target.value)}
        />
      </div>
    </Modal>
  );
}

// ─── Schedule row ─────────────────────────────────────────────────────────────

const COLS_SCHEDULE = "14px minmax(0, 1fr) 180px 96px 150px 72px 94px 112px";

interface ScheduleRowProps {
  schedule: Schedule;
  cronLabel: string | null;
  projectName: string | null;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
}

function ScheduleRow({
  schedule,
  cronLabel,
  projectName,
  selected,
  onSelect,
  onEdit,
}: ScheduleRowProps): ReactElement {
  useNow(); // keep next/last-run relative times ticking live
  const update = useUpdateSchedule();
  const remove = useDeleteSchedule();
  const fire = useFireScheduleManual();
  const runsQ = useScheduleRuns(schedule.id);
  const runs = runsQ.data?.runs ?? [];
  const lastRun = runs[0] ?? null;

  const humanSchedule = cadenceLabel(schedule, cronLabel);

  function handleToggle(): void {
    update.mutate(
      { id: schedule.id, patch: { enabled: !schedule.enabled } },
      { onError: (err) => toast.error(`Toggle failed: ${err.message}`) },
    );
  }

  function handleDelete(): void {
    if (!confirm(`Delete schedule "${schedule.name}"?`)) return;
    remove.mutate(schedule.id, {
      onError: (err) => toast.error(`Delete failed: ${err.message}`),
    });
  }

  function handleFire(): void {
    fire.mutate(schedule.id, {
      onSuccess: () => toast.success(`Fired ${schedule.name}`),
      onError: (err) => toast.error(`Fire failed: ${err.message}`),
    });
  }

  const menu: DeckMenuItem[] = [
    {
      label: schedule.enabled ? "Disable schedule" : "Enable schedule",
      disabled: update.isPending,
      onSelect: handleToggle,
    },
    {
      label: "Delete schedule",
      danger: true,
      separated: true,
      disabled: remove.isPending,
      onSelect: handleDelete,
    },
  ];

  return (
    <DeckLine
      state={scheduleState(schedule, lastRun)}
      selected={selected}
      onOpen={onSelect}
      cells={[
        {
          v: (
            <>
              {schedule.name}
              {schedule.agent_name && (
                <>
                  {" "}
                  <span className="dk-tag">{schedule.agent_name}</span>
                </>
              )}
              {projectName && (
                <>
                  {" "}
                  <span className="dim">· {projectName}</span>
                </>
              )}
            </>
          ),
          cls: "sub",
          title: schedule.name,
        },
        { v: humanSchedule, title: schedule.cron_expr ?? humanSchedule },
        {
          v: schedule.enabled && schedule.next_fire_at ? fmtRelTime(schedule.next_fire_at) : "—",
          title: fmtAbsTime(schedule.next_fire_at),
        },
        {
          v: lastRun ? (
            <>
              {fmtRelTime(lastRun.started_at ?? lastRun.fired_at)}{" "}
              <span className="dim">{runWord(lastRun.status)}</span>
            </>
          ) : (
            "never"
          ),
          title: lastRun ? fmtAbsTime(lastRun.started_at ?? lastRun.fired_at) : "never run",
        },
        { v: fmtDurationMs(lastRun?.duration_ms), cls: "r" },
        resultKindLabel(schedule.result_kind),
        {
          v: (
            <span className="dk-actions end" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="dk-btn bare"
                onClick={handleFire}
                disabled={fire.isPending}
                title="Run now (manual fire)"
              >
                run
              </button>
              <button type="button" className="dk-btn bare" onClick={onEdit}>
                edit
              </button>
              <DeckMenu label={`Actions for ${schedule.name}`} items={menu} />
            </span>
          ),
          cls: "r",
        },
      ]}
    />
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

/**
 * Three seeded starters. The empty state is what a fresh install opens on, and
 * a page that only says "none yet" leaves the owner to invent a cadence, a
 * prompt and a result type before anything can fire. Each of these opens the
 * same form, pre-filled, so the first schedule is one edit away.
 */
const STARTERS: ReadonlyArray<{ label: string; note: string; seed: Partial<FormState> }> = [
  {
    label: "morning digest",
    note: "weekdays at 09:00 — one agent reads the board and says what changed",
    seed: {
      name: "Morning digest",
      preset: "weekdays",
      hour: 9,
      minute: 0,
      resultKind: "summary",
      prompt:
        "Summarise what changed since yesterday: tasks opened and closed, failed runs, and anything blocking. Keep it under ten lines.",
    },
  },
  {
    label: "nightly check",
    note: "every day at 02:00 — runs the project's own checks and reports pass or fail",
    seed: {
      name: "Nightly check",
      preset: "daily",
      hour: 2,
      minute: 0,
      resultKind: "summary",
      prompt:
        "Run this project's full verification suite. Report PASS or FAIL, and on failure the first failing output.",
    },
  },
  {
    label: "weekly report",
    note: "Mondays at 08:00 — writes a file you can send on",
    seed: {
      name: "Weekly report",
      preset: "weekly",
      weekdays: [1],
      hour: 8,
      minute: 0,
      resultKind: "artifact",
      prompt:
        "Write a one-page report of the past week for this project and save it to the output path.",
    },
  },
];

function EmptyState({
  hasProvider,
  onStart,
}: {
  hasProvider: boolean;
  onStart: (seed: Partial<FormState>) => void;
}): ReactElement {
  return (
    <>
      <div className="dk-note sans">
        <div style={{ color: "var(--fg-2)" }}>No schedules yet</div>
        <p>
          A schedule is what turns a time into a running agent session. At the moment you choose
          it starts a real session — an agent, a prompt, a project, a provider and a model — then
          keeps the transcript, the cost and whatever file the run produced.
        </p>
        <p>Until one exists, nothing in this app fires on its own.</p>
        {!hasProvider && (
          <p style={{ color: "var(--warn)" }}>
            No provider is configured yet. A schedule needs one to launch, so add a provider in
            Settings first.
          </p>
        )}
      </div>

      <DeckGroup label="start from one of these" note="or use “new schedule” above" state="todo">
        <DeckGrid cols="14px 150px minmax(0, 1fr)" label="Starter schedules">
          <DeckHead cells={["starter", "what it does"]} />
          {STARTERS.map((s) => (
            <DeckLine
              key={s.label}
              state="todo"
              onOpen={() => onStart(s.seed)}
              cells={[
                { v: s.label, cls: "sub" },
                { v: s.note, title: s.note },
              ]}
            />
          ))}
        </DeckGrid>
      </DeckGroup>
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

/** Its own component so the 1 s tick does not re-render an open form modal. */
function NextFireStat({ at }: { at: string | undefined }): ReactElement {
  useNow();
  return (
    <div className="dk-big">
      <div className={sx("v", !at && "na")} title={fmtAbsTime(at)}>
        {at ? fmtRelTime(at) : "—"}
      </div>
      <div className="l">next fire</div>
    </div>
  );
}

export function SchedulesPage(): ReactElement {
  const schedulesQ = useSchedules();
  const schedules = schedulesQ.data?.schedules ?? [];
  const { data: projects = [] } = useProjects();
  const { data: providers = [] } = useProviders();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);
  const [formSeed, setFormSeed] = useState<Partial<FormState> | null>(null);
  const [showRetention, setShowRetention] = useState(false);
  const [humanLabels, setHumanLabels] = useState<Record<number, string>>({});

  const queryClient = useQueryClient();

  // Windowed mode: when a windowed run starts, auto-select its schedule so the
  // live output pane is on screen. Always refresh the run history so the
  // newly-started run appears immediately.
  useScheduleRunStarted(
    useCallback(
      (payload: ScheduleRunStartedPayload) => {
        // Invalidate every query the list + detail read so the queued→running
        // transition shows live (state glyph, run-history row, single run).
        void queryClient.invalidateQueries({ queryKey: ["schedules"] });
        void queryClient.invalidateQueries({
          queryKey: ["schedule-runs", payload.schedule_id],
        });
        void queryClient.invalidateQueries({
          queryKey: ["schedule-run", payload.run_id],
        });
        if (payload.run_mode === "windowed") {
          setSelectedId(payload.schedule_id);
          toast.info(`Schedule '${payload.schedule_name}' started (windowed mode)`);
        }
      },
      [queryClient],
    ),
  );

  // When a run finishes, invalidate every query the detail panel reads — the
  // schedules list (next/last run), the run-history grid, the single run, and
  // its transcript — so the UI updates live instead of only on re-select.
  useScheduleRunFinished(
    useCallback(
      (payload: ScheduleRunFinishedPayload) => {
        void queryClient.invalidateQueries({ queryKey: ["schedules"] });
        void queryClient.invalidateQueries({
          queryKey: ["schedule-runs", payload.schedule_id],
        });
        void queryClient.invalidateQueries({
          queryKey: ["schedule-run", payload.run_id],
        });
        void queryClient.invalidateQueries({
          queryKey: ["schedule-run-transcript", payload.run_id],
        });
      },
      [queryClient],
    ),
  );

  const preview = useCronPreview();

  // One human label per cron schedule, fetched once and shared by the row and
  // the detail panel.
  useEffect(() => {
    for (const s of schedules) {
      if (humanLabels[s.id] != null || !s.cron_expr) continue;
      preview.mutate(
        { cron_expr: s.cron_expr, count: 0 },
        { onSuccess: (d) => setHumanLabels((prev) => ({ ...prev, [s.id]: d.description })) },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedules]);

  const projectName = useCallback(
    (id: number | null): string | null =>
      id == null ? null : (projects.find((p) => p.id === id)?.name ?? `project #${id}`),
    [projects],
  );

  const selectedSchedule = schedules.find((s) => s.id === selectedId) ?? null;

  const openNew = useCallback((seed?: Partial<FormState>) => {
    setEditingSchedule(null);
    setFormSeed(seed ?? null);
    setFormOpen(true);
  }, []);

  const openEdit = useCallback((s: Schedule) => {
    setEditingSchedule(s);
    setFormSeed(null);
    setFormOpen(true);
  }, []);

  const closeForm = useCallback(() => {
    setFormOpen(false);
    setEditingSchedule(null);
    setFormSeed(null);
  }, []);

  const active = schedules.filter((s) => s.enabled);
  const paused = schedules.filter((s) => !s.enabled);

  // The soonest armed fire across every enabled schedule — the one number this
  // page exists to answer at a glance.
  const nextFire = active
    .map((s) => s.next_fire_at)
    .filter((v): v is string => v != null)
    .sort()[0];

  const actions: ReactNode = (
    <span className="dk-actions">
      <button
        type="button"
        className="dk-btn"
        onClick={() => setShowRetention(true)}
        title="Transcript retention settings"
      >
        retention
      </button>
      <button type="button" className="dk-btn pri" onClick={() => openNew()}>
        new schedule
      </button>
    </span>
  );

  function renderGroup(label: string, rows: Schedule[], state: DeckState): ReactElement | null {
    if (rows.length === 0) return null;
    return (
      <DeckGroup label={label} count={rows.length} state={state}>
        <DeckGrid cols={COLS_SCHEDULE} label={`${label} schedules`}>
          <DeckHead
            cells={["schedule", "cadence", "next", "last run", "r took", "result", "r "]}
          />
          {rows.map((s) => (
            <ScheduleRow
              key={s.id}
              schedule={s}
              cronLabel={humanLabels[s.id] ?? null}
              projectName={projectName(s.project_id)}
              selected={selectedId === s.id}
              onSelect={() => setSelectedId((cur) => (cur === s.id ? null : s.id))}
              onEdit={() => openEdit(s)}
            />
          ))}
        </DeckGrid>
      </DeckGroup>
    );
  }

  return (
    <DeckShell
      title="schedules"
      crumb={
        schedules.length === 0
          ? "nothing fires on its own yet"
          : `${active.length} armed · ${paused.length} paused`
      }
      actions={actions}
    >
      {schedulesQ.isPending ? (
        <div className="dk-note">Loading…</div>
      ) : schedules.length === 0 ? (
        <EmptyState hasProvider={providers.length > 0} onStart={(seed) => openNew(seed)} />
      ) : (
        <>
          <div className="dk-bigs">
            <div className="dk-big">
              <div className="v">{active.length}</div>
              <div className="l">armed · will fire on their own</div>
            </div>
            <div className="dk-big">
              <div className={sx("v", paused.length === 0 && "na")}>{paused.length}</div>
              <div className="l">paused · kept, but inert</div>
            </div>
            <NextFireStat at={nextFire} />
          </div>

          {renderGroup("armed", active, "wait")}
          {renderGroup("paused", paused, "idle")}

          {selectedSchedule != null && (
            <>
              <hr className="dk-rule" />
              <ScheduleDetail
                key={selectedSchedule.id}
                schedule={selectedSchedule}
                humanSchedule={cadenceLabel(
                  selectedSchedule,
                  humanLabels[selectedSchedule.id] ?? null,
                )}
                projectName={projectName(selectedSchedule.project_id)}
                onEdit={() => openEdit(selectedSchedule)}
                onClose={() => setSelectedId(null)}
              />
            </>
          )}
        </>
      )}

      {showRetention && <RetentionModal onClose={() => setShowRetention(false)} />}
      {formOpen && (
        <ScheduleFormModal editing={editingSchedule} seed={formSeed} onClose={closeForm} />
      )}
    </DeckShell>
  );
}
