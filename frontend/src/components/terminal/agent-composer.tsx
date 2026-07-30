/**
 * The composer — mode row, real-data context pills, an auto-growing
 * `@`-mention-highlighted editor, an actions row, the literal wire line the
 * send transmits, and re-runnable prompt-history pills. Structure mirrors
 * `prototype:737-768` top to bottom. Every element here is bound to real
 * state — nothing renders from a literal (see the plan's "NO MOCK UI" rule).
 */

import { useRef, useState } from "react";
import type { DragEvent, KeyboardEvent, ReactElement } from "react";
import { useLibraryItems, useTasks, type Task, type LibraryItem } from "../../lib/api";
import { agentInterrupt } from "../../lib/ipc";
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
import { useAgentSessionStore } from "../../stores/agent-session-store";
import { useTerminalStore } from "../../stores/terminal-store";
import { collectLeaves, paneKind } from "../../lib/layout-tree";
import styles from "./agent-composer.module.css";

interface AgentComposerProps {
  leafId: string;
  status: ConversationState["status"];
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

function ContextPicker({
  onPick,
  onClose,
}: {
  onPick: (pill: ContextPill) => void;
  onClose: () => void;
}): ReactElement {
  const { data: library } = useLibraryItems();
  const { data: tasks } = useTasks({ status: "in-progress" });
  const templates: LibraryItem[] = library?.items ?? [];
  const inProgressTasks: Task[] = tasks ?? [];

  return (
    <div className={styles.pickerPanel} role="listbox">
      <div className={styles.pickerHeader}>Templates</div>
      {templates.length === 0 ? (
        <div className={styles.pickerEmpty}>No templates yet</div>
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
      {inProgressTasks.length === 0 ? (
        <div className={styles.pickerEmpty}>No tasks</div>
      ) : (
        inProgressTasks.map((task) => (
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
          >
            #{task.id} {task.title}
          </button>
        ))
      )}
    </div>
  );
}

export function AgentComposer({ leafId, status }: AgentComposerProps): ReactElement {
  const pane = useComposerStore((s) => s.panes[leafId]);
  const draft = pane?.draft ?? "";
  const pills = pane?.pills ?? [];
  const queued = pane?.queued ?? [];
  const fanoutAll = pane?.fanoutAll ?? false;
  const history = useComposerStore((s) => s.history);
  const setDraft = useComposerStore((s) => s.setDraft);
  const removePill = useComposerStore((s) => s.removePill);
  const attachContextToPane = useComposerStore((s) => s.attachContextToPane);
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

  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragCount, setDragCount] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const messagePills = pills.map(pillToMessagePill);
  const composedText = buildUserMessageText(messagePills, draft);
  const sendDisabled = composedText.trim().length === 0;
  const lineCount = draft.length === 0 ? 0 : draft.split("\n").length;

  function handleDraftChange(el: HTMLTextAreaElement): void {
    setDraft(leafId, el.value);
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, EDITOR_MAX_HEIGHT_PX)}px`;
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

  function handleDragOver(e: DragEvent<HTMLTextAreaElement>): void {
    if (!e.dataTransfer.types.includes(CODENEST_PATHS_MIME)) return;
    e.preventDefault();
    // `items.length` is readable during dragover (unlike `getData`, which
    // browsers withhold until drop) — a real count, not a placeholder.
    setDragCount(e.dataTransfer.items.length);
  }

  function handleDrop(e: DragEvent<HTMLTextAreaElement>): void {
    if (!e.dataTransfer.types.includes(CODENEST_PATHS_MIME)) return;
    e.preventDefault();
    setDragCount(null);
    const raw = e.dataTransfer.getData(CODENEST_PATHS_MIME);
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const paths = parsed.filter((p): p is string => typeof p === "string");
      if (paths.length === 0) return;
      attachContextToPane(leafId, paths);
    } catch {
      // Malformed payload — ignored silently, no pills, no throw.
    }
  }

  return (
    <div className={styles.composer} data-agent-composer>
      <div className={styles.cmode}>
        <span className={`${styles.mbadge} ${styles.mbadgeComposing}`}>◆ Conversation</span>
        <span className={styles.mwhy}>
          native session · <code>stream-json</code> stdio · no PTY in the path
        </span>
        <button
          type="button"
          className={styles.mswap}
          onClick={() => void splitPane(leafId, "h")}
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
              drop to attach <b style={{ marginLeft: 5 }}>{dragCount} files</b> as context
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
          <span className={styles.kbd}>⇧↩</span> newline ·{" "}
          <span className={styles.kbd}>esc</span> interrupt ·{" "}
          <span className={styles.kbd}>⌘Z</span> undo
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
