/**
 * Find mode (prototype `.x-find`, markup lines 574-586) — the ⌘P palette's
 * body. Modelled as a fourth `.tree` body rather than a modal, per Design
 * decision 11: the main window renders it inside `.tree` when
 * `mode === "find"`; `<FindPaletteOverlay>` renders the same component
 * inside a centred card for the popout.
 *
 * The prototype's `↵ Add to composer as context ⏎` action row is
 * deliberately omitted — there is no composer on this branch (that is
 * `feature/agent-pane-composer`'s deliverable; the drag-payload MIME
 * contract is the seam). `⏎` is rebound to Reveal in Finder instead of
 * being left dead.
 *
 * The result the actions act on is `explorer-store`'s `selectedPath` (kept
 * pointed at the top-ranked row below), not local component state — the
 * search input's Enter/⇧Enter/⌘Enter shortcuts in `<WorkspaceNavigator>`
 * and `<FindPaletteOverlay>` read the same field via `useFindActions`, so
 * a click here and a keyboard shortcut there always agree on the target.
 */

import { useEffect, useMemo, type ReactElement } from "react";
import type { FileIndex } from "../../lib/ipc";
import { useFindActions } from "../../hooks/use-find-actions";
import { useExplorerStore } from "../../stores/explorer-store";
import type { RootDescriptor } from "../../lib/explorer/roots";
import { fuzzyRank, type FuzzyMatch } from "../../lib/explorer/fuzzy";
import {
  DECK_ICON_CLASSES,
  iconForEntry,
  iconClassFor,
} from "../../lib/explorer/file-icons";
import { DECK_COLS } from "../deck/deck-cols";
import { DeckGrid, DeckLine } from "../deck/deck-grid";

export interface ExplorerFindProps {
  roots: RootDescriptor[];
}

interface Candidate {
  rootId: string;
  root: RootDescriptor;
  relPath: string;
  absPath: string;
}

const RESULT_LIMIT = 50;

function sourceLabel(indexes: FileIndex[]): string {
  if (indexes.length === 0) return "no index yet";
  const sources = new Set(indexes.map((i) => i.source));
  if (sources.size > 1) return "mixed";
  return indexes[0]?.source === "git" ? "git ls-files" : "walk";
}

/** Render `path` with its matched ranges wrapped in `<b>`, the same
 *  highlight the prototype hard-codes (`<b style="color:var(--accent)">`). */
function highlightRanges(
  path: string,
  ranges: FuzzyMatch["ranges"],
): ReactElement {
  const pieces: ReactElement[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], i) => {
    if (start > cursor) {
      pieces.push(<span key={`${i}-pre`}>{path.slice(cursor, start)}</span>);
    }
    pieces.push(<b key={`${i}-hit`}>{path.slice(start, end)}</b>);
    cursor = end;
  });
  if (cursor < path.length) {
    pieces.push(<span key="tail">{path.slice(cursor)}</span>);
  }
  return <>{pieces}</>;
}

export function ExplorerFind({ roots }: ExplorerFindProps): ReactElement {
  const query = useExplorerStore((s) => s.query);
  const indexByRootId = useExplorerStore((s) => s.indexByRootId);
  const selectedPath = useExplorerStore((s) => s.selectedPath);
  const setSelectedPath = useExplorerStore((s) => s.setSelectedPath);
  const {
    hasSelection,
    canPaste,
    openSelected,
    pasteSelected,
    revealSelected,
  } = useFindActions();

  const rootById = useMemo(() => new Map(roots.map((r) => [r.id, r])), [roots]);

  const candidates = useMemo<Candidate[]>(() => {
    const list: Candidate[] = [];
    for (const [rootId, index] of Object.entries(indexByRootId)) {
      const root = rootById.get(rootId);
      if (!root) continue;
      for (const relPath of index.files) {
        list.push({
          rootId,
          root,
          relPath,
          absPath: `${index.root}/${relPath}`,
        });
      }
    }
    return list;
  }, [indexByRootId, rootById]);

  const trimmedQuery = query.trim();
  const ranked = useMemo(
    () =>
      trimmedQuery
        ? fuzzyRank(
            trimmedQuery,
            candidates,
            (c) => c.relPath,
            candidates.length,
          )
        : [],
    [trimmedQuery, candidates],
  );
  const shown = ranked.slice(0, RESULT_LIMIT);

  const indexes = Object.values(indexByRootId);
  const anyTruncated = indexes.some((i) => i.truncated);
  const skippedNonUtf8 = indexes.reduce((sum, i) => sum + i.skippedNonUtf8, 0);

  // Keep the shared `selectedPath` pointed at a row that is actually shown,
  // defaulting to the top-ranked result — this is what the search input's
  // keyboard shortcuts (Enter / ⇧Enter / ⌘Enter) act on.
  useEffect(() => {
    const first = shown[0];
    if (!first) return;
    const stillShown = shown.some((r) => r.item.absPath === selectedPath);
    if (!stillShown) setSelectedPath(first.item.absPath);
  }, [shown, selectedPath, setSelectedPath]);

  const actions: {
    glyph: string;
    label: string;
    kbd: string;
    disabled: boolean;
    title?: string;
    run: () => void;
  }[] = [
    {
      glyph: "↗",
      label: "Open in editor",
      kbd: "⌘⏎",
      disabled: !hasSelection,
      run: openSelected,
    },
    {
      glyph: "⌗",
      label: "Paste path into shell pane",
      kbd: "⇧⏎",
      disabled: !canPaste,
      ...(canPaste ? {} : { title: "Focus a terminal pane to paste into" }),
      run: pasteSelected,
    },
    {
      glyph: "⇱",
      label: "Reveal in Finder",
      kbd: "⏎",
      disabled: !hasSelection,
      run: revealSelected,
    },
  ];

  return (
    <DeckGrid
      cols={DECK_COLS.tree}
      className="tree"
      role="tree"
      manageFocus={false}
      label="Find"
    >
      <div className="dk-head" style={{ gridTemplateColumns: "1fr auto" }}>
        <span>{ranked.length} matches</span>
        <span>
          {sourceLabel(indexes)} · {indexes.length} roots
        </span>
      </div>
      {anyTruncated && <div className="dk-note">index truncated</div>}
      {skippedNonUtf8 > 0 && (
        <div className="dk-note">
          {skippedNonUtf8} files skipped (non-UTF-8)
        </div>
      )}
      {!trimmedQuery && <div className="dk-note">Type to search files…</div>}
      {shown.map(({ item, match }) => {
        const icon = iconForEntry(
          item.relPath.slice(item.relPath.lastIndexOf("/") + 1),
          false,
          false,
        );
        return (
          <DeckLine
            key={item.absPath}
            role="treeitem"
            selected={selectedPath === item.absPath}
            cells={[
              {
                v: (
                  <span className="dk-tree__n" style={{ paddingLeft: 9 }}>
                    <span className="t" aria-hidden="true" />
                    <span
                      className={`g ${iconClassFor(icon.tone, DECK_ICON_CLASSES)}`}
                      aria-hidden="true"
                    >
                      {icon.glyph}
                    </span>
                    <span className="l">
                      {highlightRanges(item.relPath, match.ranges)}
                    </span>
                  </span>
                ),
                title: item.absPath,
              },
              {
                v: <span className="dk-meta">{item.root.label}</span>,
                cls: "r",
              },
            ]}
            rowProps={{ "aria-selected": selectedPath === item.absPath }}
            onOpen={() => setSelectedPath(item.absPath)}
          />
        );
      })}

      <div className="dk-head" style={{ gridTemplateColumns: "1fr" }}>
        <span>actions</span>
      </div>
      {actions.map((a) => (
        <DeckLine
          key={a.label}
          role="treeitem"
          cells={[
            {
              v: (
                <span className="dk-tree__n" style={{ paddingLeft: 9 }}>
                  <span className="t" aria-hidden="true" />
                  <span className="g" aria-hidden="true">
                    {a.glyph}
                  </span>
                  <span className="l">{a.label}</span>
                </span>
              ),
              title: a.label,
            },
            { v: <span className="dk-meta">{a.kbd}</span>, cls: "r" },
          ]}
          rowProps={{
            "aria-disabled": a.disabled || undefined,
            ...(a.title !== undefined ? { title: a.title } : {}),
          }}
          {...(a.disabled ? {} : { onOpen: a.run })}
        />
      ))}
    </DeckGrid>
  );
}
