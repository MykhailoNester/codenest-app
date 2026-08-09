import { useState, type MouseEvent as ReactMouseEvent, type ReactElement } from "react";
import type { Task } from "../../lib/api";
import { Popover } from "./popover";
import { TaskCard, type TaskCardProps } from "./task-card";
import type { BoardColumnDef } from "./types";

export interface BoardColumnProps {
  col: BoardColumnDef;
  tasks: readonly Task[];
  wipLimit: number | null;
  /** D8 — a column only sees the tasks it was given; while any board filter
   * is active the visible count is not the true total, so the WIP badge is
   * muted instead of raising a false over-limit alarm. */
  filtersActive: boolean;
  onSetWipLimit: (statusSlug: string, limit: number | null) => void;
  card: Omit<TaskCardProps, "task" | "isLive">;
  liveTaskIds: ReadonlySet<number>;
}

export function BoardColumn({
  col,
  tasks,
  wipLimit,
  filtersActive,
  onSetWipLimit,
  card,
  liveTaskIds,
}: BoardColumnProps): ReactElement {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [raw, setRaw] = useState<string>(wipLimit != null ? String(wipLimit) : "");
  const open = anchor !== null;
  const count = tasks.length;

  const over = wipLimit != null && count > wipLimit;
  const warn = wipLimit != null && count === wipLimit;

  let wipClass = "";
  if (wipLimit != null) {
    if (filtersActive) wipClass = " tb-col__wip--muted";
    else if (over) wipClass = " tb-col__wip--over";
    else if (warn) wipClass = " tb-col__wip--warn";
  }
  const colOver = !filtersActive && over;

  const wipLabel = wipLimit != null ? `${count}/${wipLimit}` : "WIP";
  const wipTitle =
    filtersActive && wipLimit != null
      ? "WIP compares the filtered count — clear filters for the true total"
      : undefined;

  function openPopover(e: ReactMouseEvent<HTMLButtonElement>): void {
    setRaw(wipLimit != null ? String(wipLimit) : "");
    setAnchor(open ? null : e.currentTarget);
  }

  function close(): void {
    setAnchor(null);
  }

  function submit(): void {
    const n = Math.trunc(Number(raw));
    if (Number.isFinite(n) && n >= 1) {
      onSetWipLimit(col.id, n);
      close();
    }
  }

  function clearLimit(): void {
    onSetWipLimit(col.id, null);
    close();
  }

  return (
    <div className={`tb-col${colOver ? " tb-col--over" : ""}`}>
      <div className="tb-col__head">
        <span className="tb-col__dot" style={{ background: col.color }} />
        <span className="tb-col__title">{col.label}</span>
        <span className="tb-col__count">{count}</span>
        <button
          type="button"
          className={`tb-col__wip${wipClass}`}
          onClick={openPopover}
          title={wipTitle}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-live="polite"
        >
          {wipLabel}
        </button>
      </div>

      <div className="tb-col__body">
        {tasks.length === 0 ? (
          <div className="tb-col__empty">No tasks</div>
        ) : (
          tasks.map((t) => (
            <TaskCard key={t.id} task={t} isLive={liveTaskIds.has(t.id)} {...card} />
          ))
        )}
      </div>

      <Popover anchor={anchor} open={open} onClose={close} align="end">
        <div className="tb-wip-form">
          <label className="tb-sr" htmlFor={`tb-wip-${col.id}`}>
            WIP limit for {col.label}
          </label>
          <input
            id={`tb-wip-${col.id}`}
            type="number"
            min="1"
            step="1"
            className="tb-wip-form__input"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="No limit"
            autoFocus
          />
          <button
            type="button"
            className="d3-btn d3-btn--primary"
            onClick={submit}
          >
            Set limit
          </button>
          <button
            type="button"
            className="tb-wip-form__clear"
            onClick={clearLimit}
          >
            No limit
          </button>
        </div>
      </Popover>
    </div>
  );
}
