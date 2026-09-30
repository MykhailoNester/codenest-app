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
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  useTasks,
  useProjects,
  useTeamMembers,
  useLookups,
  useTaxonomy,
  useAgentRuns,
  changeTaskStatus,
  type AgentRun,
  type Task,
  type Taxonomy,
  type WorkflowVocabEntry,
} from "../lib/api";
import { DeckShell } from "../components/deck/deck-shell";
import { DeckTaskGroup } from "../components/deck/deck-task-group";
import { DeckFilters } from "../components/deck/deck-filters";
import { taskState } from "../components/deck/deck-cols";
import type { DeckState } from "../components/deck/deck-grid";

type DeckStateOrUndefined = DeckState | undefined;
import { ComposerModal } from "../components/taskboard/composer-modal";
import type {
  ChipOption,
} from "../components/taskboard/types";

// ─── Constants ────────────────────────────────────────────────────────────────


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

const SORT_OPTIONS: readonly ChipOption[] = [
  { value: "", label: "Newest" },
  { value: "created_at_asc", label: "Oldest" },
  { value: "priority", label: "Priority" },
  { value: "project", label: "Project" },
];

// Module-level sentinels to avoid fresh-reference cascade.
const NO_STATUSES: string[] = [];
const NO_VOCAB: WorkflowVocabEntry[] = [];
const NO_TAXONOMY: Taxonomy[] = [];
const NO_RUNS: AgentRun[] = [];

// ─── List-view sub-components (unchanged — only the toolbar above them is
//     reskinned; the row markup, virtualization and grouping stay as-is) ──────







// ─── Main page ────────────────────────────────────────────────────────────────

export function TasksPage(): ReactElement {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  // View mode persisted in URL so refresh keeps the user's choice
  const [groupBy, setGroupBy] = useState<"status" | "project">("status");

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
  if (statusFilter) taskFilters.status = statusFilter;
  if (sortFilter) taskFilters.sort = sortFilter;

  const { data: tasks = [] } = useTasks(taskFilters);
  const { data: projects = [] } = useProjects();
  const { data: members = [] } = useTeamMembers();
  const { data: lookups } = useLookups();
  const { data: labelTaxonomy = NO_TAXONOMY } = useTaxonomy("task_label");
  const { data: liveRuns = NO_RUNS } = useAgentRuns(null, "running");

  const statuses = lookups?.statuses ?? NO_STATUSES;
  const taskStatusVocab = lookups?.workflow_task_statuses ?? NO_VOCAB;
  const priorityVocab = lookups?.workflow_task_priorities ?? NO_VOCAB;

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
      setShowComposer(true);
      const next = new URLSearchParams(searchParams);
      next.delete("new");
      setSearchParams(next, { replace: true });
    });
  }, [searchParams, setSearchParams]);

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






  // Stable wrappers so TaskCard's memo() actually short-circuits — every
  // callback below keeps referential identity across renders as long as its
  // dependency (an already-useCallback'd handler) does too.
  const onCardStatus = useCallback(
    (id: number, status: string) => void handleStatus(id, status),
    [handleStatus],
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

  // ── Deck grouping ────────────────────────────────────────────────────────
  // One list, grouped. Replaces the kanban: at two hundred tasks a column you
  // scroll is worse than a group you can collapse, and status stays one click
  // away on each line rather than a drag.

  const deckGroups = useMemo(() => {
    if (groupBy === "project") {
      const byProject = new Map<number, { name: string; rows: Task[] }>();
      for (const t of visibleTasks) {
        const entry = byProject.get(t.project_id);
        if (entry) entry.rows.push(t);
        else
          byProject.set(t.project_id, {
            name: t.project_name ?? UNASSIGNED_NAME,
            rows: [t],
          });
      }
      return [...byProject.entries()]
        .map(([id, g]) => ({
          id: String(id),
          label: g.name,
          rows: g.rows,
          state: undefined as DeckStateOrUndefined,
        }))
        .sort((a, b) => {
          if (a.label === UNASSIGNED_NAME) return 1;
          if (b.label === UNASSIGNED_NAME) return -1;
          return a.label.localeCompare(b.label);
        });
    }

    // Status order comes from the taxonomy, so adding a status adds a group.
    // A task whose status is not in the taxonomy — one deactivated while tasks
    // still carry it — falls into the first group rather than disappearing,
    // which is what the board it replaces did.
    const known = new Set(taskStatusList.map((e) => e.slug));
    const firstSlug = taskStatusList[0]?.slug;
    return taskStatusList.map((e) => ({
      id: e.slug,
      label: e.label.toLowerCase(),
      rows: visibleTasks.filter(
        (t) => t.status === e.slug || (e.slug === firstSlug && !known.has(t.status)),
      ),
      state: taskState(e.slug) as DeckStateOrUndefined,
    }));
  }, [groupBy, visibleTasks, taskStatusList]);


  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <DeckShell
      title="work"
      crumb={`${visibleTasks.length} shown${filtersActive ? " · filtered" : ""}`}
      actions={
        <>
          <div className="dk-seg" role="group" aria-label="Group by">
            <button
              type="button"
              className={groupBy === "status" ? "on" : undefined}
              onClick={() => setGroupBy("status")}
            >
              status
            </button>
            <button
              type="button"
              className={groupBy === "project" ? "on" : undefined}
              onClick={() => setGroupBy("project")}
            >
              project
            </button>
          </div>
          <button
            type="button"
            className="dk-btn pri"
            title="New task (N)"
            onClick={() => setShowComposer(true)}
          >
            + task
          </button>
        </>
      }
    >
      <div className="dk-bigs" style={{ alignItems: "flex-end" }}>
        <DeckFilters
          values={{
            project_id: projectFilter,
            priority: priorityFilter,
            assignee_id: assigneeFilter,
            label: labelFilter,
            status: statusFilter,
          }}
          options={{
            project_id: projectFilterOptions,
            priority: priorityFilterOptions,
            assignee_id: assigneeFilterOptions,
            label: labelFilterOptions,
            status: statusFilterOptions,
          }}
          sort={{ value: sortFilter, options: SORT_OPTIONS }}
          onSet={setFilter}
          onSetSort={(v) => setFilter("sort", v)}
          onClearAll={handleClearAll}
        />
      </div>

      {visibleTasks.length === 0 ? (
        <div className="dk-note sans">
          No tasks match the current filters.
          {filtersActive && (
            <>
              {" "}
              <button type="button" className="dk-btn bare" onClick={handleClearAll}>
                clear filters
              </button>
            </>
          )}
        </div>
      ) : (
        deckGroups.map((g) => (
          <DeckTaskGroup
            key={g.id}
            label={g.label}
            state={g.state}
            rows={g.rows}
            statuses={statuses}
            statusLabels={statusLabels}
            priorityLabels={priorityLabels}
            liveTaskIds={liveTaskIds}
            onOpen={(id) => void navigate(`/tasks/${id}`)}
            onProject={(pid) => setFilter("project_id", String(pid))}
            onStatus={(id, s) => onCardStatus(id, s)}
          />
        ))
      )}


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
    </DeckShell>
  );
}
