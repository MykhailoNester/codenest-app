import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";
import type { TaskComment } from "../../lib/api";
import { AgentMarkdown } from "../terminal/agent-markdown";
import { formatActivityStamp } from "../../lib/task-activity";
import { DeckGrid, DeckLine } from "../deck/deck-grid";

/**
 * The Comments panel of the tab strip: composer first, thread oldest-first
 * beneath it on `.dk-list.prose` — the one list Deck lets wrap, which is what
 * a markdown body needs.
 *
 * Prop-only, like `subtasks-card.tsx` — the page owns the query and the
 * writes. `onPost` and `onSaveEdit` must reject when the write fails: the
 * draft is only cleared once the promise resolves, which is what keeps a
 * failed post's text on screen instead of losing it.
 *
 * Attribution is read off the stored `author_kind`, never guessed from the
 * name: an agent carries a visible "agent" tag, and a comment with no author
 * renders as the operator rather than a made-up member.
 */
const COLS = "14px minmax(0, 1fr) 96px";

export interface CommentsCardProps {
  comments: TaskComment[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  /** Must reject when the post fails — that is what preserves the draft. */
  onPost: (body: string) => Promise<void>;
  onSaveEdit: (id: number, body: string) => Promise<void>;
  onDelete: (id: number) => void;
}

const OPERATOR_LABEL = "Operator";

function authorLabel(comment: TaskComment): string {
  if (comment.author_kind === "operator") return OPERATOR_LABEL;
  const name = comment.author_name?.trim();
  if (name) return name;
  // The members row is gone (author_id is ON DELETE SET NULL) but the kind
  // survived it, so say what wrote this rather than inventing a name.
  return comment.author_kind === "agent" ? "Agent (removed)" : "Member (removed)";
}

function autoGrow(el: HTMLTextAreaElement | null): void {
  if (el === null) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

export function CommentsCard({
  comments,
  isLoading,
  isError,
  onRetry,
  onPost,
  onSaveEdit,
  onDelete,
}: CommentsCardProps): ReactElement {
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => autoGrow(composerRef.current), [draft]);

  async function handlePost(e: FormEvent): Promise<void> {
    e.preventDefault();
    const body = draft.trim();
    if (body === "" || posting) return;
    setPosting(true);
    try {
      await onPost(body);
      setDraft("");
    } catch {
      // The page reports it; keeping `draft` untouched is the point here.
    } finally {
      setPosting(false);
    }
  }

  async function commitEdit(comment: TaskComment): Promise<void> {
    const body = editDraft.trim();
    if (body === "" || body === comment.body) {
      setEditingId(null);
      return;
    }
    try {
      await onSaveEdit(comment.id, body);
      setEditingId(null);
    } catch {
      // Stay in edit mode so the typed text is still there to retry.
    }
  }

  return (
    <>
      <form
        className="dk-form"
        style={{ padding: "var(--u3)", gap: "var(--u2)" }}
        onSubmit={(e) => void handlePost(e)}
      >
        <textarea
          ref={composerRef}
          className="dk-ta"
          rows={2}
          value={draft}
          placeholder="Leave a note for yourself or an agent…"
          aria-label="Write a comment"
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="dk-actions end">
          <button
            type="submit"
            className="dk-btn"
            disabled={draft.trim() === "" || posting}
          >
            comment
          </button>
        </div>
      </form>

      {isLoading ? (
        <div className="dk-note">Loading comments…</div>
      ) : isError ? (
        <div className="dk-note">
          Could not load comments.{" "}
          <button type="button" className="dk-btn bare" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : comments.length === 0 ? (
        <div className="dk-note">No comments yet.</div>
      ) : (
        <DeckGrid cols={COLS} className="prose" label="Comments">
          {comments.map((comment) => {
            const label = authorLabel(comment);
            const isAgent = comment.author_kind === "agent";
            const editing = editingId === comment.id;
            return (
              <DeckLine
                key={comment.id}
                state={isAgent ? "run" : "idle"}
                cells={[
                  {
                    v: (
                      <>
                        <div className="dk-actions">
                          <b className="sub">{label}</b>
                          {isAgent ? <span className="dk-tag">agent</span> : null}
                          {comment.updated_at !== comment.created_at ? (
                            <span className="dim">edited</span>
                          ) : null}
                        </div>
                        {editing ? (
                          <>
                            <textarea
                              className="dk-ta"
                              rows={2}
                              autoFocus
                              value={editDraft}
                              aria-label={`Edit comment by ${label}`}
                              onChange={(e) => {
                                setEditDraft(e.target.value);
                                autoGrow(e.target);
                              }}
                            />
                            <div className="dk-actions">
                              <button
                                type="button"
                                className="dk-btn"
                                disabled={editDraft.trim() === ""}
                                onClick={() => void commitEdit(comment)}
                              >
                                save
                              </button>
                              <button
                                type="button"
                                className="dk-btn bare"
                                onClick={() => setEditingId(null)}
                              >
                                cancel
                              </button>
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="dk-prose">
                              <AgentMarkdown text={comment.body} />
                            </div>
                            <div className="dk-actions">
                              <button
                                type="button"
                                className="dk-btn bare"
                                onClick={() => {
                                  setEditDraft(comment.body);
                                  setEditingId(comment.id);
                                }}
                              >
                                edit
                              </button>
                              <button
                                type="button"
                                className="dk-btn bare danger"
                                aria-label={`Delete comment by ${label}`}
                                onClick={() => onDelete(comment.id)}
                              >
                                delete
                              </button>
                            </div>
                          </>
                        )}
                      </>
                    ),
                  },
                  {
                    v: (
                      <time
                        dateTime={`${comment.created_at}Z`}
                        title={comment.created_at}
                      >
                        {formatActivityStamp(comment.created_at)}
                      </time>
                    ),
                    cls: "r dim",
                  },
                ]}
              />
            );
          })}
        </DeckGrid>
      )}
    </>
  );
}
