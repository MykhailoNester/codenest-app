import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import {
  createTask,
  setTaskLabels,
  type Project,
  type TeamMember,
} from "../../lib/api";
import { useEscapeKey } from "../../hooks/use-escape-key";
import { ChipPicker, MultiChipPicker } from "./chip-picker";
import type { ChipOption } from "./types";

// D5 — setting assignee_id does not start or queue a session. What is real:
// launch_seed_service seeds an agent's saved provider + model as the launch
// defaults. Shown under every option in the Agents group.
const AGENT_HINT =
  "Assigning does not start a session. The agent's saved provider and model become the defaults when you launch this task with ▶.";

// Fixed by the schema CHECK `effort IN ('small','medium','large')` — not
// taxonomy-driven. Clearing sends null, never "" (the CHECK allows NULL,
// not the empty string).
const EFFORT_OPTIONS: readonly ChipOption[] = [
  { value: "", label: "—" },
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
];

// Moved verbatim from tasks.tsx (was 586-589) — the Composer owns the only
// description field left in this file.
function growTextarea(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

export interface ComposerLabelOption {
  id: number;
  label: string;
  color: string | null;
}

export interface ComposerModalProps {
  projects: readonly Project[];
  members: readonly TeamMember[];
  statusOptions: readonly ChipOption[];
  priorityOptions: readonly ChipOption[];
  labelOptions: readonly ComposerLabelOption[];
  defaultProjectId: string;
  defaultStatus: string;
  defaultPriority: string;
  onClose: () => void;
  onCreated: () => void;
}

interface ComposerForm {
  title: string;
  description: string;
  status: string;
  priority: string;
  /** "" means "no effort selected"; sent as null, never "". */
  effort: string;
  /** "" means "unassigned"; sent as null. */
  assigneeId: string;
  projectId: string;
  labelIds: number[];
}

// Not exported: `eslint-plugin-react-refresh`'s `only-export-components`
// rule is an error (not a warning) in this repo's config, and it rejects a
// non-component export sitting alongside a component export in the same
// .tsx file. `tasks.tsx` builds its own equivalent list for the card's
// assignee picker (see D9/D10 in the plan — the Composer takes raw
// `members`/`projects` and builds its own options, while `TaskCard` takes
// a pre-built `assigneeOptions` array; these were already two separate
// constructions, not one shared helper).
function buildAssigneeOptions(
  members: readonly TeamMember[],
): ChipOption[] {
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
}

export function ComposerModal({
  projects,
  members,
  statusOptions,
  priorityOptions,
  labelOptions,
  defaultProjectId,
  defaultStatus,
  defaultPriority,
  onClose,
  onCreated,
}: ComposerModalProps): ReactElement {
  const [form, setForm] = useState<ComposerForm>({
    title: "",
    description: "",
    status: defaultStatus,
    priority: defaultPriority,
    effort: "",
    assigneeId: "",
    projectId: defaultProjectId,
    labelIds: [],
  });
  const [showDescription, setShowDescription] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [createAnother, setCreateAnother] = useState(false);

  const titleRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  // Synchronous double-submit guard: a ref (not state) so a second ⌘↩
  // fired before the first render/effect cycle completes still sees the
  // in-flight flag — `submitting` state alone would still read stale in
  // that window.
  const submittingRef = useRef(false);
  const submitRef = useRef<() => void>(() => {});

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (showDescription && descRef.current) growTextarea(descRef.current);
  }, [form.description, showDescription]);

  useEscapeKey(onClose);

  const projectOptions: ChipOption[] = projects.map((p) => ({
    value: String(p.id),
    label: p.name,
  }));
  const assigneeOptions = buildAssigneeOptions(members);
  const effectiveProjectId = form.projectId || defaultProjectId;
  const canSubmit = form.title.trim().length > 0 && !submitting;

  function resetForCreateAnother(): void {
    setForm((f) => ({ ...f, title: "", description: "", labelIds: [] }));
    setShowDescription(false);
    titleRef.current?.focus();
  }

  async function handleCreate(): Promise<void> {
    if (!form.title.trim()) return;
    if (!effectiveProjectId) {
      setError("Project is required");
      return;
    }
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const { id } = await createTask({
        title: form.title.trim(),
        description: form.description.trim() || null,
        status: form.status,
        priority: form.priority,
        effort: form.effort || null,
        assignee_id: form.assigneeId ? Number(form.assigneeId) : null,
        project_id: Number(effectiveProjectId),
      });
      if (form.labelIds.length > 0) {
        try {
          await setTaskLabels(id, form.labelIds);
        } catch {
          toast.error("Task created, but labels failed to save");
        }
      }
      onCreated();
      if (createAnother) resetForCreateAnother();
      else onClose();
    } catch (err) {
      toast.error(`Failed to create task: ${(err as Error).message}`);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  // D13.3 — the ref is assigned INSIDE the effect (no deps array), exactly
  // as tasks.tsx does for navigateRef/setFilterRef/handleMoveTaskRef.
  // Assigning submitRef.current in the render body is a react-hooks/refs
  // error ("Cannot access refs during render").
  useEffect(() => {
    submitRef.current = () => void handleCreate();
  });

  // A single `[]`-deps effect registers exactly one window listener across
  // re-renders. The bug this avoids: inbox-promote-modal.tsx registers its
  // keydown effect with no dependency array at all, re-adding the listener
  // on every render.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        submitRef.current();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return createPortal(
    <div
      className="tb-modal__mask"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="tb-modal" role="dialog" aria-modal="true" aria-label="New task">
        <input
          ref={titleRef}
          className="tb-modal__title"
          value={form.title}
          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
          placeholder="What needs doing?"
        />

        <div className="tb-modal__chips">
          <ChipPicker
            label="Status"
            value={form.status}
            options={statusOptions}
            onSelect={(v) => setForm((f) => ({ ...f, status: v }))}
          />
          <ChipPicker
            label="Priority"
            value={form.priority}
            options={priorityOptions}
            onSelect={(v) => setForm((f) => ({ ...f, priority: v }))}
          />
          <ChipPicker
            label="Project"
            value={form.projectId}
            options={projectOptions}
            onSelect={(v) => {
              setForm((f) => ({ ...f, projectId: v }));
              if (v) setError(null);
            }}
            searchable
          />
          <ChipPicker
            label="Assignee"
            value={form.assigneeId}
            options={assigneeOptions}
            onSelect={(v) => setForm((f) => ({ ...f, assigneeId: v }))}
            searchable
          />
          <ChipPicker
            label="Effort"
            value={form.effort}
            options={EFFORT_OPTIONS}
            onSelect={(v) => setForm((f) => ({ ...f, effort: v }))}
          />
          <MultiChipPicker
            label="Labels"
            selected={form.labelIds}
            options={labelOptions}
            onToggle={(id, next) =>
              setForm((f) => ({
                ...f,
                labelIds: next
                  ? [...f.labelIds, id]
                  : f.labelIds.filter((existing) => existing !== id),
              }))
            }
            emptyText="No labels — add them in Settings → Workflow Labels"
          />
        </div>

        {error ? <div className="tb-modal__err">{error}</div> : null}

        {showDescription ? (
          <textarea
            ref={descRef}
            className="tb-modal__desc"
            value={form.description}
            onChange={(e) => {
              setForm((f) => ({ ...f, description: e.target.value }));
              growTextarea(e.target);
            }}
            placeholder="Add more detail…"
          />
        ) : (
          <button
            type="button"
            className="tb-modal__desc-add"
            onClick={() => setShowDescription(true)}
          >
            + Add description
          </button>
        )}

        <div className="tb-modal__foot">
          <label className="tb-check">
            <input
              type="checkbox"
              checked={createAnother}
              onChange={(e) => setCreateAnother(e.target.checked)}
            />
            Create another
          </label>
          <span className="tb-modal__kbd">⌘↩ to create</span>
          <button
            type="button"
            className="d3-btn d3-btn--ghost"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="d3-btn d3-btn--primary"
            disabled={!canSubmit}
            onClick={() => void handleCreate()}
          >
            Create
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
