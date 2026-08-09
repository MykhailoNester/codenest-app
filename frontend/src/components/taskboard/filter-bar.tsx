import type { ReactElement } from "react";
import { ChipPicker } from "./chip-picker";
import type { ChipOption } from "./types";

export type FilterKey =
  | "project_id"
  | "priority"
  | "assignee_id"
  | "label"
  | "status";

const KEY_LABELS: Record<FilterKey, string> = {
  project_id: "Project",
  priority: "Priority",
  assignee_id: "Assignee",
  label: "Label",
  status: "Status",
};

// project/assignee/label pickers get a search box; priority and status are
// short, fixed-length vocabularies that don't need one.
const SEARCHABLE: ReadonlySet<FilterKey> = new Set([
  "project_id",
  "assignee_id",
  "label",
]);

export interface FilterBarProps {
  values: Readonly<Record<FilterKey, string>>;
  projectOptions: readonly ChipOption[];
  priorityOptions: readonly ChipOption[];
  assigneeOptions: readonly ChipOption[];
  labelOptions: readonly ChipOption[];
  /** Present only in list mode — the board's columns are the status axis. */
  statusOptions?: readonly ChipOption[];
  /** Present only in list mode; not a filter, excluded from the count. */
  sort?: { value: string; options: readonly ChipOption[] };
  onSet: (key: FilterKey, value: string) => void;
  onSetSort?: (value: string) => void;
  onClearAll: () => void;
}

export function FilterBar({
  values,
  projectOptions,
  priorityOptions,
  assigneeOptions,
  labelOptions,
  statusOptions,
  sort,
  onSet,
  onSetSort,
  onClearAll,
}: FilterBarProps): ReactElement {
  const keys: FilterKey[] = statusOptions
    ? ["project_id", "status", "priority", "assignee_id", "label"]
    : ["project_id", "priority", "assignee_id", "label"];

  const optionsByKey: Record<FilterKey, readonly ChipOption[]> = {
    project_id: projectOptions,
    priority: priorityOptions,
    assignee_id: assigneeOptions,
    label: labelOptions,
    status: statusOptions ?? [],
  };

  const activeKeys = keys.filter((key) => values[key]);

  return (
    <div className="tb-filters">
      <div className="tb-filters__add">
        {keys.map((key) => (
          <ChipPicker
            key={key}
            label={KEY_LABELS[key]}
            value={values[key]}
            options={optionsByKey[key]}
            onSelect={(v) => onSet(key, v)}
            searchable={SEARCHABLE.has(key)}
          />
        ))}
        {sort && onSetSort ? (
          <ChipPicker
            label="Sort"
            value={sort.value}
            options={sort.options}
            onSelect={onSetSort}
          />
        ) : null}
      </div>

      {activeKeys.map((key) => {
        const option = optionsByKey[key].find((o) => o.value === values[key]);
        return (
          <span key={key} className="tb-filter">
            <span className="tb-filter__key">{KEY_LABELS[key]}</span>
            <span className="tb-filter__val">{option?.label ?? values[key]}</span>
            <button
              type="button"
              className="tb-filter__x"
              aria-label={`Remove ${KEY_LABELS[key]} filter`}
              onClick={() => onSet(key, "")}
            >
              ✕
            </button>
          </span>
        );
      })}

      {activeKeys.length > 0 ? (
        <>
          <span className="tb-filter-count">{activeKeys.length}</span>
          <button
            type="button"
            className="tb-filters__clear"
            onClick={onClearAll}
          >
            Clear all
          </button>
        </>
      ) : null}
    </div>
  );
}
