/**
 * The composer — mode row, real-data context pills, an auto-growing
 * `@`-mention-highlighted editor, an actions row, the literal wire line the
 * send transmits, and re-runnable prompt-history pills. Structure mirrors
 * `prototype:737-768` top to bottom. Every element here is bound to real
 * state — nothing renders from a literal (see the plan's "NO MOCK UI" rule).
 */

import { useEffect, useRef, useState } from "react";
import { useEscapeKey } from "../../hooks/use-escape-key";
import type { DragEvent, KeyboardEvent, ReactElement } from "react";
import { useLibraryItems, useTasks, type Task, type LibraryItem } from "../../lib/api";
import {
  agentInterrupt,
  agentSetModel,
  agentSetPermissionMode,
} from "../../lib/ipc";
import { useAgentCatalogStore } from "../../stores/agent-catalog-store";
import {
  activeSubagents,
  buildUserMessageText,
  orchestrationBadgeLabel,
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
import { useAgentSessionStore } from "../../stores/agent-session-store";
import { useTerminalStore } from "../../stores/terminal-store";
import { collectLeaves, paneKind } from "../../lib/layout-tree";
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
const EDITOR_MAX_HEIGHT_PX = 240;

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
 * Statuses a task can be attached from, most actionable first.
 *
 * The picker used to ask the API for `status: "in-progress"` alone, which is why
 * a workspace with real work in it still showed "No tasks": a task is `todo`
 * until you start it, and attaching one as context is usually how you start it.
 * `done` is left out — the list exists to point the agent at work that remains.
 */
const PICKABLE_TASK_STATUSES = [
  "in-progress",
  "blocked",
  "todo",
  "backlog",
] as const;

function taskRank(status: string): number {
  const i = PICKABLE_TASK_STATUSES.indexOf(
    status as (typeof PICKABLE_TASK_STATUSES)[number],
  );
  return i === -1 ? PICKABLE_TASK_STATUSES.length : i;
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
  // open closes via its toggle instead of closing here and immediately
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
  if (providers.length === 0) return null;

  const active = providers.find((p) => p.id === providerId) ?? providers[0]!;
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
    if (nextId === active.id) return;
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
    rememberSelection({ providerId: active.id, model: nextModel });
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
  const agentPaneCount = useTerminalStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    if (!tab) return 1;
    return collectLeaves(tab.layout).filter((l) => paneKind(l) === "agent").length;
  });

  // AgentComposer's only subscription to the agent-session store. Returns a
  // count, not the array, so the composer re-renders when delegation starts or
  // stops — not on every streamed token. `activeSubagents` already returns []
  // for an exited session (D4), so there is no status guard here.
  const subagentCount = useAgentSessionStore((s) => {
    const pane = s.panes[leafId];
    return pane === undefined ? 0 : activeSubagents(pane).length;
  });

  // Sibling of `subagentCount` above. Returns a string, not the array, so the
  // composer re-renders when an orchestration starts, finishes an agent, or
  // ends — never on a streamed token. `activeOrchestrations` already returns
  // [] for an exited session, so there is no status guard here.
  const orchestrationBadge = useAgentSessionStore((s) => {
    const pane = s.panes[leafId];
    return pane === undefined ? "" : orchestrationBadgeLabel(pane);
  });

  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragCount, setDragCount] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const messagePills = pills.map(pillToMessagePill);
  const composedText = buildUserMessageText(messagePills, draft);
  // An exited session has no stdin to write to, so Send is refused rather than
  // failing silently in `agentSend` — the pane's status bar carries the
  // Restart button. Typing itself stays enabled: the draft survives the
  // restart, which is the point of keeping the composer mounted.
  const sessionEnded = status === "exited";
  const sendDisabled = composedText.trim().length === 0 || sessionEnded;
  const lineCount = draft.length === 0 ? 0 : draft.split("\n").length;

  /** The auto-grow measurement, shared by typing and by a drop that inserts
   *  text the user did not type. */
  function resizeEditor(el: HTMLTextAreaElement): void {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, EDITOR_MAX_HEIGHT_PX)}px`;
  }

  function handleDraftChange(el: HTMLTextAreaElement): void {
    setDraft(leafId, el.value);
    resizeEditor(el);
  }

  function handleSend(): void {
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
    if (paths.length === 0) return;
    const el = e.currentTarget;
    // Where the pointer landed, not where the caret was last left: the browser
    // moves the caret to the drop point before `drop` fires, so `selectionStart`
    // is already the right offset.
    const caret = el.selectionStart;
    const nextCaret = insertPathsIntoDraft(leafId, paths, caret);
    // The store owns the value, so the DOM catches up on the next render —
    // restore focus and place the caret past the insertion after it does.
    requestAnimationFrame(() => {
      const current = textareaRef.current;
      if (!current) return;
      current.focus();
      current.setSelectionRange(nextCaret, nextCaret);
      resizeEditor(current);
    });
  }

  return (
    <div className={styles.composer} data-agent-composer>
      <div className={styles.cmode}>
        <span className={`${styles.mbadge} ${styles.mbadgeComposing}`}>◆ Conversation</span>
        {subagentCount > 0 ? (
          <span
            className={`${styles.mbadge} ${styles.mbadgeSubagent}`}
            data-testid="composer-subagent-badge"
          >
            ◈ {subagentCount} sub-agent{subagentCount === 1 ? "" : "s"}
          </span>
        ) : null}
        {orchestrationBadge !== "" ? (
          <span
            className={`${styles.mbadge} ${styles.mbadgeOrchestration}`}
            data-testid="composer-orchestration-badge"
          >
            ◇ {orchestrationBadge}
          </span>
        ) : null}
        <ProviderModelRow
          leafId={leafId}
          providerId={providerId}
          model={model}
          permissionMode={permissionMode}
          live={status !== "exited"}
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
          onClick={() => setPickerOpen((v) => !v)}
        >
          + context
        </button>
      </div>

      <div className={styles.cedit}>
        {pickerOpen ? (
          <ContextPicker
            onPick={(pill) => useComposerStore.getState().addPills(leafId, [pill])}
            onClose={() => setPickerOpen(false)}
          />
        ) : null}
        <div className={styles.editorStack}>
          <div
            className={styles.editorOverlay}
            aria-hidden="true"
            ref={overlayRef}
          >
            {renderMentionOverlay(draft)}
          </div>
          <textarea
            ref={textareaRef}
            data-agent-composer
            className={styles.editorTextarea}
            value={draft}
            onChange={(e) => handleDraftChange(e.currentTarget)}
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
              <span className={styles.kbd}>⇧↩</span> newline ·{" "}
              <span className={styles.kbd}>esc</span> interrupt ·{" "}
              <span className={styles.kbd}>⌘Z</span> undo
            </>
          )}
        </span>
        <button
          type="button"
          className={styles.sendGhost}
          disabled={status !== "running"}
          onClick={() => queue(leafId)}
        >
          ⌛ Queue
        </button>
        <button type="button" className={styles.send} disabled={sendDisabled} onClick={handleSend}>
          Send <span className={styles.kbd}>⌘↩</span>
        </button>
      </div>

      <div className={styles.wire} title={previewUserMessageLine(composedText)}>
        <span className={styles.wireLabel}>WRITES</span>
        <code className={styles.wireCode}>{previewUserMessageLine(composedText)}</code>
        <span>→ claude --print --input-format stream-json · one JSON line on stdin</span>
      </div>

      <div className={styles.chist}>
        {history.slice(0, MAX_HISTORY_PILLS).map((entry, i) => (
          <button
            key={i}
            type="button"
            className={styles.hpill}
            title={entry}
            onClick={() => recall(i, leafId)}
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
