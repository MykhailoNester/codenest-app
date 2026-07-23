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
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentEvent } from "../../lib/api";
import styles from "./event-detail-modal.module.css";

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
      className={styles.copyBtn}
      onClick={handleCopy}
      aria-label="Copy to clipboard"
      title={copied ? "Copied!" : "Copy to clipboard"}
    >
      {copied ? "Copied!" : "Copy"}
    </button>
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
    return <span className={styles.emptyHint}>(no prompt text)</span>;
  }

  return (
    <div className={styles.promptBody}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{prompt}</ReactMarkdown>
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

  return (
    <div className={styles.bashBlock}>
      {description && <div className={styles.bashDesc}>{description}</div>}
      <div className={styles.codeHeader}>
        <span className={styles.codeLabel}>command</span>
        <CopyButton text={command} />
      </div>
      <pre className={styles.codeBlock}>{command}</pre>

      {(stdout !== null || stderr !== null) && (
        <div className={styles.outputSection}>
          <button
            type="button"
            className={styles.collapseToggle}
            onClick={() => setOutputOpen((v) => !v)}
            aria-expanded={outputOpen}
          >
            <span className={styles.collapseIcon}>
              {outputOpen ? "▾" : "▸"}
            </span>
            Output
            {toolResponse?.["interrupted"] === true && (
              <span className={styles.interruptedBadge}>interrupted</span>
            )}
          </button>
          {outputOpen && (
            <div className={styles.outputBody}>
              {stdout !== null && stdout !== "" && (
                <>
                  <div className={styles.streamLabel}>stdout</div>
                  <pre className={styles.codeBlock}>{stdout}</pre>
                </>
              )}
              {stderr !== null && stderr !== "" && (
                <>
                  <div
                    className={`${styles.streamLabel} ${styles.stderrLabel}`}
                  >
                    stderr
                  </div>
                  <pre className={`${styles.codeBlock} ${styles.stderrBlock}`}>
                    {stderr}
                  </pre>
                </>
              )}
              {(stdout === "" || stdout === null) &&
                (stderr === "" || stderr === null) && (
                  <span className={styles.emptyHint}>(no output)</span>
                )}
            </div>
          )}
        </div>
      )}
    </div>
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
    <div className={styles.fileBlock}>
      <div className={styles.filePath}>
        <span className={styles.filePathLabel}>{toolName.toLowerCase()}</span>
        <code className={styles.filePathValue}>{filePath}</code>
      </div>

      {toolName === "Write" && content !== null && (
        <>
          <div className={styles.codeHeader}>
            <span className={styles.codeLabel}>content</span>
            <CopyButton text={content} />
          </div>
          <pre className={styles.codeBlock}>{content}</pre>
        </>
      )}

      {toolName === "Edit" && (
        <>
          {oldString !== null && (
            <>
              <div className={styles.codeHeader}>
                <span className={`${styles.codeLabel} ${styles.deletedLabel}`}>
                  old
                </span>
                <CopyButton text={oldString} />
              </div>
              <pre className={`${styles.codeBlock} ${styles.deletedBlock}`}>
                {oldString}
              </pre>
            </>
          )}
          {newString !== null && (
            <>
              <div className={styles.codeHeader}>
                <span className={`${styles.codeLabel} ${styles.addedLabel}`}>
                  new
                </span>
                <CopyButton text={newString} />
              </div>
              <pre className={`${styles.codeBlock} ${styles.addedBlock}`}>
                {newString}
              </pre>
            </>
          )}
        </>
      )}

      {toolName === "Read" && (
        <div className={styles.readHint}>
          {toolInput["offset"] != null && (
            <span className={styles.readMeta}>
              offset: {String(toolInput["offset"])}
            </span>
          )}
          {toolInput["limit"] != null && (
            <span className={styles.readMeta}>
              limit: {String(toolInput["limit"])}
            </span>
          )}
        </div>
      )}
    </div>
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
    <div className={styles.genericBlock}>
      <button
        type="button"
        className={styles.collapseToggle}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={styles.collapseIcon}>{open ? "▾" : "▸"}</span>
        Payload
        {payload !== null && <CopyButton text={text} />}
      </button>
      {open && <pre className={styles.codeBlock}>{text}</pre>}
    </div>
  );
}

// ─── Renderer dispatcher ──────────────────────────────────────────────────────

function renderBody(ev: EventLike): ReactElement {
  const payload = safeParseJson(ev.payload_json);

  if (ev.event_type === "UserPromptSubmit") {
    return <PromptRenderer payload={payload} />;
  }

  if (ev.event_type === "PreToolUse" || ev.event_type === "PostToolUse") {
    const tool = ev.tool_name ?? "";
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
    <div className={styles.backdrop} role="presentation" onClick={onClose}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        // Static ID is safe here because at most one EventDetailModal is rendered
        // at a time (controlled by a single modalEvent state). If concurrent
        // instances ever appear, replace with useId().
        aria-labelledby="event-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <span id="event-modal-title" className={styles.title}>
              {eventTitle(ev)}
            </span>
            <span className={styles.timestamp}>
              {fmtTimestamp(ev.created_at)}
            </span>
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Summary strip */}
        {ev.summary && <div className={styles.summary}>{ev.summary}</div>}

        {/* Body */}
        <div className={styles.body}>{renderBody(ev)}</div>

        {/* Footer */}
        {onJumpToSession !== undefined && (
          <div className={styles.footer}>
            <button
              type="button"
              className={styles.jumpBtn}
              onClick={handleJump}
            >
              Jump to session replay
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
