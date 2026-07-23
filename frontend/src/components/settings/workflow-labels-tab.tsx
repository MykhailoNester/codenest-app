/**
 * WorkflowLabelsTab — Settings → Workflow Labels.
 *
 * Single source of truth for the workflow vocabulary the Work Board renders:
 * task statuses (one board column each) and task priorities (badges + sorting).
 * Editing a label, colour, or order here drives the board, card dropdowns, and
 * list view live; the underlying slug stays stable, so existing tasks are never
 * touched by a rename.
 *
 * Add a status → a new board column appears. Remove a built-in status → its
 * column is hidden (it can be restored). Remove a custom status → it's deleted.
 *
 * UX modelled on JetBrains' Settings → editable-list (ToolbarDecorator):
 * inline in-place editing, a colour cell editor, add / remove / move-up-down,
 * and a labelled section per group.
 */
import { useState, type ReactElement } from "react";
import { toast } from "sonner";
import {
  useTaxonomies,
  useUpdateTaxonomy,
  useReorderTaxonomy,
  useCreateTaxonomy,
  useDeleteTaxonomy,
  type Taxonomy,
  type TaxonomyKind,
} from "../../lib/api";

interface GroupDef {
  kind: TaxonomyKind;
  title: string;
  description: string;
  addLabel: string;
}

// Only the two vocabularies the Work Board uses. (The board has no separate
// "inbox"/triage lane, so inbox statuses + priorities are not edited here.)
const GROUPS: readonly GroupDef[] = [
  {
    kind: "task_status",
    title: "Task statuses",
    description:
      "Each status is a column on the Work Board, plus the status dropdown on cards and the list view.",
    addLabel: "Add status",
  },
  {
    kind: "task_priority",
    title: "Task priorities",
    description: "Priority badges and priority sorting.",
    addLabel: "Add priority",
  },
];

const NEW_COLOR = "#6b7280";

// Canonical seed values, used by "Reset to defaults".
const DEFAULTS: Record<string, { label: string; color: string; order: number }> =
  {
    "task_status:backlog": { label: "Idea", color: "#6b7280", order: 10 },
    "task_status:todo": { label: "To do", color: "#60a5fa", order: 20 },
    "task_status:in-progress": {
      label: "In progress",
      color: "#f59e0b",
      order: 30,
    },
    "task_status:blocked": { label: "Blocked", color: "#ef4444", order: 40 },
    "task_status:done": { label: "Done", color: "#22c55e", order: 50 },
    "task_priority:high": { label: "High", color: "#ef4444", order: 10 },
    "task_priority:medium": { label: "Medium", color: "#f59e0b", order: 20 },
    "task_priority:low": { label: "Low", color: "#22c55e", order: 30 },
  };

function slugify(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function WorkflowLabelsTab(): ReactElement {
  const { data: rows = [], isPending, isError, error } = useTaxonomies();

  const byKind = (kind: TaxonomyKind): Taxonomy[] =>
    rows
      .filter((r) => r.kind === kind)
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <h2
          style={{
            fontSize: 16,
            fontWeight: 600,
            color: "var(--fg-0)",
            margin: 0,
          }}
        >
          Workflow Labels
        </h2>
        <p
          style={{
            fontSize: 12,
            color: "var(--fg-3)",
            marginTop: 4,
            maxWidth: 580,
          }}
        >
          Rename, recolour, reorder, add, or remove the labels your Work Board
          uses. Changes apply everywhere — board columns, dropdowns, and badges.
          The underlying key stays stable, so existing tasks are never touched
          by a rename.
        </p>
      </div>

      {isPending && (
        <div style={{ fontSize: 13, color: "var(--fg-3)" }}>Loading…</div>
      )}
      {isError && (
        <div style={{ fontSize: 13, color: "var(--err)" }}>
          Failed to load: {error.message}
        </div>
      )}

      {!isPending &&
        !isError &&
        GROUPS.map((g) => (
          <GroupSection key={g.kind} def={g} rows={byKind(g.kind)} />
        ))}
    </div>
  );
}

function GroupSection({
  def,
  rows,
}: {
  def: GroupDef;
  rows: Taxonomy[];
}): ReactElement {
  const update = useUpdateTaxonomy();
  const reorder = useReorderTaxonomy();
  const create = useCreateTaxonomy();
  const remove = useDeleteTaxonomy();

  const [draft, setDraft] = useState("");

  function commitRename(row: Taxonomy, value: string): void {
    const next = value.trim();
    if (!next || next === row.display_name) return;
    update.mutate(
      { id: row.id, patch: { display_name: next } },
      { onError: (e) => toast.error(`Rename failed: ${e.message}`) },
    );
  }

  function commitColor(row: Taxonomy, value: string): void {
    if (value === row.color) return;
    update.mutate(
      { id: row.id, patch: { color: value } },
      { onError: (e) => toast.error(`Colour change failed: ${e.message}`) },
    );
  }

  function move(index: number, dir: -1 | 1): void {
    const target = index + dir;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(target, 0, moved);
    reorder.mutate(
      { kind: def.kind, orderedIds: next.map((r) => r.id) },
      { onError: (e) => toast.error(`Reorder failed: ${e.message}`) },
    );
  }

  function handleAdd(): void {
    const label = draft.trim();
    if (!label) return;
    const slug = slugify(label);
    if (!slug) {
      toast.error("Enter a name with at least one letter or number.");
      return;
    }
    create.mutate(
      { kind: def.kind, slug, display_name: label, color: NEW_COLOR },
      {
        onSuccess: () => {
          setDraft("");
          toast.success(`Added “${label}”`);
        },
        onError: (e) => toast.error(`Add failed: ${e.message}`),
      },
    );
  }

  function handleRemove(row: Taxonomy): void {
    if (row.is_default) {
      // Built-ins can't be deleted; hide them (column disappears) but keep the
      // row so it can be restored.
      update.mutate(
        { id: row.id, patch: { is_active: false } },
        { onError: (e) => toast.error(`Remove failed: ${e.message}`) },
      );
    } else {
      remove.mutate(row.id, {
        onError: (e) => toast.error(`Remove failed: ${e.message}`),
      });
    }
  }

  function handleRestore(row: Taxonomy): void {
    update.mutate(
      { id: row.id, patch: { is_active: true } },
      { onError: (e) => toast.error(`Restore failed: ${e.message}`) },
    );
  }

  async function resetDefaults(): Promise<void> {
    try {
      for (const row of rows) {
        const d = DEFAULTS[`${def.kind}:${row.slug}`];
        if (!d) continue;
        if (
          row.display_name !== d.label ||
          row.color !== d.color ||
          !row.is_active
        ) {
          await update.mutateAsync({
            id: row.id,
            patch: { display_name: d.label, color: d.color, is_active: true },
          });
        }
      }
      const ordered = [...rows].sort((a, b) => {
        const oa = DEFAULTS[`${def.kind}:${a.slug}`]?.order ?? 1000 + a.sort_order;
        const ob = DEFAULTS[`${def.kind}:${b.slug}`]?.order ?? 1000 + b.sort_order;
        return oa - ob;
      });
      await reorder.mutateAsync({
        kind: def.kind,
        orderedIds: ordered.map((r) => r.id),
      });
      toast.success("Reset to defaults");
    } catch (e) {
      toast.error(
        `Reset failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return (
    <section
      className="d3-card"
      style={{ marginBottom: 16, padding: "14px 16px" }}
    >
      {/* Group header + toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 10,
        }}
      >
        <div>
          <div className="d3-h" style={{ display: "block", marginBottom: 2 }}>
            {def.title}
          </div>
          <div style={{ fontSize: 11, color: "var(--fg-4)" }}>
            {def.description}
          </div>
        </div>
        <button
          type="button"
          className="d3-btn d3-btn--ghost"
          style={{ fontSize: 11, flexShrink: 0 }}
          onClick={() => void resetDefaults()}
          disabled={update.isPending || reorder.isPending}
          title="Restore the built-in labels, colours, and order for this group"
        >
          Reset to defaults
        </button>
      </div>

      <div
        style={{
          border: "1px solid var(--line-2)",
          borderRadius: "var(--r-2)",
          overflow: "hidden",
        }}
      >
        {rows.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--fg-4)", padding: "10px" }}>
            None yet — add one below.
          </div>
        ) : (
          rows.map((row, idx) => (
            <LabelRow
              key={row.id}
              row={row}
              isFirst={idx === 0}
              isLast={idx === rows.length - 1}
              onRename={(v) => commitRename(row, v)}
              onColor={(v) => commitColor(row, v)}
              onMoveUp={() => move(idx, -1)}
              onMoveDown={() => move(idx, 1)}
              onRemove={() => handleRemove(row)}
              onRestore={() => handleRestore(row)}
            />
          ))
        )}

        {/* Add row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 10px",
            borderTop: rows.length === 0 ? "none" : "1px solid var(--line-3)",
            background: "var(--bg-3)",
          }}
        >
          <span
            style={{
              width: 18,
              height: 18,
              borderRadius: 4,
              flexShrink: 0,
              background: NEW_COLOR,
              border: "1px solid var(--line-1)",
              opacity: 0.6,
            }}
          />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
            }}
            placeholder={`${def.addLabel}…`}
            style={{
              flex: 1,
              minWidth: 0,
              padding: "4px 8px",
              background: "var(--bg-2)",
              border: "1px solid var(--line-2)",
              color: "var(--fg-0)",
              borderRadius: 4,
              fontSize: 13,
            }}
          />
          <button
            type="button"
            className="d3-btn d3-btn--primary"
            style={{ fontSize: 12, flexShrink: 0 }}
            onClick={handleAdd}
            disabled={!draft.trim() || create.isPending}
          >
            Add
          </button>
        </div>
      </div>
    </section>
  );
}

function LabelRow({
  row,
  isFirst,
  isLast,
  onRename,
  onColor,
  onMoveUp,
  onMoveDown,
  onRemove,
  onRestore,
}: {
  row: Taxonomy;
  isFirst: boolean;
  isLast: boolean;
  onRename: (value: string) => void;
  onColor: (value: string) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  onRestore: () => void;
}): ReactElement {
  const [color, setColor] = useState(row.color ?? NEW_COLOR);
  const inactive = !row.is_active;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        borderTop: isFirst ? "none" : "1px solid var(--line-3)",
        background: "var(--bg-2)",
        opacity: inactive ? 0.55 : 1,
      }}
    >
      {/* Colour cell editor */}
      <label
        style={{
          position: "relative",
          width: 18,
          height: 18,
          borderRadius: 4,
          flexShrink: 0,
          background: color,
          border: "1px solid var(--line-1)",
          cursor: inactive ? "default" : "pointer",
        }}
        title={inactive ? "Hidden" : "Change colour"}
      >
        <input
          type="color"
          value={color}
          disabled={inactive}
          onChange={(e) => setColor(e.target.value)}
          onBlur={() => onColor(color)}
          style={{
            position: "absolute",
            inset: 0,
            opacity: 0,
            width: "100%",
            height: "100%",
            cursor: "pointer",
            border: "none",
            padding: 0,
          }}
          aria-label={`Colour for ${row.display_name}`}
        />
      </label>

      {/* Inline label editor */}
      <input
        defaultValue={row.display_name}
        disabled={inactive}
        onBlur={(e) => onRename(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        style={{
          flex: 1,
          minWidth: 0,
          padding: "4px 8px",
          background: "var(--bg-3)",
          border: "1px solid var(--line-2)",
          color: "var(--fg-0)",
          borderRadius: 4,
          fontSize: 13,
        }}
      />

      {/* Slug reference (read-only) */}
      <span
        style={{
          fontSize: 11,
          color: "var(--fg-4)",
          fontFamily: "var(--font-mono)",
          minWidth: 96,
          textAlign: "right",
        }}
        title="Stable key (not editable)"
      >
        {row.slug}
      </span>

      {inactive ? (
        <button
          type="button"
          className="d3-btn d3-btn--ghost"
          style={{ fontSize: 11, flexShrink: 0 }}
          onClick={onRestore}
        >
          Restore
        </button>
      ) : (
        <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
          <button
            type="button"
            className="d3-btn d3-btn--ghost"
            style={{
              fontSize: 12,
              padding: "2px 7px",
              opacity: isFirst ? 0.35 : 1,
            }}
            onClick={onMoveUp}
            disabled={isFirst}
            aria-label="Move up"
          >
            ↑
          </button>
          <button
            type="button"
            className="d3-btn d3-btn--ghost"
            style={{
              fontSize: 12,
              padding: "2px 7px",
              opacity: isLast ? 0.35 : 1,
            }}
            onClick={onMoveDown}
            disabled={isLast}
            aria-label="Move down"
          >
            ↓
          </button>
          <button
            type="button"
            className="d3-btn d3-btn--ghost"
            style={{ fontSize: 13, padding: "2px 7px", color: "var(--err)" }}
            onClick={onRemove}
            aria-label={`Remove ${row.display_name}`}
            title="Remove"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
