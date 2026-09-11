/**
 * PlanHeadroom — the plan-usage panel Mission Control mounts (epic #153, #164
 * data / #166 mount).
 *
 * Every number on this panel is a raw counter out of Claude desktop's
 * `plan-usage-history.json`, and the panel's job is to show them without
 * quietly turning them into a gauge. `lib/plan-usage.ts` (#164) owns that
 * discipline — `formatLatest` refuses a unit, `observedPosition` returns a
 * position inside the range the *file* has held rather than progress toward a
 * limit, and `PLAN_USAGE_CAVEAT` is the sentence that stops a reader assuming
 * the bar is a percentage. This component adds no arithmetic of its own; it is
 * markup around those helpers, which is the reason the helpers exist.
 *
 * The bounds are read from the payload's own `observed_min` / `observed_max`
 * per series and are never written down here. They move: both counters' upper
 * bounds on this machine changed within a day of #164 landing, so a range
 * pasted into the source is a panel that starts lying the moment a counter goes
 * past it. `mission-control.test.tsx` greps this file for the stale figures the
 * design doc printed, which is the cheapest way to keep that promise honest.
 *
 * A series with no separation in its bounds (one sample, or a counter that has
 * held one value) gets no bar at all rather than an empty or a full one: with
 * `max === min` there is no position to show, and either extreme would read as
 * a statement about headroom that the data does not support.
 */

import type { ReactElement } from "react";
import { usePlanUsage } from "../../lib/api";
import {
  PLAN_USAGE_CAVEAT,
  formatLatest,
  formatMaxGap,
  formatObservedRange,
  formatSampleAge,
  observedPosition,
  planUsageNotice,
  planUsageSeries,
  type PlanUsageSeries,
} from "../../lib/plan-usage";
import styles from "./plan-headroom.module.css";

/**
 * Roughly three sampling intervals. The file is rewritten about every 15
 * minutes, so a hole this size is not jitter — it is a stretch where nothing
 * was recorded, and the shape of the series across it is not a trend. Below it
 * the gap is unremarkable and saying so would be noise.
 */
const GAP_WORTH_MENTIONING_SECONDS = 45 * 60;

function SeriesRow({ series }: { series: PlanUsageSeries }): ReactElement {
  const position = observedPosition(series);
  return (
    <div className={styles.row}>
      <div className={styles.rowHead}>
        <span className={styles.rowLabel}>
          <span className={styles.rowKey}>{series.key}</span>
          {series.label}
        </span>
        <span className={styles.rowValue}>{formatLatest(series)}</span>
      </div>
      {position !== null && (
        <div className={styles.track}>
          <div
            className={styles.fill}
            style={{ width: `${(position * 100).toFixed(1)}%` }}
          />
        </div>
      )}
      <span className={styles.observed}>
        observed {formatObservedRange(series)}
      </span>
    </div>
  );
}

export function PlanHeadroom(): ReactElement {
  const { data, isLoading, isError } = usePlanUsage();

  // No payload yet is its own state, distinct from a payload that says the
  // file is missing — rendering the "no history on this machine" copy while
  // the first fetch is still in flight would accuse a healthy install.
  if (isLoading) {
    return (
      <div className={styles.panel}>
        <div className={styles.head}>
          <span className={styles.sectionLabel}>Plan headroom</span>
        </div>
        <span className={styles.notice}>
          Reading plan-usage history&hellip;
        </span>
      </div>
    );
  }

  // A failed request is a third state, and it used to be swallowed by the
  // guard above: `isLoading || !data` is false-then-true for a query that has
  // stopped retrying with no payload, so the panel sat on "Reading…" forever
  // and blamed a slow read for an endpoint that had already given up. The
  // sidecar is the thing that failed here, not Claude desktop's file — saying
  // so is the difference between a fixable message and a spinner.
  if (isError || !data) {
    return (
      <div className={styles.panel}>
        <div className={styles.head}>
          <span className={styles.sectionLabel}>Plan headroom</span>
        </div>
        <span className={styles.notice}>
          Could not reach the sidecar for plan-usage history.
        </span>
      </div>
    );
  }

  const notice = planUsageNotice(data);
  const series = planUsageSeries(data);
  const gap = data.max_gap_seconds;

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <span className={styles.sectionLabel}>Plan headroom</span>
        {data.last_sample_at !== null && (
          <span className={styles.sampled}>
            sampled {formatSampleAge(data.last_sample_at)}
          </span>
        )}
      </div>

      {notice && <span className={styles.notice}>{notice}</span>}

      {series.length > 0 && (
        <>
          <div className={styles.rows}>
            {series.map((s) => (
              <SeriesRow key={s.key} series={s} />
            ))}
          </div>
          {gap !== null && gap >= GAP_WORTH_MENTIONING_SECONDS && (
            <span className={styles.gap}>
              longest gap between readings {formatMaxGap(gap)}
            </span>
          )}
          <p className={styles.caveat}>{PLAN_USAGE_CAVEAT}</p>
        </>
      )}
    </div>
  );
}
