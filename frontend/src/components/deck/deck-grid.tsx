import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";

export type DeckState =
  | "block"
  | "fail"
  | "wait"
  | "stall"
  | "run"
  | "done"
  | "todo"
  | "idle";

const STATE_WORD: Record<DeckState, string> = {
  block: "blocking",
  fail: "failed",
  wait: "waiting",
  stall: "stalled",
  run: "running",
  done: "done",
  todo: "queued",
  idle: "inert",
};

/** A cell: plain content, or content plus the class that positions it. */
export type DeckCell = ReactNode | { v: ReactNode; cls?: string; title?: string };

function cellOf(c: DeckCell): { v: ReactNode; cls?: string; title?: string } {
  return c !== null && typeof c === "object" && "v" in (c as object)
    ? (c as { v: ReactNode; cls?: string; title?: string })
    : { v: c as ReactNode };
}

const GridCtx = createContext<{ register: (el: HTMLDivElement | null) => void } | null>(null);

interface DeckGridProps {
  /** grid-template-columns for every row in this list. */
  cols: string;
  /** Named for assistive tech; usually the group heading. */
  label: string;
  className?: string;
  children: ReactNode;
}

/**
 * Owns the roving tabindex: Tab reaches the list once, then Up/Down move within
 * it and Home/End jump. Without this the rows are either all tab stops (forty
 * of them) or none.
 */
export function DeckGrid({ cols, label, className, children }: DeckGridProps): ReactElement {
  const rows = useRef<HTMLDivElement[]>([]);
  const root = useRef<HTMLDivElement>(null);

  rows.current = [];
  const register = useCallback((el: HTMLDivElement | null) => {
    if (el && !rows.current.includes(el)) rows.current.push(el);
  }, []);

  // First row is the single tab stop until the user moves.
  useEffect(() => {
    const live = rows.current.filter((r) => r.isConnected);
    live.forEach((r, i) => (r.tabIndex = i === 0 ? 0 : -1));
  });

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    const live = rows.current.filter((r) => r.isConnected);
    const at = live.indexOf(document.activeElement as HTMLDivElement);
    if (at < 0) return;
    let to = -1;
    if (e.key === "ArrowDown") to = Math.min(at + 1, live.length - 1);
    else if (e.key === "ArrowUp") to = Math.max(at - 1, 0);
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = live.length - 1;
    else return;
    e.preventDefault();
    live[at]!.tabIndex = -1;
    live[to]!.tabIndex = 0;
    live[to]!.focus();
  }, []);

  return (
    <GridCtx.Provider value={{ register }}>
      <div
        ref={root}
        role="grid"
        aria-label={label}
        className={`dk-list${className ? ` ${className}` : ""}`}
        style={{ ["--cols" as string]: cols }}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </GridCtx.Provider>
  );
}

/** Column headers. The state column is labelled but not shown — it is 14px. */
export function DeckHead({ cells }: { cells: string[] }): ReactElement {
  return (
    <div className="dk-head" role="row">
      <span role="columnheader">
        <span className="sr">state</span>
      </span>
      {cells.map((c, i) => (
        <span key={i} role="columnheader" className={c.startsWith("r ") ? "r" : undefined}>
          {c.replace(/^r /, "")}
        </span>
      ))}
    </div>
  );
}

interface DeckLineProps {
  state?: DeckState;
  cells: DeckCell[];
  onOpen?: () => void;
  done?: boolean;
  fresh?: boolean;
  selected?: boolean;
}

/**
 * The one primitive. A session, task, agent, run, project and alert are all
 * this. A row cannot be a <button> and a role="row" at once, so activation is
 * Enter/Space plus click, and the columns stay legible to a screen reader.
 */
export function DeckLine({
  state = "idle",
  cells,
  onOpen,
  done,
  fresh,
  selected,
}: DeckLineProps): ReactElement {
  const ctx = useContext(GridCtx);
  const cls = [
    "dk-line",
    done && "is-done",
    fresh && "is-new",
    selected && "on",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={ctx?.register}
      role="row"
      tabIndex={-1}
      className={cls}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (!onOpen) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <span className="dk-s" role="gridcell" data-s={state} aria-label={STATE_WORD[state]} />
      {cells.map((c, i) => {
        const { v, cls: k, title } = cellOf(c);
        return (
          <span
            key={i}
            role="gridcell"
            className={k}
            title={title ?? (typeof v === "string" && v ? v : undefined)}
          >
            {v}
          </span>
        );
      })}
    </div>
  );
}

interface DeckGroupProps {
  label: string;
  count?: ReactNode;
  note?: ReactNode;
  state?: DeckState;
  children: ReactNode;
}

/** A titled section. The heading is a real h2 so the page has an outline. */
export function DeckGroup({ label, count, note, state, children }: DeckGroupProps): ReactElement {
  const id = useId();
  return (
    <div className="dk-group">
      <h2 className="dk-group__h" id={id} data-s={state}>
        <span>{label}</span>
        {count != null && <span className="n">{count}</span>}
        {note != null && <span className="note">{note}</span>}
      </h2>
      {children}
    </div>
  );
}

/** Column templates, so a list's shape is named rather than inlined. */
export const DECK_COLS = {
  default: "14px minmax(0, 1fr) 110px 150px 62px 96px",
  tasks: "14px 50px minmax(0, 1fr) 100px 118px 52px 80px",
  simple: "14px minmax(0, 1fr) 90px",
  wide: "14px minmax(0, 1fr) 118px 68px 80px 90px",
} as const;
