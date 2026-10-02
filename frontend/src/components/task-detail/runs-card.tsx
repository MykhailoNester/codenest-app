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
import { DeckGrid, DeckGroup, DeckHead, DeckLine } from "../deck/deck-grid";

/**
 * Every ``agent_runs`` row this task's launches produced, as Deck lines,
 * newest-first (the page's query already orders it; this component never
 * re-sorts).
 *
 * Identity is the PROVIDER, never a team member: `agent_runs` carries
 * `provider_id`/`profile`, not a member id, so `runIdentity` renders
 * `provider_display_name ?? provider_name ?? "Unknown agent"` and the
 * identity cell carries `RUN_IDENTITY_TITLE`, so the missing per-run
 * attribution is visible in the UI rather than papered over with the task's
 * assignee or the `profile` config-home string (neither is an identity).
 * #298 dropped the coloured avatar with it — Deck carries state in column
 * one and identity as text, and a provider's hex had no other job here.
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
 */
const COLS = "14px minmax(0, 1fr) 150px 72px 72px";

export interface RunsCardProps {
  runs: AgentRun[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  /** null = replay panel closed. The page owns the selection. */
  activeSessionId: string | null;
  onReplay: (sessionId: string) => void;
}

/** `agent_runs.status` is exactly running|ended — there is no failure flag to
 *  read, so a finished run is `done` and nothing here is ever `fail`. */
function runState(run: AgentRun): "run" | "done" {
  return run.status === "running" ? "run" : "done";
}

export function RunsCard({
  runs,
  isLoading,
  isError,
  onRetry,
  activeSessionId,
  onReplay,
}: RunsCardProps): ReactElement {
  const { sessions, costUsd, calls } = summariseRuns(runs);

  const note =
    !isLoading && !isError && runs.length > 0 ? (
      <>
        {sessions} session{sessions === 1 ? "" : "s"}
        {costUsd != null ? (
          <>
            {" · "}
            <span title={RUN_COST_TITLE}>{formatUSD(costUsd)}</span>
          </>
        ) : null}
        {calls != null ? ` · ${calls} call${calls === 1 ? "" : "s"}` : null}
      </>
    ) : undefined;

  return (
    <DeckGroup label="agent runs" count={runs.length} note={note}>
      {isLoading ? (
        <div className="dk-note">Loading runs…</div>
      ) : isError ? (
        <div className="dk-note">
          Could not load agent runs.{" "}
          <button type="button" className="dk-btn bare" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : runs.length === 0 ? (
        <div className="dk-note">No agent has run on this task yet.</div>
      ) : (
        <DeckGrid cols={COLS} label="Agent runs">
          <DeckHead cells={["agent", "when", "r cost", "r "]} />
          {runs.map((run) => {
            const identity = runIdentity(run);
            const summary = runSummary(run);
            const sessionId = run.session_id;
            return (
              <DeckLine
                key={String(run.id)}
                state={runState(run)}
                cells={[
                  {
                    v: (
                      <>
                        <b title={RUN_IDENTITY_TITLE}>{identity}</b>
                        {summary ? <span className="dim"> {summary}</span> : null}
                      </>
                    ),
                    cls: "sub",
                    title: summary ? `${identity} — ${summary}` : identity,
                  },
                  { v: runMetaSegments(run).join(" · "), cls: "dk-meta" },
                  {
                    v:
                      run.session_cost_usd != null ? (
                        <span className="cost" title={RUN_COST_TITLE}>
                          {formatUSD(run.session_cost_usd)}
                        </span>
                      ) : null,
                    cls: "r",
                  },
                  {
                    v: sessionId ? (
                      <span className="acts">
                        <button
                          type="button"
                          className="dk-btn bare"
                          aria-pressed={activeSessionId === sessionId}
                          onClick={(e) => {
                            e.stopPropagation();
                            onReplay(sessionId);
                          }}
                        >
                          replay
                        </button>
                      </span>
                    ) : null,
                    cls: "r",
                  },
                ]}
                onOpen={sessionId ? () => onReplay(sessionId) : undefined}
              />
            );
          })}
        </DeckGrid>
      )}
    </DeckGroup>
  );
}
