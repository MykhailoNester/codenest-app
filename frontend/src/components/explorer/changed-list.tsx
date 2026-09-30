/**
 * Changed mode — git status across every resolved root, grouped by project.
 * This is the view a user actually keeps open while supervising an agent: a
 * file tree never shows "what did the agent just touch", git status does.
 */

import type { ReactElement } from "react";
import type { GitFileStatus, GitRootStatus } from "../../lib/ipc";
import { useExplorerStore } from "../../stores/explorer-store";
import type { RootDescriptor } from "../../lib/explorer/roots";
import { DECK_GS_CLASSES, gsClassFor } from "../../lib/explorer/git-status";
import { writePathDragPayload } from "../../lib/explorer/drag-payload";
import { formatCount } from "../../lib/format-helpers";
import { DECK_COLS } from "../deck/deck-cols";
import { DeckGrid, DeckLine, type DeckState } from "../deck/deck-grid";

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

/** A deletion is the one status worth flagging red in column one; everything
 *  else is a live edit. The letter in the trailing column carries the detail. */
function fileState(status: string): DeckState {
  return status === "D" ? "fail" : "run";
}

export function ChangedList({ roots }: ChangedListProps): ReactElement {
  const gitByRootId = useExplorerStore((s) => s.gitByRootId);
  const query = useExplorerStore((s) => s.query);

  if (roots.length === 0) {
    return (
      <div className="dk-note">
        No projects imported yet — import one from Projects.
      </div>
    );
  }

  return (
    <DeckGrid
      cols={DECK_COLS.tree}
      className="tree"
      role="tree"
      manageFocus={false}
      label="Changed"
    >
      {roots.map((root) => {
        const git = gitByRootId[root.id];
        const files = (git?.files ?? []).filter((f) => matchesQuery(f, query));
        return (
          <div key={root.id}>
            <div
              className="dk-head"
              style={{ gridTemplateColumns: "1fr auto" }}
            >
              <span>
                {root.label} · {git?.branch ?? "detached"}
              </span>
              <span>{groupSummary(git)}</span>
            </div>
            {git?.isRepo &&
              files.map((file) => {
                const absPath = `${git.repoRoot}/${file.path}`;
                return (
                  <DeckLine
                    key={absPath}
                    role="treeitem"
                    state={fileState(file.status)}
                    cells={[
                      {
                        v: (
                          <span
                            className="dk-tree__n"
                            style={{ paddingLeft: 9 }}
                          >
                            <span
                              className={gsClassFor(
                                file.status,
                                DECK_GS_CLASSES,
                              )}
                            >
                              {file.status}
                            </span>
                            <span className="l">{file.path}</span>
                          </span>
                        ),
                        title: absPath,
                      },
                      {
                        v:
                          file.added !== null || file.removed !== null ? (
                            <span className="dk-meta">
                              {file.added !== null && (
                                <span className="add">+{file.added}</span>
                              )}{" "}
                              {file.removed !== null && (
                                <span className="del">−{file.removed}</span>
                              )}
                            </span>
                          ) : (
                            ""
                          ),
                        cls: "r",
                      },
                    ]}
                    rowProps={{
                      draggable: true,
                      onDragStart: (e) =>
                        writePathDragPayload(e.dataTransfer, [absPath]),
                    }}
                  />
                );
              })}
            {git?.truncated && (
              <div className="dk-note">
                showing first {formatCount(MAX_STATUS_FILES)}
              </div>
            )}
          </div>
        );
      })}
    </DeckGrid>
  );
}
