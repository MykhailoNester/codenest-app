/**
 * EventDetailModal — drill-down view for a single agent event.
 *
 * Renderers:
 *   UserPromptSubmit → PromptRenderer (markdown)
 *   PreToolUse/PostToolUse + Bash → BashRenderer (monospace + copy)
 *   PreToolUse/PostToolUse + Read/Write/Edit → FileOpsRenderer (path + content)
 *   everything else → GenericJsonRenderer (collapsible JSON tree)
 *
 * The component accepts an EventLike interface that is structurally compatible
 * with both RecentEvent (live-activity) and AgentEvent (replay-panel).
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentEvent } from "../../lib/api";

// ─── Local constants ──────────────────────────────────────────────────────────
//
// Deck has no primitive for the four below. `components/deck/*` and
// `design/deck/*` are out of scope for #283, so they are declared here — the
// precedent is `ATTENTION_COLS` in `pages/attention.tsx` and the launch
// composer's `SCRIM_STYLE` / `MODAL_STYLE`.

/** `.dk-scrim` is z-index 60, enough for a scrim raised inside a Deck page.
 *  This one portals to `document.body` over the whole app — including the
 *  terminal pane's own portals — so it keeps the z-index its stylesheet used
 *  verbatim. A restyle must not reorder what covers what. */
const SCRIM_STYLE: CSSProperties = { zIndex: 400 };

/** A Deck frame carries one neutral border and has no semantic variant, but
 *  Deck's colour vocabulary is the point here: stderr and a deleted diff half
 *  are `--err`, an added half is `--ok`. Tokens, never hex. */
const TONE_FRAME: Record<"err" | "ok", CSSProperties> = {
  err: { borderColor: "var(--err)" },
  ok: { borderColor: "var(--ok)" },
};
const TONE_LABEL: Record<"err" | "ok", CSSProperties> = {
  err: { color: "var(--err)" },
  ok: { color: "var(--ok)" },
};

/** Real transcript payloads carry unbroken 500-character commands, paths and
 *  JSON blobs. `.dk-term__b` is `pre-wrap`, which breaks on whitespace only, so
 *  without this an unbroken run escapes its frame instead of wrapping inside
 *  it. `anywhere` also lets the frame keep its own width in the grid. */
const CODE_PRE_STYLE: CSSProperties = {
  margin: 0,
  overflowWrap: "anywhere",
  fontFamily: "var(--mono)",
};

/** `.sp` is `margin-left: auto` only inside the specific headers deck.css
 *  names, and `.dk-term__h` is not one of them. */
const PUSH_END: CSSProperties = { marginLeft: "auto" };

// ─── Structural interface ─────────────────────────────────────────────────────

/**
 * Minimum shape required by this component.
 * Derived from AgentEvent so changes to the API type propagate here automatically.
 * Structurally compatible with RecentEvent (live-activity) and AgentEvent (replay).
 */
export type EventLike = Pick<
  AgentEvent,
  "id" | "session_id" | "event_type" | "tool_name" | "summary" | "payload_json" | "created_at"
>;

export interface EventDetailModalProps {
  event: EventLike;
  onClose: () => void;
  /** When provided, a "Jump to session replay" button is shown in the footer. */
  onJumpToSession?: ((sessionId: string) => void) | undefined;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeParseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** True when the event still carries a tool body. New rows are trimmed at the
 *  sidecar insert (payload allowlist, #159) and carry neither; legacy rows do. */
function hasStoredToolBody(payload: Record<string, unknown> | null): boolean {
  if (payload === null) return false;
  const toolInput = payload["tool_input"];
  if (
    typeof toolInput === "object" &&
    toolInput !== null &&
    !Array.isArray(toolInput) &&
    Object.keys(toolInput).length > 0
  ) {
    return true;
  }
  const toolResponse = payload["tool_response"];
  if (toolResponse !== null && toolResponse !== undefined) {
    return true;
  }
  return false;
}

function fmtTimestamp(iso: string): string {
  try {
    const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function eventTitle(ev: EventLike): string {
  if (ev.event_type === "UserPromptSubmit") return "User Prompt";
  if (ev.event_type === "SessionEnd") return "Session End";
  if (ev.event_type === "Stop") return "Stop";
  if (ev.tool_name)
    return `${ev.event_type === "PostToolUse" ? "Post" : "Pre"}: ${ev.tool_name}`;
  return ev.event_type;
}

// ─── Copy button ──────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleCopy() {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      },
      () => {
        // clipboard write failed silently — nothing to surface
      },
    );
  }

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <button
      type="button"
      className="dk-btn bare"
      onClick={handleCopy}
      aria-label="Copy to clipboard"
      title={copied ? "Copied!" : "Copy to clipboard"}
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

// ─── Framed output block ──────────────────────────────────────────────────────

/** `.dk-out` is Deck's framed output pane: `.dk-term__h` is the label strip,
 *  `.dk-term__b` the scrolling body. One of these replaces every
 *  `.codeHeader` + `.codeBlock` pair the stylesheet used to draw. */
function OutBlock({
  label,
  text,
  tone,
  tintBody,
}: {
  label: string;
  text: string;
  /** Frames and labels the block in Deck's terminal semantics. */
  tone?: "err" | "ok" | undefined;
  /** stderr tinted its text as well as its frame; a diff half never did. */
  tintBody?: boolean | undefined;
}): ReactElement {
  return (
    <div className="dk-out" style={tone ? TONE_FRAME[tone] : undefined}>
      <div className="dk-term__h">
        <span className="dk-label" style={tone ? TONE_LABEL[tone] : undefined}>
          {label}
        </span>
        <span style={PUSH_END}>
          <CopyButton text={text} />
        </span>
      </div>
      <pre className="dk-term__b" style={CODE_PRE_STYLE}>
        {tintBody === true ? <span className="e">{text}</span> : text}
      </pre>
    </div>
  );
}

/** A disclosure row. The old markup nested the Copy `<button>` inside the
 *  toggle `<button>`, which is invalid HTML and made the toggle's accessible
 *  name read "▾ Payload Copy"; they are siblings in a `.dk-actions` cluster
 *  now, which is also the rule the Deck README sets for action clusters. */
function Collapse({
  label,
  open,
  onToggle,
  children,
  extra,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactElement | null;
  extra?: ReactElement | null | undefined;
}): ReactElement {
  return (
    <div>
      <div className="dk-actions">
        <button
          type="button"
          className="dk-btn bare"
          onClick={onToggle}
          aria-expanded={open}
        >
          <span aria-hidden="true">{open ? "▾" : "▸"}</span>
          {label}
        </button>
        {extra}
      </div>
      {open && children}
    </div>
  );
}

// ─── Prompt renderer ──────────────────────────────────────────────────────────

function PromptRenderer({
  payload,
}: {
  payload: Record<string, unknown> | null;
}): ReactElement {
  const prompt =
    typeof payload?.["prompt"] === "string" ? payload["prompt"] : null;

  if (!prompt) {
    return <span className="dk-meta">(no prompt text)</span>;
  }

  return (
    // `.dk-prose` caps the measure at 80ch but has no rule for a fenced block,
    // and a prompt is mostly pasted code and paths. `overflowWrap` carries
    // what the stylesheet's `word-break: break-all` did for inline tokens; the
    // `pre` override puts a fenced block in the same frame every other code
    // block in this modal uses, so it wraps and scrolls instead of escaping.
    <div className="dk-prose" style={{ overflowWrap: "anywhere" }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => (
            <div className="dk-out">
              <pre className="dk-term__b" style={CODE_PRE_STYLE}>
                {children}
              </pre>
            </div>
          ),
        }}
      >
        {prompt}
      </ReactMarkdown>
    </div>
  );
}

// ─── Bash renderer ────────────────────────────────────────────────────────────

function BashRenderer({
  payload,
}: {
  payload: Record<string, unknown> | null;
}): ReactElement {
  const toolInput = (
    typeof payload?.["tool_input"] === "object" &&
    payload["tool_input"] !== null
      ? payload["tool_input"]
      : {}
  ) as Record<string, unknown>;

  const toolResponse = (
    typeof payload?.["tool_response"] === "object" &&
    payload["tool_response"] !== null
      ? payload["tool_response"]
      : null
  ) as Record<string, unknown> | null;

  const command =
    typeof toolInput["command"] === "string" ? toolInput["command"] : null;
  const description =
    typeof toolInput["description"] === "string"
      ? toolInput["description"]
      : null;
  const stdout =
    typeof toolResponse?.["stdout"] === "string"
      ? toolResponse["stdout"]
      : null;
  const stderr =
    typeof toolResponse?.["stderr"] === "string"
      ? toolResponse["stderr"]
      : null;

  // Default open — the most common need is to see what happened immediately.
  const [outputOpen, setOutputOpen] = useState(true);

  if (!command) {
    return <GenericJsonRenderer payload={payload} />;
  }

  const empty =
    (stdout === "" || stdout === null) && (stderr === "" || stderr === null);

  return (
    <DeckStack>
      {description !== null && (
        <div className="dk-kv">
          <span>description</span>
          <span>{description}</span>
        </div>
      )}
      <OutBlock label="command" text={command} />

      {(stdout !== null || stderr !== null) && (
        <Collapse
          label="Output"
          open={outputOpen}
          onToggle={() => setOutputOpen((v) => !v)}
          extra={
            toolResponse?.["interrupted"] === true ? (
              <span className="dk-tag" data-s="fail">
                interrupted
              </span>
            ) : null
          }
        >
          <DeckStack>
            {stdout !== null && stdout !== "" && (
              <OutBlock label="stdout" text={stdout} />
            )}
            {stderr !== null && stderr !== "" && (
              <OutBlock label="stderr" text={stderr} tone="err" tintBody />
            )}
            {empty && <span className="dk-meta">(no output)</span>}
          </DeckStack>
        </Collapse>
      )}
    </DeckStack>
  );
}

// ─── File-ops renderer (Read / Write / Edit) ──────────────────────────────────

function FileOpsRenderer({
  toolName,
  payload,
}: {
  toolName: string;
  payload: Record<string, unknown> | null;
}): ReactElement {
  const toolInput = (
    typeof payload?.["tool_input"] === "object" &&
    payload["tool_input"] !== null
      ? payload["tool_input"]
      : {}
  ) as Record<string, unknown>;

  const filePath =
    typeof toolInput["file_path"] === "string" ? toolInput["file_path"] : null;
  const content =
    typeof toolInput["content"] === "string" ? toolInput["content"] : null;
  const oldString =
    typeof toolInput["old_string"] === "string"
      ? toolInput["old_string"]
      : null;
  const newString =
    typeof toolInput["new_string"] === "string"
      ? toolInput["new_string"]
      : null;

  if (!filePath) {
    return <GenericJsonRenderer payload={payload} />;
  }

  return (
    <DeckStack>
      <div className="dk-kv">
        <span>{toolName.toLowerCase()}</span>
        {/* A real transcript path runs well past the second column; it wraps
            inside the row rather than widening the dialog. */}
        <code style={CODE_PRE_STYLE} title={filePath}>
          {filePath}
        </code>
      </div>

      {toolName === "Write" && content !== null && (
        <OutBlock label="content" text={content} />
      )}

      {toolName === "Edit" && (
        <>
          {oldString !== null && (
            <OutBlock label="old" text={oldString} tone="err" />
          )}
          {newString !== null && (
            <OutBlock label="new" text={newString} tone="ok" />
          )}
        </>
      )}

      {toolName === "Read" && (
        <div className="dk-actions">
          {toolInput["offset"] != null && (
            <span className="dk-meta">
              offset: {String(toolInput["offset"])}
            </span>
          )}
          {toolInput["limit"] != null && (
            <span className="dk-meta">limit: {String(toolInput["limit"])}</span>
          )}
        </div>
      )}
    </DeckStack>
  );
}

// ─── Generic JSON renderer ────────────────────────────────────────────────────

function GenericJsonRenderer({
  payload,
}: {
  payload: Record<string, unknown> | null;
}): ReactElement {
  const [open, setOpen] = useState(true);
  const text =
    payload !== null ? JSON.stringify(payload, null, 2) : "(no payload)";

  return (
    <Collapse
      label="Payload"
      open={open}
      onToggle={() => setOpen((v) => !v)}
      extra={payload !== null ? <CopyButton text={text} /> : null}
    >
      <div className="dk-out">
        <pre className="dk-term__b" style={CODE_PRE_STYLE}>
          {text}
        </pre>
      </div>
    </Collapse>
  );
}

/** Explains a trimmed tool event: the body was policy-dropped at the
 *  sidecar insert (#159), not lost by a bug in this renderer. */
function BodyNotStored(): ReactElement {
  return (
    <div className="dk-note sans">
      Tool body not stored — Codenest keeps the summary and provenance fields
      only.
    </div>
  );
}

/** The body's vertical rhythm. Deck separates with gaps rather than rules, and
 *  every block in this modal is a sibling in one column. */
const STACK_STYLE: CSSProperties = {
  display: "grid",
  gap: "var(--u3)",
  minWidth: 0,
};

function DeckStack({ children }: { children: ReactNode }): ReactElement {
  return <div style={STACK_STYLE}>{children}</div>;
}

// ─── Renderer dispatcher ──────────────────────────────────────────────────────

function renderBody(ev: EventLike): ReactElement {
  const payload = safeParseJson(ev.payload_json);

  if (ev.event_type === "UserPromptSubmit") {
    return <PromptRenderer payload={payload} />;
  }

  if (ev.event_type === "PreToolUse" || ev.event_type === "PostToolUse") {
    const tool = ev.tool_name ?? "";
    if (!hasStoredToolBody(payload)) {
      return (
        <DeckStack>
          <BodyNotStored />
          <GenericJsonRenderer payload={payload} />
        </DeckStack>
      );
    }
    if (tool === "Bash") {
      return <BashRenderer payload={payload} />;
    }
    if (tool === "Read" || tool === "Write" || tool === "Edit") {
      return <FileOpsRenderer toolName={tool} payload={payload} />;
    }
    return <GenericJsonRenderer payload={payload} />;
  }

  return <GenericJsonRenderer payload={payload} />;
}

// ─── Modal shell ──────────────────────────────────────────────────────────────

export function EventDetailModal({
  event: ev,
  onClose,
  onJumpToSession,
}: EventDetailModalProps): ReactElement {
  // ESC to close
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleJump = useCallback(() => {
    onJumpToSession?.(ev.session_id);
    onClose();
  }, [ev.session_id, onClose, onJumpToSession]);

  return createPortal(
    // `deck` because this portals to `document.body`, outside the `.deck` the
    // page draws inside — without it every Deck token resolves to nothing and
    // the dialog renders as an unstyled white box. `display: contents` keeps
    // the wrapper out of layout (`launch-composer.tsx` sets the precedent).
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
          className="dk-modal wide"
          role="dialog"
          aria-modal="true"
          // Static ID is safe here because at most one EventDetailModal is rendered
          // at a time (controlled by a single modalEvent state). If concurrent
          // instances ever appear, replace with useId().
          aria-labelledby="event-modal-title"
        >
          {/* Header */}
          <div className="dk-modal__h">
            <h2 id="event-modal-title">{eventTitle(ev)}</h2>
            <span className="dk-meta">{fmtTimestamp(ev.created_at)}</span>
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

          {/* Body — the summary strip leads it as a key/value row, the shape
              `session-inspect.tsx` uses for the same kind of field. */}
          <div className="dk-modal__b">
            <DeckStack>
              {ev.summary && (
                <div className="dk-kv">
                  <span>summary</span>
                  <span>{ev.summary}</span>
                </div>
              )}
              {renderBody(ev)}
            </DeckStack>
          </div>

          {/* Footer */}
          {onJumpToSession !== undefined && (
            <div className="dk-modal__f">
              <button type="button" className="dk-btn pri" onClick={handleJump}>
                Jump to session replay
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
