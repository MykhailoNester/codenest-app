/**
 * PlanHeadroom — the plan-usage panel (epic #153, #164 data / #166 mount),
 * drawn on Deck (#283). Mounted by Budgets
 * (`components/budgets/usage-limits.tsx`) since #345 deleted the landing page
 * that used to carry it.
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
 * past it. This component's own test greps this file for the stale figures the
 * design doc printed, which is the cheapest way to keep that promise honest.
 *
 * A series with no separation in its bounds (one sample, or a counter that has
 * held one value) gets no bar at all rather than an empty or a full one: with
 * `max === min` there is no position to show, and either extreme would read as
 * a statement about headroom that the data does not support.
 *
 * On Deck
 * -------
 * The panel was a rounded translucent box with a bullet-prefixed section label
 * — one of the four large Command Center panels — and its stylesheet carried a
 * standing ban on `backdrop-filter` (`d3-creative.css` recorded that property
 * driving the WebKit Graphics process to ~5 cores). Both the box and the ban
 * go with the stylesheet: there is nowhere left in this component to declare
 * the property, and Deck has no blurred surface to declare it on.
 *
 * Every row carries the `idle` glyph (`·`, "inert") and no other. That is
 * deliberate and is the same claim the old stylesheet made in words: Deck's
 * ramp is a severity ramp, and "high compared with the last few days" is not a
 * severity — nothing here is known to be a limit, so no row may say it is.
 */

import type { ReactElement } from "react";
import { usePlanUsage } from "../../lib/api";
import { DeckGrid, DeckHead, DeckLine } from "../deck/deck-grid";
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

/**
 * This panel's column template.
 *
 * Not in `DECK_COLS`: that module is a deck primitive and is out of scope for
 * this ticket, so the shape lives with the only list that has it — the same
 * call `components/notification-bell.tsx` makes for `BELL_COLS`. No named
 * template fits a list whose trailing column is a range rather than a time.
 */
const HEADROOM_COLS = "14px minmax(0, 1fr) 58px 56px 118px";

/**
 * Roughly three sampling intervals. The file is rewritten about every 15
 * minutes, so a hole this size is not jitter — it is a stretch where nothing
 * was recorded, and the shape of the series across it is not a trend. Below it
 * the gap is unremarkable and saying so would be noise.
 */
const GAP_WORTH_MENTIONING_SECONDS = 45 * 60;

function seriesRow(series: PlanUsageSeries): ReactElement {
  const position = observedPosition(series);
  return (
    <DeckLine
      key={series.key}
      state="idle"
      cells={[
        {
          v: (
            <>
              {/* The key as it appears in the file, not a friendlier name we
                  invented — the panel's whole claim is that it is showing you
                  raw counters. */}
              <span className="id">{series.key}</span> {series.label}
            </>
          ),
          title: `${series.key} ${series.label}`,
        },
        {
          // `.dk-meter` is Deck's one bar, and it is 3px of neutral fill with
          // no label — which is exactly the restraint this panel needs. Its
          // `warn`/`err` variants are deliberately not used: see the header.
          v:
            position === null ? null : (
              <span className="dk-meter">
                <i style={{ width: `${(position * 100).toFixed(1)}%` }} />
              </span>
            ),
        },
        { v: formatLatest(series), cls: "r sub" },
        { v: `observed ${formatObservedRange(series)}`, cls: "r" },
      ]}
    />
  );
}

/** The heading, repeated by all three states so they cannot drift apart. */
function Head({ sampled }: { sampled?: string }): ReactElement {
  return (
    <h2 className="dk-group__h">
      <span>plan headroom</span>
      {sampled != null && <span className="note">{sampled}</span>}
    </h2>
  );
}

export function PlanHeadroom(): ReactElement {
  const { data, isLoading, isError } = usePlanUsage();

  // No payload yet is its own state, distinct from a payload that says the
  // file is missing — rendering the "no history on this machine" copy while
  // the first fetch is still in flight would accuse a healthy install.
  if (isLoading) {
    return (
      <div className="dk-group">
        <Head />
        <div className="dk-note">Reading plan-usage history&hellip;</div>
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
      <div className="dk-group">
        <Head />
        <div className="dk-note">
          Could not reach the sidecar for plan-usage history.
        </div>
      </div>
    );
  }

  const notice = planUsageNotice(data);
  const series = planUsageSeries(data);
  const gap = data.max_gap_seconds;

  return (
    <div className="dk-group">
      <Head
        sampled={
          data.last_sample_at !== null
            ? `sampled ${formatSampleAge(data.last_sample_at)}`
            : undefined
        }
      />

      {notice && <div className="dk-note">{notice}</div>}

      {series.length > 0 && (
        <>
          <DeckGrid cols={HEADROOM_COLS} label="Plan headroom">
            <DeckHead cells={["counter", "", "r latest", "r range"]} />
            {series.map(seriesRow)}
          </DeckGrid>
          {gap !== null && gap >= GAP_WORTH_MENTIONING_SECONDS && (
            <div className="dk-meta">
              longest gap between readings <em>{formatMaxGap(gap)}</em>
            </div>
          )}
          <p className="dk-note sans">{PLAN_USAGE_CAVEAT}</p>
        </>
      )}
    </div>
  );
}
