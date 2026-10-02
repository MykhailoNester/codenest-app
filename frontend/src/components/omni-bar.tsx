/**
 * OmniBar — the search-and-command field in the top chrome, on Deck (#283).
 *
 * Mount status, because it changes what a reviewer can check: nothing renders
 * this component today. It was a child of `.d3-omni-row` in `shell.tsx`, and
 * that shell is gone; every surviving mention of `OmniBar` outside this file
 * and its test is a comment. The conversion is done on its merits — the
 * component is whole and tested — but it cannot be clicked until something
 * mounts it again.
 *
 * What the stylesheet was carrying, and where it went
 * ---------------------------------------------------
 * `.input` becomes `.dk-field`, which is the same 24px bordered row with the
 * leading glyph and the focus border Deck already draws. `.suggestion` becomes
 * `.dk-line`, so a result row is the same primitive as a task row, and
 * `.suggestionActive` becomes `.on`, Deck's selected row.
 *
 * Two colour vocabularies are deliberately not carried over:
 *
 *   * **The five kind colours** (`.kindSlash` amber, `.kindReference` purple,
 *     `.kindSearch` sky, `.kindPrompt` green). Deck has four semantics and
 *     they mean broken / wants-you / finished / live — a grammar is none of
 *     those, and two of the five had no Deck colour at all. The badge already
 *     carries the grammar as a word, which is the trade
 *     `components/notification-bell.tsx` made for its per-type icon chip, so
 *     the word does the work and `.dk-tag` draws it plain. `data-s="run"` is
 *     the one state left, and it marks dictation actually listening.
 *   * **`typeColor` on a row's meta.** Seven hex literals, one per result
 *     type, on text that sits under a group header already naming that type.
 *
 * The per-row type icon goes the same way as the bell's: out, in favour of the
 * word. The group header names the type in search mode and `omni-mentions.ts`
 * puts it in `meta` for projects and members; a snippet row is the one case
 * that had only an icon, so it gets a `.dk-tag` saying so.
 *
 * This component does **not** portal — `.suggestions` was absolutely
 * positioned inside the bar — so there is no `display: contents` wrapper to
 * add. It does need a `.deck` ancestor from whatever remounts it.
 */
import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  fetchLibraryItemBySlug,
  useCreateAttachment,
  useCreateInboxItem,
  useEnabledFeatures,
  useLibraryItems,
  useProjects,
  useSearch,
  useTeamMembers,
  type SearchResult,
} from "../lib/api";
import {
  classifyIntent,
  parseLibraryRef,
  type IntentResult,
} from "../lib/prompt-intent";
import {
  buildCommandRows,
  OMNI_COMMAND_LIMIT,
  OMNI_EVENT_OPEN_LAUNCH,
  OMNI_EVENT_OPEN_PALETTE,
  type OmniCommand,
} from "../lib/omni-commands";
import { buildMentionRows, type OmniMentionRow } from "../lib/omni-mentions";
import {
  flattenGrouped,
  groupResults,
  GROUP_LABELS,
  GROUP_ORDER,
  projectRoute,
  resultMeta,
  routeForResult,
} from "../lib/search-results";
import { useDebounce } from "../hooks/use-debounce";
import { useVoiceDictation } from "../lib/use-voice-dictation";
import { Icon } from "./icon";

/**
 * The bar's own box. Deck has no "item in the chrome row" primitive — the
 * real shell's chrome is `.dk-status`, a fixed-height strip, not a growing
 * flex child — so this is a local constant, the call
 * `components/notification-bell.tsx` makes for `POPOVER_STYLE`.
 *
 * `position: relative` is load-bearing: it is what the suggestions panel's
 * `top: 100%` is measured from. `z-index` lifts the bar and its absolute
 * child over page content that makes its own stacking context.
 */
const BAR_STYLE: CSSProperties = {
  position: "relative",
  zIndex: 20,
  flex: "1 1 auto",
  display: "flex",
  alignItems: "center",
  gap: "var(--u2)",
  minWidth: 0,
};

/**
 * Files are over the bar and will be captured if dropped. `--mark` is Deck's
 * one "this wants your attention" colour and is not in the severity ramp,
 * which is right: a pending drop is not a state of anything.
 */
const BAR_DROP_STYLE: CSSProperties = {
  ...BAR_STYLE,
  outline: "2px dashed var(--mark)",
  outlineOffset: -2,
  background: "var(--sel)",
};

/**
 * The results panel.
 *
 * `.dk-modal` rather than `.dk-menu`: a menu is `min-width: 190px` and sits at
 * a corner, while this is a full-width sheet under the field. `.dk-modal` is
 * the panel box — ground, border, radius — and, decisively, it is the one
 * surface the narrow-viewport rule exempts. Under 1100px Deck gives every
 * `.dk-head`/`.dk-line` a 900px floor so a wide table scrolls sideways rather
 * than crushing, and `.dk-modal .dk-line { min-width: 0 }` is the opt-out. A
 * 520px dropdown of 900px rows is exactly the bug that rule would cause, and
 * `components/notification-bell.tsx` takes `.dk-modal` for its popover for the
 * same reason.
 *
 * `width: auto` undoes `.dk-modal`'s own 680px, since `left`/`right` set the
 * width here, and `overflowY` moves the scroll onto the panel because the
 * rows are its direct children rather than living in a `.dk-modal__b`.
 */
const PANEL_STYLE: CSSProperties = {
  position: "absolute",
  top: "100%",
  left: 0,
  right: 0,
  width: "auto",
  marginTop: 4,
  maxHeight: "min(320px, 50vh)",
  overflowY: "auto",
  zIndex: 100,
};

/**
 * Three columns: the state glyph Deck puts on every row, the label, and the
 * meta. Not in `DECK_COLS` — that module is a deck primitive and out of scope
 * — so it lives with its one list, as `BELL_COLS` does.
 */
const OMNI_COLS = "14px minmax(0, 1fr) 132px";

/** Pinned under the rows, as it was: a rule and one line of footnote. */
const PANEL_FOOT_STYLE: CSSProperties = {
  padding: "var(--u) var(--u3)",
  borderTop: "1px solid var(--line)",
};

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("file read produced non-string result"));
        return;
      }
      // `data:<mime>;base64,<payload>` → take everything after the comma.
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

function dispatchPaletteOpen(): void {
  document.dispatchEvent(new CustomEvent(OMNI_EVENT_OPEN_PALETTE));
}

function dispatchOpenLaunch(): void {
  document.dispatchEvent(new CustomEvent(OMNI_EVENT_OPEN_LAUNCH));
}

const KIND_LABEL: Record<IntentResult["kind"], string> = {
  "command-palette": "palette",
  slash: "slash cmd",
  reference: "reference",
  search: "search",
  prompt: "prompt",
};


/**
 * What the dropdown is showing right now. `"search"` covers both the
 * classifier's `search` and `prompt` kinds — they render the same result
 * list; only the capture chip (driven by `captureEligible`) distinguishes a
 * `prompt`-shaped query, per plan D3.
 */
type OmniMode = "command" | "reference" | "search" | "none";

function modeForIntent(kind: IntentResult["kind"]): OmniMode {
  switch (kind) {
    case "slash":
      return "command";
    case "reference":
      return "reference";
    case "search":
    case "prompt":
      return "search";
    case "command-palette":
      return "none";
  }
}

type OmniRow =
  | { kind: "command"; command: OmniCommand }
  | { kind: "mention"; row: OmniMentionRow }
  | { kind: "result"; result: SearchResult };

function rowKey(row: OmniRow, idx: number): string {
  switch (row.kind) {
    case "command":
      return row.command.id;
    case "mention":
      return `mention-${idx}`;
    case "result":
      return `${row.result.type}-${row.result.id}`;
  }
}

/**
 * The word a row needs when nothing else on it names its kind.
 *
 * `omni-mentions.ts` already puts "project", "agent" or "human" in `meta`, and
 * in search mode the group header above the row names the type, so those rows
 * need nothing. A library row's `meta` is the slug, which leaves it as the one
 * row whose kind was carried by its icon alone — so it gets the word.
 */
function rowTag(row: OmniRow): string | null {
  if (row.kind !== "mention") return null;
  const k = row.row.kind;
  return k === "library" || k === "library-ref" ? "snippet" : null;
}

function rowLabel(row: OmniRow): string {
  switch (row.kind) {
    case "command":
      return row.command.title;
    case "mention":
      return row.row.label;
    case "result":
      return row.result.title;
  }
}

function rowMetaText(row: OmniRow): string {
  switch (row.kind) {
    case "command":
      return row.command.hint;
    case "mention":
      return row.row.meta;
    case "result":
      return resultMeta(row.result);
  }
}

export function OmniBar(): ReactElement {
  const navigate = useNavigate();
  const projects = useProjects();
  const members = useTeamMembers();
  const createInbox = useCreateInboxItem();
  const createAttachment = useCreateAttachment();
  const features = useEnabledFeatures();

  const [query, setQuery] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  const intent = useMemo(() => classifyIntent(query), [query]);
  const mode = modeForIntent(intent.kind);

  const snippetsOn = features["snippets"] !== false;
  // No library request until the user actually types `@`, and none at all
  // when the Snippets feature is off (the default). `@library:<slug>`
  // resolution itself stays unconditional — only the suggestion rows gate.
  const library = useLibraryItems(
    undefined,
    undefined,
    mode === "reference" && snippetsOn,
  );

  const searchTerm = mode === "search" ? intent.payload : "";
  const debouncedTerm = useDebounce(searchTerm, 200);
  // useSearch self-disables below 2 chars, so no extra guard is needed here.
  const { data: searchData, isFetching, isError } = useSearch(debouncedTerm);
  const grouped = useMemo(
    () => groupResults(searchData?.results),
    [searchData],
  );

  const captureEligible = intent.kind === "prompt";

  const rows: OmniRow[] = useMemo(() => {
    if (mode === "command") {
      return buildCommandRows(intent.payload, features, OMNI_COMMAND_LIMIT).map(
        (command): OmniRow => ({ kind: "command", command }),
      );
    }
    if (mode === "reference") {
      return buildMentionRows(
        {
          projects: projects.data ?? [],
          members: members.data ?? [],
          library: library.data?.items ?? [],
        },
        intent.payload,
      ).map((row): OmniRow => ({ kind: "mention", row }));
    }
    if (mode === "search") {
      return flattenGrouped(grouped).map(
        (result): OmniRow => ({ kind: "result", result }),
      );
    }
    return [];
  }, [
    mode,
    intent.payload,
    features,
    projects.data,
    members.data,
    library.data,
    grouped,
  ]);

  const open = focused && !dismissed && mode !== "none";
  const clampedIdx = Math.min(activeIdx, Math.max(0, rows.length - 1));

  const voice = useVoiceDictation({
    onFinalTranscript: (text) => {
      setQuery((current) => (current ? `${current} ${text}` : text));
    },
  });

  // Surface the listening state in the kind badge so the user sees the
  // hotkey worked.
  useEffect(() => {
    if (voice.listening) toast.message("Listening…", { duration: 1500 });
  }, [voice.listening]);

  async function ingestOne(file: File): Promise<void> {
    try {
      const b64 = await fileToBase64(file);
      const inbox = await createInbox.mutateAsync({
        title: `Captured: ${file.name}`,
        source: "omni-bar",
        type: "attachment",
        description: `# Attachment from omni-bar drop\n\nfilename: ${file.name}\nmime: ${file.type || "application/octet-stream"}\nsize: ${file.size} bytes`,
      });
      await createAttachment.mutateAsync({
        filename: file.name,
        mime_type: file.type || "application/octet-stream",
        content_b64: b64,
        inbox_item_id: inbox.id,
      });
      toast.success(`Attached ${file.name} → inbox #${inbox.id}`);
    } catch (err) {
      toast.error(
        `Attachment failed (${file.name}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function ingestFiles(files: FileList): Promise<void> {
    // Bounded concurrency — `Promise.all` over a sliding window of 4 keeps
    // a 20-file drop from monopolising the event loop / sidecar.
    const queue = Array.from(files);
    const CONCURRENCY = 4;
    const workers = Array.from(
      { length: Math.min(CONCURRENCY, queue.length) },
      async () => {
        while (queue.length > 0) {
          const next = queue.shift();
          if (next) await ingestOne(next);
        }
      },
    );
    await Promise.all(workers);
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>): void {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      setDragOver(true);
    }
  }

  function handleDragLeave(): void {
    setDragOver(false);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>): void {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    setDragOver(false);
    void ingestFiles(e.dataTransfer.files);
  }

  async function insertLibrarySnippet(slug: string): Promise<void> {
    try {
      const item = await fetchLibraryItemBySlug(slug);
      if (!item) {
        toast.error(`No library item @library:${slug}`);
        return;
      }
      setQuery(item.body);
      toast.success(`Inserted @library:${slug}`);
    } catch (err) {
      toast.error(
        `Library lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  function capture(): void {
    createInbox.mutate(
      { title: intent.payload, source: "omni-bar", type: "prompt" },
      {
        onSuccess: (data) => {
          toast.success(`Captured to inbox #${data.id}`);
          setQuery("");
        },
        onError: (e) => toast.error(`Capture failed: ${e.message}`),
      },
    );
  }

  function activate(row: OmniRow): void {
    if (row.kind === "command") {
      const { target } = row.command;
      if (target.kind === "navigate") {
        navigate(target.path);
      } else if (target.action === "new-task") {
        navigate("/tasks?new=1");
      } else if (target.action === "launch-project") {
        dispatchOpenLaunch();
      } else {
        dispatchPaletteOpen();
      }
      setQuery("");
      return;
    }
    if (row.kind === "mention") {
      const m = row.row;
      if (m.kind === "project") {
        navigate(projectRoute(m.projectId));
        setQuery("");
      } else if (m.kind === "member") {
        navigate(`/team/${encodeURIComponent(m.name)}`);
        setQuery("");
      } else {
        void insertLibrarySnippet(m.slug);
      }
      return;
    }
    navigate(routeForResult(row.result));
    setQuery("");
  }

  function onChange(e: ChangeEvent<HTMLInputElement>): void {
    setQuery(e.target.value);
    setActiveIdx(0);
    setDismissed(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (captureEligible) capture();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (open && rows.length > 0) {
        const row = rows[clampedIdx];
        if (row) activate(row);
        return;
      }
      if (intent.kind === "reference") {
        const ref = parseLibraryRef(intent.payload);
        if (ref && !ref.ok) {
          toast.error(
            ref.reason === "empty"
              ? "Empty @library:<slug>"
              : `Invalid @library:${ref.slug}`,
          );
        }
        return;
      }
      if (intent.kind === "command-palette") {
        dispatchPaletteOpen();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, Math.max(0, rows.length - 1)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Escape") {
      // Two-stage, intentionally: escaping out of an open results panel
      // should not also destroy what you typed. `open` already implies
      // `mode !== "none"`, so a second Escape (panel already dismissed)
      // falls through to clearing the input.
      if (open) {
        setDismissed(true);
      } else {
        setQuery("");
      }
    }
  }

  // `null` means "none" — the idle state, rendered specially below so the
  // ⌘K kbd stays a real <kbd> element rather than being flattened into text.
  const modeHint = ((): string | null => {
    if (mode === "command") return "↑↓ navigate · ↵ run command";
    if (mode === "reference") return "↑↓ navigate · ↵ insert or open";
    if (mode === "search")
      return `↑↓ navigate · ↵ open${captureEligible ? " · ⌘↵ save to inbox" : ""}`;
    return null;
  })();

  const panelMessage = ((): string | null => {
    // The `useSearch`-derived flags are only meaningful in `search` mode —
    // `/` and `@` need no network, and must keep working even if the last
    // search errored (edge case: "Sidecar down / useSearch errors").
    if (mode === "search" && isFetching && !searchData) return "Searching…";
    if (mode === "search" && debouncedTerm.trim().length < 2)
      return "Keep typing to search…";
    if (mode === "search" && isError) return "Search unavailable";
    if (mode === "reference" && intent.payload.length === 0)
      return "Type to reference a project, agent or snippet";
    if (rows.length === 0) return "No matches";
    return null;
  })();

  function renderRow(row: OmniRow, idx: number): ReactElement {
    const selected = idx === clampedIdx;
    const tag = rowTag(row);
    return (
      // A `.dk-line` but not a `DeckLine`: this list is a combobox popup, so
      // the rows have to stay `role="option"` under `role="listbox"` with the
      // input keeping focus and `aria-activedescendant` pointing at the
      // selection. `DeckLine` is a `role="row"` driven by a roving tabindex,
      // which would move focus off the field and break typing. The class is
      // the part worth sharing; the keyboard model is not.
      <div
        key={rowKey(row, idx)}
        id={`omni-row-${idx}`}
        role="option"
        aria-selected={selected}
        className={`dk-line${selected ? " on" : ""}`}
        onMouseDown={(e) => {
          e.preventDefault();
          activate(row);
        }}
        onMouseEnter={() => setActiveIdx(idx)}
      >
        {/* Deck puts a state in column one of every row. A suggestion is not
            running, failing or waiting on anybody — `idle` ("inert") is the
            honest reading, and claiming anything else would give this list a
            second vocabulary for the glyph the rest of the app shares. */}
        <span className="dk-s" data-s="idle" role="img" aria-label="inert" />
        {/* `.dk-actions` is the gapped cluster — without it a label and a tag
            butt together and read as one word. Same title-plus-tag shape the
            bell uses. The label keeps its own element so it stays the row's
            accessible name rather than "Dependency Scan snippet". */}
        <span className="dk-actions">
          <span className="trunc">{rowLabel(row)}</span>
          {tag !== null && <span className="dk-tag">{tag}</span>}
        </span>
        <span className="r dim">{rowMetaText(row)}</span>
      </div>
    );
  }

  function renderPanelRows(): ReactElement {
    if (mode === "search") {
      let idx = 0;
      return (
        <>
          {GROUP_ORDER.map((type) => {
            const items = grouped[type];
            if (items.length === 0) return null;
            const groupRows = items.map((result) => {
              const el = renderRow({ kind: "result", result }, idx);
              idx += 1;
              return el;
            });
            return (
              <div key={type}>
                {/* `.dk-grp__h` is Deck's section label — uppercase, tracked
                    out, on the faint tier. It is named for the rail's groups
                    but it is a plain class and this is the same thing: a word
                    over a list. */}
                <div role="presentation" className="dk-grp__h">
                  {GROUP_LABELS[type]}
                </div>
                {groupRows}
              </div>
            );
          })}
        </>
      );
    }
    return <>{rows.map((row, idx) => renderRow(row, idx))}</>;
  }

  return (
    <div
      style={dragOver ? BAR_DROP_STYLE : BAR_STYLE}
      role="search"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* `.dk-field` is Deck's bordered input row, and it already draws the
          leading glyph slot and the focus border `.input:focus` hand-rolled.
          `components/explorer/find-palette-overlay.tsx` sets the precedent. */}
      <span className="dk-field" style={{ flex: "1 1 auto", minWidth: 0 }}>
        <span className="dim" style={{ display: "flex", flex: "none" }}>
          <Icon name="search" size={13} />
        </span>
        <input
          type="text"
          value={query}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Search, or type / for commands, @ to reference…"
          aria-label="Search and commands"
          role="combobox"
          aria-expanded={open}
          aria-controls="omni-listbox"
          aria-activedescendant={
            open && rows.length ? `omni-row-${clampedIdx}` : undefined
          }
          // The first character selects the grammar in classifyIntent
          // (lib/prompt-intent.ts), and `@library:<slug>` is rejected by a
          // lowercase-only regex, so an OS rewrite can change which branch
          // runs or turn a valid slug into an error toast.
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
        />
      </span>
      {/* The grammar, as a word. `run` while dictating is the one state the
          badge still carries — see the file header on the five kind colours. */}
      <span
        className="dk-tag"
        style={{ flex: "none" }}
        data-s={voice.listening ? "run" : undefined}
      >
        {voice.listening ? "listening…" : KIND_LABEL[intent.kind]}
      </span>
      {captureEligible ? (
        // A named secondary action, so `.dk-btn` — the pill it replaces was a
        // third button shape with no rule behind it, which is the thing
        // design/deck/README.md's "Where an action goes" exists to stop.
        <button
          type="button"
          className="dk-btn"
          onMouseDown={(e) => {
            e.preventDefault();
            capture();
          }}
          disabled={createInbox.isPending}
        >
          Save as inbox item ⌘↵
        </button>
      ) : null}
      <span className="dk-meta">
        {voice.supported
          ? "Cmd+Shift+Space dictate (audio leaves device) · "
          : ""}
        {modeHint !== null ? (
          modeHint
        ) : (
          <>
            {/* Deck has no key-cap primitive; `.dk-tag` is the chip it would
                be, and the element stays a real `<kbd>`. */}
            <kbd className="dk-tag">⌘K</kbd> palette · drop files
          </>
        )}
      </span>
      {open ? (
        <div
          id="omni-listbox"
          role="listbox"
          className="dk-modal"
          style={{ ...PANEL_STYLE, ["--cols" as string]: OMNI_COLS }}
        >
          {panelMessage !== null ? (
            <div className="dk-note">{panelMessage}</div>
          ) : (
            renderPanelRows()
          )}
          {/* Complements the always-visible `.hint` strip above (which
              already states the mode-specific navigate/act hint) rather
              than repeating it. */}
          <div className="dk-meta trunc" style={PANEL_FOOT_STYLE}>
            esc close
          </div>
        </div>
      ) : null}
    </div>
  );
}
