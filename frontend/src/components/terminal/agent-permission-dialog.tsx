/**
 * The permission request as real chrome — a titled, warn-toned dialog with
 * Allow / Allow for this session / Deny, and a working ⏎ / A / esc keyboard
 * model. This is the clearest thing the native agent pane does better than a
 * numbered-list prompt inside a redraw-heavy TUI (research §11), so its
 * keyboard model is its own component and is testable without a live
 * session.
 */

import { useEffect, useRef } from "react";
import type { CSSProperties, ReactElement } from "react";
import {
  permissionInputSummary,
  type PermissionRequest,
} from "../../lib/agent-conversation";

/* ── Local constants ─────────────────────────────────────────────────────
   The permission ask, on Deck's dialog primitive (`.dk-modal*`). It is
   deliberately NOT inside `.dk-scrim`: the ask belongs to one pane, several
   panes can hold one at once, and `isFocusedPane` decides which of them
   answers a keystroke. A viewport-fixed scrim would let a background pane's
   ask cover the whole window, so the modal box renders inline in the transcript
   and only its chrome comes from Deck.

   The buttons are Deck's own and are untouched by this file: Allow is the one
   `.dk-btn.pri` on the surface, Deny is the one `.dk-btn.danger`, and the
   separator before Deny is `.dk-actions .sep` — per the README's rule that a
   destructive action is never adjacent to the primary. Nothing below changes
   which button is which.

   Everything here is geometry or tone Deck has no opinion about, declared here
   rather than in `components/deck/*` or `design/deck/*`, which #283 does not
   touch — the precedent is the composer's `EDITOR_*` constants. Inline, so an
   override of a `.dk-*` rule does not depend on stylesheet injection order. */

/** The ask fills the transcript column and is warn-toned, because it is the
 *  one thing in the stream that is waiting on the reader. */
const PERM_STYLE: CSSProperties = {
  width: "100%",
  maxHeight: "none",
  margin: "var(--u2) 0",
  borderColor: "var(--warn)",
};

/** `.dk-modal__h` is written for a `div`; this is an `h5`, so the heading's own
 *  UA margin and weight have to go. */
const TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontWeight: 400,
  color: "var(--warn)",
  borderBottomColor: "var(--warn)",
};

/** The tool name and the queue position, inside the title bar but not part of
 *  the label: `Bash` is data and `(1 of 3)` is a count, so neither takes the
 *  bar's uppercase. */
const COUNT_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  textTransform: "none",
  letterSpacing: 0,
  color: "var(--fg-2)",
};

/** What is actually being approved — the command, path or URL from the
 *  request's `input`. Scrolls and breaks rather than wrapping unboundedly, so a
 *  long command can never push the buttons out of the pane: the reader must be
 *  able to reach Deny without scrolling the transcript. */
const TARGET_STYLE: CSSProperties = {
  margin: "0 0 var(--u2)",
  padding: "var(--u) 6px",
  maxHeight: 84,
  overflow: "auto",
  background: "var(--bg)",
  border: "1px solid var(--line)",
  borderRadius: 3,
  fontFamily: "var(--mono)",
  fontSize: "var(--fs-s)",
  color: "var(--fg)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const BODY_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--fs-s)",
  color: "var(--fg-2)",
  wordBreak: "break-word",
};

const NOTE_STYLE: CSSProperties = {
  margin: "var(--u2) 0 0",
  fontFamily: "var(--sans)",
  fontSize: "var(--fs-s)",
  color: "var(--fg-3)",
};

/** The keycap hint sits inside its button rather than beside it, so the footer
 *  stays one `.dk-actions` cluster. It inherits the button's colour rather than
 *  naming one: `.dk-btn.pri` inverts to the ground and a fixed colour would
 *  vanish into the fill. */
const KBD_STYLE: CSSProperties = {
  marginLeft: "var(--u)",
  fontSize: "var(--fs-xs)",
  opacity: 0.65,
};

interface AgentPermissionDialogProps {
  request: PermissionRequest;
  /** Only the focused pane's dialog answers a keystroke — two background
   * tabs each holding a request must not both answer one `Enter`. */
  isFocusedPane: boolean;
  /** How many requests are queued behind this one. Rendered in the title, not
   *  only as a footnote below the buttons: a second ask arriving the instant
   *  the first is answered is the thing that reads as a dropped click. */
  pendingBehind: number;
  onAllow: () => void;
  onAllowSession: () => void;
  onDeny: () => void;
}

export function AgentPermissionDialog({
  request,
  isFocusedPane,
  pendingBehind,
  onAllow,
  onAllowSession,
  onDeny,
}: AgentPermissionDialogProps): ReactElement {
  const allowRef = useRef<HTMLButtonElement>(null);

  // Keyed on `requestId` so answering one request and immediately being shown
  // the next re-focuses Allow rather than leaving focus on a button that now
  // belongs to a different ask.
  useEffect(() => {
    allowRef.current?.focus();
  }, [request.requestId]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!isFocusedPane) return;

      // A user who deliberately clicks into the composer's editor keeps
      // typing — including the letter "a" — rather than firing "Allow for
      // this session".
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("[data-agent-composer]")) return;

      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        onAllow();
        return;
      }
      if ((e.key === "a" || e.key === "A") && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        onAllowSession();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onDeny();
      }
    };

    // Capture phase so the global Escape/⌘↩ handlers in
    // use-terminal-shortcuts.ts never see a keystroke this dialog answered.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isFocusedPane, onAllow, onAllowSession, onDeny]);

  const name = request.displayName ?? request.toolName;
  const summary = permissionInputSummary(request.toolName, request.input);
  // `decision_reason` is the CLI's own consent line and says *why* this ask
  // escalated; `description` is the tool's own blurb. Showing the reason first
  // matters for a compound Bash command, where the reason names the subcommand
  // that actually needs approving and the description does not.
  const body =
    request.decisionReason ??
    request.description ??
    (request.blockedPath !== null
      ? `Path outside the allowed roots: ${request.blockedPath}`
      : "This tool call requires approval.");

  return (
    <div className="dk-modal" style={PERM_STYLE} data-permission-dialog>
      <h5 className="dk-modal__h" style={TITLE_STYLE}>
        ⚠ permission
        <span style={COUNT_STYLE}>
          {name}
          {pendingBehind > 0 ? ` (1 of ${pendingBehind + 1})` : ""}
        </span>
      </h5>
      <div className="dk-modal__b">
        {summary !== null ? (
          <pre style={TARGET_STYLE} title={summary}>
            {summary}
          </pre>
        ) : null}
        <p style={BODY_STYLE}>{body}</p>
        {/*
          A compound Bash command (`a && b && c`) is safety-checked per
          subcommand, so the CLI asks once per part — sequentially, each ask
          arriving only after the previous is answered. Without this line the
          second dialog is indistinguishable from the first and the honest
          behaviour reads as "Allow needed two clicks".
        */}
        {request.decisionReasonType === "subcommandResults" ? (
          <p style={NOTE_STYLE}>
            Part of a compound command — each part is approved separately, so
            expect a further prompt.
          </p>
        ) : null}
      </div>
      <div className="dk-modal__f">
        <span className="dk-actions">
          <button ref={allowRef} type="button" className="dk-btn pri" onClick={onAllow}>
            Allow <span style={KBD_STYLE}>⏎</span>
          </button>
          <button
            type="button"
            className="dk-btn"
            onClick={onAllowSession}
            title={`Auto-allows further "${request.sessionKey}" for the rest of this session`}
          >
            Allow for this session <span style={KBD_STYLE}>A</span>
          </button>
          <span className="sep" />
          <button type="button" className="dk-btn danger" onClick={onDeny}>
            Deny <span style={KBD_STYLE}>esc</span>
          </button>
        </span>
      </div>
    </div>
  );
}
