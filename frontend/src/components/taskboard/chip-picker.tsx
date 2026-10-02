import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { Popover } from "./popover";
import type { ChipOption } from "./types";

/* ── Local constants ──────────────────────────────────────────────────────
   The places Deck has no primitive. Declared here rather than in
   `components/deck/*` or `design/deck/*`, which #283 does not touch — the
   precedent is `pages/attention.tsx`'s `ATTENTION_COLS` and
   `components/notification-bell.tsx`'s `BELL_COLS`. */

/**
 * The option list's columns: swatch · label · selected mark.
 *
 * Not in `DECK_COLS` for the reason `BELL_COLS` is not — that module is a deck
 * primitive and out of scope here, and no named template describes a 280px
 * dropdown. Every option renders all three cells even when two are empty: a
 * colourless option still lines its label up with a coloured one, which is
 * Deck's rule 2 (alignment is what makes a list readable).
 */
const OPTION_COLS = "10px minmax(0, 1fr) 12px";

/** The search strip. `.dk-modal__h` is the panel header but it is 34px,
 *  uppercase and letter-spaced — chrome for a title, not for a text field. */
const SEARCH_STRIP_STYLE: CSSProperties = {
  flex: "none",
  padding: "var(--u2)",
  borderBottom: "1px solid var(--line)",
};

/** `.dk-modal__b` is padded for a dialog body (`--u4`); a dropdown's rows run
 *  to its edges. The ceiling is `.tb-pop__list`'s verbatim. */
const LIST_BODY_STYLE: CSSProperties = {
  padding: "var(--u)",
  maxHeight: 280,
};

/** A group heading inside the listbox. `.dk-label` carries the type; the
 *  padding puts it over the rows it heads rather than against them. */
const GROUP_HEAD_STYLE: CSSProperties = { padding: "var(--u2) var(--u2) 2px" };

/** Deck has no colour swatch: `.dk-s` is the state glyph and `.dk-tag`'s
 *  colours are the four terminal semantics, neither of which can carry an
 *  arbitrary taxonomy colour from the DB. `.dk-list.prose` aligns rows to
 *  their top, so the dot needs the same nudge `.tb-pop__swatch` had. */
const SWATCH_STYLE: CSSProperties = {
  width: 8,
  height: 8,
  marginTop: 5,
  borderRadius: "50%",
};

/** Same, on the trigger, where the row has no top alignment to correct for. */
const TRIGGER_DOT_STYLE: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: "50%",
  flex: "0 0 7px",
};

/** The explanatory second line under an option. `.dim` rather than Deck's
 *  `--fg-4`, which the design README reserves for decoration and disabled
 *  state — no text uses it. */
const HINT_STYLE: CSSProperties = {
  display: "block",
  fontSize: "var(--fs-xs)",
  marginTop: 2,
};

/** The keyboard-highlighted row, which is not the selected row: selection is
 *  `.dk-line.on` (`--sel-2`), so the cursor takes the hover tone a notch
 *  below it. Deck has no `.dk-line` modifier for "active descendant". */
const ACTIVE_STYLE: CSSProperties = { background: "var(--sel)" };

/** `.dk-btn` sizes to its content and has no ceiling — the same reason
 *  `.dk-rowsel` carries one. A project named by its full path would push the
 *  trigger past the column it sits in; it ellipsises inside it instead. */
const TRIGGER_STYLE: CSSProperties = { maxWidth: "100%" };

/** Card-sized trigger. Deck's small end bottoms out at `--fs-xs` (11px) and
 *  `.tb-chip`'s compact mode was 10px — the README moved the whole scale up a
 *  point precisely to kill that floor, so compact stops at 11 here. */
const COMPACT_TRIGGER_STYLE: CSSProperties = {
  ...TRIGGER_STYLE,
  height: 20,
  padding: "0 var(--u)",
  fontSize: "var(--fs-xs)",
};

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
   * Overrides the default `.dk-btn` trigger. The picker's anchor/open/search/
   * keyboard behaviour is otherwise identical.
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

/**
 * One row in a picker's listbox: a `.dk-line` on the `OPTION_COLS` grid, as a
 * `<button role="option">` rather than a `role="row"`. `DeckLine` is the row
 * primitive for a grid and brings `role="row"` plus `DeckGrid`'s roving
 * tabindex with it; a listbox is a different control with different keys, and
 * the keyboard model here (the caller's Arrow/Enter handler plus
 * `aria-selected`) predates the conversion and is unchanged by it.
 */
function OptionRow({
  color,
  label,
  hint,
  selected,
  active,
  onPick,
}: {
  color?: string | null | undefined;
  label: string;
  hint?: string | undefined;
  selected: boolean;
  active?: boolean;
  onPick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={`dk-line${selected ? " on" : ""}`}
      style={active === true ? ACTIVE_STYLE : undefined}
      onClick={onPick}
    >
      <span
        style={color ? { ...SWATCH_STYLE, background: color } : undefined}
      />
      <span>
        {label}
        {hint ? (
          <span className="dim" style={HINT_STYLE}>
            {hint}
          </span>
        ) : null}
      </span>
      <span aria-hidden="true">{selected ? "✓" : null}</span>
    </button>
  );
}

/** The listbox shell: `.dk-list.prose` so an option carrying a hint wraps
 *  instead of being truncated by the line's own ellipsis rule. */
function OptionList({
  label,
  onKeyDown,
  tabIndex,
  children,
}: {
  label: string;
  onKeyDown?: ((e: ReactKeyboardEvent) => void) | undefined;
  tabIndex?: number | undefined;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="dk-modal__b" style={LIST_BODY_STYLE}>
      <div
        className="dk-list prose"
        role="listbox"
        aria-label={label}
        style={{ ["--cols" as string]: OPTION_COLS }}
        onKeyDown={onKeyDown}
        tabIndex={tabIndex}
      >
        {children}
      </div>
    </div>
  );
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
        // `.dk-btn` when a value is set, `.dk-btn.bare` when it is not: the
        // border is what `.tb-chip--on` used to say, and bare is Deck's shape
        // for a control sitting in a dense cluster.
        <button
          type="button"
          className={`dk-btn${value ? "" : " bare"}`}
          style={compact ? COMPACT_TRIGGER_STYLE : TRIGGER_STYLE}
          onClick={openAt}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`${label}: ${resolvedLabel}`}
        >
          {glyph ? <span aria-hidden="true">{glyph}</span> : null}
          {dotColor ? (
            <span style={{ ...TRIGGER_DOT_STYLE, background: dotColor }} />
          ) : null}
          <span className="trunc">{resolvedLabel}</span>
          <span className="dim" aria-hidden="true">
            ▾
          </span>
        </button>
      )}
      <Popover anchor={anchor} open={open} onClose={close}>
        {searchable ? (
          <div style={SEARCH_STRIP_STYLE}>
            <input
              ref={searchRef}
              type="text"
              className="dk-ctl"
              value={query}
              placeholder={`Search ${label.toLowerCase()}…`}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleListKeyDown}
            />
          </div>
        ) : null}
        <OptionList
          label={label}
          onKeyDown={searchable ? undefined : handleListKeyDown}
          tabIndex={searchable ? undefined : 0}
        >
          {filtered.length === 0 ? (
            <div className="dk-note">{emptyText}</div>
          ) : (
            groups.map((group) => {
              const rows = group.items.map((opt) => {
                flatIndex += 1;
                const isActive = flatIndex === activeIndex;
                return (
                  <OptionRow
                    key={opt.value || "__none"}
                    color={opt.color}
                    label={opt.label}
                    hint={opt.hint}
                    selected={opt.value === value}
                    active={isActive}
                    onPick={() => select(opt.value)}
                  />
                );
              });
              // A heading between a listbox and its options is only legal as a
              // labelled `role="group"`; the old markup wrapped them in a bare
              // `<div>`, which hid the sections from assistive tech entirely.
              return group.name ? (
                <div key={group.name} role="group" aria-label={group.name}>
                  <div className="dk-label" style={GROUP_HEAD_STYLE}>
                    {group.name}
                  </div>
                  {rows}
                </div>
              ) : (
                <Fragment key="__ungrouped">{rows}</Fragment>
              );
            })
          )}
        </OptionList>
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
        className={`dk-btn${selected.length ? "" : " bare"}`}
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
        <OptionList label={label}>
          {options.length === 0 ? (
            <div className="dk-note">{emptyText}</div>
          ) : (
            options.map((opt) => {
              const isOn = selectedSet.has(opt.id);
              return (
                <OptionRow
                  key={opt.id}
                  color={opt.color}
                  label={opt.label}
                  selected={isOn}
                  onPick={() => onToggle(opt.id, !isOn)}
                />
              );
            })
          )}
        </OptionList>
      </Popover>
    </>
  );
}
