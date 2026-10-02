import type { ReactElement } from "react";
import type { TaskCost } from "../../lib/api";
import { formatUSD } from "../../lib/format-helpers";
import { DeckGroup } from "../deck/deck-grid";

/**
 * What the task cost, in the sidebar. Two attribution routes reach it
 * (`task_cost_service`): a session launched from the task, or one whose branch
 * names it. The split is shown because they are not equally strong — `branch`
 * is inference, and a reader should be able to see how much of the figure
 * rests on it.
 *
 * With no attributed session the sidecar sends `cost_usd: null`, and this
 * renders an em dash naming the lane it waits on. A `$0.00` would claim the
 * work was free.
 *
 * The page owns the query and passes plain props (the `PropertiesCard`
 * convention), which also keeps this testable without a `QueryClientProvider`.
 */
export interface CostCardProps {
  cost: TaskCost | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function CostCard({
  cost,
  isLoading,
  isError,
  onRetry,
}: CostCardProps): ReactElement {
  return (
    <DeckGroup label="cost">
      {isLoading ? (
        <div className="dk-note">Loading cost…</div>
      ) : isError || !cost ? (
        <div className="dk-note">
          Could not load cost.{" "}
          <button type="button" className="dk-btn bare" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : cost.cost_usd === null ? (
        <>
          <div className="dk-kv">
            <span>spend</span>
            <span className="dim">—</span>
          </div>
          <div className="dk-note">
            No session is attributed to this task. A session counts here when it
            is launched from the task, or when its branch names it
            (<code>feature/{cost.task_id}-…</code>).
          </div>
        </>
      ) : (
        <>
          <div className="dk-kv">
            <span>spend</span>
            <span>{formatUSD(cost.cost_usd)}</span>
          </div>
          <div className="dk-kv">
            <span>tokens</span>
            <span>
              {formatTokens(cost.tokens_in ?? 0)} in ·{" "}
              {formatTokens(cost.tokens_out ?? 0)} out
            </span>
          </div>
          <div className="dk-kv">
            <span>sessions</span>
            <span>
              {cost.session_count}
              {cost.by_branch > 0 ? (
                <span className="dim">
                  {" "}
                  ({cost.by_launch} launched, {cost.by_branch} by branch)
                </span>
              ) : null}
            </span>
          </div>
        </>
      )}
    </DeckGroup>
  );
}
