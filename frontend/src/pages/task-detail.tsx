/**
 * Task detail — a read-first document, not a row editor.
 *
 * A `.dk-bar` action row sits above a two-column `.dk-detail`: a document
 * column (`.dk-detail__doc` — inline-editable title, read-first description
 * group with an edit toggle) and a 300px properties sidebar
 * (`PropertiesCard` + blockers + timestamps). Status / priority / effort /
 * assignee / project / labels write the moment a select changes — there is
 * no "Save Changes" button for those fields, matching the Work Board
 * (`pages/tasks.tsx`). Title commits on Enter or blur; description commits
 * on an explicit save. The "saved" indicator in the shell's action slot is
 * never optimistic: it appears only after the write **and** its
 * `["task", id]` refetch have both settled (`runWrite` below), and never
 * after a failed write.
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
  createComment,
  createSubtask,
  deleteComment,
  deleteSubtask,
  deleteTask,
  removeTaskBlocker,
  removeTaskLabel,
  updateComment,
  updateSubtask,
  updateTask,
  useLookups,
  useProjects,
  useTask,
  useTaskActivity,
  useTaskCost,
  useTaskRuns,
  useTaskComments,
  useTaskSubtasks,
  useTasks,
  useTaxonomy,
  useTeamMembers,
  type ActivityEntry,
  type AgentRun,
  type Project,
  type Subtask,
  type TaskComment,
  type Task,
  type Taxonomy,
  type TeamMember,
  type WorkflowVocabEntry,
} from "../lib/api";
import { relativeTime } from "../lib/format-helpers";
import { DeckShell } from "../components/deck/deck-shell";
import { DeckMenu } from "../components/deck/deck-menu";
import { DeckGrid, DeckGroup, DeckLine } from "../components/deck/deck-grid";
import { taskState } from "../components/deck/deck-cols";
import { LaunchFromSourceButton } from "../components/launch/launch-from-source-button";
import { AgentMarkdown } from "../components/terminal/agent-markdown";
import { ActivityCard } from "../components/task-detail/activity-card";
import { PropertiesCard } from "../components/task-detail/properties-card";
import { TaskRunReplay } from "../components/task-detail/run-replay";
import { RunsCard } from "../components/task-detail/runs-card";
import { SubtasksCard } from "../components/task-detail/subtasks-card";
import { CommentsCard } from "../components/task-detail/comments-card";
import { CostCard } from "../components/task-detail/cost-card";

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
const NO_SUBTASKS: Subtask[] = [];
const NO_COMMENTS: TaskComment[] = [];

const BLOCKER_COLS = "14px minmax(0, 1fr) 90px auto";

type SavePhase = "idle" | "saving" | "saved";
const SAVED_INDICATOR_MS = 2_500;

/** `relativeTime` normalises naive UTC itself now, separator included, so this
 * only has to guard the null case its callers pass. */
function withZ(iso: string | null | undefined): string | null {
  return iso ?? null;
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
  const {
    data: cost,
    isLoading: costLoading,
    isError: costError,
    refetch: refetchCost,
  } = useTaskCost(taskId);
  const {
    data: subtasks = NO_SUBTASKS,
    isLoading: subtasksLoading,
    isError: subtasksError,
    refetch: refetchSubtasks,
  } = useTaskSubtasks(taskId);
  const {
    data: comments = NO_COMMENTS,
    isLoading: commentsLoading,
    isError: commentsError,
    refetch: refetchComments,
  } = useTaskComments(taskId);

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

  // ── Subtasks ────────────────────────────────────────────────────────────
  // The refetch is awaited before the promise settles, so the card's
  // optimistic checkbox only drops its overlay once the stored row is in
  // hand. `handleToggleSubtask` rethrows on purpose — that rejection is what
  // reverts the checkbox.
  const writeSubtask = useCallback(
    async (fn: () => Promise<unknown>): Promise<void> => {
      await fn();
      await qc.invalidateQueries({ queryKey: ["task-subtasks", taskId] });
    },
    [qc, taskId],
  );

  const handleAddSubtask = useCallback(
    (title: string) => {
      void writeSubtask(() => createSubtask(taskId, title)).catch((err) =>
        toast.error(`Failed to add subtask: ${(err as Error).message}`),
      );
    },
    [taskId, writeSubtask],
  );
  const handleRenameSubtask = useCallback(
    (subtaskId: number, title: string) => {
      void writeSubtask(() =>
        updateSubtask(taskId, subtaskId, { title }),
      ).catch((err) =>
        toast.error(`Failed to rename subtask: ${(err as Error).message}`),
      );
    },
    [taskId, writeSubtask],
  );
  const handleDeleteSubtask = useCallback(
    (subtaskId: number) => {
      void writeSubtask(() => deleteSubtask(taskId, subtaskId)).catch((err) =>
        toast.error(`Failed to delete subtask: ${(err as Error).message}`),
      );
    },
    [taskId, writeSubtask],
  );
  const handleToggleSubtask = useCallback(
    async (subtaskId: number, done: boolean): Promise<void> => {
      try {
        await writeSubtask(() => updateSubtask(taskId, subtaskId, { done }));
      } catch (err) {
        toast.error(`Failed to update subtask: ${(err as Error).message}`);
        throw err;
      }
    },
    [taskId, writeSubtask],
  );

  // ── Comments ────────────────────────────────────────────────────────────
  // Post and edit rethrow on purpose: the card only clears its draft once the
  // promise resolves, so a rejection is what keeps the typed text on screen.
  const writeComment = useCallback(
    async (fn: () => Promise<unknown>): Promise<void> => {
      await fn();
      await qc.invalidateQueries({ queryKey: ["task-comments", taskId] });
    },
    [qc, taskId],
  );

  const handlePostComment = useCallback(
    async (body: string): Promise<void> => {
      try {
        await writeComment(() => createComment(taskId, body));
      } catch (err) {
        toast.error(`Failed to post comment: ${(err as Error).message}`);
        throw err;
      }
    },
    [taskId, writeComment],
  );
  const handleEditComment = useCallback(
    async (commentId: number, body: string): Promise<void> => {
      try {
        await writeComment(() => updateComment(taskId, commentId, body));
      } catch (err) {
        toast.error(`Failed to edit comment: ${(err as Error).message}`);
        throw err;
      }
    },
    [taskId, writeComment],
  );
  const handleDeleteComment = useCallback(
    (commentId: number) => {
      void writeComment(() => deleteComment(taskId, commentId)).catch((err) =>
        toast.error(`Failed to delete comment: ${(err as Error).message}`),
      );
    },
    [taskId, writeComment],
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

  // ── Add-blocker candidates ──────────────────────────────────────────────
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
      <DeckShell title={`#${taskId}`} crumb="loading">
        <div className="dk-note">Loading task…</div>
      </DeckShell>
    );
  }

  if (isError || !task) {
    // `!task` with no error covers the disabled-query case (`useTask`'s
    // `enabled: taskId > 0`) — an invalid route param never fires the
    // fetch, so `isError` never resolves either. Same not-found copy.
    const notFound = !task || error?.status === 404;
    return (
      <DeckShell title={`#${taskId}`} crumb="loading">
        <div className="dk-note">
          {notFound ? (
            <>
              <p>Task #{taskId} no longer exists.</p>
              <Link className="dk-btn bare" to="/tasks">
                ← work board
              </Link>
            </>
          ) : (
            <>
              <p>{error?.message ?? "Failed to load task."}</p>
              <button
                type="button"
                className="dk-btn"
                onClick={() => void refetch()}
              >
                retry
              </button>
            </>
          )}
        </div>
      </DeckShell>
    );
  }

  const statusEntry = statusVocab.find((e) => e.slug === task.status);
  const statusLabel = statusEntry?.label ?? task.status;
  const assigneeMember =
    task.assignee_id != null
      ? members.find((m) => m.id === task.assignee_id)
      : undefined;
  const blockers = task.blockers ?? [];

  return (
    <DeckShell
      title={`#${taskId}`}
      crumb={statusLabel.toLowerCase()}
      actions={
        <span className="dk-actions">
          {savePhase === "saving" && <span className="dim">saving…</span>}
          {savePhase === "saved" && <span className="dim">✓ saved</span>}
          <LaunchFromSourceButton kind="task" id={taskId} label="launch agent" variant="primary" />
          <DeckMenu
            label="Task actions"
            items={[
              { label: "Copy reference", onSelect: handleCopyRef },
              {
                label: "Delete task",
                danger: true,
                separated: true,
                onSelect: () => void handleDelete(),
              },
            ]}
          />
        </span>
      }
    >
      <>
        <Link className="dk-btn bare" to="/tasks" style={{ marginBottom: "var(--u3)" }}>
          ← work board
        </Link>

        <div className="dk-detail">
          <div className="dk-detail__doc">
            {/* `.dk-title` is Deck's record header: a mono h1 over a hairline.
                The editor replaces the h1 in place and keeps the imperative
                autosize, so the row grows with the text instead of jumping to
                `textarea.dk-ctl`'s 92px floor. */}
            <div className="dk-title">
              {editingTitle ? (
                <textarea
                  ref={titleRef}
                  className="dk-ctl dk-title__edit"
                  style={{ minHeight: 0, resize: "none", flex: "1 1 auto" }}
                  autoFocus
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={handleTitleKeyDown}
                  onBlur={commitTitle}
                />
              ) : (
                <h1
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
            </div>

            <div className="dim" style={{ padding: "0 var(--u3) var(--u6)" }}>
              {task.assignee_name ?? "unassigned"}
              {assigneeMember ? ` (${assigneeMember.role})` : ""}
              {" · "}
              {task.project_name ?? "—"}
              {" · updated "}
              {relativeTime(withZ(task.updated_at))}
            </div>

            <DeckGroup
              label="description"
              actions={
                !editingDesc ? (
                  <button
                    type="button"
                    className="dk-btn bare"
                    onClick={startEditDesc}
                  >
                    edit
                  </button>
                ) : undefined
              }
            >
              {editingDesc ? (
                <div
                  className="dk-form"
                  style={{ padding: "0 var(--u3)", gap: "var(--u2)" }}
                >
                  <textarea
                    className="dk-ta"
                    autoFocus
                    rows={6}
                    value={descDraft}
                    onChange={(e) => setDescDraft(e.target.value)}
                    onKeyDown={handleDescKeyDown}
                  />
                  <div className="dk-actions">
                    <button type="button" className="dk-btn" onClick={commitDesc}>
                      save
                    </button>
                    <button
                      type="button"
                      className="dk-btn bare"
                      onClick={() => setEditingDesc(false)}
                    >
                      cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="dk-prose" style={{ padding: "0 var(--u3)" }}>
                  {task.description ? (
                    <AgentMarkdown text={task.description} />
                  ) : (
                    <span className="dim">No description yet.</span>
                  )}
                </div>
              )}
            </DeckGroup>

            <SubtasksCard
              subtasks={subtasks}
              isLoading={subtasksLoading}
              isError={subtasksError}
              onRetry={() => void refetchSubtasks()}
              onAdd={handleAddSubtask}
              onRename={handleRenameSubtask}
              onToggle={handleToggleSubtask}
              onDelete={handleDeleteSubtask}
            />

            <ActivityCard
              entries={activity}
              isLoading={activityLoading}
              isError={activityError}
              onRetry={() => void refetchActivity()}
              statusLabels={statusLabels}
              comments={
                <CommentsCard
                  comments={comments}
                  isLoading={commentsLoading}
                  isError={commentsError}
                  onRetry={() => void refetchComments()}
                  onPost={handlePostComment}
                  onSaveEdit={handleEditComment}
                  onDelete={handleDeleteComment}
                />
              }
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

          <div>
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

            <DeckGroup
              label="blockers"
              count={blockers.length}
              actions={
                <select
                  className="dk-rowsel"
                  aria-label="Add blocker"
                  value=""
                  disabled={blockerCandidates.length === 0}
                  onChange={(e) => {
                    const id = Number(e.target.value);
                    if (id) handleAddBlocker(id);
                  }}
                >
                  <option value="">
                    {blockerCandidates.length === 0
                      ? "no other tasks"
                      : "+ blocker"}
                  </option>
                  {blockerCandidates.map((t) => (
                    <option key={t.id} value={String(t.id)}>
                      #{t.id} {t.title}
                    </option>
                  ))}
                </select>
              }
            >
              {blockers.length === 0 ? (
                <div className="dk-note">Not blocked.</div>
              ) : (
                <DeckGrid cols={BLOCKER_COLS} label="Blockers">
                  {blockers.map((b) => {
                    const blockingStatus = statusVocab.find(
                      (e) => e.slug === b.blocking_status,
                    );
                    const label =
                      blockingStatus?.label ?? b.blocking_status;
                    return (
                      <DeckLine
                        key={b.id}
                        state={taskState(b.blocking_status)}
                        cells={[
                          {
                            v: `#${b.blocking_task_id} — ${b.blocking_title}`,
                            cls: "sub",
                          },
                          {
                            v: (
                              <span
                                className="dk-tag"
                                data-s={taskState(b.blocking_status)}
                              >
                                {label.toLowerCase()}
                              </span>
                            ),
                          },
                          {
                            v: (
                              <span className="acts">
                                <button
                                  type="button"
                                  className="dk-btn bare"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRemoveBlocker(b.id);
                                  }}
                                >
                                  remove
                                </button>
                              </span>
                            ),
                            cls: "r",
                          },
                        ]}
                        onOpen={() =>
                          void navigate(`/tasks/${b.blocking_task_id}`)
                        }
                      />
                    );
                  })}
                </DeckGrid>
              )}
            </DeckGroup>

            <CostCard
              cost={cost}
              isLoading={costLoading}
              isError={costError}
              onRetry={() => void refetchCost()}
            />

            <DeckGroup label="timestamps">
              <div className="dk-kv">
                <span>created</span>
                <span title={task.created_at}>
                  {relativeTime(withZ(task.created_at))}
                </span>
              </div>
              <div className="dk-kv">
                <span>started</span>
                <span>{task.started_date ?? "—"}</span>
              </div>
              <div className="dk-kv">
                <span>completed</span>
                <span>{task.completed_date ?? "—"}</span>
              </div>
              <div className="dk-kv">
                <span>updated</span>
                <span title={task.updated_at}>
                  {relativeTime(withZ(task.updated_at))}
                </span>
              </div>
            </DeckGroup>
          </div>
        </div>
      </>
    </DeckShell>
  );
}
