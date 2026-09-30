import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
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
  const root = useRef<HTMLDivElement>(null);

  const rowsOf = useCallback(
    (): HTMLDivElement[] =>
      root.current ? Array.from(root.current.querySelectorAll<HTMLDivElement>(".dk-line")) : [],
    [],
  );

  // First row is the single tab stop until the user moves, so Tab reaches the
  // list once instead of stopping on all forty rows.
  useEffect(() => {
    const rows = rowsOf();
    rows.forEach((r, i) => (r.tabIndex = i === 0 ? 0 : -1));
  });

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const rows = rowsOf();
      const at = rows.indexOf(document.activeElement as HTMLDivElement);
      if (at < 0) return;

      const to =
        e.key === "ArrowDown"
          ? Math.min(at + 1, rows.length - 1)
          : e.key === "ArrowUp"
            ? Math.max(at - 1, 0)
            : e.key === "Home"
              ? 0
              : e.key === "End"
                ? rows.length - 1
                : null;
      if (to === null) return;

      e.preventDefault();
      rows[at]!.tabIndex = -1;
      rows[to]!.tabIndex = 0;
      rows[to]!.focus();
    },
    [rowsOf],
  );

  return (
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
  /** Renders the heading as a disclosure. Children stay mounted when open. */
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}

/** A titled section. The heading is a real h2 so the page has an outline. */
export function DeckGroup({
  label,
  count,
  note,
  state,
  collapsible,
  defaultOpen = true,
  children,
}: DeckGroupProps): ReactElement {
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);

  const heading = (
    <>
      {collapsible && <span aria-hidden="true">{open ? "▾" : "▸"}</span>}
      <span>{label}</span>
      {count != null && <span className="n">{count}</span>}
      {note != null && <span className="note">{note}</span>}
    </>
  );

  return (
    <div className="dk-group">
      <h2 className="dk-group__h" id={id} data-s={state}>
        {collapsible ? (
          <button
            type="button"
            className="dk-group__btn"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {heading}
          </button>
        ) : (
          heading
        )}
      </h2>
      {(!collapsible || open) && children}
    </div>
  );
}
