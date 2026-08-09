import { memo, type MemoExoticComponent, type ReactElement } from "react";
import type { Task } from "../../lib/api";
import { relativeTime } from "../../lib/format-helpers";
import { LaunchFromSourceButton } from "../launch/launch-from-source-button";
import { ChipPicker, MultiChipPicker } from "./chip-picker";
import type { ChipOption, TaskBoardVocab } from "./types";

export interface TaskCardProps {
  task: Task;
  vocab: TaskBoardVocab;
  statusOptions: readonly ChipOption[];
  priorityOptions: readonly ChipOption[];
  assigneeOptions: readonly ChipOption[];
  labelOptions: readonly { id: number; label: string; color: string | null }[];
  isLive: boolean;
  onNavigate: (path: string) => void;
  onStatus: (id: number, status: string) => void;
  onPriority: (id: number, priority: string) => void;
  onAssignee: (id: number, assigneeId: number | null) => void;
  onToggleLabel: (id: number, labelId: number, next: boolean) => void;
}

// Deterministic avatar background: sum of char codes into a fixed palette,
// so the same name always lands on the same colour without a lookup table.
const AVATAR_HUES = [
  "--accent",
  "--ok",
  "--warn",
  "--violet",
  "--info",
  "--err",
] as const;

function hashHue(name: string): string {
  let sum = 0;
  for (let i = 0; i < name.length; i += 1) sum += name.charCodeAt(i);
  const key = AVATAR_HUES[sum % AVATAR_HUES.length] ?? "--accent";
  return `var(${key})`;
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
}

/**
 * D3 — the priority glyph is derived from the slug's rank in the active
 * ordered priority vocabulary, not a hardcoded slug allowlist (priorities
 * are user-extensible). The length check runs BEFORE the membership check:
 * an unresolved vocabulary (`priorityCount === 0`) must render "▬" on every
 * card, not "●" — membership is only meaningful once there is more than one
 * priority to rank against.
 */
function priorityGlyph(slug: string, vocab: TaskBoardVocab): string {
  if (vocab.priorityCount <= 1) return "▬";
  const rank = vocab.priorityRank[slug];
  if (rank === undefined) return "●";
  if (rank === 0) return "▲";
  if (rank === vocab.priorityCount - 1) return "▼";
  return "▬";
}

/**
 * D6 — there is no `due_date` column. Precedence: a done task's
 * `completed_date`, else `started_date`, else `created_at` (normalised to
 * UTC at this call site per `format-helpers.ts:43-50`, since a naive
 * timestamp read as local time would misreport a just-created task's age).
 */
function cardDate(task: Task): { text: string; title: string } {
  if (task.status === "done" && task.completed_date) {
    return {
      text: task.completed_date,
      title: `Completed ${task.completed_date}`,
    };
  }
  if (task.started_date) {
    return { text: task.started_date, title: `Started ${task.started_date}` };
  }
  const iso = task.created_at.endsWith("Z")
    ? task.created_at
    : `${task.created_at}Z`;
  return { text: relativeTime(iso), title: `Created ${task.created_at}` };
}

function TaskCardInner({
  task,
  vocab,
  statusOptions,
  priorityOptions,
  assigneeOptions,
  labelOptions,
  isLive,
  onNavigate,
  onStatus,
  onPriority,
  onAssignee,
  onToggleLabel,
}: TaskCardProps): ReactElement {
  const priorityColor = vocab.priorityColors[task.priority] ?? "var(--fg-4)";
  const priorityName = vocab.priorityLabels[task.priority] ?? task.priority;
  const isDone = task.status === "done";
  const glyph = priorityGlyph(task.priority, vocab);
  const date = cardDate(task);
  const labels = task.labels ?? [];
  const labelIds = labels.map((l) => l.id);
  const assigneeValue = task.assignee_id != null ? String(task.assignee_id) : "";

  return (
    <div
      className={`tb-card${isDone ? " tb-card--done" : ""}`}
      style={{ ["--tb-accent" as string]: priorityColor }}
    >
      <div className="tb-card__top">
        <span
          className="tb-card__prio"
          aria-hidden="true"
          style={{ color: priorityColor }}
        >
          {glyph}
        </span>
        <span className="tb-sr">{priorityName} priority</span>
        <button
          type="button"
          className="tb-card__id"
          onClick={() => onNavigate(`/tasks/${task.id}`)}
        >
          #{task.id}
        </button>
        <button
          type="button"
          className="tb-card__name"
          onClick={() => onNavigate(`/tasks/${task.id}`)}
        >
          {task.title}
        </button>
        {isLive ? (
          <span
            className="tb-card__live"
            title="An agent run is in progress for this task"
          >
            <span className="tb-sr">Live agent run</span>
          </span>
        ) : null}
      </div>

      <div className="tb-card__tags">
        <span
          className="tb-tag--project"
          title={task.project_name ?? "Unassigned"}
        >
          {task.project_name ?? "Unassigned"}
        </span>
        {labels.map((l) => (
          <span
            key={l.id}
            className="tb-label"
            style={{ color: l.color ?? "var(--fg-3)" }}
          >
            {l.label}
          </span>
        ))}
        <MultiChipPicker
          label="Labels"
          selected={labelIds}
          options={labelOptions}
          onToggle={(labelId, next) => onToggleLabel(task.id, labelId, next)}
          emptyText="No labels — add them in Settings → Workflow Labels"
        />
      </div>

      <div className="tb-card__meta">
        <ChipPicker
          label="Assignee"
          value={assigneeValue}
          options={assigneeOptions}
          onSelect={(v) => onAssignee(task.id, v ? Number(v) : null)}
          searchable
          renderTrigger={({ onOpen, open }) =>
            task.assignee_name ? (
              <button
                type="button"
                className="tb-avatar"
                style={{ background: hashHue(task.assignee_name) }}
                title={task.assignee_name}
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={onOpen}
              >
                {initialsOf(task.assignee_name)}
                <span className="tb-sr">Assignee: {task.assignee_name}</span>
              </button>
            ) : (
              <button
                type="button"
                className="tb-avatar tb-avatar--none"
                title="Unassigned"
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={onOpen}
              >
                <span className="tb-sr">Unassigned — pick an assignee</span>
              </button>
            )
          }
        />
        {task.effort ? <span className="tb-effort">{task.effort}</span> : null}
        <span className="tb-date" title={date.title}>
          {date.text}
        </span>
      </div>

      <div className="tb-card__actions">
        <ChipPicker
          label="Status"
          value={task.status}
          options={statusOptions}
          onSelect={(v) => onStatus(task.id, v)}
          compact
        />
        <ChipPicker
          label="Priority"
          value={task.priority}
          options={priorityOptions}
          onSelect={(v) => onPriority(task.id, v)}
          compact
        />
        <LaunchFromSourceButton
          kind="task"
          id={task.id}
          label=""
          icon="play"
          tooltip="Launch agent"
          tone="run"
        />
      </div>
    </div>
  );
}

export const TaskCard: MemoExoticComponent<typeof TaskCardInner> =
  memo(TaskCardInner);
