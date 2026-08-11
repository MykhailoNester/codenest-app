import { useMemo, useState, type ReactElement } from "react";
import type {
  Project,
  Task,
  Taxonomy,
  TeamMember,
  WorkflowVocabEntry,
} from "../../lib/api";
import { hashHue, initialsOf } from "./avatar";
import { TdPopover } from "./td-popover";

/**
 * The `.td-card td-card--props` sidebar card: one `.td-prop` row per
 * status / priority / assignee / effort / project / labels, each opening a
 * `TdPopover`. Every callback here is `void`-returning — the page owns the
 * async write, the toast on failure and the "Saved" indicator (D7/D10 in
 * the plan); this component only decides *what* to write and *when* to
 * close its own popover.
 *
 * D12 — `hashHue`/`initialsOf` (`./avatar.ts`) are duplicated relative to
 * the rest of the app, not extracted into it: per-file initials helpers are
 * already the house pattern (`task-card.tsx`, `active-sessions.tsx`,
 * `session-card.tsx`); hoisting all of those into a shared `lib/avatar.ts`
 * is listed as a follow-up, not done here. `./avatar.ts` only dedupes
 * between this ticket's own two call sites (here and `task-detail.tsx`'s
 * quickmeta row) — a plain function can't share a module with the
 * `PropertiesCard` component export without breaking
 * `react-refresh/only-export-components`.
 */

// D4 — exactly the three CHECK-allowed efforts plus "clear". Never any other
// string: `tasks.effort`'s CHECK(effort IN ('small','medium','large')) would
// reject a fourth value and the PUT would fail.
const EFFORT_CELLS: ReadonlyArray<{
  value: "small" | "medium" | "large" | null;
  glyph: string;
  label: string;
}> = [
  { value: null, glyph: "—", label: "None" },
  { value: "small", glyph: "S", label: "Small" },
  { value: "medium", glyph: "M", label: "Medium" },
  { value: "large", glyph: "L", label: "Large" },
];

const EFFORT_LABELS: Record<string, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
};

const AVATAR_PX = 20;
const AVATAR_FONT_PX = 9;

// The four ascending bar heights `.td-prio span` draws, per the design.
const PRIORITY_BAR_HEIGHTS = [5, 7, 9, 11] as const;

/**
 * Number of the four priority bars to fill, derived from the slug's rank in
 * the active ordered vocabulary — never a hardcoded slug list, because
 * priorities are user-editable (mirrors `task-card.tsx`'s `priorityGlyph`).
 * `count === 0` (lookups unresolved) always renders zero filled bars.
 */
function priorityFilledCount(rank: number, count: number): number {
  if (count === 0) return 0;
  return Math.min(4, Math.max(1, count - rank));
}

export interface PropertiesCardProps {
  task: Task;
  members: readonly TeamMember[];
  projects: readonly Project[];
  /** Already fallback-merged with `lookups.status_colors` by the page. */
  statusVocab: readonly WorkflowVocabEntry[];
  priorityVocab: readonly WorkflowVocabEntry[];
  labelTaxonomy: readonly Taxonomy[];
  onStatus: (slug: string) => void;
  onPriority: (slug: string) => void;
  onAssignee: (memberId: number | null) => void;
  onEffort: (effort: "small" | "medium" | "large" | null) => void;
  onProject: (projectId: number) => void;
  onToggleLabel: (labelId: number, next: boolean) => void;
}

type PropKey =
  "status" | "priority" | "assignee" | "effort" | "project" | "labels";

export function PropertiesCard({
  task,
  members,
  projects,
  statusVocab,
  priorityVocab,
  labelTaxonomy,
  onStatus,
  onPriority,
  onAssignee,
  onEffort,
  onProject,
  onToggleLabel,
}: PropertiesCardProps): ReactElement {
  // At most one popover open at a time.
  const [openKey, setOpenKey] = useState<PropKey | null>(null);
  const openPopover = (key: PropKey) => (next: boolean) =>
    setOpenKey(next ? key : null);

  const sortedMembers = useMemo(() => {
    const byName = (a: TeamMember, b: TeamMember) =>
      a.name.localeCompare(b.name);
    const humans = members
      .filter((m) => m.type === "human")
      .slice()
      .sort(byName);
    const agents = members
      .filter((m) => m.type === "agent")
      .slice()
      .sort(byName);
    return [...humans, ...agents];
  }, [members]);

  const activeProjects = useMemo(
    () => projects.filter((p) => p.is_active === 1),
    [projects],
  );

  const taskLabels = task.labels ?? [];

  const statusEntry = statusVocab.find((e) => e.slug === task.status);
  const statusLabel = statusEntry?.label ?? task.status;
  const statusColor = statusEntry?.color ?? "var(--fg-4)";

  const priorityRank = priorityVocab.findIndex((e) => e.slug === task.priority);
  const priorityEntry =
    priorityRank >= 0 ? priorityVocab[priorityRank] : undefined;
  const priorityLabel = priorityEntry?.label ?? task.priority;
  const priorityColor = priorityEntry?.color ?? "var(--fg-4)";
  const priorityFilled = priorityFilledCount(
    priorityRank,
    priorityVocab.length,
  );

  const effortLabel = task.effort
    ? (EFFORT_LABELS[task.effort] ?? task.effort)
    : "—";

  return (
    <div className="td-card td-card--props">
      {/* Status */}
      <div className="td-prop">
        <span className="td-prop__l">Status</span>
        <TdPopover
          label="Status"
          open={openKey === "status"}
          onOpenChange={openPopover("status")}
          renderTrigger={({ ref, open, onClick }) => (
            <button
              ref={ref}
              type="button"
              className={`td-val${open ? " is-open" : ""}`}
              aria-haspopup="listbox"
              aria-expanded={open}
              aria-label={`Status: ${statusLabel}`}
              onClick={onClick}
            >
              <span className="td-sw" style={{ background: statusColor }} />
              <span>{statusLabel}</span>
              <span className="td-caret" aria-hidden="true">
                ▾
              </span>
            </button>
          )}
        >
          {({ close }) => (
            <>
              <div className="td-pop__h">Status</div>
              {statusVocab.map((e) => {
                const isSel = e.slug === task.status;
                return (
                  <button
                    key={e.slug}
                    type="button"
                    role="option"
                    aria-selected={isSel}
                    className={`td-pop__i${isSel ? " is-sel" : ""}`}
                    onClick={() => {
                      onStatus(e.slug);
                      close();
                    }}
                  >
                    <span
                      className="td-sw"
                      style={{ background: e.color ?? "var(--fg-4)" }}
                    />
                    <span>{e.label}</span>
                    {isSel ? (
                      <span className="td-pop__c" aria-hidden="true">
                        ✓
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </>
          )}
        </TdPopover>
      </div>

      {/* Priority */}
      <div className="td-prop">
        <span className="td-prop__l">Priority</span>
        <TdPopover
          label="Priority"
          open={openKey === "priority"}
          onOpenChange={openPopover("priority")}
          renderTrigger={({ ref, open, onClick }) => (
            <button
              ref={ref}
              type="button"
              className={`td-val${open ? " is-open" : ""}`}
              aria-haspopup="listbox"
              aria-expanded={open}
              aria-label={`Priority: ${priorityLabel}`}
              onClick={onClick}
            >
              <span className="td-prio" aria-hidden="true">
                {PRIORITY_BAR_HEIGHTS.map((h, i) => (
                  <span
                    key={h}
                    style={{
                      height: h,
                      background:
                        i < priorityFilled ? priorityColor : "var(--line-3)",
                    }}
                  />
                ))}
              </span>
              <span>{priorityLabel}</span>
              <span className="td-caret" aria-hidden="true">
                ▾
              </span>
            </button>
          )}
        >
          {({ close }) => (
            <>
              <div className="td-pop__h">Priority</div>
              {priorityVocab.map((e) => {
                const isSel = e.slug === task.priority;
                return (
                  <button
                    key={e.slug}
                    type="button"
                    role="option"
                    aria-selected={isSel}
                    className={`td-pop__i${isSel ? " is-sel" : ""}`}
                    onClick={() => {
                      onPriority(e.slug);
                      close();
                    }}
                  >
                    <span
                      className="td-sw"
                      style={{ background: e.color ?? "var(--fg-4)" }}
                    />
                    <span>{e.label}</span>
                    {isSel ? (
                      <span className="td-pop__c" aria-hidden="true">
                        ✓
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </>
          )}
        </TdPopover>
      </div>

      {/* Assignee */}
      <div className="td-prop">
        <span className="td-prop__l">Assignee</span>
        <TdPopover
          label="Assignee"
          open={openKey === "assignee"}
          onOpenChange={openPopover("assignee")}
          renderTrigger={({ ref, open, onClick }) => (
            <button
              ref={ref}
              type="button"
              className={`td-val${open ? " is-open" : ""}`}
              aria-haspopup="listbox"
              aria-expanded={open}
              aria-label={`Assignee: ${task.assignee_name ?? "Unassigned"}`}
              onClick={onClick}
            >
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
              <span>{task.assignee_name ?? "Unassigned"}</span>
              <span className="td-caret" aria-hidden="true">
                ▾
              </span>
            </button>
          )}
        >
          {({ close }) => (
            <>
              <div className="td-pop__h">Assignee</div>
              <button
                type="button"
                role="option"
                aria-selected={task.assignee_id == null}
                className={`td-pop__i${task.assignee_id == null ? " is-sel" : ""}`}
                onClick={() => {
                  onAssignee(null);
                  close();
                }}
              >
                <span>— Unassigned</span>
                {task.assignee_id == null ? (
                  <span className="td-pop__c" aria-hidden="true">
                    ✓
                  </span>
                ) : null}
              </button>
              {sortedMembers.map((m) => {
                const isSel = task.assignee_id === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="option"
                    aria-selected={isSel}
                    className={`td-pop__i${isSel ? " is-sel" : ""}`}
                    onClick={() => {
                      onAssignee(m.id);
                      close();
                    }}
                  >
                    <span>
                      {m.name}
                      <span className="td-pop__role">{m.role}</span>
                    </span>
                    {isSel ? (
                      <span className="td-pop__c" aria-hidden="true">
                        ✓
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </>
          )}
        </TdPopover>
      </div>

      {/* Effort */}
      <div className="td-prop">
        <span className="td-prop__l">Effort</span>
        <TdPopover
          label="Effort"
          open={openKey === "effort"}
          onOpenChange={openPopover("effort")}
          renderTrigger={({ ref, open, onClick }) => (
            <button
              ref={ref}
              type="button"
              className={`td-val${open ? " is-open" : ""}`}
              aria-haspopup="listbox"
              aria-expanded={open}
              aria-label={`Effort: ${effortLabel}`}
              onClick={onClick}
            >
              <span>{effortLabel}</span>
              <span className="td-caret" aria-hidden="true">
                ▾
              </span>
            </button>
          )}
        >
          {({ close }) => (
            <>
              <div className="td-pop__h">Effort</div>
              <div className="td-eff">
                {EFFORT_CELLS.map((cell) => {
                  const isSel = task.effort === cell.value;
                  return (
                    <button
                      key={cell.value ?? "none"}
                      type="button"
                      role="option"
                      aria-selected={isSel}
                      className={`td-eff__b${isSel ? " is-sel" : ""}`}
                      onClick={() => {
                        onEffort(cell.value);
                        close();
                      }}
                    >
                      <b>{cell.glyph}</b>
                      <span>{cell.label}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </TdPopover>
      </div>

      {/* Project */}
      <div className="td-prop">
        <span className="td-prop__l">Project</span>
        <TdPopover
          label="Project"
          open={openKey === "project"}
          onOpenChange={openPopover("project")}
          renderTrigger={({ ref, open, onClick }) => (
            <button
              ref={ref}
              type="button"
              className={`td-val${open ? " is-open" : ""}`}
              aria-haspopup="listbox"
              aria-expanded={open}
              aria-label={`Project: ${task.project_name ?? "—"}`}
              onClick={onClick}
            >
              <span>{task.project_name ?? "—"}</span>
              <span className="td-caret" aria-hidden="true">
                ▾
              </span>
            </button>
          )}
        >
          {({ close }) => (
            <>
              <div className="td-pop__h">Project</div>
              {activeProjects.length === 0 ? (
                <button type="button" className="td-pop__i" disabled>
                  No projects imported yet — import one from Projects.
                </button>
              ) : (
                activeProjects.map((p) => {
                  const isSel = task.project_id === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      role="option"
                      aria-selected={isSel}
                      className={`td-pop__i${isSel ? " is-sel" : ""}`}
                      onClick={() => {
                        onProject(p.id);
                        close();
                      }}
                    >
                      <span>{p.name}</span>
                      {isSel ? (
                        <span className="td-pop__c" aria-hidden="true">
                          ✓
                        </span>
                      ) : null}
                    </button>
                  );
                })
              )}
            </>
          )}
        </TdPopover>
      </div>

      {/* Labels */}
      <div className="td-prop">
        <span className="td-prop__l">Labels</span>
        <div className="td-labels">
          {taskLabels.map((l) => (
            <span
              key={l.id}
              className="td-label"
              style={l.color ? { color: l.color } : undefined}
            >
              {l.label}
            </span>
          ))}
          <TdPopover
            label="Labels"
            open={openKey === "labels"}
            onOpenChange={openPopover("labels")}
            renderTrigger={({ ref, open, onClick }) => (
              <button
                ref={ref}
                type="button"
                className="td-label--add"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label="Add label"
                onClick={onClick}
              >
                +
              </button>
            )}
          >
            {() => (
              <>
                <div className="td-pop__h">Labels</div>
                {labelTaxonomy.length === 0 ? (
                  <button type="button" className="td-pop__i" disabled>
                    No labels — add them in Settings → Workflow Labels
                  </button>
                ) : (
                  labelTaxonomy.map((t) => {
                    const assigned = taskLabels.some((l) => l.id === t.id);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        role="option"
                        aria-selected={assigned}
                        className={`td-pop__i${assigned ? " is-sel" : ""}`}
                        onClick={() => onToggleLabel(t.id, !assigned)}
                      >
                        <span>{t.display_name}</span>
                        {assigned ? (
                          <span className="td-pop__c" aria-hidden="true">
                            ✓
                          </span>
                        ) : null}
                      </button>
                    );
                  })
                )}
              </>
            )}
          </TdPopover>
        </div>
      </div>
    </div>
  );
}
