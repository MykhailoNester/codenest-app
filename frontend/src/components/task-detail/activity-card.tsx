import { useState, type ReactElement, type ReactNode } from "react";
import type { ActivityEntry } from "../../lib/api";
import {
  activityActorName,
  formatActivityStamp,
  taskActivityGlyph,
  taskActivityPhrase,
} from "../../lib/task-activity";

/**
 * The `.td-tabs` card in the document column. The design shows
 * Activity | Changed files | Comments. Activity reads
 * `GET /api/v1/tasks/{id}/activity`; Comments reads
 * `GET /api/v1/tasks/{id}/comments` (#28) and arrives as the `comments` node
 * so this card keeps owning the strip without owning that panel's writes.
 * The tab renders only when that node is passed, so a caller with no comments
 * panel still gets the single-tab strip. "Changed files" is still absent —
 * it has no data source yet (#29).
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
  /** Comments panel. Omitted, its tab is not rendered. */
  comments?: ReactNode;
}

export function ActivityCard({
  entries,
  isLoading,
  isError,
  onRetry,
  statusLabels,
  comments,
}: ActivityCardProps): ReactElement {
  const [tab, setTab] = useState<"activity" | "comments">("activity");
  const onComments = comments !== undefined && tab === "comments";
  return (
    <div className="td-card">
      <div className="td-tabs" role="tablist" aria-label="Task sections">
        <button
          type="button"
          role="tab"
          className={onComments ? undefined : "is-on"}
          aria-selected={onComments ? "false" : "true"}
          id="td-tab-activity"
          aria-controls="td-panel-activity"
          onClick={() => setTab("activity")}
        >
          Activity
        </button>
        {comments !== undefined ? (
          <button
            type="button"
            role="tab"
            className={onComments ? "is-on" : undefined}
            aria-selected={onComments ? "true" : "false"}
            id="td-tab-comments"
            aria-controls="td-panel-comments"
            onClick={() => setTab("comments")}
          >
            Comments
          </button>
        ) : null}
      </div>
      {onComments ? (
        <div
          role="tabpanel"
          id="td-panel-comments"
          aria-labelledby="td-tab-comments"
        >
          {comments}
        </div>
      ) : (
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
      )}
    </div>
  );
}
