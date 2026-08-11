import type { ReactElement } from "react";
import type { AgentRun } from "../../lib/api";
import { formatUSD } from "../../lib/format-helpers";
import {
  RUN_COST_TITLE,
  RUN_IDENTITY_TITLE,
  runIdentity,
  runMetaSegments,
  runSummary,
  summariseRuns,
} from "../../lib/task-runs";
import { initialsOf } from "./avatar";

/**
 * The `.td-runs` card in the document column: every ``agent_runs`` row this
 * task's launches produced, newest-first (the page's query already orders
 * it; this component never re-sorts).
 *
 * Identity is the PROVIDER, never a team member: `agent_runs` carries
 * `provider_id`/`profile`, not a member id, so `runIdentity` renders
 * `provider_display_name ?? provider_name ?? "Unknown agent"` with the
 * provider's own colour, and the identity element carries
 * `RUN_IDENTITY_TITLE` so the missing per-run attribution is visible in the
 * UI rather than papered over with the task's assignee or the `profile`
 * config-home string (neither is an identity).
 *
 * Duration is `ended_at - started_at`, computed once from the stored
 * stamps (`task-runs.formatRunDuration`) — a run still in flight renders the
 * literal "running", never a number computed against the clock during
 * render. Zero is a value, not an unknown: `session_total_tool_calls === 0`
 * renders "0 calls"; a row with no `agent_sessions` match at all omits the
 * calls/cost segments rather than zero-filling them.
 *
 * Replay reuses `components/command-center/replay-panel.tsx` (mounted by
 * the page's `<TaskRunReplay>`, not this component) — no second replay
 * implementation.
 *
 * Prop-only, like `activity-card.tsx`: the page owns the query and passes
 * plain props, which keeps this component testable without a
 * `QueryClientProvider`.
 */
export interface RunsCardProps {
  runs: AgentRun[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  /** null = replay panel closed. The page owns the selection. */
  activeSessionId: string | null;
  onReplay: (sessionId: string) => void;
}

const AVATAR_PX = 20;
const AVATAR_FONT_PX = 9;

export function RunsCard({
  runs,
  isLoading,
  isError,
  onRetry,
  activeSessionId,
  onReplay,
}: RunsCardProps): ReactElement {
  const { sessions, costUsd, calls } = summariseRuns(runs);

  return (
    <div className="td-card">
      <div className="td-card__head">
        <h2 className="td-h">
          Agent runs <span className="td-count">{runs.length}</span>
        </h2>
        {!isLoading && !isError && runs.length > 0 ? (
          <span className="td-dim td-sm">
            {sessions} session{sessions === 1 ? "" : "s"}
            {costUsd != null ? (
              <>
                {" · "}
                <span title={RUN_COST_TITLE}>{formatUSD(costUsd)}</span>
              </>
            ) : null}
            {calls != null ? ` · ${calls} call${calls === 1 ? "" : "s"}` : null}
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <span className="td-dim td-sm">Loading runs…</span>
      ) : isError ? (
        <>
          <span className="td-dim td-sm">Could not load agent runs.</span>
          <button type="button" className="d3-btn d3-btn--ghost" onClick={onRetry}>
            Retry
          </button>
        </>
      ) : runs.length === 0 ? (
        <span className="td-dim td-sm">No agent has run on this task yet.</span>
      ) : (
        <div className="td-runs">
          {runs.map((run) => {
            const identity = runIdentity(run);
            const summary = runSummary(run);
            const hasProvider =
              run.provider_name != null || run.provider_display_name != null;
            const sessionId = run.session_id;
            return (
              <div className="td-run" key={String(run.id)}>
                {hasProvider ? (
                  <span
                    className="td-av"
                    style={{
                      width: AVATAR_PX,
                      height: AVATAR_PX,
                      fontSize: AVATAR_FONT_PX,
                      background: run.provider_color ?? "var(--fg-4)",
                    }}
                  >
                    {initialsOf(identity)}
                  </span>
                ) : (
                  <span
                    className="td-av td-av--none"
                    style={{ width: AVATAR_PX, height: AVATAR_PX }}
                  />
                )}
                <div className="td-run__body">
                  <div className="td-run__top">
                    <b title={RUN_IDENTITY_TITLE}>{identity}</b>
                    {summary ? <span>{summary}</span> : null}
                  </div>
                  <div className="td-run__meta">
                    {runMetaSegments(run).join(" · ")}
                  </div>
                </div>
                {run.session_cost_usd != null ? (
                  <span className="td-run__cost" title={RUN_COST_TITLE}>
                    {formatUSD(run.session_cost_usd)}
                  </span>
                ) : null}
                {sessionId ? (
                  <button
                    type="button"
                    className="td-ghost"
                    aria-pressed={activeSessionId === sessionId}
                    onClick={() => onReplay(sessionId)}
                  >
                    Replay
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
