import { type ReactElement } from "react";
import { DeckLine } from "./deck-grid";
import { taskState } from "./deck-cols";
import type { Task } from "../../lib/api";

interface TaskLineProps {
  task: Task;
  priorityLabel: string;
  statusLabels: Record<string, string>;
  statuses: readonly string[];
  live?: boolean;
  onOpen: () => void;
  onProject: () => void;
  onStatus: (status: string) => void;
}

/** One task, as a line. The status select stays inline — moving a task is the
 *  action this board exists for, and burying it behind the detail page would
 *  cost more than the kanban's drag did. */
export function TaskLine({
  task: t,
  priorityLabel,
  statusLabels,
  statuses,
  live,
  onOpen,
  onProject,
  onStatus,
}: TaskLineProps): ReactElement {
  return (
    <DeckLine
      state={live ? "run" : taskState(t.status)}
      done={t.status === "done"}
      onOpen={onOpen}
      cells={[
        { v: `#${t.id}`, cls: "id" },
        { v: t.title, cls: "sub", title: t.title },
        {
          v: (
            <button
              type="button"
              className="dk-btn bare"
              onClick={(e) => {
                e.stopPropagation();
                onProject();
              }}
              title="Filter to this project"
            >
              {t.project_name ?? "unassigned"}
            </button>
          ),
        },
        { v: t.assignee_name ?? "—" },
        { v: priorityLabel, cls: "r" },
        {
          v: (
            <span className="acts" onClick={(e) => e.stopPropagation()}>
              <select
                className="dk-sel"
                value={t.status}
                onChange={(e) => onStatus(e.target.value)}
                aria-label={`Status of task ${t.id}`}
              >
                {statuses.map((s) => (
                  <option key={s} value={s}>
                    {(statusLabels[s] ?? s).toLowerCase()}
                  </option>
                ))}
              </select>
            </span>
          ),
          cls: "r",
        },
      ]}
    />
  );
}
