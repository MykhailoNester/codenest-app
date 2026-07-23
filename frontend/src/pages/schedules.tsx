/**
 * Schedules page.
 *
 * Layout:
 *   SchedulesPage (Shell wrapper, list + "New" button in topbar actions)
 *     ScheduleList    — status-first job list (§6.1)
 *       ScheduleRow   — one row per job
 *     ScheduleDetail  — right-panel with run history + adaptive output pane
 *       RunHistoryTable
 *       AdaptiveRunPane — picks renderer from what the run produced
 *     ScheduleFormModal — friendly builder (§2.1) + job config (§2.2)
 *       CronBuilder — preset picker + live cron preview
 *       JobConfigFields
 *       AdvancedFields (collapsible)
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
import { Shell } from "../components/layout/shell";
import { useDebounce } from "../hooks/use-debounce";
import {
  relativeTime as fmtRelTime,
  formatDurationMs as fmtDurationMs,
} from "../lib/format-helpers";
import styles from "./schedules.module.css";

// ─── Status badge helpers ─────────────────────────────────────────────────────

interface StatusMeta {
  glyph: string;
  label: string;
  cls: string;
}

// CSS module values are typed as `string | undefined`; we assert non-null
// once here rather than scattering `!` across the object literal.
function cls(c: string | undefined): string {
  return c ?? "";
}

const STATUS_META_UNKNOWN: StatusMeta = {
  glyph: "?",
  label: "unknown",
  cls: cls(styles.statusGrey),
};

const RUN_STATUS_META: Partial<Record<string, StatusMeta>> = {
  succeeded: { glyph: "✓", label: "succeeded", cls: cls(styles.statusGreen) },
  failed: { glyph: "✗", label: "failed", cls: cls(styles.statusRed) },
  running: { glyph: "◐", label: "running", cls: cls(styles.statusBlue) },
  queued: { glyph: "◷", label: "queued", cls: cls(styles.statusGrey) },
  scheduled: { glyph: "◷", label: "scheduled", cls: cls(styles.statusGrey) },
  missed: { glyph: "⚠", label: "missed", cls: cls(styles.statusAmber) },
  timed_out: { glyph: "⏱", label: "timed out", cls: cls(styles.statusOrange) },
  cancelled: { glyph: "⊘", label: "cancelled", cls: cls(styles.statusGrey) },
  skipped: { glyph: "⤼", label: "skipped", cls: cls(styles.statusAmber) },
};

function getStatusMeta(status: string): StatusMeta {
  return RUN_STATUS_META[status] ?? { ...STATUS_META_UNKNOWN, label: status };
}

function RunStatusBadge({ status }: { status: string }): ReactElement {
  const meta = getStatusMeta(status);
  return (
    <span className={`${styles.statusBadge} ${meta.cls}`} title={meta.label}>
      <span aria-hidden="true">{meta.glyph}</span> {meta.label}
    </span>
  );
}

/** Derive health from run history: last 8 glyphs as colored dots. */
function HealthStrip({ runs }: { runs: ScheduleRun[] }): ReactElement {
  const recent = runs.slice(0, 8);
  return (
    <div className={styles.healthStrip} title="Last 8 runs">
      {recent.map((r) => {
        const meta = getStatusMeta(r.status);
        return (
          <span
            key={r.id}
            className={`${styles.healthDot} ${meta.cls}`}
            title={`${r.status} — ${fmtRelTime(r.fired_at)}`}
          />
        );
      })}
    </div>
  );
}

// ─── Time formatting ──────────────────────────────────────────────────────────
// fmtRelTime and fmtDurationMs are imported from lib/format-helpers.

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
// terminal. Live, second-by-second relative timers ("Started 3s ago …") are
// reserved for in-flight runs so a finished run's "Started" cell freezes at a
// static start time instead of counting up forever.
function isRunInFlight(status: string): boolean {
  return status === "running" || status === "queued";
}

// ─── Shared relative-time ticker ────────────────────────────────────────────
//
// A single module-level 1 s interval drives every live relative time on the
// page (Started / Next run / Last run), instead of each component spinning its
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

/** Human label for an interval schedule's cadence (e.g. "Every 2 hours"). */
function describeInterval(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return "Interval";
  if (seconds % 3600 === 0) {
    const h = seconds / 3600;
    return `Every ${h} hour${h === 1 ? "" : "s"}`;
  }
  if (seconds % 60 === 0) {
    const m = seconds / 60;
    return `Every ${m} minute${m === 1 ? "" : "s"}`;
  }
  return `Every ${seconds}s`;
}

/**
 * Cadence label for a schedule of any kind. ``cronLabel`` is the cron-preview
 * description (resolved async for cron schedules); interval/event kinds are
 * described synchronously from their own fields.
 */
function cadenceLabel(s: Schedule, cronLabel?: string | null): string {
  if (s.kind === "interval") return describeInterval(s.interval_seconds);
  if (s.kind === "event") return s.event_name ? `On "${s.event_name}"` : "Event";
  return cronLabel || s.cron_expr || "—";
}

// ─── Result kind badge ────────────────────────────────────────────────────────

const RESULT_KIND_LABELS: Record<ResultKind, string> = {
  transcript: "Transcript",
  artifact: "Artifact",
  summary: "Summary",
  notification: "Notification",
};

function ResultKindBadge({ kind }: { kind: ResultKind }): ReactElement {
  return (
    <span className={`${styles.typeBadge} ${styles[`typeBadge_${kind}`]}`}>
      {RESULT_KIND_LABELS[kind] ?? kind}
    </span>
  );
}

// ─── Live xterm attach for running scheduled runs ────────────────────────────

/**
 * Thin xterm.js wrapper that subscribes to `terminal_output:{ptyId}` events.
 *
 * Lifecycle:
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
        foreground: getComputedStyle(document.documentElement)
          .getPropertyValue("--fg-1")
          .trim() || "#e2e8f0",
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
      className={styles.liveTermContainer}
      aria-label="Live run output"
    />
  );
}

// ─── Adaptive per-run output pane ────────────────────────────────────────────

interface AdaptiveRunPaneProps {
  run: ScheduleRun;
  resultKind: ResultKind;
}

type TranscriptQuery = ReturnType<typeof useScheduleRunTranscript>;

/** Truncated session-id chip shown in output-pane headers. */
function SessionChip({ sessionId }: { sessionId: string | null }): ReactElement | null {
  if (!sessionId) return null;
  return (
    <span className={styles.outputLink}>session {sessionId.slice(0, 8)}…</span>
  );
}

/** PASS/FAIL card derived from a finished run's exit code. Shared by the
 *  failed-run branch and the summary/notification result kinds. */
function SummaryCard({ run }: { run: ScheduleRun }): ReactElement {
  const passed = run.exit_code === 0;
  return (
    <div className={styles.outputPane}>
      <div className={styles.outputHeader}>
        <span className={styles.outputLabel}>Result</span>
      </div>
      <div
        className={`${styles.summaryCard} ${passed ? styles.summaryPass : styles.summaryFail}`}
      >
        <div className={styles.summaryTop}>
          <span className={styles.summaryGlyph}>{passed ? "✓" : "✗"}</span>
          <span className={styles.summaryStatus}>{passed ? "PASS" : "FAIL"}</span>
          {run.exit_code != null && (
            <span className={styles.summaryMeta}>exit {run.exit_code}</span>
          )}
          <span className={styles.summaryMeta}>
            {fmtDurationMs(run.duration_ms)}
          </span>
          {run.tokens_in != null && (
            <span className={styles.summaryMeta}>
              {(run.tokens_in + (run.tokens_out ?? 0)).toLocaleString()} tokens
            </span>
          )}
          {run.cost_usd != null && (
            <span className={styles.summaryMeta}>${run.cost_usd.toFixed(4)}</span>
          )}
        </div>
        {run.summary_text && (
          <p className={styles.summaryText}>{run.summary_text}</p>
        )}
      </div>
    </div>
  );
}

/** Neutral card for terminal runs that produced no result (cancelled / missed /
 *  skipped / reaped) — distinct from a real PASS/FAIL outcome. */
function NoResultCard({ run }: { run: ScheduleRun }): ReactElement {
  return (
    <div className={styles.outputPane}>
      <div className={styles.outputHeader}>
        <span className={styles.outputLabel}>Result</span>
      </div>
      <div className={styles.summaryCard}>
        <div className={styles.summaryTop}>
          <span className={styles.summaryStatus}>{run.status}</span>
          <span className={styles.summaryMeta}>no result produced</span>
        </div>
        {(run.detail || run.summary_text) && (
          <p className={styles.summaryText}>{run.detail ?? run.summary_text}</p>
        )}
      </div>
    </div>
  );
}

/** Transcript output pane: header + loading/content/empty states. `notice`
 *  renders an optional banner above the transcript (artifact-fallback case). */
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
    <div className={styles.outputPane}>
      <div className={styles.outputHeader}>
        <span className={styles.outputLabel}>Transcript</span>
        <SessionChip sessionId={sessionId} />
      </div>
      {notice && <div className={styles.transcriptEmpty}>{notice}</div>}
      {q.isPending ? (
        <div className={styles.transcriptLoading}>Loading transcript…</div>
      ) : q.data?.content ? (
        <pre className={styles.transcriptPre}>{q.data.content}</pre>
      ) : (
        <div className={styles.transcriptEmpty}>No transcript recorded.</div>
      )}
    </div>
  );
}

function AdaptiveRunPane({ run, resultKind }: AdaptiveRunPaneProps): ReactElement {
  // Live attach state: only populated for running runs.
  // We store the result of the IPC call so we can distinguish "not yet checked"
  // from "checked and no active PTY".  Keyed by run.id so switching runs resets.
  const [liveState, setLiveState] = useState<{
    runId: number;
    ptyId: string | null;
    checked: boolean;
  }>({ runId: -1, ptyId: null, checked: false });

  const isRunning = run.status === "running" || run.status === "queued";
  const hasFailed =
    !isRunning && run.exit_code != null && run.exit_code !== 0;

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
  // setState is inside a promise callback, not synchronously in the effect body.
  useEffect(() => {
    if (!isRunning) return;
    // Already have current data.
    if (liveState.runId === run.id && liveState.checked) return;
    let cancelled = false;
    void getScheduleRunPtyId(run.id).then((info) => {
      if (cancelled) return;
      setLiveState({ runId: run.id, ptyId: info.pty_id ?? null, checked: true });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id, isRunning]);

  const ptyId = isRunning && liveState.runId === run.id ? liveState.ptyId : null;
  const attachChecked = isRunning && liveState.runId === run.id ? liveState.checked : false;

  // Renderer selection (contract §C5):
  // 1. Running/queued → live output pane.
  // 2. Non-zero exit (failed/timed_out) → FAIL summary card — always visible
  //    regardless of declared result type (surfaces auth errors etc.).
  // 3. Succeeded → switch on resultKind:
  //    - artifact: ArtifactPane if path present, else transcript fallback.
  //    - summary | notification: PASS/FAIL card.
  //    - transcript (default): transcript <pre>.

  // 1. Live attach for running runs.
  if (isRunning) {
    return (
      <div className={styles.outputPane}>
        <div className={styles.outputHeader}>
          <span className={styles.outputLabel}>Live output</span>
          <span className={styles.runningDot} aria-label="running" />
          <SessionChip sessionId={run.session_id} />
          <span className={styles.outputHint}>
            (viewing only — closing does not stop the run)
          </span>
        </div>
        {!attachChecked ? (
          <div className={styles.transcriptLoading}>Attaching…</div>
        ) : ptyId != null ? (
          <LiveRunTerminal
            ptyId={ptyId}
            preloadContent={transcriptQ.data?.content ?? null}
          />
        ) : (
          <div className={styles.transcriptRunning}>
            Run is starting, output will appear shortly…
          </div>
        )}
      </div>
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
        <div className={styles.outputPane}>
          <div className={styles.outputHeader}>
            <span className={styles.outputLabel}>Artifact</span>
            <a
              className={styles.outputLink}
              href={`file://${run.artifact_path}`}
              target="_blank"
              rel="noreferrer"
            >
              {run.artifact_path}
            </a>
          </div>
          <ArtifactPane runId={run.id} path={run.artifact_path} />
        </div>
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

/** Loads and renders a markdown/text artifact file via the transcript endpoint. */
function ArtifactPane({
  runId,
  path,
}: {
  runId: number;
  path: string;
}): ReactElement {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const isMarkdown = ext === "md" || ext === "markdown" || ext === "txt";
  const q = useScheduleRunTranscript(runId);

  if (q.isPending) {
    return <div className={styles.transcriptLoading}>Loading artifact…</div>;
  }
  if (!q.data?.content) {
    return (
      <div className={styles.transcriptEmpty}>
        File not readable or empty: {path}
      </div>
    );
  }
  if (isMarkdown) {
    // Render markdown as white-space preserved pre (full markdown render is Phase 3)
    return <pre className={`${styles.transcriptPre} ${styles.artifactPre}`}>{q.data.content}</pre>;
  }
  return <pre className={styles.transcriptPre}>{q.data.content}</pre>;
}

// ─── Run history table ────────────────────────────────────────────────────────

interface RunHistoryTableProps {
  runs: ScheduleRun[];
  selectedRunId: number | null;
  onSelectRun: (id: number) => void;
}

function RunHistoryTable({
  runs,
  selectedRunId,
  onSelectRun,
}: RunHistoryTableProps): ReactElement {
  useNow(); // keep "Started" relative times ticking live
  if (runs.length === 0) {
    return <div className={styles.emptyRuns}>No runs yet.</div>;
  }
  return (
    <table className={styles.runsTable}>
      <thead>
        <tr>
          <th>Status</th>
          <th>Trigger</th>
          <th>Started</th>
          <th>Duration</th>
          <th>Cost</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr
            key={r.id}
            className={`${styles.runRow} ${selectedRunId === r.id ? styles.runRowSelected : ""}`}
            onClick={() => onSelectRun(r.id)}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onSelectRun(r.id);
            }}
          >
            <td>
              <RunStatusBadge status={r.status} />
            </td>
            <td className={styles.runTrigger}>{r.trigger ?? r.trigger_kind}</td>
            <td
              className={styles.runTime}
              title={fmtAbsTime(r.started_at ?? r.fired_at)}
            >
              {isRunInFlight(r.status)
                ? fmtRelTime(r.started_at ?? r.fired_at)
                : fmtAbsTime(r.started_at ?? r.fired_at)}
            </td>
            <td className={styles.runDuration}>{fmtDurationMs(r.duration_ms)}</td>
            <td className={styles.runCost}>
              {r.cost_usd != null ? `$${r.cost_usd.toFixed(4)}` : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── Schedule detail panel ────────────────────────────────────────────────────

interface ScheduleDetailProps {
  schedule: Schedule;
  humanSchedule: string;
  onEdit: () => void;
  onClose: () => void;
}

function ScheduleDetail({
  schedule,
  humanSchedule,
  onEdit,
  onClose,
}: ScheduleDetailProps): ReactElement {
  useNow(); // keep the detail "next run" relative time ticking live
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const runsQ = useScheduleRuns(schedule.id);
  const update = useUpdateSchedule();
  const fire = useFireScheduleManual();

  const runs = runsQ.data?.runs ?? [];

  // Derive the effective selected run id: use explicit selection or fall back
  // to the most recent run (avoids setState-in-effect lint error).
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

  const selectedRun =
    selectedRunQ.data ?? runs.find((r) => r.id === effectiveRunId) ?? null;

  return (
    <div className={styles.detail}>
      {/* Header */}
      <div className={styles.detailHeader}>
        <div className={styles.detailHeaderLeft}>
          <div className={styles.detailName}>{schedule.name}</div>
          <div className={styles.detailMeta}>
            <span
              className={`${styles.enabledPill} ${schedule.enabled ? styles.enabledOn : styles.enabledOff}`}
            >
              {schedule.enabled ? "enabled" : "disabled"}
            </span>
            <ResultKindBadge kind={schedule.result_kind} />
            <span
              className={styles.detailMetaText}
              title={`Tool access: ${schedule.permission_mode}`}
              style={
                schedule.permission_mode === "bypassPermissions"
                  ? { color: "var(--warn)" }
                  : undefined
              }
            >
              {schedule.permission_mode === "bypassPermissions"
                ? "⚠ full access"
                : schedule.permission_mode === "dontAsk"
                  ? "allowed tools only"
                  : schedule.permission_mode}
            </span>
            <span className={styles.detailMetaText} title={schedule.cron_expr ?? ""}>
              {humanSchedule}
            </span>
            {schedule.next_fire_at && (
              <span className={styles.detailMetaText} title={fmtAbsTime(schedule.next_fire_at)}>
                next {fmtRelTime(schedule.next_fire_at)}
              </span>
            )}
          </div>
          <div className={styles.detailMeta}>
            {schedule.agent_name && (
              <span className={styles.detailMetaText}>
                agent: <strong>{schedule.agent_name}</strong>
              </span>
            )}
            {schedule.model && (
              <span className={styles.detailMetaText}>
                model: <strong>{schedule.model}</strong>
              </span>
            )}
            {schedule.result_kind === "artifact" && (
              <span className={styles.detailMetaText} title="Artifact output directory">
                output: <strong>{schedule.artifact_dir ?? "workspace default"}</strong>
              </span>
            )}
          </div>
        </div>
        <div className={styles.detailActions}>
          <button
            type="button"
            className={styles.btnGhost}
            onClick={handleFire}
            disabled={fire.isPending}
            title="Run now (manual fire)"
          >
            {fire.isPending ? "Firing…" : "▶ Run now"}
          </button>
          <button
            type="button"
            className={styles.btnGhost}
            onClick={handleToggle}
            disabled={update.isPending}
          >
            {schedule.enabled ? "Disable" : "Enable"}
          </button>
          <button type="button" className={styles.btnGhost} onClick={onEdit}>
            Edit
          </button>
          <button
            type="button"
            className={styles.btnClose}
            onClick={onClose}
            title="Close"
          >
            ×
          </button>
        </div>
      </div>

      {/* Prompt preview */}
      {schedule.prompt && (
        <details className={styles.promptDetails}>
          <summary className={styles.promptSummary}>Prompt</summary>
          <pre className={styles.promptPre}>{schedule.prompt}</pre>
        </details>
      )}

      {/* Health strip */}
      {runs.length > 0 && (
        <div className={styles.detailSection}>
          <div className={styles.sectionLabel}>Health</div>
          <HealthStrip runs={runs} />
        </div>
      )}

      {/* Run history + adaptive pane side-by-side */}
      <div className={styles.detailBody}>
        <div className={styles.runsColumn}>
          <div className={styles.sectionLabel}>Run history</div>
          {runsQ.isPending ? (
            <div className={styles.emptyRuns}>Loading…</div>
          ) : (
            <RunHistoryTable
              runs={runs}
              selectedRunId={effectiveRunId}
              onSelectRun={setSelectedRunId}
            />
          )}
        </div>
        <div className={styles.outputColumn}>
          {selectedRun != null ? (
            <AdaptiveRunPane run={selectedRun} resultKind={schedule.result_kind} />
          ) : (
            <div className={styles.outputEmpty}>
              Select a run to view output
            </div>
          )}
        </div>
      </div>
    </div>
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

  // AM/PM conversion
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
    <div className={styles.cronBuilder}>
      {/* Repeat dropdown */}
      <div className={styles.cronRow}>
        <label className={styles.cronLabel} htmlFor="cb-preset">
          Repeat
        </label>
        <select
          id="cb-preset"
          className={styles.select}
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

      {/* Time picker — shown for time-of-day presets */}
      {showTime && (
        <div className={styles.cronRow}>
          <label className={styles.cronLabel}>Time</label>
          <div className={styles.timePicker}>
            <select
              className={styles.selectNarrow}
              value={displayHour}
              onChange={(e) => {
                const h12 = Number(e.target.value);
                const base = amPm === "PM" ? (h12 === 12 ? 12 : h12 + 12) : h12 === 12 ? 0 : h12;
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
            <span className={styles.timeSep}>:</span>
            <select
              className={styles.selectNarrow}
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
              className={styles.selectNarrow}
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

      {/* Day-of-week chips for Weekly */}
      {preset === "weekly" && (
        <div className={styles.cronRow}>
          <label className={styles.cronLabel}>On</label>
          <div className={styles.dayChips}>
            {WEEKDAY_LABELS.map((label, idx) => (
              <button
                key={idx}
                type="button"
                className={`${styles.dayChip} ${weekdays.includes(idx) ? styles.dayChipOn : ""}`}
                onClick={() => toggleWeekday(idx)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Day-of-month for Monthly */}
      {preset === "monthly" && (
        <div className={styles.cronRow}>
          <label className={styles.cronLabel} htmlFor="cb-dom">
            Day
          </label>
          <select
            id="cb-dom"
            className={styles.selectNarrow}
            value={dayOfMonth}
            onChange={(e) => onDayOfMonthChange(Number(e.target.value))}
          >
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <span className={styles.fieldHint}>of each month (max 28)</span>
        </div>
      )}

      {/* N-hours selector */}
      {preset === "every_n_hours" && (
        <div className={styles.cronRow}>
          <label className={styles.cronLabel} htmlFor="cb-nhours">
            Every
          </label>
          <select
            id="cb-nhours"
            className={styles.selectNarrow}
            value={everyNHours}
            onChange={(e) => onEveryNHoursChange(Number(e.target.value))}
          >
            {N_HOURS_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span className={styles.fieldHint}>hour(s)</span>
        </div>
      )}

      {/* Raw cron input — Custom only */}
      {preset === "custom" && (
        <div className={styles.cronRow}>
          <label className={styles.cronLabel} htmlFor="cb-custom">
            Cron
          </label>
          <input
            id="cb-custom"
            className={`${styles.input} ${styles.inputMono}`}
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

/** Live preview bar — calls cron-preview endpoint and shows description + next fires. */
function CronPreviewBar({
  previewInput,
}: {
  previewInput: CronPreviewInput;
}): ReactElement {
  const preview = useCronPreview();
  // Debounce a STABLE serialized key, not the object. previewInput is recreated
  // by the parent on every render (e.g. each prompt keystroke); debouncing the
  // object reference re-fires the mutation on unrelated edits and makes the bar
  // blink. Keying on the JSON string only re-fires when the schedule actually
  // changes.
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
    preview.mutate(input, {
      onSuccess: (data) => setLastData(data),
    });
    // preview.mutate intentionally not in deps — mutation fn is stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputKey]);

  const data = preview.data ?? lastData;
  if (!data && !preview.isPending) return <></>;

  return (
    <div className={styles.previewBar}>
      {!data && preview.isPending ? (
        <span className={styles.previewLoading}>Calculating…</span>
      ) : !data && preview.isError ? (
        <span className={styles.previewError}>Invalid cron expression</span>
      ) : data ? (
        <>
          <span className={styles.previewIcon}>▶</span>
          <span className={styles.previewDesc}>{data.description}</span>
          <span className={styles.previewSep}>/</span>
          <span className={styles.previewFires}>
            Next:{" "}
            {data.next_fires
              .slice(0, 3)
              .map((f) => fmtAbsTime(f))
              .join(" · ")}
          </span>
          {data.cron_expr && (
            <code className={styles.previewCron} title="Cron expression">
              {data.cron_expr}
            </code>
          )}
        </>
      ) : null}
    </div>
  );
}

// ─── Job config fields ────────────────────────────────────────────────────────

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
    name: s.name,
    preset: isInterval ? "every_n_hours" : "custom",
    hour: 9,
    minute: 0,
    weekdays: [1],
    dayOfMonth: 1,
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
    maxRuntimeSec:
      s.max_runtime_sec != null ? String(s.max_runtime_sec) : "",
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

// ─── Schedule form modal ──────────────────────────────────────────────────────

interface ScheduleFormModalProps {
  /** When non-null, we are editing an existing schedule. */
  editing: Schedule | null;
  onClose: () => void;
}

function ScheduleFormModal({
  editing,
  onClose,
}: ScheduleFormModalProps): ReactElement {
  const [form, setForm] = useState<FormState>(
    editing != null ? scheduleToForm(editing) : defaultForm(),
  );
  const [showAdvanced, setShowAdvanced] = useState(false);

  const providersQ = useProviders();
  const providerModelsQ = useProviderModels(
    form.providerId !== "" ? form.providerId : null,
  );
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
      const prov = (providersQ.data ?? []).find(
        (p) => p.id === Number(val),
      );
      setForm((f) => ({
        ...f,
        [key]: val,
        model: prov?.default_model ?? "",
      }));
      return;
    }
    setForm((f) => ({ ...f, [key]: val }));
  }

  // Gather agents: org agents + project agents
  const allAgents = [
    ...(configuredAgentsQ.data?.shared ?? []),
  ];

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
      max_budget_usd:
        form.maxBudgetUsd !== "" ? Number(form.maxBudgetUsd) : null,
      max_runtime_sec:
        form.maxRuntimeSec !== "" ? Number(form.maxRuntimeSec) : null,
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
              form.preset === "custom"
                ? form.customCron.trim() || null
                : encodedPresetCron(form),
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
      max_budget_usd:
        form.maxBudgetUsd !== "" ? Number(form.maxBudgetUsd) : null,
      max_runtime_sec:
        form.maxRuntimeSec !== "" ? Number(form.maxRuntimeSec) : null,
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
    <div
      className={styles.modalOverlay}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.modal} role="dialog" aria-modal="true">
        <div className={styles.modalHeader}>
          <h2 className={styles.modalTitle}>
            {editing != null ? "Edit schedule" : "New schedule"}
          </h2>
          <button
            type="button"
            className={styles.btnClose}
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className={styles.modalBody}>
          {/* Name */}
          <div className={styles.formField}>
            <label className={styles.fieldLabel} htmlFor="sf-name">
              Name
            </label>
            <input
              id="sf-name"
              className={styles.input}
              value={form.name}
              onChange={(e) => patch("name", e.target.value)}
              placeholder="Daily digest"
              autoFocus
            />
          </div>

          {/* Cron builder */}
          <div className={styles.formSection}>
            <div className={styles.formSectionHeader}>
              <span className={styles.sectionLabel}>Schedule</span>
              <div className={styles.formSectionRule} />
            </div>
            <div className={styles.formSectionBody}>
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
          </div>

          {/* Job config */}
          <div className={styles.formSection}>
            <div className={styles.formSectionHeader}>
              <span className={styles.sectionLabel}>Job configuration</span>
              <div className={styles.formSectionRule} />
            </div>
            <div className={styles.formSectionBody}>
              <div className={styles.formGrid}>
                {/* Project */}
                <div className={styles.formField}>
                  <label className={styles.fieldLabel} htmlFor="sf-project">
                    Project
                  </label>
                  <select
                    id="sf-project"
                    className={styles.select}
                    value={form.projectId}
                    onChange={(e) =>
                      patch(
                        "projectId",
                        e.target.value === "" ? "" : Number(e.target.value),
                      )
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

                {/* Provider */}
                <div className={styles.formField}>
                  <label className={styles.fieldLabel} htmlFor="sf-provider">
                    Provider
                  </label>
                  <select
                    id="sf-provider"
                    className={styles.select}
                    value={form.providerId}
                    onChange={(e) =>
                      patch(
                        "providerId",
                        e.target.value === "" ? "" : Number(e.target.value),
                      )
                    }
                  >
                    <option value="" disabled>Select a provider…</option>
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.display_name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Model — only show when provider selected */}
                {form.providerId !== "" && (
                  <div className={styles.formField}>
                    <label className={styles.fieldLabel} htmlFor="sf-model">
                      Model
                    </label>
                    <select
                      id="sf-model"
                      className={styles.select}
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
                        (
                          providers.find((p) => p.id === Number(form.providerId))
                            ?.models ?? []
                        ).map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                    </select>
                  </div>
                )}

                {/* Agent */}
                <div className={styles.formField}>
                  <label className={styles.fieldLabel} htmlFor="sf-agent">
                    Agent
                  </label>
                  <select
                    id="sf-agent"
                    className={styles.select}
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

                {/* Run mode */}
                <div className={styles.formField}>
                  <label className={styles.fieldLabel} htmlFor="sf-runmode">
                    Run mode
                  </label>
                  <select
                    id="sf-runmode"
                    className={styles.select}
                    value={form.runMode}
                    onChange={(e) => patch("runMode", e.target.value as RunMode)}
                  >
                    <option value="background">Background (headless)</option>
                    <option value="windowed">Windowed (terminal opens)</option>
                  </select>
                </div>

                {/* Result kind */}
                <div className={styles.formField}>
                  <label className={styles.fieldLabel} htmlFor="sf-resultkind">
                    Result type
                  </label>
                  <select
                    id="sf-resultkind"
                    className={styles.select}
                    value={form.resultKind}
                    onChange={(e) =>
                      patch("resultKind", e.target.value as ResultKind)
                    }
                  >
                    <option value="transcript">Transcript</option>
                    <option value="artifact">Artifact (file output)</option>
                    <option value="summary">Summary (PASS/FAIL)</option>
                    <option value="notification">Notification</option>
                  </select>
                </div>

                {/* Output path — artifact only */}
                {form.resultKind === "artifact" && (
                  <div className={`${styles.formField} ${styles.formFieldFull}`}>
                    <label className={styles.fieldLabel} htmlFor="sf-artifactdir">
                      Output path
                    </label>
                    <div className={styles.inputRow}>
                      <input
                        id="sf-artifactdir"
                        className={styles.input}
                        value={form.artifactDir}
                        onChange={(e) => patch("artifactDir", e.target.value)}
                        placeholder="Default: workspace/schedule-artifacts/<name>"
                      />
                      <button
                        type="button"
                        className={styles.btnGhost}
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
                        Browse…
                      </button>
                    </div>
                    <span className={styles.fieldHelper}>
                      Where the agent saves its file. Leave empty to use the workspace default. The exact file path is appended to the prompt so the run can capture it.
                    </span>
                  </div>
                )}
              </div>

              {/* Prompt */}
              <div className={styles.formField}>
                <label className={styles.fieldLabel} htmlFor="sf-prompt">
                  Prompt
                </label>
                <textarea
                  id="sf-prompt"
                  className={styles.textarea}
                  value={form.prompt}
                  onChange={(e) => patch("prompt", e.target.value)}
                  placeholder="Describe what the agent should do…"
                  rows={4}
                />
              </div>
            </div>
          </div>

          {/* Advanced section */}
          <details
            className={styles.advancedSection}
            open={showAdvanced}
            onToggle={(e) =>
              setShowAdvanced((e.currentTarget as HTMLDetailsElement).open)
            }
          >
            <summary className={styles.advancedSummary}>
              Advanced options
            </summary>
            <div className={styles.formGrid}>
              {/* Permission mode — only the two modes that are safe for an
                  unattended run are offered. 'default'/'plan'/'auto' would
                  block on an interactive prompt that no one can answer (and
                  stall the run), so they are intentionally not selectable; a
                  legacy value already stored on the schedule is preserved. */}
              <div className={styles.formField}>
                <label className={styles.fieldLabel} htmlFor="sf-perm">
                  Tool access
                </label>
                <select
                  id="sf-perm"
                  className={styles.select}
                  value={form.permissionMode}
                  onChange={(e) => patch("permissionMode", e.target.value)}
                >
                  <option value="dontAsk">
                    Allowed tools only (safe default)
                  </option>
                  <option value="bypassPermissions">
                    Full access — runs any tool autonomously
                  </option>
                  {!["dontAsk", "bypassPermissions"].includes(
                    form.permissionMode,
                  ) && (
                    <option value={form.permissionMode}>
                      {form.permissionMode} (advanced)
                    </option>
                  )}
                </select>
                <span className={styles.fieldHelper}>
                  {form.permissionMode === "bypassPermissions"
                    ? "Unattended runs may use any tool (web, shell, file edits) without asking."
                    : "Only the tools listed below run; anything else is denied — the run never stalls."}
                </span>
              </div>

              {/* Notify policy */}
              <div className={styles.formField}>
                <label className={styles.fieldLabel} htmlFor="sf-notify">
                  Notifications
                </label>
                <select
                  id="sf-notify"
                  className={styles.select}
                  value={form.notifyPolicy}
                  onChange={(e) =>
                    patch("notifyPolicy", e.target.value as NotifyPolicy)
                  }
                >
                  <option value="on_failure">On failure only</option>
                  <option value="every_run">Every run</option>
                  <option value="never">Never</option>
                </select>
              </div>

              {/* Allowed tools */}
              <div className={`${styles.formField} ${styles.formFieldFull}`}>
                <label className={styles.fieldLabel} htmlFor="sf-tools">
                  Allowed tools
                </label>
                <input
                  id="sf-tools"
                  className={`${styles.input} ${styles.inputMono}`}
                  value={form.allowedTools}
                  onChange={(e) => patch("allowedTools", e.target.value)}
                  placeholder="Read,Bash,Edit"
                />
                <span className={styles.fieldHelper}>
                  Comma-separated tool names. Leave empty to allow all tools.
                </span>
              </div>

              {/* Max budget */}
              <div className={styles.formField}>
                <label className={styles.fieldLabel} htmlFor="sf-budget">
                  Max budget
                </label>
                <input
                  id="sf-budget"
                  className={styles.input}
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.maxBudgetUsd}
                  onChange={(e) => patch("maxBudgetUsd", e.target.value)}
                  placeholder="e.g. 1.00"
                />
                <span className={styles.fieldHelper}>USD. Leave empty for no limit.</span>
              </div>

              {/* Max runtime */}
              <div className={styles.formField}>
                <label className={styles.fieldLabel} htmlFor="sf-runtime">
                  Max runtime
                </label>
                <input
                  id="sf-runtime"
                  className={styles.input}
                  type="number"
                  min="0"
                  step="60"
                  value={form.maxRuntimeSec}
                  onChange={(e) => patch("maxRuntimeSec", e.target.value)}
                  placeholder="e.g. 3600"
                />
                <span className={styles.fieldHelper}>Seconds. Leave empty for no limit.</span>
              </div>
            </div>
          </details>
        </div>

        <div className={styles.modalFooter}>
          <button
            type="button"
            className={styles.btnGhost}
            onClick={onClose}
            disabled={isPending}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            onClick={handleSubmit}
            disabled={isPending}
          >
            {isPending
              ? editing != null
                ? "Saving…"
                : "Creating…"
              : editing != null
                ? "Save changes"
                : "Create schedule"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Schedule list row ────────────────────────────────────────────────────────

interface ScheduleRowProps {
  schedule: Schedule;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
}

/** A single row in the schedule list. Fetches cron preview for human label. */
function ScheduleRow({
  schedule,
  selected,
  onSelect,
  onEdit,
}: ScheduleRowProps): ReactElement {
  useNow(); // keep next/last-run relative times ticking live
  // Async cron description (interval/event kinds are described synchronously).
  const [cronLabel, setCronLabel] = useState<string | null>(null);
  const preview = useCronPreview();
  const update = useUpdateSchedule();
  const remove = useDeleteSchedule();
  const fire = useFireScheduleManual();
  const runsQ = useScheduleRuns(schedule.id);
  const runs = runsQ.data?.runs ?? [];
  const lastRun = runs[0] ?? null;

  // Fetch a friendly description for cron schedules only.
  useEffect(() => {
    if (schedule.kind === "cron" && schedule.cron_expr) {
      preview.mutate(
        { cron_expr: schedule.cron_expr, count: 0 },
        { onSuccess: (d) => setCronLabel(d.description) },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedule.kind, schedule.cron_expr]);

  const humanSchedule = cadenceLabel(schedule, cronLabel);

  function handleToggle(e: React.MouseEvent): void {
    e.stopPropagation();
    update.mutate(
      { id: schedule.id, patch: { enabled: !schedule.enabled } },
      { onError: (err) => toast.error(`Toggle failed: ${err.message}`) },
    );
  }

  function handleDelete(e: React.MouseEvent): void {
    e.stopPropagation();
    if (!confirm(`Delete schedule "${schedule.name}"?`)) return;
    remove.mutate(schedule.id, {
      onError: (err) => toast.error(`Delete failed: ${err.message}`),
    });
  }

  function handleFire(e: React.MouseEvent): void {
    e.stopPropagation();
    fire.mutate(schedule.id, {
      onSuccess: () => toast.success(`Fired ${schedule.name}`),
      onError: (err) => toast.error(`Fire failed: ${err.message}`),
    });
  }

  function handleEdit(e: React.MouseEvent): void {
    e.stopPropagation();
    onEdit();
  }

  return (
    <tr
      className={`${styles.listRow} ${selected ? styles.listRowSelected : ""} ${!schedule.enabled ? styles.listRowDisabled : ""}`}
      onClick={onSelect}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect();
      }}
    >
      {/* Status glyph derived from last run */}
      <td className={styles.listCellStatus}>
        {lastRun ? (
          <RunStatusBadge status={lastRun.status} />
        ) : (
          <span className={`${styles.statusBadge} ${styles.statusGrey}`}>
            — never run
          </span>
        )}
      </td>

      {/* Name */}
      <td className={styles.listCellName}>
        <div className={styles.rowName}>{schedule.name}</div>
        {schedule.agent_name && (
          <div className={styles.rowSub}>{schedule.agent_name}</div>
        )}
      </td>

      {/* Type badge */}
      <td className={styles.listCellType}>
        <ResultKindBadge kind={schedule.result_kind} />
      </td>

      {/* Human schedule */}
      <td className={styles.listCellSchedule}>
        <span title={schedule.cron_expr ?? ""}>{humanSchedule}</span>
      </td>

      {/* Next run */}
      <td
        className={styles.listCellNext}
        title={fmtAbsTime(schedule.next_fire_at)}
      >
        {schedule.enabled && schedule.next_fire_at
          ? fmtRelTime(schedule.next_fire_at)
          : "—"}
      </td>

      {/* Last run */}
      <td className={styles.listCellLast}>
        {lastRun ? (
          <span title={fmtAbsTime(lastRun.started_at ?? lastRun.fired_at)}>
            {fmtRelTime(lastRun.started_at ?? lastRun.fired_at)}
          </span>
        ) : (
          "—"
        )}
      </td>

      {/* Last duration */}
      <td className={styles.listCellDuration}>
        {fmtDurationMs(lastRun?.duration_ms)}
      </td>

      {/* Enabled toggle */}
      <td className={styles.listCellToggle} onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className={`${styles.toggleBtn} ${schedule.enabled ? styles.toggleOn : styles.toggleOff}`}
          onClick={handleToggle}
          disabled={update.isPending}
          title={schedule.enabled ? "Disable" : "Enable"}
          aria-label={schedule.enabled ? "Disable schedule" : "Enable schedule"}
        >
          {schedule.enabled ? "On" : "Off"}
        </button>
      </td>

      {/* Project tag */}
      <td className={styles.listCellProject}>
        {schedule.project_id != null ? (
          <span className={styles.projectTag}>proj #{schedule.project_id}</span>
        ) : null}
      </td>

      {/* Quick actions */}
      <td className={styles.listCellActions} onClick={(e) => e.stopPropagation()}>
        <div className={styles.rowActions}>
          <button
            type="button"
            className={styles.actionBtn}
            onClick={handleFire}
            disabled={fire.isPending}
            title="Run now"
          >
            ▶
          </button>
          <button
            type="button"
            className={styles.actionBtn}
            onClick={handleEdit}
            title="Edit"
          >
            ✎
          </button>
          <button
            type="button"
            className={`${styles.actionBtn} ${styles.actionBtnDanger}`}
            onClick={handleDelete}
            disabled={remove.isPending}
            title="Delete"
          >
            ✕
          </button>
        </div>
      </td>
    </tr>
  );
}

// ─── Client-side preset → cron helper ─────────────────────────────────────────

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

// ─── Main page ────────────────────────────────────────────────────────────────

/** Cache of human-readable descriptions per schedule id. */

export function SchedulesPage(): ReactElement {
  const schedulesQ = useSchedules();
  const schedules = schedulesQ.data?.schedules ?? [];

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);
  const [humanLabels, setHumanLabels] = useState<Record<number, string>>({});

  const queryClient = useQueryClient();

  // Windowed mode (3.2): when a windowed run starts, auto-select its schedule
  // and navigate to the runs list so the user sees the live output pane. Always
  // refresh the run history so the newly-started run appears immediately.
  useScheduleRunStarted(
    useCallback(
      (payload: ScheduleRunStartedPayload) => {
        // Invalidate every query the list + detail read so the queued→running
        // transition shows live (status badge, run-history row, single run).
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
  // schedules list (next/last run), the run-history table, the single run, and
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

  // Build human labels for all schedules once they load
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

  const selectedSchedule = schedules.find((s) => s.id === selectedId) ?? null;
  const humanSchedule = selectedSchedule
    ? cadenceLabel(
        selectedSchedule,
        selectedId != null ? humanLabels[selectedId] : null,
      )
    : "—";

  const openNew = useCallback(() => {
    setEditingSchedule(null);
    setFormOpen(true);
  }, []);

  const openEdit = useCallback(
    (s: Schedule) => {
      setEditingSchedule(s);
      setFormOpen(true);
    },
    [],
  );

  const closeForm = useCallback(() => {
    setFormOpen(false);
    setEditingSchedule(null);
  }, []);

  const [showRetention, setShowRetention] = useState(false);
  const retentionQ = useScheduleRetention();
  const setRetention = useSetScheduleRetention();
  // Retain the draft value separately; initialise from server data lazily.
  // We avoid setState-in-effect by computing the displayed value inline.
  const [retentionDraft, setRetentionDraft] = useState<string | null>(null);
  // The displayed value is the draft if it was touched, otherwise the server value.
  const retentionInput =
    retentionDraft ?? (retentionQ.data != null ? String(retentionQ.data.retention_days) : "30");
  function setRetentionInput(v: string): void {
    setRetentionDraft(v);
  }

  function handleSaveRetention(): void {
    const days = Number(retentionInput);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      toast.error("Retention must be 1–365 days");
      return;
    }
    setRetention.mutate(days, {
      onSuccess: () => toast.success("Retention setting saved"),
      onError: (e) => toast.error(`Save failed: ${e.message}`),
    });
  }

  const actions: ReactNode = (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <button
        type="button"
        className={styles.btnGhost}
        onClick={() => setShowRetention((v) => !v)}
        title="Transcript retention settings"
        style={{ fontSize: 13 }}
      >
        ⚙ Retention
      </button>
      <button
        type="button"
        className={styles.btnPrimary}
        onClick={openNew}
      >
        + New schedule
      </button>
    </div>
  );

  return (
    <Shell topbarTitle="Schedules" actions={actions}>
      <div className={styles.page}>
        {/* Left: schedule list */}
        <div className={styles.listPane}>
          {schedulesQ.isPending ? (
            <div className={styles.empty}>Loading…</div>
          ) : schedules.length === 0 ? (
            <div className={styles.empty}>
              No schedules yet — click "New schedule" to create one.
            </div>
          ) : (
            <div className={styles.tableWrapper}>
              <table className={styles.listTable}>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Schedule</th>
                    <th>Next run</th>
                    <th>Last run</th>
                    <th>Duration</th>
                    <th>Enabled</th>
                    <th>Project</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {schedules.map((s) => (
                    <ScheduleRow
                      key={s.id}
                      schedule={s}
                      selected={selectedId === s.id}
                      onSelect={() =>
                        setSelectedId((cur) => (cur === s.id ? null : s.id))
                      }
                      onEdit={() => openEdit(s)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Right: detail panel — shown when a schedule is selected */}
        {selectedSchedule != null && (
          <div className={styles.detailPane}>
            <ScheduleDetail
              schedule={selectedSchedule}
              humanSchedule={humanSchedule}
              onEdit={() => openEdit(selectedSchedule)}
              onClose={() => setSelectedId(null)}
            />
          </div>
        )}
      </div>

      {/* Retention settings panel */}
      {showRetention && (
        <div
          className={styles.modalOverlay}
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowRetention(false);
          }}
        >
          <div
            className={styles.modal}
            role="dialog"
            aria-modal="true"
            style={{ maxWidth: 400 }}
          >
            <div className={styles.modalHeader}>
              <h2 className={styles.modalTitle}>Transcript retention</h2>
              <button
                type="button"
                className={styles.btnClose}
                onClick={() => { setShowRetention(false); setRetentionDraft(null); }}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className={styles.modalBody}>
              <p style={{ fontSize: 13, color: "var(--fg-3)", marginBottom: 16 }}>
                Run metadata and artifact files are kept. Internal run
                transcripts (raw logs) are deleted after this many days to
                reclaim disk space. The prune runs on startup and then once per
                day.
              </p>
              <div className={styles.formField}>
                <label className={styles.fieldLabel} htmlFor="ret-days">
                  Keep transcripts for (days)
                </label>
                <input
                  id="ret-days"
                  className={styles.input}
                  type="number"
                  min="1"
                  max="365"
                  value={retentionInput}
                  onChange={(e) => setRetentionInput(e.target.value)}
                />
              </div>
            </div>
            <div className={styles.modalFooter}>
              <button
                type="button"
                className={styles.btnGhost}
                onClick={() => { setShowRetention(false); setRetentionDraft(null); }}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.btnPrimary}
                onClick={handleSaveRetention}
                disabled={setRetention.isPending}
              >
                {setRetention.isPending ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Form modal */}
      {formOpen && (
        <ScheduleFormModal editing={editingSchedule} onClose={closeForm} />
      )}
    </Shell>
  );
}
