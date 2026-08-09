import {
  useEffect,
  useMemo,
  useState,
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
  routeForResult,
  typeColor,
  typeIcon,
} from "../lib/search-results";
import { useDebounce } from "../hooks/use-debounce";
import { useVoiceDictation } from "../lib/use-voice-dictation";
import { Icon } from "./icon";
import styles from "./omni-bar.module.css";

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

const KIND_CLASS: Record<IntentResult["kind"], string> = {
  "command-palette": styles.kindEmpty ?? "",
  slash: styles.kindSlash ?? "",
  reference: styles.kindReference ?? "",
  search: styles.kindSearch ?? "",
  prompt: styles.kindPrompt ?? "",
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

function rowIconName(row: OmniRow): string {
  switch (row.kind) {
    case "command":
      return row.command.icon;
    case "mention":
      if (row.row.kind === "project") return "projects";
      if (row.row.kind === "member") return "team";
      return "library";
    case "result":
      return typeIcon(row.result.type);
  }
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
      return row.result.type;
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
    const metaStyle =
      row.kind === "result" ? { color: typeColor(row.result.type) } : undefined;
    return (
      <div
        key={rowKey(row, idx)}
        id={`omni-row-${idx}`}
        role="option"
        aria-selected={selected}
        className={`${styles.suggestion ?? ""} ${selected ? (styles.suggestionActive ?? "") : ""}`}
        onMouseDown={(e) => {
          e.preventDefault();
          activate(row);
        }}
        onMouseEnter={() => setActiveIdx(idx)}
      >
        <span className={styles.rowIcon ?? ""}>
          <Icon name={rowIconName(row)} size={12} />
        </span>
        <span>{rowLabel(row)}</span>
        <span className={styles.rowMeta ?? ""} style={metaStyle}>
          {rowMetaText(row)}
        </span>
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
                <div role="presentation" className={styles.groupHeader ?? ""}>
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
      className={`${styles.bar ?? ""} ${dragOver ? (styles.barDrag ?? "") : ""}`}
      role="search"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <span className={styles.leadIcon ?? ""}>
        <Icon name="search" size={13} />
      </span>
      <input
        type="text"
        className={styles.input}
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
      <span className={`${styles.kind ?? ""} ${KIND_CLASS[intent.kind] ?? ""}`}>
        {voice.listening ? "listening…" : KIND_LABEL[intent.kind]}
      </span>
      {captureEligible ? (
        <button
          type="button"
          className={styles.captureChip ?? ""}
          onMouseDown={(e) => {
            e.preventDefault();
            capture();
          }}
          disabled={createInbox.isPending}
        >
          Save as inbox item ⌘↵
        </button>
      ) : null}
      <span className={styles.hint}>
        {voice.supported
          ? "Cmd+Shift+Space dictate (audio leaves device) · "
          : ""}
        {modeHint !== null ? (
          modeHint
        ) : (
          <>
            <kbd className={styles.kbdHint}>⌘K</kbd> palette · drop files
          </>
        )}
      </span>
      {open ? (
        <div id="omni-listbox" role="listbox" className={styles.suggestions ?? ""}>
          {panelMessage !== null ? (
            <div className={styles.emptyState ?? ""}>{panelMessage}</div>
          ) : (
            renderPanelRows()
          )}
          {/* Complements the always-visible `.hint` strip above (which
              already states the mode-specific navigate/act hint) rather
              than repeating it. */}
          <div className={styles.panelFooter ?? ""}>esc close</div>
        </div>
      ) : null}
    </div>
  );
}
