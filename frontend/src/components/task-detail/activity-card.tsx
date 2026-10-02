import { useState, type ReactElement, type ReactNode } from "react";
import type { ActivityEntry } from "../../lib/api";
import {
  activityActorName,
  formatActivityStamp,
  taskActivityGlyph,
  taskActivityPhrase,
} from "../../lib/task-activity";
import { DeckGrid, DeckLine } from "../deck/deck-grid";

/**
 * The `.dk-tabs` strip in the document column. The design shows
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
const COLS = "14px minmax(0, 1fr) 96px";

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
    <div className="dk-group">
      <div className="dk-tabs" role="tablist" aria-label="Task sections">
        <button
          type="button"
          role="tab"
          className={`dk-tab${onComments ? "" : " on"}`}
          aria-selected={onComments ? "false" : "true"}
          id="task-tab-activity"
          aria-controls="task-panel-activity"
          onClick={() => setTab("activity")}
        >
          activity
        </button>
        {comments !== undefined ? (
          <button
            type="button"
            role="tab"
            className={`dk-tab${onComments ? " on" : ""}`}
            aria-selected={onComments ? "true" : "false"}
            id="task-tab-comments"
            aria-controls="task-panel-comments"
            onClick={() => setTab("comments")}
          >
            comments
          </button>
        ) : null}
      </div>
      {onComments ? (
        <div
          role="tabpanel"
          id="task-panel-comments"
          aria-labelledby="task-tab-comments"
        >
          {comments}
        </div>
      ) : (
        <div
          role="tabpanel"
          id="task-panel-activity"
          aria-labelledby="task-tab-activity"
        >
          {isLoading ? (
            <div className="dk-note">Loading activity…</div>
          ) : isError ? (
            <div className="dk-note">
              Could not load activity.{" "}
              <button type="button" className="dk-btn bare" onClick={onRetry}>
                Retry
              </button>
            </div>
          ) : entries.length === 0 ? (
            <div className="dk-note">No activity recorded yet.</div>
          ) : (
            <DeckGrid cols={COLS} label="Activity">
              {entries.map((entry) => (
                <DeckLine
                  key={entry.id}
                  cells={[
                    {
                      v: (
                        <>
                          <span className="dim" aria-hidden="true">
                            {taskActivityGlyph(entry.action)}
                          </span>{" "}
                          <b>{activityActorName(entry.actor)}</b>{" "}
                          {taskActivityPhrase(entry, { statusLabels })}
                        </>
                      ),
                      cls: "sub",
                    },
                    {
                      v: (
                        <time
                          dateTime={`${entry.created_at}Z`}
                          title={entry.created_at}
                        >
                          {formatActivityStamp(entry.created_at)}
                        </time>
                      ),
                      cls: "r dim",
                    },
                  ]}
                />
              ))}
            </DeckGrid>
          )}
        </div>
      )}
    </div>
  );
}
