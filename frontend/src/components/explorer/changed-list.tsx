/**
 * Changed mode (prototype `.x-chg`, markup lines 561-571) — git status
 * across every resolved root, grouped by project. This is the view a user
 * actually keeps open while supervising an agent (research doc §12): a
 * file tree never shows "what did the agent just touch", git status does.
 */

import type { ReactElement } from "react";
import type { GitFileStatus, GitRootStatus } from "../../lib/ipc";
import { useExplorerStore } from "../../stores/explorer-store";
import type { RootDescriptor } from "../../lib/explorer/roots";
import { gsClassFor } from "../../lib/explorer/git-status";
import { writePathDragPayload } from "../../lib/explorer/drag-payload";
import { formatCount } from "../../lib/format-helpers";
import styles from "./workspace-navigator.module.css";

export interface ChangedListProps {
  roots: RootDescriptor[];
}

/** MAX_STATUS_FILES, `src-tauri/src/commands/git.rs:244`. */
const MAX_STATUS_FILES = 2_000;

function groupSummary(git: GitRootStatus | undefined): string {
  if (!git) return "";
  if (!git.isRepo) return "not a git repo";
  if (git.error !== null) return git.error;
  if (!git.dirty) return "clean";
  return `${git.files.length} files`;
}

function matchesQuery(file: GitFileStatus, query: string): boolean {
  if (!query) return true;
  return file.path.toLowerCase().includes(query.toLowerCase());
}

export function ChangedList({ roots }: ChangedListProps): ReactElement {
  const gitByRootId = useExplorerStore((s) => s.gitByRootId);
  const query = useExplorerStore((s) => s.query);

  if (roots.length === 0) {
    return (
      <div className={styles.tree}>
        <div className={styles.empty}>
          No projects imported yet — import one from Projects.
        </div>
      </div>
    );
  }

  return (
    <div className={styles.tree} role="tree" aria-label="Changed">
      {roots.map((root) => {
        const git = gitByRootId[root.id];
        const files = (git?.files ?? []).filter((f) => matchesQuery(f, query));
        return (
          <div key={root.id}>
            <div className={styles.grp}>
              {root.label} · {git?.branch ?? "detached"}
              <span className={styles.grpCnt}>{groupSummary(git)}</span>
            </div>
            {git?.isRepo &&
              files.map((file) => {
                const absPath = `${git.repoRoot}/${file.path}`;
                return (
                  <div
                    key={absPath}
                    className={`${styles.row} ${styles.d1}`}
                    draggable
                    onDragStart={(e) =>
                      writePathDragPayload(e.dataTransfer, [absPath])
                    }
                  >
                    <span className={styles.tw} aria-hidden="true" />
                    <span
                      className={`${styles.gs} ${gsClassFor(file.status, styles)}`}
                    >
                      {file.status}
                    </span>
                    <span className={styles.nm}>{file.path}</span>
                    {(file.added !== null || file.removed !== null) && (
                      <span className={styles.diffn}>
                        {file.added !== null && (
                          <span className={styles.diffAdded}>
                            +{file.added}
                          </span>
                        )}{" "}
                        {file.removed !== null && (
                          <span className={styles.diffRemoved}>
                            −{file.removed}
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                );
              })}
            {git?.truncated && (
              <div className={styles.empty}>
                showing first {formatCount(MAX_STATUS_FILES)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
