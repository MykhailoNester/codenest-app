import type { ReactElement } from "react";
import type { ActivityEntry } from "../../lib/api";
import {
  activityActorName,
  formatActivityStamp,
  taskActivityGlyph,
  taskActivityPhrase,
} from "../../lib/task-activity";

/**
 * The `.td-tabs` card in the document column. The design shows
 * Activity | Changed files | Comments; only Activity has a read endpoint
 * today (`GET /api/v1/tasks/{id}/activity`), so the tab strip renders just
 * that one tab, always selected — no `useState`, nothing to switch between
 * yet. "Changed files" and "Comments" need schema this app does not have
 * (see the plan's Follow-ups).
 *
 * The page owns the query and passes plain props (mirrors `PropertiesCard`:
 * the page owns writes/state, the card renders) — that also keeps this
 * component testable without a `QueryClientProvider`.
 */
export interface ActivityCardProps {
  entries: ActivityEntry[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  /** status slug -> display label, from the page's `statusVocab`. */
  statusLabels: Readonly<Record<string, string>>;
}

export function ActivityCard({
  entries,
  isLoading,
  isError,
  onRetry,
  statusLabels,
}: ActivityCardProps): ReactElement {
  return (
    <div className="td-card">
      <div className="td-tabs" role="tablist" aria-label="Task sections">
        <button
          type="button"
          role="tab"
          className="is-on"
          aria-selected="true"
          id="td-tab-activity"
          aria-controls="td-panel-activity"
        >
          Activity
        </button>
      </div>
      <div
        role="tabpanel"
        id="td-panel-activity"
        aria-labelledby="td-tab-activity"
      >
        {isLoading ? (
          <span className="td-dim td-sm">Loading activity…</span>
        ) : isError ? (
          <>
            <span className="td-dim td-sm">Could not load activity.</span>
            <button
              type="button"
              className="d3-btn d3-btn--ghost"
              onClick={onRetry}
            >
              Retry
            </button>
          </>
        ) : entries.length === 0 ? (
          <span className="td-dim td-sm">No activity recorded yet.</span>
        ) : (
          <ul className="td-feed">
            {entries.map((entry) => (
              <li key={entry.id}>
                <span className="td-feed__i" aria-hidden="true">
                  {taskActivityGlyph(entry.action)}
                </span>
                <span className="td-feed__t">
                  <b>{activityActorName(entry.actor)}</b>{" "}
                  {taskActivityPhrase(entry, { statusLabels })}
                </span>
                <time
                  className="td-feed__w"
                  dateTime={`${entry.created_at}Z`}
                  title={entry.created_at}
                >
                  {formatActivityStamp(entry.created_at)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
