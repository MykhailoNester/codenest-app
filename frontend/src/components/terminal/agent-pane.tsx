/**
 * The native agent pane — a conversation plus a composer, in place of an
 * xterm terminal. Owns the duplex `claude` session's lifecycle end to end:
 * subscribes to `agent_frame:{leafId}` before calling `agent_start` (so an
 * `init` frame emitted in the gap can never be lost), and is the *only*
 * place a session is stopped — pane close, tab close, feature-toggle-off,
 * and window teardown all unmount this component (Design decision 4 in the
 * agent-pane-composer plan).
 */

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import {
  agentStart,
  agentStop,
  agentRespondPermission,
  subscribeAgentFrames,
  getWorkspacePath,
  type AgentFrame,
} from "../../lib/ipc";
import { useAgentSessionStore } from "../../stores/agent-session-store";
import { useComposerStore } from "../../stores/composer-store";
import { useTerminalStore } from "../../stores/terminal-store";
import { AgentConversation } from "./agent-conversation";
import { AgentComposer } from "./agent-composer";
import { Icon } from "../icon";
import styles from "./agent-pane.module.css";

interface AgentPaneProps {
  leafId: string;
  cwd?: string;
  title: string;
  showHeader?: boolean;
  active: boolean;
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
 * synchronously in `handleRetry`": that alternative works today but depends
 * on every future retryToken-bumping call site remembering to clear it
 * first, whereas keying by the pair is correct by construction regardless
 * of what triggers a `retryToken` bump later.
 */
const startedPanes = new Set<string>();

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
}: AgentPaneProps): ReactElement {
  const conversation = useAgentSessionStore((s) => s.panes[leafId]);
  const markStarting = useAgentSessionStore((s) => s.markStarting);
  const applyFrame = useAgentSessionStore((s) => s.applyFrame);
  const resolvePermission = useAgentSessionStore((s) => s.resolvePermission);
  const allowSession = useAgentSessionStore((s) => s.allowSession);
  const reset = useAgentSessionStore((s) => s.reset);
  const clearPane = useComposerStore((s) => s.clearPane);
  const setTargetPane = useComposerStore((s) => s.setTargetPane);

  const focusedLeafId = useTerminalStore((s) => s.focusedLeafId);
  const setFocusedLeaf = useTerminalStore((s) => s.setFocusedLeaf);
  const maximizedLeafId = useTerminalStore((s) => s.maximizedLeafId);
  const toggleMaximize = useTerminalStore((s) => s.toggleMaximize);
  const closePane = useTerminalStore((s) => s.closePane);

  const [startError, setStartError] = useState<string | null>(null);
  const [lastControlNote, setLastControlNote] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    // See the doc comment on `startedPanes` above (review round 1, F1) —
    // keying by the pair, not just `leafId`, is what makes a Restart safe
    // against the previous boot's still in-flight `agentStop`.
    const bootKey = `${leafId}:${retryToken}`;
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    async function boot(): Promise<void> {
      setStartError(null);
      setTargetPane(leafId);

      const dispose = await subscribeAgentFrames(leafId, (frame: AgentFrame) => {
        applyFrame(leafId, frame);
        if (frame.kind === "control") {
          setLastControlNote(summarizeControlFrame(frame.raw));
        }
      });
      if (cancelled) {
        dispose();
        return;
      }
      unlisten = dispose;

      // Already starting/started for this (leafId, retryToken) pair
      // (StrictMode double-mount) — the frame subscription above still
      // delivers frames to this instance either way.
      if (startedPanes.has(bootKey)) return;

      markStarting(leafId);
      const resolvedCwd = cwd ?? (await getWorkspacePath().catch(() => undefined));
      if (cancelled) return;
      if (!resolvedCwd) {
        setStartError("No working directory for this session");
        return;
      }

      startedPanes.add(bootKey);
      try {
        await agentStart({ paneId: leafId, cwd: resolvedCwd });
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
      unlisten?.();
      void agentStop(leafId).finally(() => startedPanes.delete(bootKey));
    };
    // `cwd`, and every store action below, are stable references (zustand
    // actions never change identity) or intentionally excluded — only
    // `leafId` and a user-clicked Restart should re-run this lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leafId, retryToken]);

  // Composer draft/pills and conversation state are wiped only on a genuine
  // teardown of this leaf — a real unmount (pane/tab close, feature toggled
  // off) or `leafId` itself changing — never on a `retryToken`-only re-run
  // (review round 1, F2). Deliberately a *separate* effect, keyed on
  // `leafId` alone: the effect above re-runs its cleanup on every Restart
  // click (it must, to stop the old session), but this one's cleanup must
  // not, or a draft/pills the user had pending when the session exited
  // would be silently discarded the instant they click Restart — the exact
  // guarantee the plan's Design decision 12 states ("a composer draft
  // survives a session exit and restart").
  useEffect(() => {
    return () => {
      clearPane(leafId);
      reset(leafId);
    };
  }, [leafId, clearPane, reset]);

  function handleRetry(): void {
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
  const conv = conversation ?? {
    turns: [],
    status: "starting" as const,
    streaming: false,
    streamText: "",
    thinking: false,
    thinkingTokens: 0,
    sessionId: null,
    model: null,
    permissions: [],
    lastResult: null,
    exitCode: null,
  };

  return (
    <div
      className={`${styles.pane} ${isFocused ? styles.paneFocused : ""}`}
      data-agent-pane-id={leafId}
      onMouseDown={() => setFocusedLeaf(leafId)}
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
        <AgentConversation
          state={conv}
          isFocusedPane={isFocused && active}
          onAllowPermission={handleAllow}
          onAllowPermissionSession={handleAllowSession}
          onDenyPermission={handleDeny}
          lastControlNote={lastControlNote}
        />

        {startError !== null ? (
          <div className={styles.startError}>
            <span>{startError}</span>
            <button type="button" className={styles.restartBtn} onClick={handleRetry}>
              Retry
            </button>
          </div>
        ) : conv.status === "exited" ? (
          <div className={styles.endedBar}>
            <span>Session ended (exit {conv.exitCode ?? "?"})</span>
            <button type="button" className={styles.restartBtn} onClick={handleRetry}>
              Restart
            </button>
          </div>
        ) : (
          <AgentComposer leafId={leafId} status={conv.status} />
        )}
      </div>
    </div>
  );
}

/** Rendered by `<SplitContainer/>` instead of `<AgentPane/>` when the
 * `composer` feature is off. A persisted agent leaf is never silently
 * rendered as a shell — this notice is the honest alternative. */
export function AgentPaneDisabled({ leafId }: { leafId: string }): ReactElement {
  const closePane = useTerminalStore((s) => s.closePane);
  return (
    <div className={styles.pane} data-agent-pane-id={leafId}>
      <div className={styles.disabled}>
        <span>Agent panes are off — enable Composer in Settings → Features.</span>
        <button
          type="button"
          className={styles.restartBtn}
          onClick={() => void closePane(leafId)}
        >
          Close
        </button>
      </div>
    </div>
  );
}
