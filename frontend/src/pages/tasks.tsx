/**
 * Work Board — unified kanban over `workflow_items` (triage) + `tasks`.
 *
 * Both tables stay; the board just reads from both.
 * Column → status mapping:
 *   Triage      = workflow_items with status inbox | review | ready
 *   Backlog     = tasks with status backlog
 *   Todo        = tasks with status todo
 *   In Progress = tasks with status in-progress (+ blocked shown with badge)
 *   Done        = tasks with status done
 *
 * Moving a triage card out → promote via POST /api/v1/inbox/{id}/promote (modal).
 * Moving a task card        → POST /api/v1/tasks/{id}/status.
 *
 * TODO: when workflow_items is merged into tasks, remove the triage-column
 * fetch, the promote modal, and the inbox hooks here.
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useTasks,
  useProjects,
  useTeamMembers,
  useLookups,
  fetchSidecar,
  type Task,
  type WorkflowVocabEntry,
} from "../lib/api";
import { Shell } from "../components/layout/shell";
import { LaunchFromSourceButton } from "../components/launch/launch-from-source-button";

// ─── Constants ────────────────────────────────────────────────────────────────

const VIRTUAL_THRESHOLD = 50;
const ROW_HEIGHT_PX = 41;
const ROW_GRID =
  "60px minmax(180px,2fr) minmax(140px,1fr) 130px 90px 140px 100px";

const UNASSIGNED_NAME = "Unassigned";

// Fallback priority colours for slugs the taxonomy doesn't define (e.g.
// "urgent"). The Workflow Labels taxonomy overlays these at runtime.
const FALLBACK_PRIORITY_COLORS: Record<string, string> = {
  high: "#ef4444",
  medium: "#f59e0b",
  low: "#22c55e",
  urgent: "#a855f7",
};

// Board columns are fully dynamic: one column per active task-status from the
// Workflow Labels taxonomy, in its sort order, using its label + colour. Adding
// a status adds a column; deactivating/removing it drops the column.
interface BoardColumn {
  id: string; // task-status slug
  label: string;
  color: string;
}

// Seed fallback used only until the taxonomy lookups resolve, so the board
// isn't momentarily empty on first paint.
const FALLBACK_TASK_STATUSES: ReadonlyArray<WorkflowVocabEntry> = [
  { slug: "backlog", label: "Idea", color: "#6b7280", sort_order: 10 },
  { slug: "todo", label: "To do", color: "#60a5fa", sort_order: 20 },
  { slug: "in-progress", label: "In progress", color: "#f59e0b", sort_order: 30 },
  { slug: "blocked", label: "Blocked", color: "#ef4444", sort_order: 40 },
  { slug: "done", label: "Done", color: "#22c55e", sort_order: 50 },
];

// Resolved per-card vocabulary helpers, threaded to the memoised card/row
// components so a rename/recolour in Settings → Workflow Labels shows up live.
interface VocabMaps {
  priorityColors: Record<string, string>;
  priorityLabels: Record<string, string>;
  statusLabels: Record<string, string>;
}

// Module-level sentinels to avoid fresh-reference cascade
const NO_STATUSES: string[] = [];
const NO_STATUS_COLORS: Record<string, string> = {};
const NO_VOCAB: WorkflowVocabEntry[] = [];

// ─── Board card components ────────────────────────────────────────────────────

interface TaskCardProps {
  task: Task;
  vocab: VocabMaps;
  targetStatuses: ReadonlyArray<{ value: string; label: string }>;
  onNavigate: (path: string) => void;
  onMoveTask: (id: number, status: string) => void;
}

function TaskCardInner({
  task: t,
  vocab,
  targetStatuses,
  onNavigate,
  onMoveTask,
}: TaskCardProps): ReactElement {
  const priorityColor = vocab.priorityColors[t.priority] ?? "var(--fg-4)";
  const isDone = t.status === "done";

  return (
    <div
      className="wb-card"
      style={{
        ["--wb-accent" as string]: priorityColor,
        opacity: isDone ? 0.62 : 1,
      }}
    >
      {/* Title */}
      <div className="wb-card__title">
        <button
          type="button"
          className="wb-card__id"
          onClick={() => onNavigate(`/tasks/${t.id}`)}
        >
          #{t.id}
        </button>
        <button
          type="button"
          className="wb-card__name"
          style={isDone ? { textDecoration: "line-through" } : undefined}
          onClick={() => onNavigate(`/tasks/${t.id}`)}
        >
          {t.title}
        </button>
      </div>

      {/* Badges */}
      <div className="wb-card__badges">
        <span
          className="wb-chip"
          style={{
            color: priorityColor,
            borderColor: `${priorityColor}40`,
            background: `${priorityColor}1a`,
          }}
        >
          {vocab.priorityLabels[t.priority] ?? t.priority}
        </span>
        {t.project_name && (
          <span className="wb-chip wb-chip--project" title={t.project_name}>
            {t.project_name}
          </span>
        )}
      </div>

      {/* Move control + launch */}
      <div className="wb-card__foot">
        <select
          value={t.status}
          onChange={(e) => {
            if (e.target.value !== t.status) onMoveTask(t.id, e.target.value);
          }}
          className="wb-select"
          title="Move to column"
        >
          {targetStatuses.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <LaunchFromSourceButton
          kind="task"
          id={t.id}
          label=""
          icon="play"
          tooltip="Launch agent"
          tone="run"
        />
      </div>
    </div>
  );
}
const TaskCard = memo(TaskCardInner);

// ─── Board column component ───────────────────────────────────────────────────

interface BoardColProps {
  col: BoardColumn;
  taskItems: Task[];
  vocab: VocabMaps;
  targetStatuses: ReadonlyArray<{ value: string; label: string }>;
  onNavigate: (path: string) => void;
  onMoveTask: (id: number, status: string) => void;
}

function BoardCol({
  col,
  taskItems,
  vocab,
  targetStatuses,
  onNavigate,
  onMoveTask,
}: BoardColProps): ReactElement {
  const count = taskItems.length;

  return (
    <div className="wb-col">
      {/* Column header */}
      <div className="wb-col__head">
        <span className="wb-col__dot" style={{ background: col.color }} />
        <span className="wb-col__title">{col.label}</span>
        <span className="wb-col__count">{count}</span>
      </div>

      {/* Cards */}
      <div className="wb-col__body">
        {taskItems.length === 0 ? (
          <div className="wb-col__empty">No tasks</div>
        ) : (
          taskItems.map((task) => (
            <TaskCard
              key={`task-${task.id}`}
              task={task}
              vocab={vocab}
              targetStatuses={targetStatuses}
              onNavigate={onNavigate}
              onMoveTask={onMoveTask}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ─── List-view sub-components (preserved from original tasks.tsx) ─────────────

interface TaskRowCallbacks {
  navigate: (path: string) => void;
  setProjectFilter: (id: string) => void;
  changeStatus: (id: number, status: string) => void;
  statuses: string[];
  statusColors: Record<string, string>;
  statusLabels: Record<string, string>;
  priorityColors: Record<string, string>;
  priorityLabels: Record<string, string>;
}

interface TaskRowProps {
  task: Task;
  cb: TaskRowCallbacks;
}

function TaskRowTableInner({ task: t, cb }: TaskRowProps): ReactElement {
  return (
    <tr style={{ borderBottom: "1px solid var(--line-1)" }}>
      <td style={{ padding: "8px 12px" }}>
        <button
          type="button"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--accent)",
            fontSize: 13,
            padding: 0,
          }}
          onClick={() => cb.navigate(`/tasks/${t.id}`)}
        >
          #{t.id}
        </button>
      </td>
      <td style={{ padding: "8px 12px" }}>
        <button
          type="button"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--fg-0)",
            fontSize: 13,
            padding: 0,
            textAlign: "left",
          }}
          onClick={() => cb.navigate(`/tasks/${t.id}`)}
        >
          {t.title}
        </button>
      </td>
      <td style={{ padding: "8px 12px" }}>
        <button
          type="button"
          onClick={() => cb.setProjectFilter(String(t.project_id))}
          style={{
            fontSize: 11,
            padding: "2px 7px",
            borderRadius: 3,
            background: "color-mix(in srgb, var(--accent) 12%, transparent)",
            border:
              "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
            color: "var(--accent)",
            cursor: "pointer",
          }}
        >
          {t.project_name ?? UNASSIGNED_NAME}
        </button>
      </td>
      <td style={{ padding: "8px 12px" }}>
        <select
          value={t.status}
          onChange={(e) => cb.changeStatus(t.id, e.target.value)}
          style={{
            fontSize: 11,
            padding: "2px 6px",
            background: `${cb.statusColors[t.status] ?? "var(--bg-2)"}20`,
            border: `1px solid ${cb.statusColors[t.status] ?? "var(--line-2)"}50`,
            color: cb.statusColors[t.status] ?? "var(--fg-2)",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          {cb.statuses.map((s) => (
            <option key={s} value={s}>
              {cb.statusLabels[s] ?? s}
            </option>
          ))}
        </select>
      </td>
      <td style={{ padding: "8px 12px" }}>
        <span
          style={{
            fontSize: 11,
            padding: "2px 7px",
            borderRadius: 3,
            border: `1px solid ${cb.priorityColors[t.priority] ?? "var(--line-2)"}50`,
            color: cb.priorityColors[t.priority] ?? "var(--fg-3)",
          }}
        >
          {cb.priorityLabels[t.priority] ?? t.priority}
        </span>
      </td>
      <td style={{ padding: "8px 12px", fontSize: 13, color: "var(--fg-3)" }}>
        {t.assignee_name ?? "—"}
      </td>
      <td style={{ padding: "4px 8px" }} onClick={(e) => e.stopPropagation()}>
        <LaunchFromSourceButton
          kind="task"
          id={t.id}
          label="Launch"
          icon="play"
          tone="run"
        />
      </td>
    </tr>
  );
}
const TaskRowTable = memo(TaskRowTableInner);

function TaskRowVirtualInner({ task: t, cb }: TaskRowProps): ReactElement {
  const cell = {
    padding: "8px 12px",
    display: "flex",
    alignItems: "center",
  } as const;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: ROW_GRID,
        height: ROW_HEIGHT_PX,
        borderBottom: "1px solid var(--line-1)",
      }}
    >
      <div style={cell}>
        <button
          type="button"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--accent)",
            fontSize: 13,
            padding: 0,
          }}
          onClick={() => cb.navigate(`/tasks/${t.id}`)}
        >
          #{t.id}
        </button>
      </div>
      <div style={{ ...cell, overflow: "hidden" }}>
        <button
          type="button"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--fg-0)",
            fontSize: 13,
            padding: 0,
            textAlign: "left",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            width: "100%",
          }}
          onClick={() => cb.navigate(`/tasks/${t.id}`)}
        >
          {t.title}
        </button>
      </div>
      <div style={cell}>
        <button
          type="button"
          onClick={() => cb.setProjectFilter(String(t.project_id))}
          style={{
            fontSize: 11,
            padding: "2px 7px",
            borderRadius: 3,
            background: "color-mix(in srgb, var(--accent) 12%, transparent)",
            border:
              "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
            color: "var(--accent)",
            cursor: "pointer",
            maxWidth: "100%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {t.project_name ?? UNASSIGNED_NAME}
        </button>
      </div>
      <div style={cell}>
        <select
          value={t.status}
          onChange={(e) => cb.changeStatus(t.id, e.target.value)}
          style={{
            fontSize: 11,
            padding: "2px 6px",
            background: `${cb.statusColors[t.status] ?? "var(--bg-2)"}20`,
            border: `1px solid ${cb.statusColors[t.status] ?? "var(--line-2)"}50`,
            color: cb.statusColors[t.status] ?? "var(--fg-2)",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          {cb.statuses.map((s) => (
            <option key={s} value={s}>
              {cb.statusLabels[s] ?? s}
            </option>
          ))}
        </select>
      </div>
      <div style={cell}>
        <span
          style={{
            fontSize: 11,
            padding: "2px 7px",
            borderRadius: 3,
            border: `1px solid ${cb.priorityColors[t.priority] ?? "var(--line-2)"}50`,
            color: cb.priorityColors[t.priority] ?? "var(--fg-3)",
          }}
        >
          {cb.priorityLabels[t.priority] ?? t.priority}
        </span>
      </div>
      <div style={{ ...cell, fontSize: 13, color: "var(--fg-3)" }}>
        {t.assignee_name ?? "—"}
      </div>
      <div
        style={{ ...cell, padding: "4px 8px" }}
        onClick={(e) => e.stopPropagation()}
      >
        <LaunchFromSourceButton
          kind="task"
          id={t.id}
          label="Launch"
          icon="play"
          tone="run"
        />
      </div>
    </div>
  );
}
const TaskRowVirtual = memo(TaskRowVirtualInner);

const HEADER_LABELS = [
  "ID",
  "Title",
  "Project",
  "Status",
  "Priority",
  "Assignee",
  "",
] as const;

function VirtualTaskList({
  tasks,
  cb,
}: {
  tasks: Task[];
  cb: TaskRowCallbacks;
}): ReactElement {
  const parentRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 8,
  });
  return (
    <div className="d3-card" style={{ padding: 0, overflow: "hidden" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: ROW_GRID,
          borderBottom: "1px solid var(--line-2)",
          background: "var(--bg-2)",
        }}
      >
        {HEADER_LABELS.map((h) => (
          <div
            key={h}
            style={{
              padding: "8px 12px",
              fontSize: 11,
              color: "var(--fg-3)",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            {h}
          </div>
        ))}
      </div>
      <div ref={parentRef} style={{ height: 600, overflowY: "auto" }}>
        <div
          style={{
            height: virtualizer.getTotalSize(),
            position: "relative",
            width: "100%",
          }}
        >
          {virtualizer.getVirtualItems().map((vRow) => {
            const t = tasks[vRow.index]!;
            return (
              <div
                key={t.id}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vRow.start}px)`,
                }}
              >
                <TaskRowVirtual task={t} cb={cb} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── New task form ────────────────────────────────────────────────────────────

interface NewTaskFormProps {
  projects: Array<{ id: number; name: string }>;
  members: Array<{ id: number; name: string }>;
  statuses: string[];
  statusLabels: Record<string, string>;
  priorities: ReadonlyArray<{ value: string; label: string }>;
  defaultProjectId: string;
  onCancel: () => void;
  onCreated: () => void;
}

function growTextarea(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

function NewTaskForm({
  projects,
  members,
  statuses,
  statusLabels,
  priorities,
  defaultProjectId,
  onCancel,
  onCreated,
}: NewTaskFormProps): ReactElement {
  const [form, setForm] = useState({
    title: "",
    description: "",
    status: "todo",
    priority: "medium",
    effort: "",
    assignee_id: "",
    project_id: defaultProjectId,
  });
  const [formError, setFormError] = useState<string | null>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the description field whenever its value changes (covers the
  // initial mount and any future pre-fill, not just per-keystroke onChange).
  useLayoutEffect(() => {
    if (descRef.current) growTextarea(descRef.current);
  }, [form.description]);

  const effectiveProjectId = form.project_id || defaultProjectId;

  const inputStyle = {
    width: "100%",
    padding: "6px 10px",
    background: "var(--bg-3)",
    border: "1px solid var(--line-2)",
    color: "var(--fg-0)",
    borderRadius: 6,
    fontSize: 13,
    boxSizing: "border-box" as const,
  };

  const handleCreate = async () => {
    if (!form.title.trim()) return;
    if (!effectiveProjectId) {
      setFormError("Project is required");
      return;
    }
    setFormError(null);
    await fetchSidecar("/api/v1/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: form.title,
        description: form.description || null,
        status: form.status,
        priority: form.priority,
        effort: form.effort || null,
        assignee_id: form.assignee_id ? parseInt(form.assignee_id) : null,
        project_id: parseInt(effectiveProjectId),
      }),
    });
    onCreated();
  };

  return (
    <div className="d3-card" style={{ padding: "16px 20px", marginBottom: 16 }}>
      <span className="d3-h" style={{ display: "block", marginBottom: 12 }}>
        New Task
      </span>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "2fr 1fr 1fr",
          gap: 10,
          marginBottom: 10,
        }}
      >
        <div>
          <label
            style={{
              fontSize: 11,
              color: "var(--fg-3)",
              display: "block",
              marginBottom: 4,
            }}
          >
            Title *
          </label>
          <input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="Task title..."
            style={inputStyle}
          />
        </div>
        <div>
          <label
            style={{
              fontSize: 11,
              color: "var(--fg-3)",
              display: "block",
              marginBottom: 4,
            }}
          >
            Priority
          </label>
          <select
            value={form.priority}
            onChange={(e) => setForm({ ...form, priority: e.target.value })}
            style={inputStyle}
          >
            {priorities.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            style={{
              fontSize: 11,
              color: "var(--fg-3)",
              display: "block",
              marginBottom: 4,
            }}
          >
            Status
          </label>
          <select
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value })}
            style={inputStyle}
          >
            {statuses.map((s) => (
              <option key={s} value={s}>
                {statusLabels[s] ?? s}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div style={{ marginBottom: 10 }}>
        <label
          style={{
            fontSize: 11,
            color: "var(--fg-3)",
            display: "block",
            marginBottom: 4,
          }}
        >
          Description
        </label>
        <textarea
          ref={descRef}
          value={form.description}
          onChange={(e) => {
            setForm({ ...form, description: e.target.value });
            growTextarea(e.target);
          }}
          placeholder="Describe the task..."
          style={{
            ...inputStyle,
            minHeight: "calc(2 * 1.4em + 12px)",
            overflow: "hidden",
            resize: "none",
          }}
        />
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 10,
          marginBottom: 12,
        }}
      >
        <div>
          <label
            style={{
              fontSize: 11,
              color: "var(--fg-3)",
              display: "block",
              marginBottom: 4,
            }}
          >
            Project *
          </label>
          <select
            value={effectiveProjectId}
            onChange={(e) => {
              setForm({ ...form, project_id: e.target.value });
              if (e.target.value) setFormError(null);
            }}
            required
            style={{
              ...inputStyle,
              border: formError ? "1px solid #ef4444" : inputStyle.border,
            }}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {formError && (
            <div
              style={{
                fontSize: 11,
                color: "#ef4444",
                marginTop: 4,
              }}
            >
              {formError}
            </div>
          )}
        </div>
        <div>
          <label
            style={{
              fontSize: 11,
              color: "var(--fg-3)",
              display: "block",
              marginBottom: 4,
            }}
          >
            Assignee
          </label>
          <select
            value={form.assignee_id}
            onChange={(e) => setForm({ ...form, assignee_id: e.target.value })}
            style={inputStyle}
          >
            <option value="">—</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            style={{
              fontSize: 11,
              color: "var(--fg-3)",
              display: "block",
              marginBottom: 4,
            }}
          >
            Effort
          </label>
          <select
            value={form.effort}
            onChange={(e) => setForm({ ...form, effort: e.target.value })}
            style={inputStyle}
          >
            <option value="">—</option>
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
          </select>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          className="d3-btn d3-btn--primary"
          type="button"
          onClick={() => void handleCreate()}
        >
          Create Task
        </button>
        <button
          className="d3-btn d3-btn--ghost"
          type="button"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

type ViewMode = "board" | "list";

export function TasksPage(): ReactElement {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  // View mode persisted in URL so refresh keeps the user's choice
  const viewParam = searchParams.get("view");
  const viewMode: ViewMode = viewParam === "list" ? "list" : "board";

  const projectFilter = searchParams.get("project_id") ?? "";
  const statusFilter = searchParams.get("status") ?? "";
  const sortFilter = searchParams.get("sort") ?? "";

  // ── Data fetching ────────────────────────────────────────────────────────

  // Tasks — fetch all (no status filter) so the board can bucket them
  const taskFilters: Record<string, string> = {};
  if (projectFilter) taskFilters.project_id = projectFilter;
  // In list mode honour the status filter; board always shows all columns
  if (viewMode === "list" && statusFilter) taskFilters.status = statusFilter;
  if (viewMode === "list" && sortFilter) taskFilters.sort = sortFilter;

  const { data: tasks = [] } = useTasks(taskFilters);
  const { data: projects = [] } = useProjects();
  const { data: members = [] } = useTeamMembers();
  const { data: lookups } = useLookups();
  const statuses = lookups?.statuses ?? NO_STATUSES;
  const statusColors = lookups?.status_colors ?? NO_STATUS_COLORS;
  const taskStatusVocab = lookups?.workflow_task_statuses ?? NO_VOCAB;
  const priorityVocab = lookups?.workflow_task_priorities ?? NO_VOCAB;

  // ── Workflow Labels → live vocabulary (labels/colours/order) ───────────────
  // Everything below reads from the taxonomy-backed lookups, so a rename or
  // recolour under Settings → Workflow Labels reflects here immediately.

  const statusLabels = useMemo(() => {
    const m: Record<string, string> = {};
    for (const e of taskStatusVocab) m[e.slug] = e.label;
    return m;
  }, [taskStatusVocab]);

  const priorityColors = useMemo(() => {
    const m: Record<string, string> = { ...FALLBACK_PRIORITY_COLORS };
    for (const e of priorityVocab) if (e.color) m[e.slug] = e.color;
    return m;
  }, [priorityVocab]);

  const priorityLabels = useMemo(() => {
    const m: Record<string, string> = {};
    for (const e of priorityVocab) m[e.slug] = e.label;
    return m;
  }, [priorityVocab]);

  const vocab = useMemo<VocabMaps>(
    () => ({ priorityColors, priorityLabels, statusLabels }),
    [priorityColors, priorityLabels, statusLabels],
  );

  const priorities = useMemo<ReadonlyArray<{ value: string; label: string }>>(
    () =>
      priorityVocab.length
        ? priorityVocab.map((e) => ({ value: e.slug, label: e.label }))
        : [
            { value: "high", label: "High" },
            { value: "medium", label: "Medium" },
            { value: "low", label: "Low" },
          ],
    [priorityVocab],
  );

  // The board now has one column per active task status (in taxonomy order), so
  // the move-task dropdown offers every status, including the ones the cascade
  // also manages (e.g. blocked).
  const taskStatusList = taskStatusVocab.length
    ? taskStatusVocab
    : FALLBACK_TASK_STATUSES;

  const targetStatuses = useMemo<
    ReadonlyArray<{ value: string; label: string }>
  >(
    () => taskStatusList.map((e) => ({ value: e.slug, label: e.label })),
    [taskStatusList],
  );

  // Board columns: one per active task status, ordered/labelled/coloured by the
  // Workflow Labels taxonomy. Adding a status adds a column; removing it drops one.
  const boardColumns = useMemo<BoardColumn[]>(
    () =>
      taskStatusList.map((e) => ({
        id: e.slug,
        label: e.label,
        color: e.color ?? "#6366f1",
      })),
    [taskStatusList],
  );

  // ── Derived board data ───────────────────────────────────────────────────

  const tasksByColumn = useMemo<Map<string, Task[]>>(() => {
    const map = new Map<string, Task[]>();
    for (const col of boardColumns) map.set(col.id, []);
    const fallbackId = boardColumns[0]?.id;
    for (const t of tasks) {
      // Each column id is a status slug; an orphan status (e.g. one that was
      // deactivated while tasks still carry it) falls into the first column.
      const colId = map.has(t.status) ? t.status : fallbackId;
      if (colId) map.get(colId)?.push(t);
    }
    return map;
  }, [tasks, boardColumns]);

  // ── UI state ─────────────────────────────────────────────────────────────

  const [showForm, setShowForm] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});

  // The OmniBar's "New Task" command navigates here with `?new=1` — there is
  // no other cross-page way to open this form. Clearing the param with
  // `replace` keeps Back and a page refresh from re-opening it, and makes
  // the command idempotent when you are already on /tasks.
  //
  // The state updates are deferred to a microtask so this satisfies
  // `react-hooks/set-state-in-effect` (no direct synchronous `setState` in
  // the effect body); the deferral is a microtask, so it still lands before
  // the next paint.
  useEffect(() => {
    if (searchParams.get("new") !== "1") return;
    queueMicrotask(() => {
      setShowForm(true);
      const next = new URLSearchParams(searchParams);
      next.delete("new");
      setSearchParams(next, { replace: true });
    });
  }, [searchParams, setSearchParams]);

  // ── Callbacks ────────────────────────────────────────────────────────────

  const invalidateTasks = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["tasks"] });
  }, [qc]);

  const handleMoveTask = useCallback(
    async (taskId: number, status: string) => {
      await fetchSidecar(`/api/v1/tasks/${taskId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      invalidateTasks();
    },
    [invalidateTasks],
  );

  // ── List-view filter helpers ─────────────────────────────────────────────

  const setFilter = useCallback(
    (key: string, value: string) => {
      const p = new URLSearchParams(searchParams);
      if (value) p.set(key, value);
      else p.delete(key);
      setSearchParams(p);
    },
    [searchParams, setSearchParams],
  );

  const setViewMode = useCallback(
    (mode: ViewMode) => {
      const p = new URLSearchParams(searchParams);
      if (mode === "board") p.delete("view");
      else p.set("view", mode);
      setSearchParams(p);
    },
    [searchParams, setSearchParams],
  );

  // ── Default project id for new-task form ─────────────────────────────────

  const defaultProjectId = useMemo(() => {
    if (projectFilter) return projectFilter;
    if (projects.length === 0) return "";
    const preferred =
      projects.find((p) => p.name !== UNASSIGNED_NAME) ?? projects[0];
    return preferred ? String(preferred.id) : "";
  }, [projects, projectFilter]);

  // ── Stable callbacks for memoised list-view rows ─────────────────────────

  const navigateRef = useRef(navigate);
  const setFilterRef = useRef(setFilter);
  const handleMoveTaskRef = useRef(handleMoveTask);
  useEffect(() => {
    navigateRef.current = navigate;
    setFilterRef.current = setFilter;
    handleMoveTaskRef.current = handleMoveTask;
  });
  const rowCallbacks = useMemo<TaskRowCallbacks>(
    () => ({
      navigate: (path: string) => void navigateRef.current(path),
      setProjectFilter: (id: string) => setFilterRef.current("project_id", id),
      changeStatus: (id: number, status: string) =>
        void handleMoveTaskRef.current(id, status),
      statuses,
      statusColors,
      statusLabels,
      priorityColors,
      priorityLabels,
    }),
    [statuses, statusColors, statusLabels, priorityColors, priorityLabels],
  );

  // ── List-view grouped rendering ──────────────────────────────────────────

  const groups = useMemo(() => {
    if (viewMode !== "list" || projectFilter) return null;
    const byProject = new Map<number, { name: string; rows: Task[] }>();
    for (const t of tasks) {
      const entry = byProject.get(t.project_id);
      if (entry) {
        entry.rows.push(t);
      } else {
        byProject.set(t.project_id, {
          name: t.project_name ?? UNASSIGNED_NAME,
          rows: [t],
        });
      }
    }
    return [...byProject.entries()]
      .map(([id, g]) => ({ id, ...g }))
      .sort((a, b) => {
        if (a.name === UNASSIGNED_NAME) return 1;
        if (b.name === UNASSIGNED_NAME) return -1;
        return a.name.localeCompare(b.name);
      });
  }, [tasks, projectFilter, viewMode]);

  const renderTable = (rows: Task[]) => (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr style={{ borderBottom: "1px solid var(--line-2)" }}>
          {HEADER_LABELS.map((h) => (
            <th
              key={h}
              style={{
                padding: "8px 12px",
                fontSize: 11,
                color: "var(--fg-3)",
                textAlign: "left",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((t) => (
          <TaskRowTable key={t.id} task={t} cb={rowCallbacks} />
        ))}
      </tbody>
    </table>
  );

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <Shell
      actions={
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {/* View toggle */}
          <div
            style={{
              display: "flex",
              background: "var(--bg-2)",
              border: "1px solid var(--line-2)",
              borderRadius: 6,
              overflow: "hidden",
            }}
          >
            <button
              type="button"
              onClick={() => setViewMode("board")}
              style={{
                padding: "5px 12px",
                fontSize: 12,
                border: "none",
                cursor: "pointer",
                background:
                  viewMode === "board" ? "var(--accent)" : "transparent",
                color: viewMode === "board" ? "#fff" : "var(--fg-3)",
                fontWeight: viewMode === "board" ? 600 : 400,
              }}
            >
              Board
            </button>
            <button
              type="button"
              onClick={() => setViewMode("list")}
              style={{
                padding: "5px 12px",
                fontSize: 12,
                border: "none",
                cursor: "pointer",
                background:
                  viewMode === "list" ? "var(--accent)" : "transparent",
                color: viewMode === "list" ? "#fff" : "var(--fg-3)",
                fontWeight: viewMode === "list" ? 600 : 400,
              }}
            >
              List
            </button>
          </div>
          <button
            className="d3-btn d3-btn--primary"
            type="button"
            onClick={() => setShowForm(!showForm)}
          >
            + New Task
          </button>
        </div>
      }
    >
      <div style={{ padding: "0 24px 24px" }}>
        {/* New task form */}
        {showForm && (
          <NewTaskForm
            projects={projects}
            members={members}
            statuses={statuses}
            statusLabels={statusLabels}
            priorities={priorities}
            defaultProjectId={defaultProjectId}
            onCancel={() => setShowForm(false)}
            onCreated={() => {
              setShowForm(false);
              invalidateTasks();
            }}
          />
        )}

        {/* Project filter (both views) */}
        <div
          style={{
            display: "flex",
            gap: 8,
            marginBottom: 16,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <select
            value={projectFilter}
            onChange={(e) => setFilter("project_id", e.target.value)}
            style={{
              fontSize: 13,
              padding: "4px 8px",
              background: "var(--bg-2)",
              border: "1px solid var(--line-2)",
              color: "var(--fg-1)",
              borderRadius: 6,
            }}
          >
            <option value="">All Projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          {/* List-only filters */}
          {viewMode === "list" && (
            <>
              <select
                value={statusFilter}
                onChange={(e) => setFilter("status", e.target.value)}
                style={{
                  fontSize: 13,
                  padding: "4px 8px",
                  background: "var(--bg-2)",
                  border: "1px solid var(--line-2)",
                  color: "var(--fg-1)",
                  borderRadius: 6,
                }}
              >
                <option value="">All Statuses</option>
                {statuses.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <select
                value={sortFilter}
                onChange={(e) => setFilter("sort", e.target.value)}
                style={{
                  fontSize: 13,
                  padding: "4px 8px",
                  background: "var(--bg-2)",
                  border: "1px solid var(--line-2)",
                  color: "var(--fg-1)",
                  borderRadius: 6,
                }}
              >
                <option value="">Sort: Newest</option>
                <option value="created_at_asc">Sort: Oldest</option>
                <option value="priority">Sort: Priority</option>
                <option value="project">Sort: Project</option>
              </select>
            </>
          )}
        </div>

        {/* ── BOARD VIEW ── */}
        {viewMode === "board" && (
          <div className="wb-board">
            {boardColumns.map((col) => (
              <BoardCol
                key={col.id}
                col={col}
                taskItems={tasksByColumn.get(col.id) ?? []}
                vocab={vocab}
                targetStatuses={targetStatuses}
                onNavigate={(path) => void navigate(path)}
                onMoveTask={(id, status) => void handleMoveTask(id, status)}
              />
            ))}
          </div>
        )}

        {/* ── LIST VIEW ── */}
        {viewMode === "list" && (
          <>
            {tasks.length === 0 ? (
              <div
                style={{
                  color: "var(--fg-3)",
                  fontSize: 13,
                  padding: "32px 0",
                  textAlign: "center",
                }}
              >
                No tasks
                {statusFilter ? ` with status "${statusFilter}"` : ""}
                {projectFilter ? " in selected project" : ""}.
              </div>
            ) : tasks.length >= VIRTUAL_THRESHOLD ? (
              <VirtualTaskList tasks={tasks} cb={rowCallbacks} />
            ) : groups ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                }}
              >
                {groups.map((g) => {
                  const isCollapsed = collapsed[g.id] ?? false;
                  return (
                    <div
                      key={g.id}
                      className="d3-card"
                      style={{ padding: 0, overflow: "hidden" }}
                    >
                      <button
                        type="button"
                        onClick={() =>
                          setCollapsed((prev) => ({
                            ...prev,
                            [g.id]: !isCollapsed,
                          }))
                        }
                        style={{
                          width: "100%",
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "10px 14px",
                          background: "var(--bg-2)",
                          border: "none",
                          borderBottom: isCollapsed
                            ? "none"
                            : "1px solid var(--line-2)",
                          color: "var(--fg-1)",
                          cursor: "pointer",
                          textAlign: "left",
                          fontSize: 13,
                          fontWeight: 600,
                        }}
                      >
                        <span style={{ width: 12, color: "var(--fg-3)" }}>
                          {isCollapsed ? "▸" : "▾"}
                        </span>
                        <span>{g.name}</span>
                        <span
                          style={{
                            fontSize: 11,
                            padding: "2px 7px",
                            borderRadius: 3,
                            background: "var(--bg-3)",
                            color: "var(--fg-3)",
                            fontWeight: 500,
                          }}
                        >
                          {g.rows.length}
                        </span>
                      </button>
                      {!isCollapsed && renderTable(g.rows)}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div
                className="d3-card"
                style={{ padding: 0, overflow: "hidden" }}
              >
                {renderTable(tasks)}
              </div>
            )}
          </>
        )}
      </div>
    </Shell>
  );
}
