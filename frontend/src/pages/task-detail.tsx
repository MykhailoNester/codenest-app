/**
 * Task detail — a read-first document, not a row editor.
 *
 * A sticky `.td-bar` action row sits above a two-column `.td-grid`: a
 * document column (inline-editable title, read-first Description card with
 * an Edit toggle) and a 300px properties sidebar (`PropertiesCard` +
 * Blockers + Timestamps + Delete). Status / priority / effort / assignee /
 * project / labels write the moment a popover item is chosen — there is no
 * "Save Changes" button for those fields, matching the Work Board
 * (`pages/tasks.tsx`). Title commits on Enter or blur; description commits
 * on an explicit Save. The `.td-saved` indicator is never optimistic: it
 * appears only after the write **and** its `["task", id]` refetch have both
 * settled (`runWrite` below), and never after a failed write.
 *
 * Four deliberate divergences from the design mockup, all forced by schema
 * the sidecar does not have (never "fix" these without a migration):
 *   - `#<id>`, not a per-project ticket key like "CN-9" — `tasks` has no
 *     ticket-key column.
 *   - Exactly high/medium/low priority — the `task_priority` taxonomy seed
 *     has no "urgent".
 *   - Exactly None/Small/Medium/Large effort — `tasks.effort`'s
 *     `CHECK(effort IN ('small','medium','large'))` rejects a fourth value.
 *   - "Copy ref" (copies `#<id> — <title>`), not "Copy link" — there is no
 *     URL bar or registered URL scheme in this Tauri webview.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  addTaskBlocker,
  addTaskLabel,
  changeTaskStatus,
  deleteTask,
  removeTaskBlocker,
  removeTaskLabel,
  updateTask,
  useLookups,
  useProjects,
  useTask,
  useTaskActivity,
  useTaskRuns,
  useTasks,
  useTaxonomy,
  useTeamMembers,
  type ActivityEntry,
  type AgentRun,
  type Project,
  type Task,
  type Taxonomy,
  type TeamMember,
  type WorkflowVocabEntry,
} from "../lib/api";
import { relativeTime } from "../lib/format-helpers";
import { Shell } from "../components/layout/shell";
import { LaunchFromSourceButton } from "../components/launch/launch-from-source-button";
import { AgentMarkdown } from "../components/terminal/agent-markdown";
import { ActivityCard } from "../components/task-detail/activity-card";
import { hashHue, initialsOf } from "../components/task-detail/avatar";
import { PropertiesCard } from "../components/task-detail/properties-card";
import { TaskRunReplay } from "../components/task-detail/run-replay";
import { RunsCard } from "../components/task-detail/runs-card";
import { TdPopover } from "../components/task-detail/td-popover";

// Module-level sentinels so a not-yet-resolved query never hands a fresh
// array/object reference into a memo dependency (`tasks.tsx`'s NO_* idiom).
const NO_MEMBERS: TeamMember[] = [];
const NO_PROJECTS: Project[] = [];
const NO_TASKS: Task[] = [];
const NO_VOCAB: WorkflowVocabEntry[] = [];
const NO_TAXONOMY: Taxonomy[] = [];
const NO_STATUS_COLORS: Record<string, string> = {};
const NO_ACTIVITY: ActivityEntry[] = [];
const NO_RUNS: AgentRun[] = [];

const AVATAR_PX = 20;
const AVATAR_FONT_PX = 9;

type SavePhase = "idle" | "saving" | "saved";
const SAVED_INDICATOR_MS = 2_500;

/** The sidecar returns naive UTC with no trailing "Z" — `relativeTime` does
 * not normalise on its own, so every caller appends it (mirrors
 * `task-card.tsx`'s `cardDate`). */
function withZ(iso: string): string {
  return iso.endsWith("Z") ? iso : `${iso}Z`;
}

export function TaskDetailPage(): ReactElement {
  const { id } = useParams<{ id: string }>();
  const taskId = parseInt(id ?? "0", 10);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: task, isLoading, isError, error, refetch } = useTask(taskId);
  const { data: members = NO_MEMBERS } = useTeamMembers();
  const { data: projects = NO_PROJECTS } = useProjects();
  const { data: allTasks = NO_TASKS } = useTasks();
  const { data: lookups } = useLookups();
  const { data: labelTaxonomy = NO_TAXONOMY } = useTaxonomy("task_label");
  const {
    data: activity = NO_ACTIVITY,
    isLoading: activityLoading,
    isError: activityError,
    refetch: refetchActivity,
  } = useTaskActivity(taskId);
  const {
    data: runs = NO_RUNS,
    isLoading: runsLoading,
    isError: runsError,
    refetch: refetchRuns,
  } = useTaskRuns(taskId);

  const priorityVocab = lookups?.workflow_task_priorities ?? NO_VOCAB;

  // Status vocab, fallback-merged with `lookups.status_colors` for any row
  // whose taxonomy colour is unset — the same two-source colour resolution
  // `pages/tasks.tsx` already does for the board.
  const statusVocab = useMemo<WorkflowVocabEntry[]>(() => {
    const list = lookups?.workflow_task_statuses ?? NO_VOCAB;
    const colors = lookups?.status_colors ?? NO_STATUS_COLORS;
    return list.map((e) =>
      e.color ? e : { ...e, color: colors[e.slug] ?? null },
    );
  }, [lookups]);

  // Activity phrases localise a status slug via this map (falling back to
  // the humanizer) rather than a hardcoded label list — the taxonomy is
  // user-editable.
  const statusLabels = useMemo(
    () => Object.fromEntries(statusVocab.map((e) => [e.slug, e.label])),
    [statusVocab],
  );

  // ── Agent runs replay — toggles closed on a second click of the same run.
  const [replaySessionId, setReplaySessionId] = useState<string | null>(null);
  const handleReplay = useCallback((sessionId: string) => {
    setReplaySessionId((cur) => (cur === sessionId ? null : sessionId));
  }, []);

  // ── Save indicator ────────────────────────────────────────────────────
  const [savePhase, setSavePhase] = useState<SavePhase>("idle");
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  // D10 — awaits the write AND the refetch before showing "Saved"; never
  // optimistic. `["tasks"]`/`["dashboard"]` invalidate fire-and-forget,
  // matching `tasks.tsx`'s `invalidateTasks`.
  const runWrite = useCallback(
    async (label: string, fn: () => Promise<unknown>): Promise<void> => {
      setSavePhase("saving");
      try {
        await fn();
        await qc.invalidateQueries({ queryKey: ["task", taskId] });
        void qc.invalidateQueries({ queryKey: ["tasks"] });
        void qc.invalidateQueries({ queryKey: ["dashboard"] });
        void qc.invalidateQueries({ queryKey: ["task-activity", taskId] });
        setSavePhase("saved");
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(
          () => setSavePhase("idle"),
          SAVED_INDICATOR_MS,
        );
      } catch (err) {
        toast.error(`Failed to ${label}: ${(err as Error).message}`);
        setSavePhase("idle");
      }
    },
    [qc, taskId],
  );

  // ── Property writes — one popover selection each, immediate (D7/D9) ────
  const handleStatus = useCallback(
    (slug: string) => {
      void runWrite("change status", () => changeTaskStatus(taskId, slug));
    },
    [runWrite, taskId],
  );
  const handlePriority = useCallback(
    (slug: string) => {
      void runWrite("change priority", () =>
        updateTask(taskId, { priority: slug }),
      );
    },
    [runWrite, taskId],
  );
  const handleAssignee = useCallback(
    (memberId: number | null) => {
      void runWrite("change assignee", () =>
        updateTask(taskId, { assignee_id: memberId }),
      );
    },
    [runWrite, taskId],
  );
  const handleEffort = useCallback(
    (effort: "small" | "medium" | "large" | null) => {
      void runWrite("change effort", () => updateTask(taskId, { effort }));
    },
    [runWrite, taskId],
  );
  const handleProject = useCallback(
    (projectId: number) => {
      void runWrite("change project", () =>
        updateTask(taskId, { project_id: projectId }),
      );
    },
    [runWrite, taskId],
  );
  const handleToggleLabel = useCallback(
    (labelId: number, next: boolean) => {
      void runWrite("update labels", () =>
        next ? addTaskLabel(taskId, labelId) : removeTaskLabel(taskId, labelId),
      );
    },
    [runWrite, taskId],
  );
  const handleAddBlocker = useCallback(
    (blockingTaskId: number) => {
      void runWrite("add blocker", () =>
        addTaskBlocker(taskId, blockingTaskId),
      );
    },
    [runWrite, taskId],
  );
  const handleRemoveBlocker = useCallback(
    (blockerId: number) => {
      void runWrite("remove blocker", () =>
        removeTaskBlocker(taskId, blockerId),
      );
    },
    [runWrite, taskId],
  );

  // ── Title — inline edit, Enter commits, Escape cancels ──────────────────
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const titleRef = useRef<HTMLTextAreaElement>(null);
  // Some engines fire a native `blur` when React removes the still-focused
  // textarea from the DOM (e.g. right after Enter commits it) — jsdom does
  // not reproduce this, so it can't be pinned by a test, but a real WebKit
  // webview can. This ref makes `closeTitleEdit`/`commitTitle` idempotent
  // per edit session, so that stray blur can never re-commit (or, worse,
  // commit an already-discarded Escape draft) a second time.
  const titleClosedRef = useRef(false);

  useLayoutEffect(() => {
    if (!editingTitle || !titleRef.current) return;
    titleRef.current.style.height = "auto";
    titleRef.current.style.height = `${titleRef.current.scrollHeight}px`;
  }, [editingTitle, titleDraft]);

  function startEditTitle(): void {
    if (!task) return;
    titleClosedRef.current = false;
    setTitleDraft(task.title);
    setEditingTitle(true);
  }

  function closeTitleEdit(): void {
    titleClosedRef.current = true;
    setEditingTitle(false);
  }

  function commitTitle(): void {
    if (titleClosedRef.current) return;
    closeTitleEdit();
    if (!task) return;
    const trimmed = titleDraft.trim();
    // `tasks.title` is NOT NULL — a blank title would make the row
    // unfindable everywhere else, so an empty draft is a no-op, not a write.
    if (trimmed === "" || trimmed === task.title) return;
    void runWrite("update title", () => updateTask(taskId, { title: trimmed }));
  }

  function handleTitleKeyDown(
    e: ReactKeyboardEvent<HTMLTextAreaElement>,
  ): void {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      commitTitle();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      closeTitleEdit();
    }
  }

  // ── Description — read-first card, explicit Save ───────────────────────
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState("");

  function startEditDesc(): void {
    if (!task) return;
    setDescDraft(task.description ?? "");
    setEditingDesc(true);
  }

  function commitDesc(): void {
    if (!task) return;
    setEditingDesc(false);
    const next = descDraft.trim() === "" ? null : descDraft;
    if (next === (task.description ?? null)) return;
    void runWrite("update description", () =>
      updateTask(taskId, { description: next }),
    );
  }

  function handleDescKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === "Escape") {
      e.stopPropagation();
      setEditingDesc(false);
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commitDesc();
    }
  }

  // ── Add-blocker popover ─────────────────────────────────────────────────
  const [blockerPopoverOpen, setBlockerPopoverOpen] = useState(false);

  // `useTasks()` with no filters/sort defaults to `t.created_at DESC`
  // (`task_service.get_all_tasks`) — already newest-first, so no client
  // re-sort is needed.
  const blockerCandidates = useMemo(() => {
    if (!task) return NO_TASKS;
    const blocked = new Set(
      (task.blockers ?? []).map((b) => b.blocking_task_id),
    );
    return allTasks.filter((t) => t.id !== task.id && !blocked.has(t.id));
  }, [allTasks, task]);

  async function handleDelete(): Promise<void> {
    if (!confirm("Delete this task?")) return;
    await deleteTask(taskId);
    void navigate("/tasks");
  }

  function handleCopyRef(): void {
    if (!task) return;
    void navigator.clipboard.writeText(`#${task.id} — ${task.title}`);
    toast.success("Copied reference");
  }

  // ── Render states ────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <Shell scrollable={false}>
        <div className="td-main">
          <div style={{ padding: "24px 28px" }}>
            <span className="td-dim td-sm">Loading task…</span>
          </div>
        </div>
      </Shell>
    );
  }

  if (isError || !task) {
    // `!task` with no error covers the disabled-query case (`useTask`'s
    // `enabled: taskId > 0`) — an invalid route param never fires the
    // fetch, so `isError` never resolves either. Same not-found copy.
    const notFound = !task || error?.status === 404;
    return (
      <Shell scrollable={false}>
        <div className="td-main">
          <div style={{ padding: "24px 28px" }}>
            {notFound ? (
              <>
                <p className="td-dim">Task #{taskId} no longer exists.</p>
                <Link className="td-back" to="/tasks">
                  ← Work Board
                </Link>
              </>
            ) : (
              <>
                <p className="td-dim">
                  {error?.message ?? "Failed to load task."}
                </p>
                <button
                  type="button"
                  className="d3-btn d3-btn--ghost"
                  onClick={() => void refetch()}
                >
                  Retry
                </button>
              </>
            )}
          </div>
        </div>
      </Shell>
    );
  }

  const statusEntry = statusVocab.find((e) => e.slug === task.status);
  const statusLabel = statusEntry?.label ?? task.status;
  const statusColor = statusEntry?.color ?? "var(--fg-4)";
  const assigneeMember =
    task.assignee_id != null
      ? members.find((m) => m.id === task.assignee_id)
      : undefined;
  const blockers = task.blockers ?? [];

  return (
    <Shell scrollable={false}>
      <div className="td-main">
        <div className="td-bar">
          <div className="td-bar__l">
            <Link className="td-back" to="/tasks">
              ← Work Board
            </Link>
            <span className="td-bar__sep">/</span>
            <span className="td-bar__ref">#{taskId}</span>
            <span
              className="td-badge"
              style={{ ["--c" as string]: statusColor }}
            >
              <span className="td-badge__dot" />
              {statusLabel}
            </span>
          </div>
          <div className="td-bar__r">
            {savePhase === "saving" ? (
              <span className="td-saved td-dim">Saving…</span>
            ) : null}
            {savePhase === "saved" ? (
              <span className="td-saved">✓ Saved</span>
            ) : null}
            <button
              type="button"
              className="d3-btn d3-btn--ghost"
              onClick={handleCopyRef}
            >
              Copy ref
            </button>
            <LaunchFromSourceButton
              kind="task"
              id={taskId}
              label="Launch agent"
              variant="primary"
            />
            <button
              type="button"
              className="d3-btn d3-btn--ghost"
              style={{ color: "var(--err)" }}
              onClick={() => void handleDelete()}
            >
              Delete
            </button>
          </div>
        </div>

        <div className="td-grid">
          <div className="td-doc">
            {editingTitle ? (
              <textarea
                ref={titleRef}
                className="td-title td-title--edit"
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={handleTitleKeyDown}
                onBlur={commitTitle}
              />
            ) : (
              <h1
                className="td-title"
                role="button"
                tabIndex={0}
                onClick={startEditTitle}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    startEditTitle();
                  }
                }}
              >
                {task.title}
              </h1>
            )}

            <div className="td-quickmeta">
              {task.assignee_name ? (
                <span
                  className="td-av"
                  style={{
                    width: AVATAR_PX,
                    height: AVATAR_PX,
                    fontSize: AVATAR_FONT_PX,
                    background: hashHue(task.assignee_name),
                  }}
                >
                  {initialsOf(task.assignee_name)}
                </span>
              ) : (
                <span
                  className="td-av td-av--none"
                  style={{ width: AVATAR_PX, height: AVATAR_PX }}
                />
              )}
              <b>{task.assignee_name ?? "Unassigned"}</b>
              {assigneeMember ? (
                <span className="td-dim td-sm">{assigneeMember.role}</span>
              ) : null}
              <span className="td-dot-sep" />
              <span>{task.project_name ?? "—"}</span>
              <span className="td-dot-sep" />
              <span>Updated {relativeTime(withZ(task.updated_at))}</span>
            </div>

            <div className="td-card">
              <div className="td-card__head">
                <h2 className="td-h">Description</h2>
                {!editingDesc ? (
                  <button
                    type="button"
                    className="td-ghost"
                    onClick={startEditDesc}
                  >
                    Edit
                  </button>
                ) : null}
              </div>
              {editingDesc ? (
                <>
                  <textarea
                    className="td-desc__ta"
                    autoFocus
                    rows={6}
                    value={descDraft}
                    onChange={(e) => setDescDraft(e.target.value)}
                    onKeyDown={handleDescKeyDown}
                  />
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      marginTop: 8,
                    }}
                  >
                    <button
                      type="button"
                      className="d3-btn d3-btn--primary"
                      onClick={commitDesc}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="td-ghost"
                      onClick={() => setEditingDesc(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <div className="td-body">
                  {task.description ? (
                    <AgentMarkdown text={task.description} />
                  ) : (
                    <span className="td-dim td-sm">No description yet.</span>
                  )}
                </div>
              )}
            </div>

            <ActivityCard
              entries={activity}
              isLoading={activityLoading}
              isError={activityError}
              onRetry={() => void refetchActivity()}
              statusLabels={statusLabels}
            />

            <RunsCard
              runs={runs}
              isLoading={runsLoading}
              isError={runsError}
              onRetry={() => void refetchRuns()}
              activeSessionId={replaySessionId}
              onReplay={handleReplay}
            />
            {replaySessionId ? (
              <TaskRunReplay
                sessionId={replaySessionId}
                onClose={() => setReplaySessionId(null)}
              />
            ) : null}
          </div>

          <div className="td-side">
            <PropertiesCard
              task={task}
              members={members}
              projects={projects}
              statusVocab={statusVocab}
              priorityVocab={priorityVocab}
              labelTaxonomy={labelTaxonomy}
              onStatus={handleStatus}
              onPriority={handlePriority}
              onAssignee={handleAssignee}
              onEffort={handleEffort}
              onProject={handleProject}
              onToggleLabel={handleToggleLabel}
            />

            <div className="td-card">
              <div className="td-card__head">
                <h2 className="td-h td-h--side">
                  Blockers <span className="td-count">{blockers.length}</span>
                </h2>
                <TdPopover
                  label="Add blocker"
                  open={blockerPopoverOpen}
                  onOpenChange={setBlockerPopoverOpen}
                  renderTrigger={({ ref, open, onClick }) => (
                    <button
                      ref={ref}
                      type="button"
                      className="td-ghost"
                      aria-haspopup="listbox"
                      aria-expanded={open}
                      onClick={onClick}
                    >
                      + Add
                    </button>
                  )}
                >
                  {({ close }) => (
                    <>
                      <div className="td-pop__h">Add blocker</div>
                      {blockerCandidates.length === 0 ? (
                        <button type="button" className="td-pop__i" disabled>
                          No other tasks to add
                        </button>
                      ) : (
                        blockerCandidates.map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            role="option"
                            aria-selected={false}
                            className="td-pop__i"
                            onClick={() => {
                              handleAddBlocker(t.id);
                              close();
                            }}
                          >
                            #{t.id} {t.title}
                          </button>
                        ))
                      )}
                    </>
                  )}
                </TdPopover>
              </div>
              {blockers.length === 0 ? (
                <div className="td-noblock">✓ Not blocked</div>
              ) : (
                <div className="td-blockers">
                  {blockers.map((b) => {
                    const blockingStatus = statusVocab.find(
                      (e) => e.slug === b.blocking_status,
                    );
                    return (
                      <div key={b.id} className="td-blocker">
                        <button
                          type="button"
                          className="td-blocker__link"
                          onClick={() =>
                            void navigate(`/tasks/${b.blocking_task_id}`)
                          }
                        >
                          #{b.blocking_task_id} — {b.blocking_title}
                        </button>
                        <span
                          className="td-label"
                          style={{
                            color: blockingStatus?.color ?? "var(--fg-4)",
                          }}
                        >
                          {blockingStatus?.label ?? b.blocking_status}
                        </span>
                        <button
                          type="button"
                          className="td-ghost"
                          style={{ color: "var(--err)" }}
                          onClick={() => handleRemoveBlocker(b.id)}
                        >
                          Remove
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="td-card">
              <h2 className="td-h td-h--side">Timestamps</h2>
              <div className="td-times">
                <div>
                  <span>Created</span>
                  <b title={task.created_at}>
                    {relativeTime(withZ(task.created_at))}
                  </b>
                </div>
                <div>
                  <span>Started</span>
                  <b>{task.started_date ?? "—"}</b>
                </div>
                <div>
                  <span>Completed</span>
                  <b>{task.completed_date ?? "—"}</b>
                </div>
                <div>
                  <span>Updated</span>
                  <b title={task.updated_at}>
                    {relativeTime(withZ(task.updated_at))}
                  </b>
                </div>
              </div>
            </div>

            <button
              type="button"
              className="td-danger"
              onClick={() => void handleDelete()}
            >
              Delete task
            </button>
          </div>
        </div>
      </div>
    </Shell>
  );
}
