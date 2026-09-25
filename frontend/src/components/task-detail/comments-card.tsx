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
import { hashHue, initialsOf } from "./avatar";

/**
 * The Comments panel of the `.td-tabs` card: composer first, thread
 * oldest-first beneath it.
 *
 * Prop-only, like `subtasks-card.tsx` — the page owns the query and the
 * writes. `onPost` and `onSaveEdit` must reject when the write fails: the
 * draft is only cleared once the promise resolves, which is what keeps a
 * failed post's text on screen instead of losing it.
 *
 * Attribution is read off the stored `author_kind`, never guessed from the
 * name: an agent gets its own avatar shape and a visible "Agent" chip, and a
 * comment with no author renders as the operator rather than a made-up member.
 */
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
      <form className="td-comment" onSubmit={(e) => void handlePost(e)}>
        <span
          className="td-av"
          aria-hidden="true"
          style={{
            width: 26,
            height: 26,
            fontSize: 10.5,
            background: hashHue(OPERATOR_LABEL),
            color: "var(--bg-0)",
          }}
        >
          {initialsOf(OPERATOR_LABEL)}
        </span>
        <div className="td-comment__body">
          <textarea
            ref={composerRef}
            className="td-desc__ta td-comment__ta"
            rows={2}
            value={draft}
            placeholder="Leave a note for yourself or an agent…"
            aria-label="Write a comment"
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="td-comment__acts">
            <button
              type="submit"
              className="d3-btn d3-btn--primary"
              disabled={draft.trim() === "" || posting}
            >
              Comment
            </button>
          </div>
        </div>
      </form>

      {isLoading ? (
        <span className="td-dim td-sm">Loading comments…</span>
      ) : isError ? (
        <>
          <span className="td-dim td-sm">Could not load comments.</span>
          <button
            type="button"
            className="d3-btn d3-btn--ghost"
            onClick={onRetry}
          >
            Retry
          </button>
        </>
      ) : comments.length === 0 ? (
        <span className="td-dim td-sm">No comments yet.</span>
      ) : (
        <ul className="td-thread">
          {comments.map((comment) => {
            const label = authorLabel(comment);
            const isAgent = comment.author_kind === "agent";
            return (
              <li key={comment.id} className="td-comment">
                <span
                  className={`td-av${isAgent ? " td-av--agent" : ""}`}
                  aria-hidden="true"
                  style={{
                    width: 26,
                    height: 26,
                    fontSize: 10.5,
                    background: hashHue(label),
                    color: "var(--bg-0)",
                  }}
                >
                  {initialsOf(label)}
                </span>
                <div className="td-comment__body">
                  <div className="td-comment__who">
                    <b>{label}</b>
                    {isAgent ? <span className="td-kind">Agent</span> : null}
                    <time
                      className="td-comment__when"
                      dateTime={`${comment.created_at}Z`}
                      title={comment.created_at}
                    >
                      {formatActivityStamp(comment.created_at)}
                    </time>
                    {comment.updated_at !== comment.created_at ? (
                      <span className="td-comment__when">edited</span>
                    ) : null}
                  </div>

                  {editingId === comment.id ? (
                    <>
                      <textarea
                        className="td-desc__ta td-comment__ta"
                        rows={2}
                        autoFocus
                        value={editDraft}
                        aria-label={`Edit comment by ${label}`}
                        onChange={(e) => {
                          setEditDraft(e.target.value);
                          autoGrow(e.target);
                        }}
                      />
                      <div className="td-comment__acts">
                        <button
                          type="button"
                          className="d3-btn d3-btn--primary"
                          disabled={editDraft.trim() === ""}
                          onClick={() => void commitEdit(comment)}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="d3-btn d3-btn--ghost"
                          onClick={() => setEditingId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="td-para">
                        <AgentMarkdown text={comment.body} />
                      </div>
                      <div className="td-comment__acts">
                        <button
                          type="button"
                          className="td-ghost"
                          onClick={() => {
                            setEditDraft(comment.body);
                            setEditingId(comment.id);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="td-ghost"
                          aria-label={`Delete comment by ${label}`}
                          onClick={() => onDelete(comment.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
