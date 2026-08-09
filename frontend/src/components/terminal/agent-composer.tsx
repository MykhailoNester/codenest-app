/**
 * The composer — mode row, real-data context pills (plus a `{}` popover onto
 * the literal wire line send transmits), an auto-growing `@`-mention-highlighted
 * editor, an actions row, and re-runnable prompt-history pills. Structure
 * mirrors `prototype:737-768` top to bottom. Every element here is bound to
 * real state — nothing renders from a literal (see the plan's "NO MOCK UI"
 * rule).
 *
 * On top of that: a leading `/` opens a caret-anchored command menu
 * (`/model`, `/mode`, `/clear`, `/compact`, `/help` — a mirror of the CLI
 * TUI's own menu, restored because the composer replaced a raw PTY running
 * that CLI), and a typed `@` opens a caret-anchored mention menu over
 * Codenest agents, open tasks and library snippets. See the plan's Design
 * decisions 1-12 for the reasoning behind each choice below.
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useEscapeKey } from "../../hooks/use-escape-key";
import type { DragEvent, KeyboardEvent, ReactElement, Ref } from "react";
import {
  useLibraryItems,
  useTasks,
  fetchLibraryItemBySlug,
  type Task,
  type LibraryItem,
} from "../../lib/api";
import {
  agentInterrupt,
  agentSend,
  agentSetModel,
  agentSetPermissionMode,
} from "../../lib/ipc";
import { useAgentCatalogStore, type CatalogProvider } from "../../stores/agent-catalog-store";
import {
  buildUserMessageText,
  previewUserMessageLine,
  type ConversationState,
  type UserMessagePill,
} from "../../lib/agent-conversation";
import {
  useComposerStore,
  resolveSendTargets,
  CODENEST_PATHS_MIME,
  type ContextPill,
} from "../../stores/composer-store";
import { readPathDragPayload } from "../../lib/explorer/drag-payload";
import { logDnd } from "../../lib/drop-diagnostics";
import { useAgentSessionStore } from "../../stores/agent-session-store";
import { useTerminalStore } from "../../stores/terminal-store";
import { collectLeaves, paneKind } from "../../lib/layout-tree";
import { recordAgentExited } from "../../lib/agent-run-telemetry";
import { detectTrigger, parseCommandLine } from "../../lib/prompt-intent";
import {
  findCommand,
  buildSlashRows,
  runCommandLine,
  helpRows,
  type CommandData,
  type CommandOption,
  type CommandOutcome,
  type SlashCommandEffects,
  type SlashRow,
} from "../../lib/composer-commands";
import {
  buildMentionRows,
  replaceRange,
  PICKABLE_TASK_STATUSES,
  taskRank,
  type MentionSources,
  type MentionRow,
} from "../../lib/composer-mentions";
import { caretAnchor } from "../../lib/caret-anchor";
import { slashRowToSuggest, mentionRowToSuggest, type SuggestRow } from "../../lib/composer-menu";
import { SuggestPanel, MentionSourceProbe } from "./composer-suggest";
import { focusComposerAt, resizeComposerEditor } from "../../lib/composer-focus";
import styles from "./agent-composer.module.css";

interface AgentComposerProps {
  leafId: string;
  status: ConversationState["status"];
  /** `providers.id` this pane's session runs against, as persisted on the leaf. */
  providerId: number | null;
  /** The model this pane's session runs, as persisted on the leaf. */
  model: string | null;
  /** The permission mode persisted on the leaf; `null` means the CLI default. */
  permissionMode: string | null;
  /** Stop and respawn the session — the only way to apply a provider change,
   *  since the binary and env are fixed at spawn. */
  onRequestRestart: () => void;
}

const MAX_HISTORY_PILLS = 6;
// The mirror's inset inside `.editorStack` (matches `.editorMirror`'s
// `top`/`left` in `agent-composer.module.css`), and the suggestion panel's
// nominal width (`.suggest`'s `min-width`/`max-width` midpoint) — both feed
// `caretAnchor` (Design decision 8/9).
const MIRROR_PAD_LEFT_PX = 10;
const MIRROR_PAD_TOP_PX = 8;
const SUGGEST_PANEL_WIDTH_PX = 320;
const SUGGEST_GAP_PX = 6;

function pillToMessagePill(pill: ContextPill): UserMessagePill {
  switch (pill.kind) {
    case "file":
      return { kind: "file", path: pill.path };
    case "task":
      return { kind: "task", taskId: pill.taskId, title: pill.title, description: pill.description };
    case "template":
      return { kind: "template", slug: pill.slug, title: pill.title, body: pill.body };
  }
}

function pathBasename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function pillLabel(pill: ContextPill): string {
  switch (pill.kind) {
    case "file":
      return pathBasename(pill.path);
    case "task":
      return `#${pill.taskId} ${pill.title}`;
    case "template":
      return pill.title;
  }
}

function pillClass(pill: ContextPill): string | undefined {
  switch (pill.kind) {
    case "file":
      return styles.pillFile;
    case "task":
      return styles.pillTask;
    case "template":
      return styles.pillTpl;
  }
}

function pillKey(pill: ContextPill): string {
  switch (pill.kind) {
    case "file":
      return "@";
    case "task":
      return "task";
    case "template":
      return "tpl";
  }
}

/** Highlights `@token` runs for the read-only overlay behind the textarea. */
function renderMentionOverlay(text: string): ReactElement {
  const parts = text.split(/(@\S+)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("@") ? (
          <span key={i} className={styles.mention}>
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

/**
 * `head` + a marker span wrapping the sigil-to-caret token + `tail`, used
 * only to measure where the caret currently is (Design decision 8). The span
 * always wraps at least the sigil character (`start` is the `/` or `@`'s own
 * index, `end` is the caret), so its rect is never degenerate — including at
 * the start of a wrapped or freshly-newlined line. Rendered into a hidden
 * mirror div that shares `.editorOverlay`/`.editorTextarea`'s font metrics
 * and wrapping by construction (same CSS rule group), so no
 * `getComputedStyle` copying is needed.
 */
function renderMirror(
  text: string,
  start: number,
  end: number,
  markerRef: Ref<HTMLSpanElement>,
): ReactElement {
  return (
    <>
      {text.slice(0, start)}
      <span ref={markerRef} className={styles.mirrorMark}>
        {text.slice(start, end)}
      </span>
      {text.slice(end)}
    </>
  );
}

/** `providers.find(p => p.id === providerId) ?? providers[0] ?? null` —
 *  narrows on `null`, so callers never need a `!`. */
function activeProvider(
  providers: CatalogProvider[],
  providerId: number | null,
): CatalogProvider | null {
  return providers.find((p) => p.id === providerId) ?? providers[0] ?? null;
}

function ContextPicker({
  onPick,
  onClose,
}: {
  onPick: (pill: ContextPill) => void;
  onClose: () => void;
}): ReactElement {
  const { data: library } = useLibraryItems();
  // No status filter: the sort below orders what came back, so one request
  // serves every status the picker offers.
  const { data: tasks } = useTasks();
  const [query, setQuery] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  // Dismiss on a click anywhere else — the same `mousedown` + Escape pairing the
  // app's other popovers use (`notification-bell.tsx:65-81`). The trigger button
  // stops its own `mousedown` from reaching this listener, so clicking it while
  // open closes it once via its toggle instead of closing here and immediately
  // reopening.
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (!panelRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);
  useEscapeKey(onClose);

  const needle = query.trim().toLowerCase();
  const templates: LibraryItem[] = (library?.items ?? []).filter(
    (item) =>
      needle === "" ||
      item.title.toLowerCase().includes(needle) ||
      item.slug.toLowerCase().includes(needle),
  );
  const pickableTasks: Task[] = (tasks ?? [])
    .filter((t) => taskRank(t.status) < PICKABLE_TASK_STATUSES.length)
    .filter(
      (t) =>
        needle === "" ||
        t.title.toLowerCase().includes(needle) ||
        // A ticket is as often known by its number as its title.
        `#${t.id}`.includes(needle) ||
        String(t.id) === needle,
    )
    .sort((a, b) => taskRank(a.status) - taskRank(b.status) || b.id - a.id);

  return (
    <div className={styles.pickerPanel} role="listbox" ref={panelRef}>
      <div className={styles.pickerSearch}>
        <input
          className={styles.pickerInput}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter templates and tasks…"
          aria-label="Filter context"
          autoFocus
          // The needle is compared to lowercased titles, slugs and `#<id>`
          // (see the filters above), so an OS word substitution would
          // silently empty the list.
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
        />
      </div>
      <div className={styles.pickerHeader}>Templates</div>
      {templates.length === 0 ? (
        <div className={styles.pickerEmpty}>
          {needle === "" ? "No templates yet" : "No matching templates"}
        </div>
      ) : (
        templates.map((item) => (
          <button
            key={item.slug}
            type="button"
            className={styles.pickerRow}
            onClick={() => {
              onPick({ id: crypto.randomUUID(), kind: "template", slug: item.slug, title: item.title, body: item.body });
              onClose();
            }}
          >
            {item.title}
          </button>
        ))
      )}
      <div className={styles.pickerHeader}>Tasks</div>
      {pickableTasks.length === 0 ? (
        <div className={styles.pickerEmpty}>
          {needle === "" ? "No open tasks" : "No matching tasks"}
        </div>
      ) : (
        pickableTasks.map((task) => (
          <button
            key={task.id}
            type="button"
            className={styles.pickerRow}
            onClick={() => {
              onPick({
                id: crypto.randomUUID(),
                kind: "task",
                taskId: task.id,
                title: task.title,
                description: task.description,
              });
              onClose();
            }}
            title={`#${task.id} · ${task.status}`}
          >
            <span className={styles.pickerRowId}>#{task.id}</span>
            <span className={styles.pickerRowTitle}>{task.title}</span>
            <span className={styles.pickerRowMeta}>{task.status}</span>
          </button>
        ))
      )}
    </div>
  );
}

/**
 * The popover behind the `{}` trigger: the exact stdin line Send would write
 * for the current draft, in full — not the ellipsised fragment the old `.wire`
 * strip showed. `line` is a prop, not something derived in here: the parent
 * already re-renders on every keystroke (`draft` from the composer store), so
 * a fresh `line` arrives per keystroke and this panel stays live for free.
 *
 * Dismissal mirrors `ContextPicker` above: outside `mousedown` + Escape, plus
 * an explicit `×` because this panel opens over its own trigger (it anchors
 * upward from `.cedit`, the same box `ContextPicker` uses) and so a
 * pointer-only user needs some way to close it that isn't "click elsewhere".
 */
function WirePreview({
  line,
  panelId,
  onClose,
}: {
  line: string;
  panelId: string;
  onClose: () => void;
}): ReactElement {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (!panelRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);
  useEscapeKey(onClose);

  return (
    <div
      className={styles.previewPanel}
      role="group"
      aria-label="Wire preview"
      id={panelId}
      ref={panelRef}
    >
      <div className={styles.previewHead}>
        <span className={styles.previewLabel}>WRITES</span>
        <span className={styles.previewMeta}>{line.length} chars</span>
        <button
          type="button"
          className={styles.previewClose}
          aria-label="Close preview"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <code className={styles.previewCode}>{line}</code>
      <span className={styles.previewNote}>
        → claude --print --input-format stream-json · one JSON line on stdin
      </span>
    </div>
  );
}

/**
 * The permission modes offered for a *live* switch, in ascending order of how
 * much they let the agent do unasked. Deliberately not `agent::PERMISSION_MODES`
 * verbatim: that list is the spawn-time flag surface and includes
 * `bypassPermissions`, which the CLI refuses over the control channel unless the
 * session was launched with `--dangerously-skip-permissions` (verified against
 * CLI 2.1.220). Offering it here would be a control that fails every time it is
 * used, so it is left to the spawn path.
 *
 * `manual` is the CLI's `--help` spelling of the mode it applies as `default`,
 * which is why {@link modeSelectValue} has to treat the two as one option.
 */
const LIVE_PERMISSION_MODES: ReadonlyArray<{
  value: string;
  label: string;
  title: string;
}> = [
  {
    value: "plan",
    label: "plan",
    title: "Plan mode — the agent researches and proposes, and may not edit or run anything.",
  },
  {
    value: "manual",
    label: "ask",
    title: "Ask for everything the CLI would normally ask about (the default).",
  },
  {
    value: "acceptEdits",
    label: "auto-edit",
    title: "File edits apply without asking; everything else still asks.",
  },
  {
    value: "auto",
    label: "auto",
    title:
      "The CLI decides what is safe to run unasked. Some installs gate this mode off, in which case the switch is refused.",
  },
  {
    value: "dontAsk",
    // Deliberately not ordered last and deliberately not described as "allow
    // everything": `dontAsk` is a *deny* mode. The CLI documents it as
    // "Don't prompt for permissions, deny if not pre-approved" (2.1.220), and
    // it auto-denies through the same path as a deny rule — so on a session
    // with no allow rules it refuses every Bash call without ever asking.
    // The old wording ("stop asking altogether") read as bypassPermissions and
    // sent people here for the opposite of what they wanted.
    label: "don't ask (deny)",
    title:
      "Never prompts — and denies anything your permission rules don't already allow. For a session that just runs things, pick auto-edit, auto, or restart with full access.",
  },
];

/**
 * Which option to select for the mode the session reports. The CLI normalises
 * `manual` to `default` and reports the applied value, so a session running
 * `default` must light up the `manual` option rather than falling through to
 * "no selection".
 */
function modeSelectValue(applied: string | null): string {
  if (applied === null) return "";
  if (applied === "default") return "manual";
  return LIVE_PERMISSION_MODES.some((m) => m.value === applied) ? applied : "";
}

/** `LIVE_PERMISSION_MODES` as the slash registry's `CommandOption[]` — built
 *  once, module scope, so `/mode`'s menu and cycle order are always exactly
 *  the mode `<select>`'s own order. */
const MODE_OPTIONS: readonly CommandOption[] = LIVE_PERMISSION_MODES.map((m) => ({
  value: m.value,
  label: m.label,
  hint: m.title,
}));

/**
 * The provider + model + permission-mode row. The provider and model lists come
 * from Settings → Providers (the `providers` / `provider_models` tables), so
 * this surface never invents a model name of its own.
 *
 * The three selectors behave differently on purpose:
 *
 * * **Model** switches the *live* session over the stdin control channel
 *   (`set_model`) — the same thing `/model` does in the TUI. Nothing restarts,
 *   the conversation is kept, and the next assistant message simply comes back
 *   from the new model. If the session is not running there is nothing to
 *   switch, so the pick is just recorded for the next start.
 * * **Mode** switches over that same channel (`set_permission_mode`) — what
 *   Shift+Tab does in the TUI, which a `--print` child has no way to receive.
 *   The displayed value is the mode the *CLI* reports (`init`, then each
 *   `control_response`), never the optimistic pick, because the CLI both
 *   normalises the value and can refuse the switch.
 * * **Provider** cannot be applied in flight: it decides argv[0] and the env
 *   overlay (`CLAUDE_CONFIG_DIR`, i.e. *which account*), both fixed at spawn.
 *   Changing it restarts the session, which is why it asks first once a
 *   conversation exists.
 */
function ProviderModelRow({
  leafId,
  providerId,
  model,
  permissionMode,
  live,
  onRequestRestart,
}: {
  leafId: string;
  providerId: number | null;
  model: string | null;
  /** The mode persisted on the leaf — what the *next* start will use. Shown
   *  until the running session reports its own, which then wins. */
  permissionMode: string | null;
  /** Whether a session is currently running for this pane. */
  live: boolean;
  onRequestRestart: () => void;
}): ReactElement | null {
  const providers = useAgentCatalogStore((s) => s.providers);
  const load = useAgentCatalogStore((s) => s.load);
  const rememberSelection = useAgentCatalogStore((s) => s.rememberSelection);
  const setLeafAgentConfig = useTerminalStore((s) => s.setLeafAgentConfig);
  const turnCount = useAgentSessionStore((s) => s.panes[leafId]?.turns.length ?? 0);
  // The CLI's own answer, not what was picked here — see `modeSelectValue`.
  const appliedMode = useAgentSessionStore(
    (s) => s.panes[leafId]?.permissionMode ?? null,
  );
  const refusedMode = useAgentSessionStore(
    (s) => s.panes[leafId]?.permissionModeError ?? null,
  );
  const [modelError, setModelError] = useState<string | null>(null);
  const [modeError, setModeError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  // No catalog (sidecar unreachable, or no provider registered yet) — render
  // nothing rather than an empty dropdown that implies a choice exists.
  const active = activeProvider(providers, providerId);
  if (active === null) return null;
  // Re-bound to a plain, never-null local: TS does not carry the narrowing
  // above into the nested `handleProviderChange`/`handleModelChange`
  // declarations below, since a closure could in principle run after
  // `active` (however `const`) went out of scope's control-flow analysis.
  const activeId = active.id;

  const models = active.models;

  /**
   * The leaf carries no provider even though the catalog has one: this session
   * was started before the catalog was known, so it is running *without* that
   * provider's binary and env — against the default `~/.claude` config, which
   * is what produces `401 OAuth access token is invalid` on the first turn.
   *
   * The dropdown still has to show something, and it shows the provider that
   * *would* be used, so this flag is what stops that from being a lie: the row
   * says the session is not running it and offers the restart that applies it.
   * (Prevention lives in `agent-pane.tsx`, which now waits for the catalog
   * before spawning; this is the honest report for a session that predates the
   * fix or hit a genuinely unreachable sidecar.)
   */
  const unapplied = live && providerId === null;

  function handleProviderChange(nextId: number): void {
    if (nextId === activeId) return;
    if (
      live &&
      turnCount > 0 &&
      !window.confirm(
        "Switching provider restarts this session — the conversation so far is cleared. Continue?",
      )
    ) {
      return;
    }
    const next = providers.find((p) => p.id === nextId);
    if (!next) return;
    // The model is cleared, not carried over: a model registered against one
    // provider is not necessarily valid for another, and `resolveSelection`
    // will pick the new provider's own default.
    setLeafAgentConfig(leafId, { providerId: nextId, model: next.defaultModel });
    rememberSelection({ providerId: nextId, model: next.defaultModel });
    onRequestRestart();
  }

  function handleModelChange(nextModel: string): void {
    if (nextModel === model) return;
    setLeafAgentConfig(leafId, { model: nextModel });
    rememberSelection({ providerId: activeId, model: nextModel });
    setModelError(null);
    if (!live) return;
    void agentSetModel(leafId, nextModel).catch((err: unknown) => {
      // The switch did not take: say so instead of leaving the dropdown
      // claiming a model the session is not running.
      setModelError(err instanceof Error ? err.message : String(err));
    });
  }

  // The session's own report wins once it has one; until then (not started, or
  // started but pre-`init`) the leaf's persisted pick is the honest answer.
  const shownMode =
    modeSelectValue(appliedMode) || modeSelectValue(permissionMode);

  function handleModeChange(nextMode: string): void {
    if (nextMode === "" || nextMode === shownMode) return;
    // Recorded first so a restart boots into the chosen mode even if the live
    // switch below is refused — the flag path accepts modes the control path
    // will not.
    setLeafAgentConfig(leafId, { permissionMode: nextMode });
    setModeError(null);
    if (!live) return;
    void agentSetPermissionMode(leafId, nextMode).catch((err: unknown) => {
      setModeError(err instanceof Error ? err.message : String(err));
    });
  }

  return (
    <div className={styles.selectors}>
      <label className={styles.selectWrap}>
        <span className={styles.selectLabel}>provider</span>
        <select
          className={`${styles.select} ${unapplied ? styles.selectStale : ""}`}
          value={active.id}
          onChange={(e) => handleProviderChange(Number(e.currentTarget.value))}
          aria-label="Agent provider"
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </select>
      </label>
      {unapplied ? (
        <button
          type="button"
          className={styles.selectWarn}
          onClick={onRequestRestart}
          title={`This session started before ${active.displayName} was known, so it is running without that provider's environment — which is what a 401 on the first message means. Restart to apply it.`}
        >
          ⚠ restart to apply
        </button>
      ) : null}
      <label className={styles.selectWrap}>
        <span className={styles.selectLabel}>model</span>
        <select
          className={styles.select}
          value={model ?? active.defaultModel ?? ""}
          onChange={(e) => handleModelChange(e.currentTarget.value)}
          disabled={models.length === 0}
          aria-label="Agent model"
        >
          {models.length === 0 ? (
            <option value="">CLI default</option>
          ) : (
            models.map((m) => (
              <option key={m.model_name} value={m.model_name}>
                {m.display_name}
              </option>
            ))
          )}
        </select>
      </label>
      {modelError !== null ? (
        <span className={styles.selectError} title={modelError}>
          model switch failed
        </span>
      ) : null}
      <label className={styles.selectWrap}>
        <span className={styles.selectLabel}>mode</span>
        <select
          className={styles.select}
          value={shownMode}
          onChange={(e) => handleModeChange(e.currentTarget.value)}
          aria-label="Permission mode"
          title={
            LIVE_PERMISSION_MODES.find((m) => m.value === shownMode)?.title ??
            "How much this session does without asking. Applies to the running session — nothing restarts."
          }
        >
          {shownMode === "" ? <option value="">CLI default</option> : null}
          {LIVE_PERMISSION_MODES.map((m) => (
            <option key={m.value} value={m.value} title={m.title}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      {(modeError ?? refusedMode) !== null ? (
        <span
          className={styles.selectError}
          title={modeError ?? refusedMode ?? ""}
        >
          mode switch refused
        </span>
      ) : null}
    </div>
  );
}

export function AgentComposer({
  leafId,
  status,
  providerId,
  model,
  permissionMode,
  onRequestRestart,
}: AgentComposerProps): ReactElement {
  const pane = useComposerStore((s) => s.panes[leafId]);
  const draft = pane?.draft ?? "";
  const pills = pane?.pills ?? [];
  const queued = pane?.queued ?? [];
  const fanoutAll = pane?.fanoutAll ?? false;
  const history = useComposerStore((s) => s.history);
  const setDraft = useComposerStore((s) => s.setDraft);
  const removePill = useComposerStore((s) => s.removePill);
  const insertPathsIntoDraft = useComposerStore((s) => s.insertPathsIntoDraft);
  const setFanoutAll = useComposerStore((s) => s.setFanoutAll);
  const send = useComposerStore((s) => s.send);
  const queue = useComposerStore((s) => s.queue);
  const recall = useComposerStore((s) => s.recall);

  const splitPane = useTerminalStore((s) => s.splitPane);
  const setLeafAgentConfig = useTerminalStore((s) => s.setLeafAgentConfig);
  const agentPaneCount = useTerminalStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    if (!tab) return 1;
    return collectLeaves(tab.layout).filter((l) => paneKind(l) === "agent").length;
  });

  const providers = useAgentCatalogStore((s) => s.providers);
  const rememberSelection = useAgentCatalogStore((s) => s.rememberSelection);
  // The CLI's own answer, not the optimistic pick — see `modeSelectValue`.
  const appliedMode = useAgentSessionStore(
    (s) => s.panes[leafId]?.permissionMode ?? null,
  );

  // One state, not two booleans: `ContextPicker` and `WirePreview` are both
  // absolutely-positioned children of `.cedit`, so two independent booleans
  // would let them overlap. This makes mutual exclusion structural.
  const [popover, setPopover] = useState<"context" | "preview" | null>(null);
  const previewPanelId = useId();
  // Stable identity so neither popover re-subscribes its outside-mousedown
  // listener on every render — `WirePreview`'s parent re-renders on every
  // keystroke, which makes that worth doing here.
  const closePopover = useCallback(() => setPopover(null), []);
  const [dragCount, setDragCount] = useState<number | null>(null);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [note, setNote] = useState<CommandOutcome | null>(null);
  const [sources, setSources] = useState<MentionSources | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [anchor, setAnchor] = useState({ left: 0, bottom: 0 });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLSpanElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);

  // Seeded from the mount-time draft, not "": a composer that remounts with a
  // surviving draft (session restart, a sibling pane closing — see
  // `agent-pane.tsx`'s unmount cleanup) must not read as an external change
  // and steal focus on mount.
  const lastLocalDraftRef = useRef(draft);

  // Default-on focus/caret restore for any draft change that did not come
  // from this textarea's own `onChange` (`recall`, either drop path, and any
  // future store mutator that inserts text) — so a new writer cannot
  // silently ship without the restore, which is how this bug class started.
  // It deliberately does not touch pane focus (`setFocusedLeaf`): which pane
  // gets focus is the call site's business (`use-terminal-file-drop.ts`,
  // `agent-pane.tsx`), this effect only restores the DOM caret/box once a
  // pane's own composer is the thing that changed.
  useEffect(() => {
    if (draft === lastLocalDraftRef.current) return;
    lastLocalDraftRef.current = draft;
    // A clear is never an insertion whose caret the user needs, and `send`
    // only clears *after* `await Promise.all(agentSend …)`
    // (`composer-store.ts`), i.e. an unbounded time after the keystroke that
    // triggered it — by which point the user may have clicked into a shell
    // pane, a sibling composer, or a modal input. Restoring focus on that
    // transition would yank it back mid-typing, which is exactly the class
    // of bug this mechanism exists to remove, not reintroduce.
    if (draft === "") return;
    focusComposerAt(leafId);
  }, [draft, leafId]);

  const messagePills = pills.map(pillToMessagePill);
  const composedText = buildUserMessageText(messagePills, draft);
  const wireLine = previewUserMessageLine(composedText);
  // An exited session has no stdin to write to, so Send is refused rather than
  // failing silently in `agentSend` — the pane's status bar carries the
  // Restart button. Typing itself stays enabled: the draft survives the
  // restart, which is the point of keeping the composer mounted. A *command*
  // is exempt (`sendDisabled` below) — `/clear` on an exited session is
  // exactly when it is wanted.
  const sessionEnded = status === "exited";
  const live = !sessionEnded;
  const lineCount = draft.length === 0 ? 0 : draft.split("\n").length;

  // ── Slash-command / `@`-mention detection ────────────────────────────────
  const trigger = useMemo(() => detectTrigger(draft, caret), [draft, caret]);

  const models = useMemo<CommandOption[]>(() => {
    const active = activeProvider(providers, providerId);
    return active?.models.map((m) => ({ value: m.model_name, label: m.display_name })) ?? [];
  }, [providers, providerId]);

  const currentMode = modeSelectValue(appliedMode) || modeSelectValue(permissionMode);

  // Pure data only (Design decision 12) — this is what lets `commandRows`,
  // and with it `menuRows`, keep a stable identity across renders that don't
  // actually change anything, which is what lets arrow-key navigation survive
  // a re-render at all.
  const data: CommandData = useMemo(
    () => ({ models, modes: MODE_OPTIONS, currentMode, live }),
    [models, currentMode, live],
  );

  const commandRows: SlashRow[] = useMemo(
    () => (trigger?.kind === "slash" ? buildSlashRows(trigger.query, data) : []),
    [trigger, data],
  );
  const mentionRows: MentionRow[] = useMemo(
    () =>
      trigger?.kind === "mention" && sources !== null
        ? buildMentionRows(sources, trigger.query)
        : [],
    [trigger, sources],
  );
  const menuRows: SuggestRow[] = useMemo(
    () =>
      commandRows.length > 0
        ? commandRows.map(slashRowToSuggest)
        : mentionRows.map((_row, i) => mentionRowToSuggest(mentionRows, i)),
    [commandRows, mentionRows],
  );
  // The last `menuRows` identity `activeIndex` was reset for. Initialised to
  // the same reference `menuRows` already has on this very render (rather
  // than a fresh `[]`), so mounting never causes a spurious extra render.
  const [prevMenuRows, setPrevMenuRows] = useState<SuggestRow[]>(menuRows);
  // `helpOpen` deliberately does not participate — the help panel is a
  // read-only surface that never consumes a key (Design decision 12).
  const menuOpen = !dismissed && menuRows.length > 0;

  const parsed = parseCommandLine(draft);
  const command = parsed !== null ? findCommand(parsed.name) : undefined;
  // Bundled together (rather than narrowing `parsed` from a `command !==
  // undefined` check at each use site) so the disposition row below reads
  // without a non-null assertion.
  const runInfo =
    parsed !== null && command !== undefined ? { parsed, command } : null;
  const unregisteredName =
    parsed !== null && command === undefined ? parsed.name : null;
  // Suppressed while the menu is actually visible and offering candidates —
  // "not a Codenest command" on the same frame as a menu row reading
  // `/model` is noise, not information (Design decision 4). Once the menu is
  // dismissed (Escape) the warning is exactly what a bare `/` needs, even
  // though `commandRows` itself still lists every command by name.
  const showUnregisteredWarning =
    unregisteredName !== null && (dismissed || commandRows.length === 0);

  const sendDisabled =
    command === undefined ? composedText.trim().length === 0 || sessionEnded : false;

  // Resets (and thereby clamps) the highlight whenever the row set changes —
  // adjusted during render (react.dev's "Adjusting state when a prop
  // changes"), not in an effect: a `useEffect` here would fire one render
  // late and a ref cannot be read during render, either. Sound only because
  // `menuRows` has a stable identity across renders that change nothing else
  // (Design decision 12); arrow keys mutate `activeIndex` alone and so never
  // retrigger this.
  if (prevMenuRows !== menuRows) {
    setPrevMenuRows(menuRows);
    if (activeIndex !== 0) setActiveIndex(0);
  }

  // Caret-coordinate mirror (Design decision 8/9): measured only while a menu
  // is open, so it costs nothing in the normal case.
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const textarea = textareaRef.current;
    const mirror = mirrorRef.current;
    const marker = markerRef.current;
    const stack = stackRef.current;
    if (!textarea || !mirror || !marker || !stack) return;
    // Width-matched to `clientWidth`, not to the overlay's `left`/`right`
    // insets: past 240px `.editorTextarea` grows a scrollbar that narrows its
    // own line box but would not narrow an inset-positioned mirror's, which
    // would make long-draft wrapping (and the caret line with it) diverge.
    mirror.style.width = `${textarea.clientWidth}px`;
    const markerRect = marker.getBoundingClientRect();
    const stackRect = stack.getBoundingClientRect();
    setAnchor(
      caretAnchor({
        markerLeft: markerRect.left - stackRect.left,
        markerTop: markerRect.top - stackRect.top,
        scrollTop: textarea.scrollTop,
        hostWidth: stack.clientWidth,
        hostHeight: stack.clientHeight,
        padLeft: MIRROR_PAD_LEFT_PX,
        padTop: MIRROR_PAD_TOP_PX,
        panelWidth: SUGGEST_PANEL_WIDTH_PX,
        gapPx: SUGGEST_GAP_PX,
      }),
    );
    // Deliberately curated deps, in the same style as `agent-pane.tsx`'s own
    // boot effect: re-measure exactly when the menu opens/closes, the
    // command line's sigil moves, the draft's layout could have changed, or
    // the row count (and with it the panel's own height) changed.
  }, [menuOpen, trigger?.start, draft, menuRows.length]);

  /** Focuses the textarea and places the caret once the store's new draft has
   *  reached the DOM. Every caller writes the draft through the store first and
   *  then wants a *specific* caret, so the store value is claimed as locally
   *  originated here: otherwise the external-draft effect's caret-less default
   *  request races this one and lands the caret at end-of-text instead of just
   *  past an accepted `/` or `@` completion. */
  function focusCaretAt(nextCaret: number): void {
    lastLocalDraftRef.current = useComposerStore.getState().panes[leafId]?.draft ?? "";
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextCaret, nextCaret);
      setCaret(nextCaret);
      resizeComposerEditor(el);
    });
  }

  function handleDraftChange(el: HTMLTextAreaElement): void {
    // Marks this value as locally originated *before* the store write, so the
    // effect above sees `draft === lastLocalDraftRef.current` and skips it.
    // This is what keeps ordinary typing and native ⌘Z undo (both arrive
    // through this same `onChange`) from jumping the caret to end-of-text.
    lastLocalDraftRef.current = el.value;
    setDraft(leafId, el.value);
    setCaret(el.selectionStart);
    setDismissed(false);
    setHelpOpen(false);
    setNote(null);
    resizeComposerEditor(el);
  }

  /** Built fresh at execution time (Design decision 12) — identity here is
   *  irrelevant, since nothing memoizes on it. */
  function commandEffects(): SlashCommandEffects {
    return {
      setModel: async (nextModel) => {
        const active = activeProvider(providers, providerId);
        setLeafAgentConfig(leafId, { model: nextModel });
        rememberSelection({ providerId: active?.id ?? null, model: nextModel });
        if (live) await agentSetModel(leafId, nextModel);
      },
      setPermissionMode: async (nextMode) => {
        setLeafAgentConfig(leafId, { permissionMode: nextMode });
        if (live) await agentSetPermissionMode(leafId, nextMode);
      },
      // Reads the session id *before* dropping any state — the pane's own
      // teardown reports the exit under `panes[leafId]?.sessionId` after the
      // restart is requested, so resetting first would make that report
      // unnamed and unsafe across the replacement session (Design decision 6).
      clearSession: () => {
        const sessionId = useAgentSessionStore.getState().panes[leafId]?.sessionId ?? null;
        useComposerStore.getState().clearPane(leafId);
        if (sessionId !== null) recordAgentExited(leafId, null, sessionId);
        useAgentSessionStore.getState().reset(leafId);
        onRequestRestart();
      },
      sendRaw: async (text) => {
        useAgentSessionStore.getState().markSendStart(leafId, text);
        await agentSend(leafId, text);
        setDraft(leafId, "");
      },
      showHelp: () => {
        setHelpOpen(true);
        setDraft(leafId, "");
      },
    };
  }

  /** Runs `text` as a command line, records the outcome, and — only on
   *  success — clears the draft (an error leaves the line in place so it can
   *  be fixed). Never called with text that isn't a registered command line
   *  (callers check `command !== undefined`/`runsBare` first), so the
   *  `"unregistered"`/`null` results are unreachable in practice. */
  async function executeCommandLine(text: string): Promise<void> {
    const result = await runCommandLine(text, { ...data, ...commandEffects() });
    if (result === null || result.kind === "unregistered") return;
    setNote(result.outcome);
    if (result.outcome.kind === "ok") {
      setDraft(leafId, "");
      setCaret(0);
      const el = textareaRef.current;
      if (el) el.style.height = "auto";
    }
  }

  function setDraftAndRun(text: string): void {
    setDraft(leafId, text);
    void executeCommandLine(text);
  }

  function placeDraftWithCaretAtEnd(text: string): void {
    setDraft(leafId, text);
    focusCaretAt(text.length);
  }

  /** Accepting a `/`-menu row: a bare `runsBare` command runs immediately; a
   *  `runsBare: false` command (only `/model` today) completes to `"/name "`
   *  and leaves the arg menu open, since picking `/model` is not yet a
   *  choice of *which* model. An `arg` row always runs immediately. */
  function acceptSlashRow(row: SlashRow): void {
    if (row.kind === "command") {
      if (row.command.runsBare) {
        setDraftAndRun(`/${row.command.name}`);
      } else {
        placeDraftWithCaretAtEnd(`/${row.command.name} `);
      }
      return;
    }
    setDraftAndRun(`/${row.command.name} ${row.option.value}`);
  }

  /** Accepting an `@`-menu row (Design decision 7): an agent inserts text at
   *  the token; a task or library row deletes the token and attaches the
   *  existing pill kind instead; a `library-ref` fetches the item first. */
  async function acceptMentionRow(row: MentionRow): Promise<void> {
    if (trigger === null || trigger.kind !== "mention") return;
    const { start } = trigger;
    if (row.kind === "agent") {
      const edit = replaceRange(draft, start, caret, row.insertText);
      setDraft(leafId, edit.text);
      focusCaretAt(edit.caret);
      return;
    }
    if (row.kind === "task") {
      const edit = replaceRange(draft, start, caret, "");
      setDraft(leafId, edit.text);
      focusCaretAt(edit.caret);
      useComposerStore.getState().addPills(leafId, [
        {
          id: crypto.randomUUID(),
          kind: "task",
          taskId: row.taskId,
          title: row.title,
          description: row.description,
        },
      ]);
      return;
    }
    if (row.kind === "library") {
      const edit = replaceRange(draft, start, caret, "");
      setDraft(leafId, edit.text);
      focusCaretAt(edit.caret);
      useComposerStore.getState().addPills(leafId, [
        { id: crypto.randomUUID(), kind: "template", slug: row.slug, title: row.title, body: row.body },
      ]);
      return;
    }
    // `library-ref`: a syntactically valid slug with no match in the loaded
    // page — the shared resolver is what makes this genuinely work rather
    // than just naming the slug.
    try {
      const item = await fetchLibraryItemBySlug(row.slug);
      if (item === null) {
        setNote({ kind: "error", note: `No library item @library:${row.slug}` });
        return;
      }
      const edit = replaceRange(draft, start, caret, "");
      setDraft(leafId, edit.text);
      focusCaretAt(edit.caret);
      useComposerStore.getState().addPills(leafId, [
        { id: crypto.randomUUID(), kind: "template", slug: item.slug, title: item.title, body: item.body },
      ]);
    } catch (err) {
      setNote({
        kind: "error",
        note: `Library lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /** Indexes back into `commandRows`/`mentionRows` by position — `menuRows`
   *  is presentational only and carries no reference back to the row it
   *  came from. */
  async function acceptMenuRow(index: number): Promise<void> {
    if (commandRows.length > 0) {
      const row = commandRows[index];
      if (row) acceptSlashRow(row);
      return;
    }
    const row = mentionRows[index];
    if (row) await acceptMentionRow(row);
  }

  function handleSend(): void {
    // A command never reaches `agentSend` — this is the whole regression the
    // task exists to fix.
    if (command !== undefined) {
      void executeCommandLine(draft);
      return;
    }
    if (sendDisabled) return;
    // The optimistic user turn is wired here, at the component layer, not
    // inside `composer-store.send()` — `composer-store.ts` never imports
    // `agent-session-store.ts` (the store dependency graph is a DAG, Design
    // decision 11), and a component is free to import both.
    const targets = resolveSendTargets(leafId, fanoutAll);
    for (const target of targets) {
      useAgentSessionStore.getState().markSendStart(target, composedText);
    }
    void send(leafId);
    const el = textareaRef.current;
    if (el) el.style.height = "auto";
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (menuOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((i) => (i + delta + menuRows.length) % menuRows.length);
      return;
    }
    if (menuOpen && (e.key === "Enter" || e.key === "Tab")) {
      e.preventDefault();
      void acceptMenuRow(activeIndex);
      return;
    }
    if (menuOpen && e.key === "Escape") {
      // The menu owns this Escape — a running turn must not be interrupted by
      // a menu dismissal.
      e.preventDefault();
      setDismissed(true);
      return;
    }
    if (helpOpen && e.key === "Escape") {
      e.preventDefault();
      setHelpOpen(false);
      return;
    }
    // An open popover wins over interrupt: dismissing the preview or picker
    // must never also interrupt a running session. Checked regardless of
    // `status`, so a second Escape (popover already closed) falls through to
    // the interrupt branch below as always.
    if (e.key === "Escape" && popover !== null) {
      e.preventDefault();
      setPopover(null);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }
    if (e.key === "Escape" && status === "running") {
      e.preventDefault();
      void agentInterrupt(leafId);
    }
    // ⇧Enter is left to the textarea's default (newline); ⌘Z is the
    // textarea's own native undo — nothing here intercepts either.
  }

  /**
   * Paths carried by a drag over the editor, from either half of the contract:
   * the Codenest MIME type an in-window drag from the explorer sets, or the
   * `text/plain` fallback `writePathDragPayload` writes alongside it (one path
   * per line) — which is also what a drag out of another app arrives as.
   */
  function pathsFromDrag(dt: DataTransfer): string[] {
    const payload = readPathDragPayload(dt);
    if (payload) return payload;
    return dt
      .getData("text/plain")
      .split("\n")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  }

  function acceptsEditorDrag(dt: DataTransfer): boolean {
    return dt.types.includes(CODENEST_PATHS_MIME) || dt.types.includes("text/plain");
  }

  function handleDragOver(e: DragEvent<HTMLTextAreaElement>): void {
    if (!acceptsEditorDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    // Logged only on the dragCount === null -> non-null transition, so a
    // drag held over the editor does not emit at the dragover repeat rate.
    if (dragCount === null) {
      logDnd("composer.dragover", {
        types: [...e.dataTransfer.types],
        items: e.dataTransfer.items.length,
        leafId,
      });
    }
    // `items.length` is readable during dragover (unlike `getData`, which
    // browsers withhold until drop) — a real count, not a placeholder.
    setDragCount(e.dataTransfer.items.length);
  }

  /**
   * A drop in the editor inserts the paths as text at the caret — the behaviour
   * every other editor has, and the reason this stopped attaching context pills:
   * the point of dropping a file into a prompt is to write about that path.
   *
   * `preventDefault` matters even though the textarea would insert `text/plain`
   * itself: the browser's own insertion bypasses React's `onChange` for a
   * controlled value, so the draft in the store would not match what is on
   * screen, and the next keystroke would revert it.
   */
  function handleDrop(e: DragEvent<HTMLTextAreaElement>): void {
    if (!acceptsEditorDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragCount(null);
    const paths = pathsFromDrag(e.dataTransfer);
    const el = e.currentTarget;
    // Where the pointer landed, not where the caret was last left: the browser
    // moves the caret to the drop point before `drop` fires, so `selectionStart`
    // is already the right offset.
    const dropCaret = el.selectionStart;
    // Logged before the empty-paths bail: a drop that arrives carrying nothing
    // is the signal that wry claimed the drag, which is what this trace is for.
    logDnd("composer.drop", {
      types: [...e.dataTransfer.types],
      pathCount: paths.length,
      caret: dropCaret,
      leafId,
    });
    if (paths.length === 0) return;
    const nextCaret = insertPathsIntoDraft(leafId, paths, dropCaret);
    // This write is synchronous (`insertPathsIntoDraft`'s `set` has already
    // run), so reading the store here — before the external-draft effect's
    // passive-effect flush runs — marks this value as locally originated.
    // Without this, the effect's caret-less default request could win a
    // scheduling race against the specific caret requested below and land the
    // caret at end-of-text instead of just past the insertion.
    lastLocalDraftRef.current = useComposerStore.getState().panes[leafId]?.draft ?? "";
    // The store owns the value, so the DOM catches up on the next render —
    // `focusComposerAt` defers to a frame so it reads the post-update value.
    focusComposerAt(leafId, nextCaret);
    // Keeps the trigger scanner tracking a dropped caret, which the shared
    // helper does not touch because it owns the DOM, not this component's state.
    setCaret(nextCaret);
  }

  const wireWarningText =
    unregisteredName !== null
      ? `/${unregisteredName} is not a Codenest command — Enter sends it to claude as text`
      : null;

  return (
    <div className={styles.composer} data-agent-composer>
      <div className={styles.cmode}>
        <span className={`${styles.mbadge} ${styles.mbadgeComposing}`}>◆ Conversation</span>
        <ProviderModelRow
          leafId={leafId}
          providerId={providerId}
          model={model}
          permissionMode={permissionMode}
          live={live}
          onRequestRestart={onRequestRestart}
        />
        <button
          type="button"
          className={styles.mswap}
          onClick={() => void splitPane(leafId, "h")}
          title="Open a shell pane beside this one (⌘⇧T)"
        >
          ⌘⇧T open shell beside
        </button>
      </div>

      <div className={styles.cctx}>
        {pills.map((pill) => (
          <span key={pill.id} className={`${styles.pill} ${pillClass(pill)}`}>
            <span className={styles.pillKey}>{pillKey(pill)}</span>
            {pillLabel(pill)}
            <button
              type="button"
              className={styles.pillRemove}
              aria-label={`Remove ${pillLabel(pill)}`}
              onClick={() => removePill(leafId, pill.id)}
            >
              ×
            </button>
          </span>
        ))}
        <button
          type="button"
          className={`${styles.pill} ${styles.pillAdd}`}
          // Keeps this press away from the picker's outside-click listener, so
          // clicking the trigger while open closes it once rather than closing
          // and reopening in the same gesture.
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setPopover((p) => (p === "context" ? null : "context"))}
          aria-expanded={popover === "context"}
        >
          + context
        </button>
        <button
          type="button"
          className={`${styles.pill} ${styles.pillWire}`}
          aria-label="Show what Send writes to the agent"
          aria-expanded={popover === "preview"}
          aria-controls={previewPanelId}
          title="What Send writes on stdin — one JSON line (click to preview)"
          onMouseDown={(e) => {
            // stopPropagation: same reason as `+ context` above — let the
            // trigger's own toggle handle a reopen instead of racing this
            // panel's outside-click listener. preventDefault: suppresses the
            // mousedown's focus shift so the caret stays in the textarea and
            // the user can keep typing right through opening this panel.
            e.stopPropagation();
            e.preventDefault();
          }}
          onClick={() => setPopover((p) => (p === "preview" ? null : "preview"))}
        >
          {"{}"}
        </button>
      </div>

      <div className={styles.cedit}>
        {popover === "context" ? (
          <ContextPicker
            onPick={(pill) => useComposerStore.getState().addPills(leafId, [pill])}
            onClose={closePopover}
          />
        ) : null}
        {popover === "preview" ? (
          <WirePreview
            line={
              runInfo !== null
                ? `/${runInfo.parsed.name}${runInfo.parsed.arg ? ` ${runInfo.parsed.arg}` : ""} → ${runInfo.command.summary}`
                : wireLine
            }
            panelId={previewPanelId}
            onClose={closePopover}
          />
        ) : null}
        {helpOpen ? (
          <div className={styles.helpPanel} role="note">
            <div className={styles.helpPanelHeader}>
              Commands
              <button
                type="button"
                className={styles.helpClose}
                aria-label="Close command help"
                onClick={() => setHelpOpen(false)}
              >
                ×
              </button>
            </div>
            {helpRows().map((row) => (
              <div key={row.name} className={styles.helpRow}>
                <span className={styles.helpName}>
                  /{row.name}
                  {row.argHint ? ` ${row.argHint}` : ""}
                </span>
                <span className={styles.helpSummary}>{row.summary}</span>
              </div>
            ))}
          </div>
        ) : null}
        <div className={styles.editorStack} ref={stackRef}>
          <div
            className={styles.editorOverlay}
            aria-hidden="true"
            ref={overlayRef}
          >
            {renderMentionOverlay(draft)}
          </div>
          {menuOpen && trigger !== null ? (
            <div className={styles.editorMirror} aria-hidden="true" ref={mirrorRef}>
              {renderMirror(draft, trigger.start, caret, markerRef)}
            </div>
          ) : null}
          {/* macOS applies OS-level autocorrect, text replacement and sentence
              capitalisation inside a WKWebView, which rewrites a prompt as it
              is typed. `spellCheck` alone only drops the red underline; the
              WebKit-only `autocorrect`/`autocapitalize` are the pair that stop
              the substitution (Chromium ignores them, which is harmless). */}
          <textarea
            ref={textareaRef}
            data-agent-composer
            data-composer-pane-id={leafId}
            className={styles.editorTextarea}
            value={draft}
            onChange={(e) => handleDraftChange(e.currentTarget)}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={handleKeyDown}
            onScroll={(e) => {
              if (overlayRef.current) {
                overlayRef.current.scrollTop = e.currentTarget.scrollTop;
              }
            }}
            onDragOver={handleDragOver}
            onDragLeave={() => setDragCount(null)}
            onDrop={handleDrop}
            placeholder="Message the agent…"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
          />
          <span className={styles.gut}>
            {lineCount} lines · {draft.length} chars
          </span>
          {dragCount !== null ? (
            <div className={styles.dropzone}>
              drop to insert
              <b style={{ marginLeft: 5 }}>
                {dragCount} {dragCount === 1 ? "path" : "paths"}
              </b>
            </div>
          ) : null}
          {menuOpen ? (
            <SuggestPanel
              rows={menuRows}
              activeIndex={activeIndex}
              anchor={anchor}
              onPick={(i) => void acceptMenuRow(i)}
              onHover={setActiveIndex}
              footer={
                commandRows.length > 0
                  ? "↩ select · ⇥ complete · esc dismiss"
                  : "↩ insert · esc dismiss"
              }
            />
          ) : null}
          {trigger?.kind === "mention" && !dismissed ? (
            <MentionSourceProbe onSources={setSources} />
          ) : null}
        </div>
      </div>

      <div className={styles.cact}>
        {agentPaneCount > 1 ? (
          <button
            type="button"
            className={styles.fanout}
            onClick={() => setFanoutAll(leafId, !fanoutAll)}
          >
            fanout{" "}
            <b className={styles.fanoutCount}>
              {fanoutAll ? `${agentPaneCount} agent panes` : "this session"}
            </b>
          </button>
        ) : (
          <span className={styles.fanout}>
            fanout <b className={styles.fanoutCount}>this session</b>
          </span>
        )}
        <span className={styles.hint}>
          {sessionEnded ? (
            "session ended · Restart to send"
          ) : (
            <>
              <span className={styles.kbd}>/</span> commands ·{" "}
              <span className={styles.kbd}>@</span> mention ·{" "}
              <span className={styles.kbd}>⇧↩</span> newline ·{" "}
              <span className={styles.kbd}>esc</span> interrupt ·{" "}
              <span className={styles.kbd}>⌘Z</span> undo
            </>
          )}
        </span>
        <button
          type="button"
          className={styles.sendGhost}
          disabled={status !== "running" || command !== undefined}
          onClick={() => queue(leafId)}
        >
          ⌛ Queue
        </button>
        <button type="button" className={styles.send} disabled={sendDisabled} onClick={handleSend}>
          {command ? "Run" : "Send"} <span className={styles.kbd}>⌘↩</span>
        </button>
      </div>

      {note !== null ? (
        <div
          className={`${styles.cnote} ${note.kind === "error" ? styles.cnoteError : ""}`}
          role="status"
        >
          {note.note}
        </div>
      ) : null}
      {showUnregisteredWarning && wireWarningText !== null ? (
        <div className={styles.wireWarn}>{wireWarningText}</div>
      ) : null}


      <div className={styles.chist}>
        {history.slice(0, MAX_HISTORY_PILLS).map((entry, i) => (
          <button
            key={i}
            type="button"
            className={styles.hpill}
            title={entry}
            onClick={() => {
              recall(i, leafId);
              // Explicit, not redundant with the effect above: recalling text
              // identical to what is already in the draft leaves `draft`
              // unchanged, so the effect never fires and this call is the
              // only thing that returns focus to the editor.
              focusComposerAt(leafId);
            }}
          >
            ↺ {entry}
          </button>
        ))}
        {queued.map((entry, i) => (
          <span key={i} className={`${styles.hpill} ${styles.hpillQueued}`} title={entry}>
            ⌛ queued · {entry}
          </span>
        ))}
      </div>
    </div>
  );
}
