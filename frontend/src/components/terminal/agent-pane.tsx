/**
 * The native agent pane — a conversation plus a composer, in place of an
 * xterm terminal. Owns the duplex `claude` session's lifecycle: subscribes to
 * `agent_frame:{leafId}` before calling `agent_start` (so an `init` frame
 * emitted in the gap can never be lost), and stops the session when its leaf
 * is genuinely gone.
 *
 * "Genuinely gone" is the load-bearing part. An unmount alone does not mean
 * teardown: closing a *sibling* pane collapses the split, which reconciles this
 * subtree at a new position in the tree and therefore unmounts and remounts it.
 * Treating that as teardown is what used to kill a working session and leave
 * "Session ended (exit 0)" behind the moment the user closed the shell beside
 * it. So both cleanups below ask the store whether the leaf still exists and
 * keep the session — and the conversation, and the draft — when it does.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DragEvent, ReactElement } from "react";
import {
  agentStart,
  agentStop,
  agentRespondPermission,
  subscribeAgentFrames,
  getWorkspacePath,
  type AgentFrame,
} from "../../lib/ipc";
import { useAgentSessionStore } from "../../stores/agent-session-store";
import type { PaneLaunchSeed } from "../../lib/layout-tree";
import { useComposerStore, CODENEST_PATHS_MIME } from "../../stores/composer-store";
import { useTerminalStore } from "../../stores/terminal-store";
import { consumePendingPrompt } from "../../stores/pending-prompt-store";
import {
  recordAgentLaunch,
  recordAgentExited,
} from "../../lib/agent-run-telemetry";
import { currentPaneTarget } from "../../lib/window-target";
import { useAgentCatalogStore } from "../../stores/agent-catalog-store";
import { readPathDragPayload } from "../../lib/explorer/drag-payload";
import { logDnd } from "../../lib/drop-diagnostics";
import { emptyConversation } from "../../lib/agent-conversation";
import { dockNavRows, nextDockNavKey } from "../../lib/agent-dock";
import { findComposerEditor, focusComposerAt } from "../../lib/composer-focus";
import { AgentConversation } from "./agent-conversation";
import { AgentComposer } from "./agent-composer";
import { AgentViewPanel } from "./agent-view-panel";
import {
  findOrchestration,
  findSubagent,
  findToolBlock,
  listAgentViews,
  MAIN_VIEW,
  resolveView,
  viewKey,
  type AgentViewId,
} from "../../lib/agent-views";
import { AgentActivityDock } from "./agent-activity-dock";
import { Icon } from "../icon";
import styles from "./agent-pane.module.css";

/** The stick-to-bottom threshold Effect A's scroll listener applies — how
 *  close to the bottom counts as "still pinned". Carries the same figure the
 *  `<AgentConversation/>` listener this replaced used. */
const STICK_TO_BOTTOM_PX = 40;

/**
 * The keyboard cursor over the activity dock's rows (#22) — a second piece
 * of pane state, but not a second *selection*: `key` is a `viewKey(...)`
 * string, never an `AgentViewId`, so it can never be mistaken for, or fed
 * into, `resolveView`. `focus` is a one-shot "…and take DOM focus" request,
 * carried *inside* the object rather than read from `key`, so the dock's
 * focus effect can key off `focus` alone — every pointer move (a row click)
 * changes `key` while leaving `focus`'s identity untouched, so that effect
 * never re-fires and a mouse click can never pull the caret out of the
 * composer (plan D15, fixing review round 1's B1).
 */
interface DockCursorState {
  key: string | null;
  focus: { key: string; token: number } | null;
}

interface AgentPaneProps {
  leafId: string;
  cwd?: string;
  title: string;
  showHeader?: boolean;
  active: boolean;
  /** `providers.id` persisted on this leaf, if the user has picked one. */
  providerId?: number;
  /** The model persisted on this leaf, if the user has picked one. */
  model?: string;
  /** The permission mode persisted on this leaf, if the user has picked one.
   *  Absent means no `--permission-mode` flag at spawn: the CLI's own default. */
  permissionMode?: string;
  /**
   * Launch-time telemetry attribution (project/profile/source/prompt-preview)
   * from a programmatic launch's leaf (`buildPaneLayout`, `lib/launch.ts`).
   * Spread into the boot effect's `recordAgentLaunch` call below on every
   * boot — including a `retryToken` restart, which correctly re-stamps the
   * same attribution onto the new session since it is the same launch.
   * Never persisted: `terminal-store.persistToStorage` strips `seed` off the
   * leaf before it reaches localStorage, so a *rehydrated* tab starts with no
   * seed at all rather than re-crediting a launch from a previous run.
   */
  seed?: PaneLaunchSeed;
}

/**
 * `` `${leafId}:${retryToken}` `` -> "a start is in flight or has succeeded".
 * Guards React StrictMode's dev-only double-mount from calling `agent_start`
 * twice for one pane (`mod.rs` rejects a second start as an error); cleared
 * once `agent_stop` for that boot resolves (natural unmount, feature toggled
 * off, or a user-clicked Restart).
 *
 * Keyed on the *pair*, not just `leafId`, on purpose (review round 1, F1):
 * cleanup fires `void agentStop(leafId).finally(() =>
 * startedPanes.delete(key))` — fire-and-forget, since a `useEffect` cleanup
 * cannot be awaited — while the *next* effect run's `boot()` awaits
 * `subscribeAgentFrames` before checking this set. Keying by `leafId` alone
 * raced those two independent async IPC calls: if `boot()`'s check ran
 * before the old `agentStop`'s `.finally()` had cleared the flag, it read a
 * stale `true` and returned without ever calling `agent_start` again — the
 * pane stayed dead after the very first Restart click following any exit.
 * A `retryToken` bump mints a key this set has never seen, so a restart's
 * `boot()` can never read a stale entry left by the *previous* boot's still
 * in-flight `agentStop` — the two keys don't collide, so there is nothing
 * left to race. This is deliberately structural rather than "clear the flag
 * synchronously in `requestRestart`": that alternative works today but depends
 * on every future retryToken-bumping call site remembering to clear it
 * first, whereas keying by the pair is correct by construction regardless
 * of what triggers a `retryToken` bump later.
 */
const startedPanes = new Set<string>();

/**
 * `leafId` -> the live `agent_frame:{leafId}` listener's disposer.
 *
 * The subscription deliberately outlives the component. A pane unmounts for
 * reasons that have nothing to do with its session ending — a sibling pane
 * closing, or a route change away from the Terminal page — and a session whose
 * frames nobody is listening to loses them for good: the assistant text of a
 * turn that finished while the user was on another page would simply never
 * appear, and a missed `result` frame would leave the pane's status stuck on
 * "running" forever. Keeping the listener registered means frames keep landing
 * in `agent-session-store` regardless, so a remount renders the *current* state
 * of the conversation rather than a stale snapshot plus a gap.
 *
 * Disposed only where the session itself is stopped (see the lifecycle effect's
 * cleanup), which keeps "is there a listener?" and "is there a child?" in step.
 */
const frameSubscriptions = new Map<string, () => void>();

/**
 * `leafId` -> the mounted pane's control-note setter, if one is mounted.
 *
 * The long-lived listener above writes conversation state through the store,
 * but the control-frame breadcrumb is component state, and the mount that
 * registered it may be gone by the time a frame arrives. An indirection through
 * this map means the listener always talks to whichever mount is current, and to
 * nothing at all when there is none — rather than holding a closure over a
 * setter from an unmounted tree.
 */
const controlNoteSinks = new Map<string, (note: string) => void>();

/** In-flight subscribe calls, so two mounts of one leaf can't double-register. */
const pendingSubscriptions = new Map<string, Promise<void>>();

async function ensureFrameSubscription(leafId: string): Promise<void> {
  if (frameSubscriptions.has(leafId)) return;
  const pending = pendingSubscriptions.get(leafId);
  if (pending) return pending;

  const promise = subscribeAgentFrames(leafId, (frame: AgentFrame) => {
    // `getState()` rather than a captured action: this closure outlives the
    // component that created it.
    useAgentSessionStore.getState().applyFrame(leafId, frame);
    if (frame.kind === "control") {
      controlNoteSinks.get(leafId)?.(summarizeControlFrame(frame.raw));
    }
    if (frame.kind === "exit") {
      // An agent pane has no PTY, so `pty-exited` — the liveness sink every
      // provider pane relies on — never fires for it. This frame is the
      // equivalent, and without it a Command Center row would sit at
      // "running" forever after the session ended. Covers a natural exit, a
      // crash, and a Stop pressed from that panel (the child dies, the waiter
      // thread emits this). An explicit teardown reports separately, because
      // it disposes this subscription before stopping the child.
      // Scoped to the session that ended, not just the pane: a leaf keeps its
      // id across a Restart, so an unscoped report could end the replacement.
      recordAgentExited(leafId, exitCodeOf(frame.raw), frame.session_id);
    }
  })
    .then((dispose) => {
      // A `disposeFrameSubscription` that landed while this was in flight wins:
      // it removed the pending entry, so drop the listener we just created.
      if (!pendingSubscriptions.has(leafId)) {
        dispose();
        return;
      }
      frameSubscriptions.set(leafId, dispose);
    })
    .finally(() => {
      pendingSubscriptions.delete(leafId);
    });

  pendingSubscriptions.set(leafId, promise);
  return promise;
}

function disposeFrameSubscription(leafId: string): void {
  frameSubscriptions.get(leafId)?.();
  frameSubscriptions.delete(leafId);
  // Clearing this also signals an in-flight `ensureFrameSubscription` to throw
  // its listener away instead of registering it.
  pendingSubscriptions.delete(leafId);
  controlNoteSinks.delete(leafId);
}

/** `exit_code` off an `exit` frame — same field the reducer's `applyExit` reads. */
function exitCodeOf(raw: unknown): number | null {
  if (typeof raw !== "object" || raw === null) return null;
  const code = (raw as Record<string, unknown>)["exit_code"];
  return typeof code === "number" ? code : null;
}

function summarizeControlFrame(raw: unknown): string {
  if (typeof raw === "object" && raw !== null) {
    const rec = raw as Record<string, unknown>;
    const response = rec["response"];
    if (typeof response === "object" && response !== null) {
      const subtype = (response as Record<string, unknown>)["subtype"];
      if (typeof subtype === "string") return `control · ${subtype}`;
    }
  }
  return "control message (not answered — see plan Design decision 14)";
}

export function AgentPane({
  leafId,
  cwd,
  title,
  showHeader = true,
  active,
  providerId,
  model,
  permissionMode,
  seed,
}: AgentPaneProps): ReactElement {
  const conversation = useAgentSessionStore((s) => s.panes[leafId]);
  const markStarting = useAgentSessionStore((s) => s.markStarting);
  const resolvePermission = useAgentSessionStore((s) => s.resolvePermission);
  const allowSession = useAgentSessionStore((s) => s.allowSession);
  const reset = useAgentSessionStore((s) => s.reset);
  const clearPane = useComposerStore((s) => s.clearPane);
  const setTargetPane = useComposerStore((s) => s.setTargetPane);
  const seedDraft = useComposerStore((s) => s.seedDraft);

  const focusedLeafId = useTerminalStore((s) => s.focusedLeafId);
  const setFocusedLeaf = useTerminalStore((s) => s.setFocusedLeaf);
  const maximizedLeafId = useTerminalStore((s) => s.maximizedLeafId);
  const toggleMaximize = useTerminalStore((s) => s.toggleMaximize);
  const closePane = useTerminalStore((s) => s.closePane);
  const setLeafAgentConfig = useTerminalStore((s) => s.setLeafAgentConfig);

  const loadCatalog = useAgentCatalogStore((s) => s.load);

  const [startError, setStartError] = useState<string | null>(null);
  const [lastControlNote, setLastControlNote] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [dropActive, setDropActive] = useState(false);
  const [selectedView, setSelectedView] = useState<AgentViewId>(MAIN_VIEW);

  // The dock keyboard cursor (#22) — see `DockCursorState`'s own doc comment
  // above for why this is a separate piece of state from `selectedView`.
  const [dockCursor, setDockCursor] = useState<DockCursorState>({
    key: null,
    focus: null,
  });
  /** Where the caret was in the composer when focus left for the dock, so the
   *  return trip restores the user's place and not just their text. A ref:
   *  nothing renders from it and writing it must not re-render. */
  const composerCaretRef = useRef<number | null>(null);

  /** The only two writers of `dockCursor`, and the only place focus intent is
   *  decided: `focus` is set when — and only when — the user pressed a key to
   *  enter or walk the dock. A row click reaches this with no options and
   *  therefore carries the previous request object through unchanged, so the
   *  dock's focus effect does not re-run (plan D15). */
  const setDockCursorKey = useCallback(
    (key: string | null, opts?: { focus?: boolean }): void => {
      setDockCursor((c) =>
        opts?.focus === true && key !== null
          ? { key, focus: { key, token: (c.focus?.token ?? 0) + 1 } }
          : { key, focus: c.focus },
      );
    },
    [],
  );

  /** Ctrl+↑ / Ctrl+↓ from the composer: remember the caret, then move the
   *  cursor *and* ask for focus. `rows` is computed outside the updater so
   *  the updater stays a pure function of its argument. */
  function moveDockCursor(delta: -1 | 1): void {
    composerCaretRef.current = findComposerEditor(leafId)?.selectionStart ?? null;
    const rows = dockNavRows(conv);
    setDockCursor((c) => {
      const next = nextDockNavKey(rows, c.key, delta);
      if (next === null) return c.key === null ? c : { key: null, focus: c.focus };
      return { key: next, focus: { key: next, token: (c.focus?.token ?? 0) + 1 } };
    });
  }

  const returnFocusToComposer = useCallback((): void => {
    const caret = composerCaretRef.current;
    focusComposerAt(leafId, caret === null ? undefined : caret);
  }, [leafId]);

  /**
   * Set by [`requestRestart`] immediately before it bumps `retryToken`, and
   * read (then cleared) by the lifecycle effect's cleanup. This is how the
   * cleanup tells "the user asked for a fresh session" apart from "React moved
   * this subtree" — the two are indistinguishable from inside a cleanup
   * otherwise, and only the former may stop the running child. A ref, not
   * state, because it must be readable in the same commit that sets it.
   */
  const restartRef = useRef(false);
  /**
   * The pane's single scroll viewport (`.viewport`, agent-pane.module.css),
   * shared by all three body views below. The pane measures and scrolls this
   * element itself (Effects A-D below) — the transcript and every drill-in
   * view are plain content with no overflow of their own.
   */
  const viewportRef = useRef<HTMLDivElement>(null);
  /** How far into a view's own content the user had scrolled, and whether
   *  they were pinned to its bottom, keyed by `viewKey(effectiveView)`. A
   *  ref-held Map: nothing renders from it and writing it must not
   *  re-render. Its lifetime is this mount — the same lifetime
   *  `selectedView` and the dock's collapse state already have, so a
   *  sibling-close remount resets all three together rather than leaving
   *  one stale. */
  const scrollMemoryRef = useRef(new Map<string, { top: number; stick: boolean }>());
  /** Stick-to-bottom for the view currently on screen; mirrored into the map
   *  above on every switch (Effect B). A view never seen before starts
   *  pinned. */
  const stickRef = useRef(true);

  useEffect(() => {
    // See the doc comment on `startedPanes` above (review round 1, F1) —
    // keying by the pair, not just `leafId`, is what makes a Restart safe
    // against the previous boot's still in-flight `agentStop`.
    const bootKey = `${leafId}:${retryToken}`;
    let cancelled = false;

    async function boot(): Promise<void> {
      setStartError(null);
      setTargetPane(leafId);
      // Route control-frame notes to *this* mount for as long as it lives.
      controlNoteSinks.set(leafId, setLastControlNote);

      await ensureFrameSubscription(leafId);
      if (cancelled) return;

      // Already starting/started for this (leafId, retryToken) pair
      // (StrictMode double-mount) — the frame subscription above still
      // delivers frames either way.
      if (startedPanes.has(bootKey)) return;

      // Launch prompt handoff (#32): consume-once, keyed by leaf id. Deliberately
      // ahead of the catalog wait and `agent_start` — the composer draft is the
      // durable home for this text (it survives a failed start and the Retry that
      // follows), so consuming early costs nothing on failure and keeps the window
      // in which the user could be typing into an empty composer as small as
      // possible. A `retryToken` restart re-runs this line and finds nothing: the
      // registry is emptied by the first read, which is what makes a restart not a
      // re-send.
      const seededPrompt = consumePendingPrompt(leafId);
      if (seededPrompt !== null) seedDraft(leafId, seededPrompt);

      markStarting(leafId);
      const resolvedCwd = cwd ?? (await getWorkspacePath().catch(() => undefined));
      if (cancelled) return;
      if (!resolvedCwd) {
        setStartError("No working directory for this session");
        return;
      }

      // Resolve which provider/model this session runs with, then write the
      // resolution back onto the leaf so a Restart, a reload and the composer's
      // selectors all agree on what is actually running. Without the provider's
      // env the child reads the default `~/.claude` config — for a user who
      // authenticated only their `claude-work` / `claude-personal` aliases that
      // is an unauthenticated config, and every turn fails with
      // `401 OAuth access token is invalid`.
      //
      // Spawning is therefore held until the catalog is *known*, not merely
      // attempted. On a cold launch this pane can mount while the sidecar is
      // still starting, and a session started in that window would run against
      // the wrong config dir for its whole life — argv and env are fixed at
      // spawn, so there is no recovering from it later. The cached catalog
      // usually makes this instant; only a first-ever run actually waits, and
      // an authoritative "no providers configured" resolves immediately.
      if (useAgentCatalogStore.getState().providers.length > 0) {
        void loadCatalog();
      } else {
        await useAgentCatalogStore.getState().loadWithRetry();
      }
      if (cancelled) return;
      const catalog = useAgentCatalogStore.getState();
      const selection = catalog.resolveSelection({
        providerId: providerId ?? null,
        model: model ?? null,
      });
      const provider = catalog.providerById(selection.providerId);
      setLeafAgentConfig(leafId, {
        providerId: selection.providerId,
        model: selection.model,
      });

      startedPanes.add(bootKey);
      try {
        const handle = await agentStart({
          paneId: leafId,
          cwd: resolvedCwd,
          ...(provider ? { command: provider.command, env: provider.env } : {}),
          ...(selection.model !== null ? { model: selection.model } : {}),
          // Boots straight into the mode the pane was last switched to, so a
          // Restart is not a silent drop back to the CLI default.
          ...(permissionMode !== undefined ? { permissionMode } : {}),
        });
        // Register the session as a run so it appears in the Command Center's
        // AGENTS panel with working Focus/Stop. Posted after the spawn, not
        // before, so a failed start never leaves a phantom "running" row —
        // and with the *real* session id off the handle rather than a
        // frontend-minted one, which is what lets Claude hooks enrich it.
        //
        // `target` comes from which window this pane was created in: the
        // Command Center raises the detached window for a `popout` row and
        // activates a main-window tab for an `embedded` one, so getting it
        // wrong makes Focus a no-op.
        recordAgentLaunch({
          pane_id: leafId,
          session_id: handle.session_id,
          provider: selection.providerId,
          cwd: resolvedCwd,
          model: selection.model,
          target: currentPaneTarget(),
          // Launch attribution from a programmatic launch's leaf seed — absent
          // for a hand-split agent pane, which stamps none of this (D5/D7 in
          // the ordered-pane-list plan; the sidecar already parses all four).
          ...(seed?.projectId !== undefined
            ? { project_id: seed.projectId }
            : {}),
          ...(seed?.profileName !== undefined
            ? { profile: seed.profileName }
            : {}),
          ...(seed?.sourceKind !== undefined
            ? { source_kind: seed.sourceKind, source_id: seed.sourceId ?? null }
            : {}),
          ...(seed?.promptPreview !== undefined
            ? { prompt_preview: seed.promptPreview }
            : {}),
        });
      } catch (err) {
        startedPanes.delete(bootKey);
        if (!cancelled) {
          setStartError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    void boot();

    return () => {
      cancelled = true;
      if (controlNoteSinks.get(leafId) === setLastControlNote) {
        controlNoteSinks.delete(leafId);
      }
      // Only a genuine teardown — or an explicit restart — stops the session.
      // A remount (sibling pane closed → split collapsed → this subtree
      // reconciled elsewhere; or the whole Terminal page unmounted by a route
      // change) must leave the running `claude` child alone, and its frame
      // subscription in place, so the conversation continues uninterrupted.
      const restarting = restartRef.current;
      restartRef.current = false;
      if (!restarting && useTerminalStore.getState().leafExists(leafId)) {
        return;
      }
      disposeFrameSubscription(leafId);
      // Reported here rather than from the `exit` frame: the line above just
      // removed the listener that would have carried it, so this is the only
      // place a teardown-driven end can be seen. The sidecar ignores a second
      // report for an already-ended run, so the overlap with the frame path is
      // harmless. The session id comes from the store because the frame that
      // carried it is no longer arriving — and naming the session is what keeps
      // a Restart's teardown from ending the session it is restarting into.
      recordAgentExited(
        leafId,
        null,
        useAgentSessionStore.getState().panes[leafId]?.sessionId ?? null,
      );
      void agentStop(leafId).finally(() => startedPanes.delete(bootKey));
    };
    // `cwd`, and every store action below, are stable references (zustand
    // actions never change identity) or intentionally excluded — only
    // `leafId` and a user-clicked Restart should re-run this lifecycle.
    // `permissionMode` in particular must stay out: it changes on every live
    // mode switch, and re-running this effect would restart the session the
    // control channel just switched in place. `seed` is read from the closure
    // for the same reason — it never changes for a mounted pane, and adding
    // it here would only invite a future edit to depend on its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leafId, retryToken]);

  // Composer draft/pills and conversation state are wiped only on a genuine
  // teardown of this leaf — the leaf leaving the store (pane/tab close) or
  // `leafId` itself changing — never on a `retryToken`-only re-run (review
  // round 1, F2) and never on a remount. Deliberately a *separate* effect,
  // keyed on `leafId` alone: the effect above re-runs its cleanup on every
  // Restart click (it must, to stop the old session), but this one's cleanup
  // must not, or a draft/pills the user had pending when the session exited
  // would be silently discarded the instant they click Restart — the exact
  // guarantee the plan's Design decision 12 states ("a composer draft
  // survives a session exit and restart"). The `leafExists` guard extends the
  // same protection to a sibling-close remount, which would otherwise wipe a
  // live conversation the user can still see on screen.
  useEffect(() => {
    return () => {
      if (useTerminalStore.getState().leafExists(leafId)) return;
      clearPane(leafId);
      reset(leafId);
    };
  }, [leafId, clearPane, reset]);

  /**
   * Tear the current session down and start a fresh one — the Restart button,
   * and the composer's provider switch (a different binary or env cannot be
   * applied to a running child, unlike a model switch, which goes over the
   * control channel).
   */
  function requestRestart(): void {
    restartRef.current = true;
    setRetryToken((t) => t + 1);
  }

  function handleAllow(): void {
    const permission = conversation?.permissions[0];
    if (!permission) return;
    void agentRespondPermission({
      paneId: leafId,
      requestId: permission.requestId,
      allow: true,
      updatedInput: permission.input,
    });
    resolvePermission(leafId, permission.requestId);
  }

  function handleAllowSession(): void {
    const permission = conversation?.permissions[0];
    if (!permission) return;
    void agentRespondPermission({
      paneId: leafId,
      requestId: permission.requestId,
      allow: true,
      updatedInput: permission.input,
    });
    allowSession(leafId, permission.sessionKey);
    resolvePermission(leafId, permission.requestId);
  }

  function handleDeny(): void {
    const permission = conversation?.permissions[0];
    if (!permission) return;
    void agentRespondPermission({
      paneId: leafId,
      requestId: permission.requestId,
      allow: false,
    });
    resolvePermission(leafId, permission.requestId);
  }

  const isFocused = focusedLeafId === leafId;
  const isMaximized = maximizedLeafId === leafId;
  // `emptyConversation()` rather than an inline literal, so a field added to
  // `ConversationState` cannot be forgotten here.
  const conv = conversation ?? emptyConversation();

  // Which agent this pane's body is showing. `resolveView` re-derives it every
  // render so a selection whose sub-agent or run has gone — `/clear`, a
  // restart, a session that exited — falls back to the transcript instead of
  // rendering an empty panel for something that no longer exists.
  const effectiveView = resolveView(conv, selectedView);
  const viewKeyStr = viewKey(effectiveView);
  const agentViews = listAgentViews(conv);
  const viewedSubagent =
    effectiveView.kind === "subagent" ? findSubagent(conv, effectiveView.id) : null;
  const viewedRun =
    effectiveView.kind === "workflow" ? findOrchestration(conv, effectiveView.taskId) : null;
  // The workflow view's own stream: frames the wire parented to the
  // `Workflow` block itself (`OrchestrationRun.toolUseId`), not to any one
  // agent inside it — the only stream an orchestration can have (see the
  // plan's Scope/Out and Design decision 5). `[]` when the wire parented
  // nothing there, or when the view is not a workflow at all; either way
  // `<AgentViewPanel/>` renders no stream section for an empty array.
  const viewedRunTurns =
    viewedRun?.toolUseId != null
      ? (findToolBlock(conv, viewedRun.toolUseId)?.childTurns ?? [])
      : [];

  // Effect A — one scroll listener for the pane's life. `viewportRef`'s
  // element is rendered unconditionally (below), so it is the same DOM node
  // for the whole mount and a re-subscribe per view switch would be pointless
  // churn; `stickRef` is what Effects B-D read and set instead.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onScroll = (): void => {
      stickRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_PX;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
    };
  }, []);

  // Effect B — restores the view being switched *to*, and saves the view
  // being switched *away from*, in the same effect: the cleanup closes over
  // the `viewKeyStr` this run applied to, which is exactly the outgoing view
  // by the time the next run's cleanup fires, so restore and save can never
  // disagree about which view they describe. `useLayoutEffect`, not
  // `useEffect`, so the restored offset is in place before paint — otherwise
  // the user would see the bottom flash past on every switch.
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    // Captured once per run rather than read again in the cleanup: the ref's
    // own `.current` is a stable `Map` for this mount's whole life (nothing
    // ever replaces it), but `react-hooks/exhaustive-deps` cannot know that
    // and warns generically about reading `.current` inside a cleanup —
    // this local binding is what it asks for either way.
    const memory = scrollMemoryRef.current;
    const saved = memory.get(viewKeyStr);
    if (saved === undefined) {
      // A view this mount has never shown starts pinned to the bottom — the
      // right default for a stream the user has not scrolled in yet.
      stickRef.current = true;
      el.scrollTop = el.scrollHeight;
    } else {
      stickRef.current = saved.stick;
      el.scrollTop = saved.stick ? el.scrollHeight : saved.top;
    }
    return () => {
      memory.set(viewKeyStr, { top: el.scrollTop, stick: stickRef.current });
    };
  }, [viewKeyStr]);

  // Effect C — the moved stick-to-bottom: a new frame pins the viewport only
  // when the user has not scrolled away from it. `conv.turns` changes
  // identity for a *child* frame too (`withChildStream`/`applyChildFrame`
  // return fresh arrays/state), so this one dependency covers the main
  // transcript and every child stream a drill-in view renders.
  useEffect(() => {
    if (!stickRef.current) return;
    const el = viewportRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [conv.turns, conv.streamText, conv.thinking]);

  const permission = conv.permissions[0];

  // Effect D — a pending permission request blocks the session, so it is
  // scrolled into view whether or not the user was stuck to the bottom —
  // unlike ordinary output, which must not yank a scrolled-back reader down.
  // Without this, a request that arrived while reading scrollback left the
  // pane looking hung with the dialog off screen; and when the next request
  // in a queue took the first one's place, the replacement could render
  // below the fold. Scoped to the `main` view: `<AgentPermissionDialog/>`
  // only renders there (below), so forcing a drill-in view to the bottom for
  // a dialog the user cannot see there would be a yank with no payoff.
  useEffect(() => {
    if (permission === undefined) return;
    if (effectiveView.kind !== "main") return;
    const el = viewportRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickRef.current = true;
  }, [permission, effectiveView.kind]);

  /** Opens the named `Task`/`Agent` block's own drill-in view — the click
   *  target for every delegation card, wherever it renders (the main
   *  transcript, a sub-agent's own stream, a workflow's own stream). */
  function openSubagent(id: string): void {
    setSelectedView({ kind: "subagent", id });
  }

  /**
   * Pane-wide drop target, so dragging files onto an agent pane behaves like
   * dragging them onto a shell pane: anywhere inside the pane works, not just
   * the composer's textarea. Paths are appended to the composer draft as text
   * (there is no PTY to paste bytes into), which is how a dropped screenshot
   * reaches the agent too — it reads the path with its own Read tool. The
   * OS/Finder equivalent arrives through Tauri's `onDragDropEvent` and is
   * handled in `use-terminal-file-drop.ts`, which hit-tests
   * `data-agent-pane-id` below.
   */
  // `text/plain` as well as the Codenest type: `handlePaneDrop` already falls
  // back to it, but without accepting the drag here `dragover` is never
  // defaulted-prevented, so the browser refuses the drop and `onDrop` never
  // fires — the fallback was unreachable.
  const acceptsDrag = (dt: DataTransfer): boolean =>
    dt.types.includes(CODENEST_PATHS_MIME) || dt.types.includes("text/plain");

  function handlePaneDragOver(e: DragEvent<HTMLDivElement>): void {
    if (!acceptsDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function handlePaneDrop(e: DragEvent<HTMLDivElement>): void {
    // Never let a drop bubble to a parent handler, recognised or not.
    e.preventDefault();
    e.stopPropagation();
    setDropActive(false);
    const paths =
      readPathDragPayload(e.dataTransfer) ??
      e.dataTransfer
        .getData("text/plain")
        .split("\n")
        .filter((p) => p.length > 0);
    // This handler silently absorbing a drop meant for the composer's own
    // caret-precise `handleDrop` (agent-composer.tsx) is exactly the
    // ambiguity the dropzone-overlay fix has to resolve — logged here so a
    // hand-check can tell which of the two actually ran.
    logDnd("pane.drop", { pathCount: paths.length, leafId });
    if (paths.length === 0) return;
    // Appended to the draft rather than attached as pills: a dropped file's path
    // belongs in the text being written, which is what every other app does and
    // what the agent can act on directly.
    useComposerStore.getState().insertPathsIntoDraft(leafId, paths);
    setFocusedLeaf(leafId);
  }

  return (
    <div
      className={[
        styles.pane,
        isFocused ? styles.paneFocused : "",
        dropActive ? styles.paneDrop : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-agent-pane-id={leafId}
      onMouseDown={() => setFocusedLeaf(leafId)}
      onDragOver={handlePaneDragOver}
      onDragEnter={(e) => {
        if (!acceptsDrag(e.dataTransfer)) return;
        e.preventDefault();
        setDropActive(true);
      }}
      onDragLeave={(e) => {
        // Only clear when the pointer actually left the pane, not when it
        // crossed into a child element (dragleave fires for both).
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDropActive(false);
      }}
      onDrop={handlePaneDrop}
    >
      {showHeader ? (
        <div className={styles.header}>
          <span className={styles.kind}>Agent</span>
          <span className={styles.title}>{title}</span>
          <span className={styles.cwd} title={cwd ?? ""}>
            {cwd ?? ""}
          </span>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => toggleMaximize(leafId)}
            aria-label={isMaximized ? "Restore pane" : "Expand pane"}
            title={isMaximized ? "Restore pane" : "Expand pane"}
          >
            <Icon name={isMaximized ? "minimize" : "maximize"} size={14} stroke={1.6} />
          </button>
          <button
            type="button"
            className={styles.close}
            onClick={() => void closePane(leafId)}
            aria-label="Close pane"
          >
            ×
          </button>
        </div>
      ) : null}

      <div className={styles.body}>
        <div
          className={styles.viewport}
          ref={viewportRef}
          data-testid="agent-pane-viewport"
        >
          {effectiveView.kind === "main" ? (
            <AgentConversation
              state={conv}
              isFocusedPane={isFocused && active}
              onAllowPermission={handleAllow}
              onAllowPermissionSession={handleAllowSession}
              onDenyPermission={handleDeny}
              lastControlNote={lastControlNote}
              onOpenSubagent={openSubagent}
            />
          ) : viewedSubagent !== null ? (
            <AgentViewPanel
              kind="subagent"
              block={viewedSubagent}
              sessionExited={conv.status === "exited"}
              onOpenSubagent={openSubagent}
            />
          ) : viewedRun !== null ? (
            <AgentViewPanel
              kind="workflow"
              run={viewedRun}
              childTurns={viewedRunTurns}
              sessionExited={conv.status === "exited"}
              onOpenSubagent={openSubagent}
            />
          ) : null}
        </div>

        {/* Zone B — the activity dock. A *sibling* of `.viewport`, never a
            child: inside it, it would scroll away with the transcript.
            Mounted unconditionally so its collapse state survives the phases
            where it has nothing to report and renders null. Its rows and the
            composer's picker below are two views of the same `selectedView`
            state — the dock takes the resolved value and the setter as a
            prop pair rather than owning a second copy, so clicking a row
            here and picking the same entity in the composer can never
            disagree.

            The keyboard *cursor* (#22) is a third, separate piece of state,
            owned here rather than by the dock, because the composer's
            Ctrl+↑/↓ must be able to move it too. It is a row key, never a
            selection, so it can never be fed into `resolveView` by mistake.
            Focus intent travels with it as a one-shot field precisely so a
            mouse click on a row cannot take the caret out of the composer —
            see `DockCursorState`'s own doc comment above. */}
        <AgentActivityDock
          state={conv}
          cwd={cwd}
          paneId={leafId}
          selectedView={effectiveView}
          onSelectView={setSelectedView}
          highlightedKey={dockCursor.key}
          focusRequest={dockCursor.focus}
          onHighlightChange={setDockCursorKey}
          onReturnFocus={returnFocusToComposer}
        />

        {/*
          A dead session shows its status bar *above* a still-mounted composer
          rather than replacing it. Replacing it made the input surface vanish
          exactly when the user most wants to type the next prompt — and since
          the composer owns the provider/model selectors, it also took away the
          controls needed to restart on a different model. The draft, the pills
          and the history all survive here, so Restart resumes with whatever was
          already typed.
        */}
        {startError !== null ? (
          <div className={styles.startError}>
            <span>{startError}</span>
            <button type="button" className={styles.restartBtn} onClick={requestRestart}>
              Retry
            </button>
          </div>
        ) : conv.status === "exited" ? (
          <div className={styles.endedBar}>
            <span>Session ended (exit {conv.exitCode ?? "?"})</span>
            <button type="button" className={styles.restartBtn} onClick={requestRestart}>
              Restart
            </button>
          </div>
        ) : null}

        <AgentComposer
          leafId={leafId}
          status={conv.status}
          providerId={providerId ?? null}
          model={model ?? null}
          permissionMode={permissionMode ?? null}
          onRequestRestart={requestRestart}
          views={agentViews}
          selectedView={effectiveView}
          onSelectView={setSelectedView}
          onEnterDock={moveDockCursor}
        />

        {dropActive ? (
          <div className={styles.paneDropHint}>drop to insert file path</div>
        ) : null}
      </div>
    </div>
  );
}
