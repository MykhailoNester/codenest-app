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
import type { PermissionRequest } from "../../lib/agent-conversation";
import styles from "./agent-permission-dialog.module.css";

interface AgentPermissionDialogProps {
  request: PermissionRequest;
  /** Only the focused pane's dialog answers a keystroke — two background
   * tabs each holding a request must not both answer one `Enter`. */
  isFocusedPane: boolean;
  onAllow: () => void;
  onAllowSession: () => void;
  onDeny: () => void;
}

export function AgentPermissionDialog({
  request,
  isFocusedPane,
  onAllow,
  onAllowSession,
  onDeny,
}: AgentPermissionDialogProps): ReactElement {
  const allowRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    allowRef.current?.focus();
  }, []);

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

  return (
    <div className={styles.perm} data-permission-dialog>
      <h5 className={styles.permTitle}>⚠ Permission — {name}</h5>
      <p className={styles.permBody}>
        {request.description ?? "This tool call requires approval."}
      </p>
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
    </div>
  );
}
