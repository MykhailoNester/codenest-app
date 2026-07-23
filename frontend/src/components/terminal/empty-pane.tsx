/**
 * empty-pane.tsx
 *
 * Placeholder rendered for grid cells that have no backing PTY yet
 * (workspace-mode sparse cells).  Displays the target project + provider
 * names and offers an "Open shell here" button that allocates a real PTY
 * via `replaceEmptyLeaf`.
 */

import type { ReactElement } from "react";
import { useTerminalStore } from "../../stores/terminal-store";
import styles from "./empty-pane.module.css";

interface EmptyPaneProps {
  /** The leaf's placeholder terminalId (e.g. `"pending-2"`). */
  leafId: string;
  /** Display name of the target project, or undefined when unknown. */
  projectName?: string;
  /** Display name of the target provider, or undefined when unknown. */
  providerName?: string;
  /** Working directory to use when opening the shell. */
  cwd?: string;
  /** Init command to write after the shell opens (e.g. the provider command). */
  initCommand?: string;
}

export function EmptyPane({
  leafId,
  projectName,
  providerName,
  cwd,
  initCommand,
}: EmptyPaneProps): ReactElement {
  const replaceEmptyLeaf = useTerminalStore((s) => s.replaceEmptyLeaf);

  function handleOpen(): void {
    void replaceEmptyLeaf(leafId, { cwd, initCommand });
  }

  return (
    <div className={styles.pane}>
      <div className={styles.meta}>
        {projectName !== undefined && (
          <span className={styles.projectName}>{projectName}</span>
        )}
        {providerName !== undefined && (
          <span className={styles.providerName}>{providerName}</span>
        )}
      </div>
      <button type="button" className={styles.openBtn} onClick={handleOpen}>
        Open shell here
      </button>
    </div>
  );
}
