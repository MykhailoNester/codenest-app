import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from "react";
import { Popover } from "./popover";
import type { ChipOption } from "./types";

export interface ChipPickerTriggerContext {
  open: boolean;
  resolvedLabel: string;
  /** Wire this to the trigger element's onClick — captures the anchor per D13.2. */
  onOpen: (e: ReactMouseEvent<HTMLElement>) => void;
}

export interface ChipPickerProps {
  label: string;
  value: string;
  options: readonly ChipOption[];
  onSelect: (value: string) => void;
  /** Leading text glyph on the default trigger, aria-hidden. */
  glyph?: string;
  /** Dot colour on the default trigger. Defaults to the selected option's `color`. */
  color?: string | null;
  searchable?: boolean;
  emptyText?: string;
  disabled?: boolean;
  /** Card-sized (smaller) trigger padding vs. Composer/filter-bar sizing. */
  compact?: boolean;
  /**
   * Overrides the default `tb-chip` trigger — used by the card's assignee
   * picker, which renders a `tb-avatar` instead of a text chip. The picker's
   * anchor/open/search/keyboard behaviour is otherwise identical.
   */
  renderTrigger?: (ctx: ChipPickerTriggerContext) => ReactElement;
}

function groupOptions(
  options: readonly ChipOption[],
): { name: string | null; items: ChipOption[] }[] {
  const groups: { name: string | null; items: ChipOption[] }[] = [];
  for (const opt of options) {
    const key = opt.group ?? null;
    let bucket = groups.find((g) => g.name === key);
    if (!bucket) {
      bucket = { name: key, items: [] };
      groups.push(bucket);
    }
    bucket.items.push(opt);
  }
  return groups;
}

export function ChipPicker({
  label,
  value,
  options,
  onSelect,
  glyph,
  color,
  searchable = false,
  emptyText = "No options",
  disabled = false,
  compact = false,
  renderTrigger,
}: ChipPickerProps): ReactElement {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  const open = anchor !== null;
  const current = options.find((o) => o.value === value);
  const resolvedLabel = current?.label ?? label;
  const dotColor = color !== undefined ? color : (current?.color ?? null);

  const filtered =
    searchable && query.trim()
      ? options.filter((o) =>
          o.label.toLowerCase().includes(query.trim().toLowerCase()),
        )
      : options;
  const groups = groupOptions(filtered);

  // Autofocus the search box on open — a ref read inside an effect, never
  // during render, so this is not a react-hooks/refs violation.
  useEffect(() => {
    if (open && searchable) searchRef.current?.focus();
  }, [open, searchable]);

  function close(): void {
    setAnchor(null);
  }

  function openAt(e: ReactMouseEvent<HTMLElement>): void {
    setAnchor(open ? null : e.currentTarget);
    setQuery("");
    setActiveIndex(0);
  }

  function select(v: string): void {
    onSelect(v);
    close();
  }

  function handleListKeyDown(e: ReactKeyboardEvent): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = filtered[activeIndex];
      if (opt) select(opt.value);
    }
  }

  let flatIndex = -1;

  return (
    <>
      {renderTrigger ? (
        renderTrigger({ open, resolvedLabel, onOpen: openAt })
      ) : (
        <button
          type="button"
          className={`tb-chip${value ? " tb-chip--on" : ""}`}
          style={compact ? { padding: "2px 6px", fontSize: 10 } : undefined}
          onClick={openAt}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`${label}: ${resolvedLabel}`}
        >
          {glyph ? <span aria-hidden="true">{glyph}</span> : null}
          {dotColor ? (
            <span className="tb-chip__dot" style={{ background: dotColor }} />
          ) : null}
          <span>{resolvedLabel}</span>
          <span className="tb-chip__caret" aria-hidden="true">
            ▾
          </span>
        </button>
      )}
      <Popover anchor={anchor} open={open} onClose={close}>
        {searchable ? (
          <input
            ref={searchRef}
            type="text"
            className="tb-pop__search"
            value={query}
            placeholder={`Search ${label.toLowerCase()}…`}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleListKeyDown}
          />
        ) : null}
        <div
          className="tb-pop__list"
          role="listbox"
          aria-label={label}
          onKeyDown={searchable ? undefined : handleListKeyDown}
          tabIndex={searchable ? undefined : 0}
        >
          {filtered.length === 0 ? (
            <div className="tb-pop__empty">{emptyText}</div>
          ) : (
            groups.map((group) => (
              <div key={group.name ?? "__ungrouped"}>
                {group.name ? (
                  <div className="tb-pop__group">{group.name}</div>
                ) : null}
                {group.items.map((opt) => {
                  flatIndex += 1;
                  const isOn = opt.value === value;
                  const isActive = flatIndex === activeIndex;
                  return (
                    <button
                      key={opt.value || "__none"}
                      type="button"
                      role="option"
                      aria-selected={isOn}
                      className={`tb-pop__item${isOn ? " tb-pop__item--on" : ""}${
                        isActive ? " tb-pop__item--active" : ""
                      }`}
                      onClick={() => select(opt.value)}
                    >
                      {opt.color ? (
                        <span
                          className="tb-pop__swatch"
                          style={{ background: opt.color }}
                        />
                      ) : null}
                      <span>
                        {opt.label}
                        {opt.hint ? (
                          <span className="tb-pop__hint">{opt.hint}</span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </Popover>
    </>
  );
}

export interface MultiChipPickerOption {
  id: number;
  label: string;
  color: string | null;
}

export interface MultiChipPickerProps {
  label: string;
  selected: readonly number[];
  options: readonly MultiChipPickerOption[];
  onToggle: (id: number, next: boolean) => void;
  emptyText?: string;
}

export function MultiChipPicker({
  label,
  selected,
  options,
  onToggle,
  emptyText = "No options",
}: MultiChipPickerProps): ReactElement {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const open = anchor !== null;
  const selectedSet = new Set(selected);

  function close(): void {
    setAnchor(null);
  }

  return (
    <>
      <button
        type="button"
        className="tb-chip tb-chip--add"
        onClick={(e) => setAnchor(open ? null : e.currentTarget)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={
          selected.length
            ? `${label}: ${selected.length} selected`
            : `Add ${label.toLowerCase()}`
        }
      >
        {selected.length === 0 ? "+" : `+${selected.length}`}
      </button>
      <Popover anchor={anchor} open={open} onClose={close}>
        <div className="tb-pop__list" role="listbox" aria-label={label}>
          {options.length === 0 ? (
            <div className="tb-pop__empty">{emptyText}</div>
          ) : (
            options.map((opt) => {
              const isOn = selectedSet.has(opt.id);
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="option"
                  aria-selected={isOn}
                  className={`tb-pop__item${isOn ? " tb-pop__item--on" : ""}`}
                  onClick={() => onToggle(opt.id, !isOn)}
                >
                  {opt.color ? (
                    <span
                      className="tb-pop__swatch"
                      style={{ background: opt.color }}
                    />
                  ) : null}
                  <span>{opt.label}</span>
                  {isOn ? (
                    <span className="tb-pop__check" aria-hidden="true">
                      ✓
                    </span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      </Popover>
    </>
  );
}
