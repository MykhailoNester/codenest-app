import {
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type ReactElement,
} from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  classifyIntent,
  fetchSidecar,
  SidecarError,
  useCreateAttachment,
  useCreateInboxItem,
  useProjects,
  useTeamMembers,
  type IntentResult,
  type LibraryItem,
} from "../lib/api";
import { useVoiceDictation } from "../lib/use-voice-dictation";
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

// Global event the App-level Cmd+K handler subscribes to so Shell consumers
// don't have to plumb a callback down through every page.
const PALETTE_OPEN_EVENT = "omni:open-palette";

const LIBRARY_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

function dispatchPaletteOpen(): void {
  document.dispatchEvent(new CustomEvent(PALETTE_OPEN_EVENT));
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

const KIND_ACTION: Record<IntentResult["kind"], string> = {
  "command-palette": "",
  slash: "↵ run command",
  reference: "↵ navigate  ·  @library:<slug> to insert a snippet",
  search: "↵ search docs",
  prompt: "↵ capture to WorkBoard",
};

export function OmniBar(): ReactElement {
  const navigate = useNavigate();
  const projects = useProjects();
  const members = useTeamMembers();
  const createInbox = useCreateInboxItem();
  const createAttachment = useCreateAttachment();

  const [query, setQuery] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const intent = useMemo(() => classifyIntent(query), [query]);

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

  const refSuggestions = useMemo(() => {
    if (intent.kind !== "reference") return [];
    const needle = intent.payload.toLowerCase();
    // Require at least one character after the `@` — typing just `@`
    // shouldn't surface every project + member.
    if (needle.length === 0) return [];
    const out: { label: string; meta: string; onPick: () => void }[] = [];
    for (const p of projects.data ?? []) {
      if (p.name.toLowerCase().includes(needle)) {
        out.push({
          label: p.name,
          meta: "project",
          onPick: () => {
            navigate("/projects");
            setQuery("");
          },
        });
      }
    }
    for (const m of members.data ?? []) {
      if (m.name.toLowerCase().includes(needle)) {
        out.push({
          label: m.name,
          meta: m.type === "agent" ? "agent" : "human",
          onPick: () => {
            navigate(`/team/${encodeURIComponent(m.name)}`);
            setQuery("");
          },
        });
      }
    }
    return out.slice(0, 10);
  }, [intent, projects.data, members.data, navigate]);

  function handleSubmit(): void {
    switch (intent.kind) {
      case "command-palette":
        dispatchPaletteOpen();
        return;
      case "slash":
        // Re-use the existing palette as the slash execution surface so we
        // don't reimplement the slash registry.
        dispatchPaletteOpen();
        return;
      case "reference":
        if (intent.payload.toLowerCase().startsWith("library:")) {
          const rest = intent.payload.slice("library:".length);
          const slug = rest.split(/\s/, 1)[0]?.toLowerCase() ?? "";
          if (!slug) {
            toast.error("Empty @library:<slug>");
            return;
          }
          if (!LIBRARY_SLUG_RE.test(slug)) {
            toast.error(`Invalid @library:${slug}`);
            return;
          }
          void (async () => {
            try {
              const item = await fetchSidecar<LibraryItem>(
                `/api/v1/library/by-slug/${encodeURIComponent(slug)}`,
              );
              setQuery((current) => {
                const match = current.match(/@library:/i);
                const idx = match?.index ?? -1;
                const head = idx >= 0 ? current.slice(0, idx) : "";
                return `${head}${item.body}`;
              });
              toast.success(`Inserted @library:${slug}`);
            } catch (err) {
              if (err instanceof SidecarError && err.status === 404) {
                toast.error(`No library item @library:${slug}`);
              } else {
                toast.error(
                  `Library lookup failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
          })();
          return;
        }
        // Pick the first suggestion on Enter; if none, fall through to inbox.
        if (refSuggestions.length > 0) {
          refSuggestions[0]?.onPick();
          return;
        }
        toast.error(`No match for @${intent.payload}`);
        return;
      case "search":
        // Route to the docs page with a search hash — that page already
        // wires a search box; it just consumes the hash and filters.
        navigate(`/docs#q=${encodeURIComponent(intent.payload)}`);
        setQuery("");
        return;
      case "prompt":
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
        return;
    }
  }

  return (
    <div
      className={`${styles.bar} ${dragOver ? (styles.barDrag ?? "") : ""}`}
      role="search"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        type="text"
        className={styles.input}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            handleSubmit();
          } else if (e.key === "Escape") {
            setQuery("");
          }
        }}
        placeholder="Ask, /command, @reference, or ?search…"
        aria-label="Universal prompt bar"
        // The first character selects the grammar in classifyIntent
        // (lib/api.ts), and `@library:<slug>` is rejected by a
        // lowercase-only regex, so an OS rewrite can change which branch
        // runs or turn a valid slug into an error toast.
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
      />
      <span className={`${styles.kind} ${KIND_CLASS[intent.kind] ?? ""}`}>
        {voice.listening ? "listening…" : KIND_LABEL[intent.kind]}
      </span>
      <span className={styles.hint}>
        {voice.supported
          ? "Cmd+Shift+Space dictate (audio leaves device) · "
          : ""}
        <kbd className={styles.kbdHint}>⌘K</kbd> palette · drop files
      </span>
      {refSuggestions.length > 0 ? (
        <div className={styles.suggestions} role="listbox">
          {refSuggestions.map((s) => (
            <div
              key={`${s.meta}:${s.label}`}
              className={styles.suggestion}
              role="option"
              aria-selected={false}
              onClick={s.onPick}
            >
              <span>{s.label}</span>
              <span className={styles.suggestionMeta}>{s.meta}</span>
            </div>
          ))}
        </div>
      ) : null}
      {intent.kind !== "command-palette" &&
      refSuggestions.length === 0 &&
      query.length > 0 &&
      !(intent.kind === "reference" && intent.payload.length === 0) ? (
        <span className={styles.actionHint}>
          {KIND_ACTION[intent.kind]}
        </span>
      ) : null}
    </div>
  );
}
