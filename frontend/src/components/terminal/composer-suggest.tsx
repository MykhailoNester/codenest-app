/**
 * The presentational suggestion panel shared by the slash and mention menus,
 * and the render-nothing child that feeds the mention menu its data.
 *
 * `MentionSourceProbe` is the reason the react-query hooks it calls never
 * appear in `<AgentComposer/>` itself: that component must stay renderable
 * with no `QueryClientProvider` (`agent-pane-render.test.tsx`), so this probe
 * is mounted only while a mention is actually being typed (Design decision
 * 10), and reports its raw arrays upward once via `onSources`.
 *
 * Agents and skills come from the sidecar's invocables catalog, scoped to the
 * pane's cwd — not from the `members` table the agent group used to read, which
 * is hand-curated and empty on a normal install, so the group it fed was
 * structurally always empty however many agents the workspace had linked.
 *
 * This file exports components only — `react-refresh/only-export-components`
 * is an error in this repo's eslint config — so the `SuggestRow` type and the
 * two `*RowToSuggest` adapters live in `lib/composer-menu.ts` instead.
 */

import { useEffect, useMemo, useRef, type ReactElement } from "react";
import {
  useInvocables,
  useLibraryItems,
  useTasks,
  type InvocableItem,
} from "../../lib/api";
import type { InvocableSource, MentionSources } from "../../lib/composer-mentions";
import type { SuggestRow } from "../../lib/composer-menu";
import styles from "./agent-composer.module.css";

export function SuggestPanel({
  rows,
  activeIndex,
  anchor,
  onPick,
  onHover,
  footer,
}: {
  rows: SuggestRow[];
  activeIndex: number;
  anchor: { left: number; bottom: number };
  onPick: (index: number) => void;
  onHover: (index: number) => void;
  footer: string;
}): ReactElement {
  const activeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = activeRef.current;
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  return (
    <div
      className={styles.suggest}
      role="listbox"
      style={{ left: `${anchor.left}px`, bottom: `${anchor.bottom}px` }}
    >
      {rows.map((row, i) => (
        <div key={row.key}>
          {row.group !== null ? (
            <div className={styles.suggestGroup}>{row.group}</div>
          ) : null}
          <div
            ref={i === activeIndex ? activeRef : undefined}
            role="option"
            aria-selected={i === activeIndex}
            data-active={i === activeIndex ? "true" : undefined}
            className={
              i === activeIndex
                ? `${styles.suggestRow} ${styles.suggestRowActive}`
                : styles.suggestRow
            }
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(i)}
          >
            <span className={styles.suggestLabel}>{row.label}</span>
            <span className={styles.suggestMeta}>{row.meta}</span>
          </div>
        </div>
      ))}
      <div className={styles.suggestFooter}>{footer}</div>
    </div>
  );
}

/** Catalog row → menu row. The token is carried, never derived: only the
 *  sidecar knows what the CLI resolves for each kind. */
function toInvocableSource(item: InvocableItem): InvocableSource {
  return {
    name: item.name,
    label: item.alias,
    insertText: item.invoke_token,
    projectName: item.project_name,
    description: item.description,
  };
}

export function MentionSourceProbe({
  cwd,
  onSources,
}: {
  /** The pane's working directory — scopes the catalog to what a session
   *  started there could actually resolve. Undefined means the workspace, the
   *  same default a pane spawns with. */
  cwd?: string | null;
  onSources: (sources: MentionSources) => void;
}): ReactElement | null {
  // Tasks and library are the same hooks `ContextPicker` uses, so they share the
  // react-query cache rather than firing a second, redundant fetch.
  const { data: catalog } = useInvocables(cwd);
  const { data: tasks } = useTasks();
  const { data: library } = useLibraryItems();

  // Load-bearing memo: react-query returns a stable `data` identity between
  // renders, so this output is stable too, and the effect below fires only
  // when the data actually changes. Building the object inline in the effect
  // would set parent state on every render and infinite-loop.
  const sources = useMemo<MentionSources>(
    () => ({
      // A failed or still-loading catalog degrades to no agents and no skills —
      // the tasks and snippets groups keep working, and the menu never becomes
      // an error surface.
      agents: (catalog?.agents ?? []).map(toInvocableSource),
      skills: (catalog?.skills ?? []).map(toInvocableSource),
      tasks: (tasks ?? []).map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        description: t.description,
      })),
      library: (library?.items ?? []).map((item) => ({
        slug: item.slug,
        title: item.title,
        body: item.body,
      })),
    }),
    [catalog, tasks, library],
  );

  useEffect(() => {
    onSources(sources);
  }, [sources, onSources]);

  return null;
}
