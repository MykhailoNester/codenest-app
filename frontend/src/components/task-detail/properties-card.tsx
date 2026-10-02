import { useMemo, type ReactElement } from "react";
import type {
  Project,
  Task,
  Taxonomy,
  TeamMember,
  WorkflowVocabEntry,
} from "../../lib/api";
import { DeckGroup } from "../deck/deck-grid";

/**
 * The properties column: one `.dk-kv` row per status / priority / assignee /
 * effort / project / labels.
 *
 * #298 — every picker is a native `<select class="dk-rowsel">`, the same
 * control the Work board's line already carries, instead of the old
 * `TdPopover` menus. Deck has no popover primitive and `deck.css` is
 * generated, so a popover would have meant keeping a per-screen stylesheet
 * alive for six fields; a select is the one control Deck does have, it is
 * keyboard- and screen-reader-native, and it made `d3-taskdetail.css`
 * deletable.
 *
 * Labels stay multi-valued: assigned ones are `.dk-tag` chips that remove
 * themselves on click, and the select only ever adds.
 *
 * Every callback here is `void`-returning — the page owns the async write,
 * the toast on failure and the "saved" indicator; this component only
 * decides *what* to write.
 */

// Exactly the three CHECK-allowed efforts plus "clear". Never any other
// string: `tasks.effort`'s CHECK(effort IN ('small','medium','large')) would
// reject a fourth value and the PUT would fail.
const EFFORTS: ReadonlyArray<{ value: "small" | "medium" | "large"; label: string }> = [
  { value: "small", label: "small" },
  { value: "medium", label: "medium" },
  { value: "large", label: "large" },
];

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

/**
 * A stored slug the active taxonomy no longer lists (a status deactivated
 * while tasks still carry it) would render the select blank and silently
 * rewrite the field on the next change. It gets its own option instead.
 */
function Orphan({
  value,
  known,
}: {
  value: string | null;
  known: readonly WorkflowVocabEntry[];
}): ReactElement | null {
  if (!value || known.some((e) => e.slug === value)) return null;
  return <option value={value}>{value.toLowerCase()}</option>;
}

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
  const sortedMembers = useMemo(() => {
    const byName = (a: TeamMember, b: TeamMember) => a.name.localeCompare(b.name);
    const humans = members.filter((m) => m.type === "human").slice().sort(byName);
    const agents = members.filter((m) => m.type === "agent").slice().sort(byName);
    return [...humans, ...agents];
  }, [members]);

  const activeProjects = useMemo(
    () => projects.filter((p) => p.is_active === 1),
    [projects],
  );

  const taskLabels = task.labels ?? [];
  const unassignedLabels = labelTaxonomy.filter(
    (t) => !taskLabels.some((l) => l.id === t.id),
  );

  return (
    <DeckGroup label="properties">
      <div className="dk-kv">
        <span>status</span>
        <span>
          <select
            className="dk-rowsel"
            aria-label="Status"
            value={task.status}
            onChange={(e) => onStatus(e.target.value)}
          >
            <Orphan value={task.status} known={statusVocab} />
            {statusVocab.map((e) => (
              <option key={e.slug} value={e.slug}>
                {e.label.toLowerCase()}
              </option>
            ))}
          </select>
        </span>
      </div>

      <div className="dk-kv">
        <span>priority</span>
        <span>
          <select
            className="dk-rowsel"
            aria-label="Priority"
            value={task.priority}
            onChange={(e) => onPriority(e.target.value)}
          >
            <Orphan value={task.priority} known={priorityVocab} />
            {priorityVocab.map((e) => (
              <option key={e.slug} value={e.slug}>
                {e.label.toLowerCase()}
              </option>
            ))}
          </select>
        </span>
      </div>

      <div className="dk-kv">
        <span>assignee</span>
        <span>
          <select
            className="dk-rowsel"
            aria-label="Assignee"
            value={task.assignee_id == null ? "" : String(task.assignee_id)}
            onChange={(e) =>
              onAssignee(e.target.value === "" ? null : Number(e.target.value))
            }
          >
            <option value="">unassigned</option>
            {sortedMembers.map((m) => (
              <option key={m.id} value={String(m.id)}>
                {m.name} · {m.role}
              </option>
            ))}
          </select>
        </span>
      </div>

      <div className="dk-kv">
        <span>effort</span>
        <span>
          <select
            className="dk-rowsel"
            aria-label="Effort"
            value={task.effort ?? ""}
            onChange={(e) =>
              onEffort(
                e.target.value === ""
                  ? null
                  : (e.target.value as "small" | "medium" | "large"),
              )
            }
          >
            <option value="">—</option>
            {EFFORTS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </span>
      </div>

      <div className="dk-kv">
        <span>project</span>
        <span>
          {activeProjects.length === 0 ? (
            <span className="dim">no projects imported yet</span>
          ) : (
            <select
              className="dk-rowsel"
              aria-label="Project"
              value={task.project_id == null ? "" : String(task.project_id)}
              onChange={(e) => onProject(Number(e.target.value))}
            >
              {task.project_id == null && <option value="">—</option>}
              {activeProjects.map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </span>
      </div>

      <div className="dk-kv">
        <span>labels</span>
        <span className="dk-actions">
          {taskLabels.map((l) => (
            <button
              key={l.id}
              type="button"
              className="dk-tag"
              aria-label={`Remove label ${l.label}`}
              onClick={() => onToggleLabel(l.id, false)}
            >
              {l.label.toLowerCase()} ×
            </button>
          ))}
          {labelTaxonomy.length === 0 ? (
            <span className="dim">none defined</span>
          ) : (
            <select
              className="dk-rowsel"
              aria-label="Add label"
              value=""
              onChange={(e) => {
                const id = Number(e.target.value);
                if (id) onToggleLabel(id, true);
              }}
            >
              <option value="">+ label</option>
              {unassignedLabels.map((t) => (
                <option key={t.id} value={String(t.id)}>
                  {t.display_name}
                </option>
              ))}
            </select>
          )}
        </span>
      </div>
    </DeckGroup>
  );
}
