import { useState, type FormEvent, type ReactElement } from "react";
import type { Subtask } from "../../lib/api";

/**
 * The `.td-subs` checklist card in the document column.
 *
 * Prop-only, like `runs-card.tsx`: the page owns the query and the writes.
 * The one piece of state kept here is the optimistic overlay — a map of
 * subtask id to the checked value a flight is trying to store. A row renders
 * that value while the write is in flight, and the entry is dropped once
 * `onToggle` settles either way, so a success reveals the refetched row and a
 * failure reverts the checkbox visibly. Count chip and progress bar are both
 * computed from the SAME overlaid list the rows render, so they can never
 * disagree with what is on screen.
 */
export interface SubtasksCardProps {
  subtasks: Subtask[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onAdd: (title: string) => void;
  onRename: (id: number, title: string) => void;
  /** Must reject when the write fails — that is what reverts the checkbox. */
  onToggle: (id: number, done: boolean) => Promise<void>;
  onDelete: (id: number) => void;
}

export function SubtasksCard({
  subtasks,
  isLoading,
  isError,
  onRetry,
  onAdd,
  onRename,
  onToggle,
  onDelete,
}: SubtasksCardProps): ReactElement {
  const [pending, setPending] = useState<Record<number, boolean>>({});
  const [draft, setDraft] = useState("");
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const rows = subtasks.map((s) => {
    const inFlight = pending[s.id];
    return inFlight === undefined ? s : { ...s, done: inFlight };
  });
  const doneCount = rows.filter((s) => s.done).length;
  const percent = rows.length > 0 ? (doneCount / rows.length) * 100 : 0;

  async function handleToggle(id: number, next: boolean): Promise<void> {
    setPending((p) => ({ ...p, [id]: next }));
    try {
      await onToggle(id, next);
    } catch {
      // The page reports it; here the revert below is the visible part.
    } finally {
      setPending((p) => {
        const rest = { ...p };
        delete rest[id];
        return rest;
      });
    }
  }

  function handleAdd(e: FormEvent): void {
    e.preventDefault();
    const title = draft.trim();
    if (title === "") return;
    setDraft("");
    onAdd(title);
  }

  function commitRename(row: Subtask): void {
    setRenamingId(null);
    const title = renameDraft.trim();
    // `title` is NOT NULL and the sidecar rejects a blank one — a cleared
    // draft is a cancel, not a write.
    if (title === "" || title === row.title) return;
    onRename(row.id, title);
  }

  return (
    <div className="td-card">
      <div className="td-card__head">
        <h2 className="td-h">
          Subtasks
          {rows.length > 0 ? (
            <span className="td-count">
              {doneCount}/{rows.length}
            </span>
          ) : null}
        </h2>
        {rows.length > 0 ? (
          <div
            className="td-prog"
            role="progressbar"
            aria-label="Subtasks complete"
            aria-valuemin={0}
            aria-valuemax={rows.length}
            aria-valuenow={doneCount}
          >
            <i style={{ width: `${percent}%` }} />
          </div>
        ) : null}
      </div>

      {isLoading ? (
        <span className="td-dim td-sm">Loading subtasks…</span>
      ) : isError ? (
        <>
          <span className="td-dim td-sm">Could not load subtasks.</span>
          <button
            type="button"
            className="d3-btn d3-btn--ghost"
            onClick={onRetry}
          >
            Retry
          </button>
        </>
      ) : (
        <>
          {rows.length === 0 ? (
            <span className="td-dim td-sm">No subtasks yet.</span>
          ) : (
            <ul className="td-subs">
              {rows.map((row) => (
                <li key={row.id} className={row.done ? "is-done" : undefined}>
                  <input
                    type="checkbox"
                    className="td-check"
                    checked={row.done}
                    aria-label={row.title}
                    onChange={() => void handleToggle(row.id, !row.done)}
                  />
                  {renamingId === row.id ? (
                    <input
                      className="td-sub__edit"
                      autoFocus
                      value={renameDraft}
                      aria-label={`Rename ${row.title}`}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={() => commitRename(row)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitRename(row);
                        } else if (e.key === "Escape") {
                          e.stopPropagation();
                          setRenamingId(null);
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="td-sub__title"
                      onClick={() => {
                        setRenameDraft(row.title);
                        setRenamingId(row.id);
                      }}
                    >
                      {row.title}
                    </button>
                  )}
                  <button
                    type="button"
                    className="td-ghost"
                    aria-label={`Delete ${row.title}`}
                    onClick={() => onDelete(row.id)}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form className="td-addsub" onSubmit={handleAdd}>
            <span aria-hidden="true">+</span>
            <input
              value={draft}
              placeholder="Add a subtask…"
              aria-label="Add a subtask"
              onChange={(e) => setDraft(e.target.value)}
            />
          </form>
        </>
      )}
    </div>
  );
}
