import { type ReactElement } from "react";

export interface DeckFilterOption {
  value: string;
  label: string;
}

interface Props {
  values: Record<string, string>;
  options: Record<string, readonly DeckFilterOption[] | undefined>;
  sort?: { value: string; options: readonly DeckFilterOption[] };
  onSet: (key: string, value: string) => void;
  onSetSort?: (value: string) => void;
  onClearAll: () => void;
}

const LABELS: Record<string, string> = {
  project_id: "project",
  priority: "priority",
  assignee_id: "who",
  label: "label",
  status: "status",
};

/**
 * The filter row, as selects rather than the old popover chips. A console's
 * filters should say what they are set to without being opened.
 */
export function DeckFilters({
  values,
  options,
  sort,
  onSet,
  onSetSort,
  onClearAll,
}: Props): ReactElement {
  const active = Object.entries(values).filter(([, v]) => v).length;

  return (
    <div style={{ display: "flex", gap: "var(--u2)", alignItems: "center", flexWrap: "wrap" }}>
      {Object.entries(LABELS).map(([key, label]) => {
        const opts = options[key];
        if (!opts || opts.length === 0) return null;
        return (
          <label key={key} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span className="dim" style={{ fontSize: "var(--fs-xs)" }}>
              {label}
            </span>
            <select
              className="dk-sel"
              value={values[key] ?? ""}
              onChange={(e) => onSet(key, e.target.value)}
              aria-label={`Filter by ${label}`}
            >
              <option value="">any</option>
              {opts.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label.toLowerCase()}
                </option>
              ))}
            </select>
          </label>
        );
      })}

      {sort && onSetSort && (
        <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span className="dim" style={{ fontSize: "var(--fs-xs)" }}>
            sort
          </span>
          <select
            className="dk-sel"
            value={sort.value}
            onChange={(e) => onSetSort(e.target.value)}
            aria-label="Sort order"
          >
            {sort.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label.toLowerCase()}
              </option>
            ))}
          </select>
        </label>
      )}

      {active > 0 && (
        <button type="button" className="dk-btn bare" onClick={onClearAll}>
          clear {active}
        </button>
      )}
    </div>
  );
}
