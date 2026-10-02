import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
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

/* ── Local constants ──────────────────────────────────────────────────────
   The places Deck has no primitive. Declared here rather than in
   `components/deck/*` or `design/deck/*`, which #283 does not touch — the
   precedent is `launch/launch-composer.tsx`'s `SCRIM_STYLE` / `MODAL_STYLE`
   and `sessions/event-detail-modal.tsx`'s `PUSH_END`. */

/** `.dk-scrim` is z-index 60, enough for a scrim raised inside a Deck page.
 *  This one portals to `document.body` over the whole app — including the
 *  terminal pane's own portals — so it keeps `.tb-modal__mask`'s z-index
 *  verbatim. A restyle must not reorder what covers what. The pickers'
 *  popovers sit at 199/200 and must stay above it. */
const SCRIM_STYLE: CSSProperties = { zIndex: 150 };

/** `.dk-modal` is `min(680px, 100%)`; the Composer is a short form and was
 *  560px. Narrower reads better than a half-empty dialog. */
const MODAL_STYLE: CSSProperties = { width: "min(560px, 100%)" };

/** `.sp` is `margin-left: auto` only inside the headers deck.css names, and
 *  `.dk-modal__f` is not one of them. The footer is right-aligned, so the
 *  one thing that belongs on the left pushes everything else away instead. */
const PUSH_START: CSSProperties = { marginRight: "auto" };

/** `.dk-modal__f` does not wrap — a footer of one or two buttons never needs
 *  to. This one carries four items; on a narrow window it wraps rather than
 *  pushing Create off the dialog, as `.tb-modal__foot` did. */
const FOOTER_STYLE: CSSProperties = { flexWrap: "wrap" };

/** A checkbox and its words. Deck draws form controls but has no primitive
 *  for an inline checkbox label; this is `launch/launch-composer.tsx`'s. */
const CHECK_LABEL_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--u2)",
  fontSize: "var(--fs-s)",
};

/** `.dk-modal__h` styles its own text but has no rule for a heading inside
 *  it — unlike `.dk-title h1` and `.dk-side__h h3`, which both reset one. A
 *  bare `<h2>` therefore lands at the UA's 1.5em bold with margins and bursts
 *  the 34px header. The dialog still wants a real heading so the app has an
 *  outline, so it gets one and inherits the strip's type. */
const MODAL_TITLE_STYLE: CSSProperties = { font: "inherit", margin: 0 };

/** `.dk-help` is the form's explanatory line. Deck has no error variant of
 *  it — `--err` is the terminal semantic for broken, which a rejected field
 *  is. */
const ERR_TEXT_STYLE: CSSProperties = { color: "var(--err)" };

/** `textarea.dk-ctl` is `resize: vertical`, which fights a textarea that
 *  sizes itself: a manual drag is overwritten on the next keystroke. The
 *  field grows to its content instead, as `.tb-modal__desc` did. */
const GROW_TEXTAREA_STYLE: CSSProperties = {
  resize: "none",
  overflow: "hidden",
};

/** One labelled control in the picker grid. The pickers render their own
 *  `aria-label` ("Status: To do"), so the visible label is a `<span>`, not a
 *  `<label for>` that would fight it for the accessible name. */
function FormRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="dk-form__row">
      <span className="dk-label">{label}</span>
      <span className="dk-actions">{children}</span>
    </div>
  );
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
    // `deck` because this portals to `document.body`, outside the `.deck` the
    // page draws inside — without it every Deck token resolves to nothing and
    // the dialog renders as an unstyled white box. `display: contents` keeps
    // the wrapper out of layout (`launch/launch-composer.tsx` set the
    // precedent, `sessions/event-detail-modal.tsx` follows it).
    <div className="deck" style={{ display: "contents" }}>
      <div
        className="dk-scrim"
        style={SCRIM_STYLE}
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          className="dk-modal"
          style={MODAL_STYLE}
          role="dialog"
          aria-modal="true"
          aria-label="New task"
        >
          <div className="dk-modal__h">
            <h2 style={MODAL_TITLE_STYLE}>new task</h2>
            <span className="sp" />
            <button
              type="button"
              className="dk-btn bare icon"
              onClick={onClose}
              aria-label="Close"
            >
              ×
            </button>
          </div>

          <div className="dk-modal__b">
            <div className="dk-form">
              <div className="dk-form__row">
                <label className="dk-label" htmlFor="composer-title">
                  Title
                </label>
                <input
                  ref={titleRef}
                  id="composer-title"
                  className="dk-ctl"
                  value={form.title}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, title: e.target.value }))
                  }
                  placeholder="What needs doing?"
                />
              </div>

              {/* Six pickers read as six anonymous chips in one row; on the
                  form grid each one says what it sets. */}
              <div className="dk-form__grid">
                <FormRow label="Status">
                  <ChipPicker
                    label="Status"
                    value={form.status}
                    options={statusOptions}
                    onSelect={(v) => setForm((f) => ({ ...f, status: v }))}
                  />
                </FormRow>
                <FormRow label="Priority">
                  <ChipPicker
                    label="Priority"
                    value={form.priority}
                    options={priorityOptions}
                    onSelect={(v) => setForm((f) => ({ ...f, priority: v }))}
                  />
                </FormRow>
                <FormRow label="Project">
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
                </FormRow>
                <FormRow label="Assignee">
                  <ChipPicker
                    label="Assignee"
                    value={form.assigneeId}
                    options={assigneeOptions}
                    onSelect={(v) => setForm((f) => ({ ...f, assigneeId: v }))}
                    searchable
                  />
                </FormRow>
                <FormRow label="Effort">
                  <ChipPicker
                    label="Effort"
                    value={form.effort}
                    options={EFFORT_OPTIONS}
                    onSelect={(v) => setForm((f) => ({ ...f, effort: v }))}
                  />
                </FormRow>
                <FormRow label="Labels">
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
                </FormRow>
              </div>

              {error ? (
                <div className="dk-help" style={ERR_TEXT_STYLE} role="alert">
                  {error}
                </div>
              ) : null}

              {showDescription ? (
                <div className="dk-form__row">
                  <label className="dk-label" htmlFor="composer-description">
                    Description
                  </label>
                  <textarea
                    ref={descRef}
                    id="composer-description"
                    className="dk-ctl"
                    style={GROW_TEXTAREA_STYLE}
                    value={form.description}
                    onChange={(e) => {
                      setForm((f) => ({ ...f, description: e.target.value }));
                      growTextarea(e.target);
                    }}
                    placeholder="Add more detail…"
                  />
                </div>
              ) : (
                <div className="dk-actions">
                  <button
                    type="button"
                    className="dk-btn bare"
                    onClick={() => setShowDescription(true)}
                  >
                    <span aria-hidden="true">+</span> Add description
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="dk-modal__f" style={FOOTER_STYLE}>
            <label style={{ ...CHECK_LABEL_STYLE, ...PUSH_START }}>
              <input
                type="checkbox"
                checked={createAnother}
                onChange={(e) => setCreateAnother(e.target.checked)}
              />
              Create another
            </label>
            <span className="dk-meta">⌘↩ to create</span>
            <button type="button" className="dk-btn bare" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="dk-btn pri"
              disabled={!canSubmit}
              onClick={() => void handleCreate()}
            >
              Create
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
