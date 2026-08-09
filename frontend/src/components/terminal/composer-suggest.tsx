/**
 * The presentational suggestion panel shared by the slash and mention menus,
 * and the render-nothing child that feeds the mention menu its data.
 *
 * `MentionSourceProbe` is the reason the react-query hooks it calls never
 * appear in `<AgentComposer/>` itself: that component must stay renderable
 * with no `QueryClientProvider` (`agent-pane-render.test.tsx`), so this probe
 * is mounted only while a mention is actually being typed (Design decision
 * 10), and reports its three raw arrays upward once via `onSources`.
 *
 * This file exports components only — `react-refresh/only-export-components`
 * is an error in this repo's eslint config — so the `SuggestRow` type and the
 * two `*RowToSuggest` adapters live in `lib/composer-menu.ts` instead.
 */

import { useEffect, useMemo, useRef, type ReactElement } from "react";
import { useLibraryItems, useTasks, useTeamMembers } from "../../lib/api";
import type { MentionSources } from "../../lib/composer-mentions";
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

export function MentionSourceProbe({
  onSources,
}: {
  onSources: (sources: MentionSources) => void;
}): ReactElement | null {
  // The same hooks `ContextPicker` uses, so they share the react-query cache
  // rather than firing a second, redundant fetch.
  const { data: members } = useTeamMembers();
  const { data: tasks } = useTasks();
  const { data: library } = useLibraryItems();

  // Load-bearing memo: react-query returns a stable `data` identity between
  // renders, so this output is stable too, and the effect below fires only
  // when the data actually changes. Building the object inline in the effect
  // would set parent state on every render and infinite-loop.
  const sources = useMemo<MentionSources>(
    () => ({
      agents: (members ?? [])
        .filter((m) => m.type === "agent")
        .map((m) => ({ name: m.name, role: m.role, agentFile: m.agent_file })),
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
    [members, tasks, library],
  );

  useEffect(() => {
    onSources(sources);
  }, [sources, onSources]);

  return null;
}
