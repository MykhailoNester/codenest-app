/**
 * Work Board — a kanban + list view over `tasks`.
 *
 * One board column per active `task_status` taxonomy row (Settings →
 * Workflow Labels), in taxonomy sort order, using its label + colour.
 * Status moves go through `POST /api/v1/tasks/{id}/status`. Labels come from
 * the `task_label` taxonomy + `task_label_assignments` join table and are
 * toggled per-pair (`POST`/`DELETE /api/v1/tasks/{id}/labels[/…]`). WIP
 * limits are the `board_wip_limits` app-setting, read from `useLookups()`
 * and written through `PUT /api/v1/settings/board_wip_limits`. The live
 * dot on a card is driven by `agent_runs` rows with `source_kind: "task"`
 * and `status: "running"` — not `agent_sessions.task_id`, which nothing
 * ever writes.
 *
 * TODO: the Inbox's triage → task promote flow
 * (`components/inbox-promote-modal.tsx`, mounted at `pages/inbox.tsx`) reads
 * `workflow_items` and writes `tasks` on promotion. When `workflow_items` is
 * folded into `tasks`, this file needs no change — it already reads only
 * `tasks`.
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import {
  useTasks,
  useProjects,
  useTeamMembers,
  useLookups,
  useTaxonomy,
  useAgentRuns,
  changeTaskStatus,
  updateTask,
  setBoardWipLimit,
  addTaskLabel,
  removeTaskLabel,
  type AgentRun,
  type LookupsOut,
  type Task,
  type Taxonomy,
  type WorkflowVocabEntry,
} from "../lib/api";
import { Shell } from "../components/layout/shell";
import { LaunchFromSourceButton } from "../components/launch/launch-from-source-button";
import { BoardColumn } from "../components/taskboard/board-column";
import { ComposerModal } from "../components/taskboard/composer-modal";
import { FilterBar } from "../components/taskboard/filter-bar";
import {
  ViewToggle,
  type ViewMode,
} from "../components/taskboard/view-toggle";
import type {
  BoardColumnDef,
  ChipOption,
  TaskBoardVocab,
} from "../components/taskboard/types";

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

// Seed fallback used only until the priority taxonomy lookups resolve, so
// the picker options and the "never blank" default aren't momentarily empty.
const FALLBACK_PRIORITY_VOCAB: ReadonlyArray<WorkflowVocabEntry> = [
  { slug: "high", label: "High", color: null, sort_order: 10 },
  { slug: "medium", label: "Medium", color: null, sort_order: 20 },
  { slug: "low", label: "Low", color: null, sort_order: 30 },
];

// Seed fallback used only until the taxonomy lookups resolve, so the board
// isn't momentarily empty on first paint.
const FALLBACK_TASK_STATUSES: ReadonlyArray<WorkflowVocabEntry> = [
  { slug: "backlog", label: "Idea", color: "#6b7280", sort_order: 10 },
  { slug: "todo", label: "To do", color: "#60a5fa", sort_order: 20 },
  { slug: "in-progress", label: "In progress", color: "#f59e0b", sort_order: 30 },
  { slug: "blocked", label: "Blocked", color: "#ef4444", sort_order: 40 },
  { slug: "done", label: "Done", color: "#22c55e", sort_order: 50 },
];

// D5 — shown under every Agents-group option in the card's assignee picker.
// Kept in sync by hand with the identical string in composer-modal.tsx
// (not shared via an export: see the note at that file's private
// buildAssigneeOptions for why).
const AGENT_HINT =
  "Assigning does not start a session. The agent's saved provider and model become the defaults when you launch this task with ▶.";

const SORT_OPTIONS: readonly ChipOption[] = [
  { value: "", label: "Newest" },
  { value: "created_at_asc", label: "Oldest" },
  { value: "priority", label: "Priority" },
  { value: "project", label: "Project" },
];

// Module-level sentinels to avoid fresh-reference cascade.
const NO_STATUSES: string[] = [];
const NO_STATUS_COLORS: Record<string, string> = {};
const NO_VOCAB: WorkflowVocabEntry[] = [];
const NO_TAXONOMY: Taxonomy[] = [];
const NO_WIP: Record<string, number> = {};
const NO_RUNS: AgentRun[] = [];

// ─── List-view sub-components (unchanged — only the toolbar above them is
//     reskinned; the row markup, virtualization and grouping stay as-is) ──────

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

// ─── Main page ────────────────────────────────────────────────────────────────

export function TasksPage(): ReactElement {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  // View mode persisted in URL so refresh keeps the user's choice
  const viewParam = searchParams.get("view");
  const viewMode: ViewMode = viewParam === "list" ? "list" : "board";

  const projectFilter = searchParams.get("project_id") ?? "";
  const priorityFilter = searchParams.get("priority") ?? "";
  const assigneeFilter = searchParams.get("assignee_id") ?? "";
  const labelFilter = searchParams.get("label") ?? "";
  const statusFilter = searchParams.get("status") ?? "";
  const sortFilter = searchParams.get("sort") ?? "";

  // ── Data fetching ────────────────────────────────────────────────────────

  // Tasks — server-side filters that exist on every mode; board always shows
  // every status (the columns are the status axis), so `status`/`sort` are
  // only honoured in list mode.
  const taskFilters: Record<string, string> = {};
  if (projectFilter) taskFilters.project_id = projectFilter;
  if (priorityFilter) taskFilters.priority = priorityFilter;
  if (assigneeFilter) taskFilters.assignee_id = assigneeFilter;
  if (viewMode === "list" && statusFilter) taskFilters.status = statusFilter;
  if (viewMode === "list" && sortFilter) taskFilters.sort = sortFilter;

  const { data: tasks = [] } = useTasks(taskFilters);
  const { data: projects = [] } = useProjects();
  const { data: members = [] } = useTeamMembers();
  const { data: lookups } = useLookups();
  const { data: labelTaxonomy = NO_TAXONOMY } = useTaxonomy("task_label");
  const { data: liveRuns = NO_RUNS } = useAgentRuns(null, "running");

  const statuses = lookups?.statuses ?? NO_STATUSES;
  const statusColors = lookups?.status_colors ?? NO_STATUS_COLORS;
  const taskStatusVocab = lookups?.workflow_task_statuses ?? NO_VOCAB;
  const priorityVocab = lookups?.workflow_task_priorities ?? NO_VOCAB;
  const wipLimits = lookups?.board_wip_limits ?? NO_WIP;

  // `label` is a taxonomies.id and is applied client-side — there is no
  // server-side label filter (see the Composer/filter-bar plan's D9/§Edge
  // cases: `TaskFilters` intentionally has no `label` key).
  const visibleTasks = useMemo(() => {
    if (!labelFilter) return tasks;
    const labelId = Number(labelFilter);
    return tasks.filter((t) => (t.labels ?? []).some((l) => l.id === labelId));
  }, [tasks, labelFilter]);

  // D4 — the live dot comes from agent_runs (real, already-populated data),
  // not the dead agent_sessions.task_id column. `flatMap`, not
  // `filter(...).map(...)`: a property-narrowing filter predicate does not
  // narrow under --strict, so the filter form types as Set<number | null>.
  const liveTaskIds = useMemo<ReadonlySet<number>>(
    () =>
      new Set(
        liveRuns.flatMap((r) =>
          r.source_kind === "task" && r.source_id != null ? [r.source_id] : [],
        ),
      ),
    [liveRuns],
  );

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

  // D3 — priority rank/count for the card glyph. Deliberately NOT
  // fallback-merged: `priorityCount` reads 0 until lookups resolve, so every
  // glyph renders "▬" (never a crash) rather than guessing at a rank.
  const priorityRank = useMemo(() => {
    const m: Record<string, number> = {};
    priorityVocab.forEach((e, i) => {
      m[e.slug] = i;
    });
    return m;
  }, [priorityVocab]);

  const boardVocab = useMemo<TaskBoardVocab>(
    () => ({
      priorityColors,
      priorityLabels,
      statusLabels,
      priorityRank,
      priorityCount: priorityVocab.length,
    }),
    [
      priorityColors,
      priorityLabels,
      statusLabels,
      priorityRank,
      priorityVocab.length,
    ],
  );

  // Fallback-merged lists for pickers, so options (and the Composer's
  // defaults) are never empty before lookups resolve.
  const priorityVocabOrFallback = priorityVocab.length
    ? priorityVocab
    : FALLBACK_PRIORITY_VOCAB;
  const taskStatusList = taskStatusVocab.length
    ? taskStatusVocab
    : FALLBACK_TASK_STATUSES;

  // Board columns: one per active task status, ordered/labelled/coloured by
  // the Workflow Labels taxonomy. Adding a status adds a column; removing it
  // drops one.
  const boardColumns = useMemo<BoardColumnDef[]>(
    () =>
      taskStatusList.map((e) => ({
        id: e.slug,
        label: e.label,
        color: e.color ?? "#6366f1",
      })),
    [taskStatusList],
  );

  const tasksByColumn = useMemo<Map<string, Task[]>>(() => {
    const map = new Map<string, Task[]>();
    for (const col of boardColumns) map.set(col.id, []);
    const fallbackId = boardColumns[0]?.id;
    for (const t of visibleTasks) {
      // Each column id is a status slug; an orphan status (e.g. one that was
      // deactivated while tasks still carry it) falls into the first column.
      const colId = map.has(t.status) ? t.status : fallbackId;
      if (colId) map.get(colId)?.push(t);
    }
    return map;
  }, [visibleTasks, boardColumns]);

  // ── Chip-picker option arrays (cards + Composer) ────────────────────────

  const statusOptions = useMemo<ChipOption[]>(
    () =>
      taskStatusList.map((e) => ({
        value: e.slug,
        label: e.label,
        color: e.color,
      })),
    [taskStatusList],
  );

  const priorityOptions = useMemo<ChipOption[]>(
    () =>
      priorityVocabOrFallback.map((e) => ({
        value: e.slug,
        label: e.label,
        color: priorityColors[e.slug] ?? e.color,
      })),
    [priorityVocabOrFallback, priorityColors],
  );

  // Grouped Humans/Agents, alphabetical within each group, "— Unassigned"
  // first. Mirrors ComposerModal's own (module-private) construction —
  // ComposerModal takes raw `members` and builds its own options (D9/D10
  // in the plan already treat these as two separate constructions, not one
  // shared helper), while the card takes this pre-built array.
  const assigneeOptions = useMemo<ChipOption[]>(() => {
    const humans = members
      .filter((m) => m.type === "human")
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((m): ChipOption => ({ value: String(m.id), label: m.name, group: "Humans" }));
    const agents = members
      .filter((m) => m.type === "agent")
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(
        (m): ChipOption => ({
          value: String(m.id),
          label: m.name,
          group: "Agents",
          hint: AGENT_HINT,
        }),
      );
    return [{ value: "", label: "— Unassigned" }, ...humans, ...agents];
  }, [members]);

  const labelOptions = useMemo(
    () => labelTaxonomy.map((t) => ({ id: t.id, label: t.display_name, color: t.color })),
    [labelTaxonomy],
  );

  // ── Filter-bar option arrays — separate from the card/Composer arrays
  //    above: a filter's "" row means "stop filtering" ("Any …"), never
  //    "— Unassigned", which on a card means "write assignee_id: null". No
  //    agent hint is carried here either. ─────────────────────────────────

  const projectFilterOptions = useMemo<ChipOption[]>(
    () => [
      { value: "", label: "Any project" },
      ...projects.map((p) => ({ value: String(p.id), label: p.name })),
    ],
    [projects],
  );

  const priorityFilterOptions = useMemo<ChipOption[]>(
    () => [
      { value: "", label: "Any priority" },
      ...priorityVocabOrFallback.map((e) => ({
        value: e.slug,
        label: e.label,
        color: priorityColors[e.slug] ?? e.color,
      })),
    ],
    [priorityVocabOrFallback, priorityColors],
  );

  const assigneeFilterOptions = useMemo<ChipOption[]>(
    () => [
      { value: "", label: "Any assignee" },
      ...members
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((m) => ({ value: String(m.id), label: m.name })),
    ],
    [members],
  );

  const labelFilterOptions = useMemo<ChipOption[]>(
    () => [
      { value: "", label: "Any label" },
      ...labelTaxonomy.map((t) => ({
        value: String(t.id),
        label: t.display_name,
        color: t.color,
      })),
    ],
    [labelTaxonomy],
  );

  const statusFilterOptions = useMemo<ChipOption[]>(
    () => [
      { value: "", label: "Any status" },
      ...taskStatusList.map((e) => ({
        value: e.slug,
        label: e.label,
        color: e.color,
      })),
    ],
    [taskStatusList],
  );

  // Never blank: "medium"/"todo" when the active vocabulary has them,
  // otherwise the first active slug — preserves the pre-Composer NewTaskForm
  // seed without hardcoding a slug that a custom taxonomy might not have.
  const defaultPriority = useMemo(() => {
    if (priorityVocabOrFallback.some((e) => e.slug === "medium")) return "medium";
    return priorityVocabOrFallback[0]?.slug ?? "";
  }, [priorityVocabOrFallback]);

  const defaultStatus = useMemo(() => {
    if (taskStatusList.some((e) => e.slug === "todo")) return "todo";
    return taskStatusList[0]?.slug ?? "";
  }, [taskStatusList]);

  // ── UI state ─────────────────────────────────────────────────────────────

  const [showComposer, setShowComposer] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});

  // ── Callbacks ────────────────────────────────────────────────────────────

  const invalidateTasks = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["tasks"] });
    void qc.invalidateQueries({ queryKey: ["dashboard"] });
  }, [qc]);

  const handleStatus = useCallback(
    async (id: number, status: string) => {
      try {
        await changeTaskStatus(id, status);
        invalidateTasks();
      } catch (err) {
        toast.error(`Failed to change status: ${(err as Error).message}`);
      }
    },
    [invalidateTasks],
  );

  const handlePriority = useCallback(
    async (id: number, priority: string) => {
      try {
        await updateTask(id, { priority });
        invalidateTasks();
      } catch (err) {
        toast.error(`Failed to change priority: ${(err as Error).message}`);
      }
    },
    [invalidateTasks],
  );

  const handleAssignee = useCallback(
    async (id: number, assigneeId: number | null) => {
      try {
        await updateTask(id, { assignee_id: assigneeId });
        invalidateTasks();
      } catch (err) {
        toast.error(`Failed to change assignee: ${(err as Error).message}`);
      }
    },
    [invalidateTasks],
  );

  const handleToggleLabel = useCallback(
    async (id: number, labelId: number, next: boolean) => {
      try {
        if (next) await addTaskLabel(id, labelId);
        else await removeTaskLabel(id, labelId);
        invalidateTasks();
      } catch (err) {
        toast.error(`Failed to update labels: ${(err as Error).message}`);
      }
    },
    [invalidateTasks],
  );

  const wipLimitWriteQueueRef = useRef<Promise<void>>(Promise.resolve());

  const handleSetWipLimit = useCallback(
    (statusSlug: string, limit: number | null) => {
      wipLimitWriteQueueRef.current = wipLimitWriteQueueRef.current.then(
        async () => {
          try {
            const current =
              qc.getQueryData<LookupsOut>(["lookups"])?.board_wip_limits ??
              NO_WIP;
            await setBoardWipLimit(current, statusSlug, limit);
            await qc.invalidateQueries({ queryKey: ["lookups"] });
          } catch (err) {
            toast.error(
              `Failed to update WIP limit: ${(err as Error).message}`,
            );
          }
        },
      );
    },
    [qc],
  );

  // Stable wrappers so TaskCard's memo() actually short-circuits — every
  // callback below keeps referential identity across renders as long as its
  // dependency (an already-useCallback'd handler) does too.
  const onCardNavigate = useCallback(
    (path: string) => void navigate(path),
    [navigate],
  );
  const onCardStatus = useCallback(
    (id: number, status: string) => void handleStatus(id, status),
    [handleStatus],
  );
  const onCardPriority = useCallback(
    (id: number, priority: string) => void handlePriority(id, priority),
    [handlePriority],
  );
  const onCardAssignee = useCallback(
    (id: number, assigneeId: number | null) =>
      void handleAssignee(id, assigneeId),
    [handleAssignee],
  );
  const onCardToggleLabel = useCallback(
    (id: number, labelId: number, next: boolean) =>
      void handleToggleLabel(id, labelId, next),
    [handleToggleLabel],
  );

  // ── Filter helpers ───────────────────────────────────────────────────────

  const setFilter = useCallback(
    (key: string, value: string) => {
      const p = new URLSearchParams(searchParams);
      if (value) p.set(key, value);
      else p.delete(key);
      setSearchParams(p);
    },
    [searchParams, setSearchParams],
  );

  const handleClearAll = useCallback(() => {
    const p = new URLSearchParams(searchParams);
    for (const key of ["project_id", "priority", "assignee_id", "label", "status"]) {
      p.delete(key);
    }
    setSearchParams(p);
  }, [searchParams, setSearchParams]);

  const setViewMode = useCallback(
    (mode: ViewMode) => {
      const p = new URLSearchParams(searchParams);
      if (mode === "board") p.delete("view");
      else p.set("view", mode);
      setSearchParams(p);
    },
    [searchParams, setSearchParams],
  );

  const filtersActive = Boolean(
    projectFilter || priorityFilter || assigneeFilter || labelFilter,
  );

  // ── Default project id for the Composer ──────────────────────────────────

  const defaultProjectId = useMemo(() => {
    if (projectFilter) return projectFilter;
    if (projects.length === 0) return "";
    const preferred =
      projects.find((p) => p.name !== UNASSIGNED_NAME) ?? projects[0];
    return preferred ? String(preferred.id) : "";
  }, [projects, projectFilter]);

  // ── Keyboard shortcut: N opens the Composer ──────────────────────────────

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (showComposer) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "n" && e.key !== "N") return;
      if (e.target instanceof HTMLElement) {
        const editable = e.target.closest(
          "input, textarea, select, [contenteditable=''], [contenteditable='true']",
        );
        if (editable) return;
      }
      e.preventDefault();
      setShowComposer(true);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showComposer]);

  // ── Stable callbacks for memoised list-view rows ─────────────────────────

  const navigateRef = useRef(navigate);
  const setFilterRef = useRef(setFilter);
  const handleStatusRef = useRef(handleStatus);
  useEffect(() => {
    navigateRef.current = navigate;
    setFilterRef.current = setFilter;
    handleStatusRef.current = handleStatus;
  });
  const rowCallbacks = useMemo<TaskRowCallbacks>(
    () => ({
      navigate: (path: string) => void navigateRef.current(path),
      setProjectFilter: (id: string) => setFilterRef.current("project_id", id),
      changeStatus: (id: number, status: string) =>
        void handleStatusRef.current(id, status),
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
    for (const t of visibleTasks) {
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
  }, [visibleTasks, projectFilter, viewMode]);

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
          <ViewToggle mode={viewMode} onChange={setViewMode} />
          <button
            className="d3-btn d3-btn--primary"
            type="button"
            title="New task (N)"
            onClick={() => setShowComposer(true)}
          >
            + New Task
          </button>
        </div>
      }
    >
      <div style={{ padding: "0 24px 24px" }}>
        <div className="tb-toolbar">
          <FilterBar
            values={{
              project_id: projectFilter,
              priority: priorityFilter,
              assignee_id: assigneeFilter,
              label: labelFilter,
              status: statusFilter,
            }}
            projectOptions={projectFilterOptions}
            priorityOptions={priorityFilterOptions}
            assigneeOptions={assigneeFilterOptions}
            labelOptions={labelFilterOptions}
            statusOptions={
              viewMode === "list" ? statusFilterOptions : undefined
            }
            sort={
              viewMode === "list"
                ? { value: sortFilter, options: SORT_OPTIONS }
                : undefined
            }
            onSet={setFilter}
            onSetSort={
              viewMode === "list" ? (v) => setFilter("sort", v) : undefined
            }
            onClearAll={handleClearAll}
          />
        </div>

        {/* ── BOARD VIEW ── */}
        {viewMode === "board" && (
          <div className="tb-board">
            {boardColumns.map((col) => (
              <BoardColumn
                key={col.id}
                col={col}
                tasks={tasksByColumn.get(col.id) ?? []}
                wipLimit={wipLimits[col.id] ?? null}
                filtersActive={filtersActive}
                onSetWipLimit={(slug, limit) =>
                  void handleSetWipLimit(slug, limit)
                }
                liveTaskIds={liveTaskIds}
                card={{
                  vocab: boardVocab,
                  statusOptions,
                  priorityOptions,
                  assigneeOptions,
                  labelOptions,
                  onNavigate: onCardNavigate,
                  onStatus: onCardStatus,
                  onPriority: onCardPriority,
                  onAssignee: onCardAssignee,
                  onToggleLabel: onCardToggleLabel,
                }}
              />
            ))}
          </div>
        )}

        {/* ── LIST VIEW ── */}
        {viewMode === "list" && (
          <>
            {visibleTasks.length === 0 ? (
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
            ) : visibleTasks.length >= VIRTUAL_THRESHOLD ? (
              <VirtualTaskList tasks={visibleTasks} cb={rowCallbacks} />
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
                {renderTable(visibleTasks)}
              </div>
            )}
          </>
        )}
      </div>

      {showComposer && (
        <ComposerModal
          projects={projects}
          members={members}
          statusOptions={statusOptions}
          priorityOptions={priorityOptions}
          labelOptions={labelOptions}
          defaultProjectId={defaultProjectId}
          defaultStatus={defaultStatus}
          defaultPriority={defaultPriority}
          onClose={() => setShowComposer(false)}
          onCreated={invalidateTasks}
        />
      )}
    </Shell>
  );
}
