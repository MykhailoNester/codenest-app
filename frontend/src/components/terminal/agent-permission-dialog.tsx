/**
 * The permission request as real chrome — a titled, warn-toned dialog with
 * Allow / Allow for this session / Deny, and a working ⏎ / A / esc keyboard
 * model. This is the clearest thing the native agent pane does better than a
 * numbered-list prompt inside a redraw-heavy TUI (research §11), so its
 * keyboard model is its own component and is testable without a live
 * session.
 */

import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import {
  permissionInputSummary,
  type PermissionRequest,
} from "../../lib/agent-conversation";
import styles from "./agent-permission-dialog.module.css";

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
    <div className={styles.perm} data-permission-dialog>
      <h5 className={styles.permTitle}>
        ⚠ Permission — {name}
        {pendingBehind > 0 ? (
          <span className={styles.permCount}>
            {" "}
            (1 of {pendingBehind + 1})
          </span>
        ) : null}
      </h5>
      {summary !== null ? (
        <pre className={styles.permTarget} title={summary}>
          {summary}
        </pre>
      ) : null}
      <p className={styles.permBody}>{body}</p>
      <div className={styles.permBtns}>
        <button
          ref={allowRef}
          type="button"
          className={`${styles.permBtn} ${styles.btnPri}`}
          onClick={onAllow}
        >
          Allow <span className={styles.kbd}>⏎</span>
        </button>
        <button
          type="button"
          className={styles.permBtn}
          onClick={onAllowSession}
          title={`Auto-allows further "${request.sessionKey}" for the rest of this session`}
        >
          Allow for this session <span className={styles.kbd}>A</span>
        </button>
        <button
          type="button"
          className={`${styles.permBtn} ${styles.btnDanger}`}
          onClick={onDeny}
        >
          Deny <span className={styles.kbd}>esc</span>
        </button>
      </div>
      {/*
        A compound Bash command (`a && b && c`) is safety-checked per
        subcommand, so the CLI asks once per part — sequentially, each ask
        arriving only after the previous is answered. Without this line the
        second dialog is indistinguishable from the first and the honest
        behaviour reads as "Allow needed two clicks".
      */}
      {request.decisionReasonType === "subcommandResults" ? (
        <p className={styles.permNote}>
          Part of a compound command — each part is approved separately, so
          expect a further prompt.
        </p>
      ) : null}
    </div>
  );
}
