import { useState, type ReactElement } from "react";
import { DeckGrid, DeckGroup, DeckHead, type DeckState } from "./deck-grid";
import { COLS_TASK } from "./deck-cols";
import { TaskLine } from "./deck-task-row";
import type { Task } from "../../lib/api";

/**
 * How many rows a group shows before it asks. The board has to stay readable at
 * two hundred tasks, and a group that renders every row turns the page into a
 * scroll rather than a state you can take in.
 */
const PREVIEW = 8;

interface Props {
  label: string;
  state?: DeckState;
  rows: Task[];
  statuses: readonly string[];
  statusLabels: Record<string, string>;
  priorityLabels: Record<string, string>;
  liveTaskIds: ReadonlySet<number>;
  onOpen: (id: number) => void;
  onProject: (projectId: number) => void;
  onStatus: (id: number, status: string) => void;
}

export function DeckTaskGroup({
  label,
  state,
  rows,
  statuses,
  statusLabels,
  priorityLabels,
  liveTaskIds,
  onOpen,
  onProject,
  onStatus,
}: Props): ReactElement | null {
  const [all, setAll] = useState(false);
  if (rows.length === 0) return null;

  const shown = all ? rows : rows.slice(0, PREVIEW);
  const hidden = rows.length - shown.length;

  return (
    <DeckGroup
      label={label}
      count={rows.length}
      note={hidden > 0 ? `${shown.length} shown` : undefined}
      state={state}
      collapsible
      defaultOpen={rows.length <= 40}
    >
      <DeckGrid cols={COLS_TASK} label={label}>
        <DeckHead cells={["", "what", "project", "who", "r priority", "r status"]} />
        {shown.map((t) => (
          <TaskLine
            key={t.id}
            task={t}
            live={liveTaskIds.has(t.id)}
            statuses={statuses}
            statusLabels={statusLabels}
            priorityLabel={(priorityLabels[t.priority] ?? t.priority).toLowerCase()}
            onOpen={() => onOpen(t.id)}
            onProject={() => onProject(t.project_id)}
            onStatus={(s) => onStatus(t.id, s)}
          />
        ))}
      </DeckGrid>
      {hidden > 0 && (
        <button
          type="button"
          className="dk-btn bare"
          style={{ margin: "var(--u2) var(--u3)" }}
          onClick={() => setAll(true)}
          aria-label={`Show all ${rows.length} in ${label}`}
        >
          show all {rows.length} ↓
        </button>
      )}
      {all && rows.length > PREVIEW && (
        <button
          type="button"
          className="dk-btn bare"
          style={{ margin: "var(--u2) var(--u3)" }}
          onClick={() => setAll(false)}
        >
          show fewer ↑
        </button>
      )}
    </DeckGroup>
  );
}
export { PREVIEW as DECK_GROUP_PREVIEW };
