import { useState, type FormEvent, type ReactElement } from "react";
import type { Subtask } from "../../lib/api";
import { DeckGrid, DeckGroup, DeckLine } from "../deck/deck-grid";

/**
 * The subtask checklist, as Deck lines: state glyph, checkbox, title, delete.
 * The count rides the group heading and the progress bar is a `.dk-meter` in
 * its actions slot.
 *
 * Prop-only, like `runs-card.tsx`: the page owns the query and the writes.
 * The one piece of state kept here is the optimistic overlay — a map of
 * subtask id to the checked value a flight is trying to store. A row renders
 * that value while the write is in flight, and the entry is dropped once
 * `onToggle` settles either way, so a success reveals the refetched row and a
 * failure reverts the checkbox visibly. Count and meter are both computed
 * from the SAME overlaid list the rows render, so they can never disagree
 * with what is on screen.
 */
const COLS = "14px 18px minmax(0, 1fr) auto";

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
    <DeckGroup
      label="subtasks"
      count={rows.length > 0 ? `${doneCount}/${rows.length}` : undefined}
      actions={
        rows.length > 0 ? (
          <span
            className="dk-meter"
            role="progressbar"
            aria-label="Subtasks complete"
            aria-valuemin={0}
            aria-valuemax={rows.length}
            aria-valuenow={doneCount}
          >
            <i style={{ width: `${percent}%` }} />
          </span>
        ) : undefined
      }
    >
      {isLoading ? (
        <div className="dk-note">Loading subtasks…</div>
      ) : isError ? (
        <div className="dk-note">
          Could not load subtasks.{" "}
          <button type="button" className="dk-btn bare" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : (
        <>
          {rows.length === 0 ? (
            <div className="dk-note">No subtasks yet.</div>
          ) : (
            <DeckGrid cols={COLS} label="Subtasks">
              {rows.map((row) => (
                <DeckLine
                  key={row.id}
                  state={row.done ? "done" : "todo"}
                  done={row.done}
                  cells={[
                    {
                      v: (
                        <input
                          type="checkbox"
                          checked={row.done}
                          aria-label={row.title}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => void handleToggle(row.id, !row.done)}
                        />
                      ),
                    },
                    {
                      v:
                        renamingId === row.id ? (
                          <input
                            className="dk-ctl"
                            autoFocus
                            value={renameDraft}
                            aria-label={`Rename ${row.title}`}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onBlur={() => commitRename(row)}
                            onKeyDown={(e) => {
                              e.stopPropagation();
                              if (e.key === "Enter") {
                                e.preventDefault();
                                commitRename(row);
                              } else if (e.key === "Escape") {
                                setRenamingId(null);
                              }
                            }}
                          />
                        ) : (
                          row.title
                        ),
                      cls: "sub",
                      title: row.title,
                    },
                    {
                      v: (
                        <span className="acts">
                          <button
                            type="button"
                            className="dk-btn bare icon"
                            aria-label={`Delete ${row.title}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onDelete(row.id);
                            }}
                          >
                            ✕
                          </button>
                        </span>
                      ),
                      cls: "r",
                    },
                  ]}
                  onOpen={
                    renamingId === row.id
                      ? undefined
                      : () => {
                          setRenameDraft(row.title);
                          setRenamingId(row.id);
                        }
                  }
                />
              ))}
            </DeckGrid>
          )}

          <form
            className="dk-actions"
            style={{ display: "flex", padding: "var(--u2) var(--u3) 0" }}
            onSubmit={handleAdd}
          >
            <span className="dk-field" style={{ flex: "1 1 auto" }}>
              <input
                value={draft}
                placeholder="add a subtask…"
                aria-label="Add a subtask"
                onChange={(e) => setDraft(e.target.value)}
              />
            </span>
            <button type="submit" className="dk-btn" disabled={draft.trim() === ""}>
              add
            </button>
          </form>
        </>
      )}
    </DeckGroup>
  );
}
