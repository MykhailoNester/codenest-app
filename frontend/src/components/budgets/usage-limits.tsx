/**
 * Usage & limits (#182), drawn on Deck (#283).
 *
 * The two consumption figures were cards — a bordered, filled box each, with
 * the "no data" variant distinguished by a dashed border. Deck's trade is that
 * cards become lines and a figure becomes `.dk-big`, whose `.v.na` is the same
 * "nothing observed" distinction carried by ink instead of a border style, so
 * it survives in a screenshot at any size.
 *
 * The window switcher was three bordered buttons with an accent border on the
 * active one; `.dk-seg` is Deck's segmented control and marks the active
 * segment by inverting it, which is legible with colour switched off.
 */
import { useState, type ReactElement, type ReactNode } from "react";
import {
  USAGE_WINDOWS,
  useUsageConsumption,
  type UsageConsumption,
  type UsageWindow,
} from "../../lib/api";
import { DeckGroup } from "../deck/deck-grid";
import { PlanHeadroom } from "../dashboard/plan-headroom";

const WINDOW_LABEL: Record<UsageWindow, string> = {
  "24h": "last 24 hours",
  "7d": "last 7 days",
  "30d": "last 30 days",
};

function NotObserved(): ReactElement {
  return <span className="dim">not observed</span>;
}

function usd(value: number | null): ReactNode {
  return value === null ? <NotObserved /> : `$${value.toFixed(4)}`;
}

function count(value: number | null): ReactNode {
  return value === null ? <NotObserved /> : value.toLocaleString();
}

/**
 * One counter. `.dk-kv` is Deck's label/value pair and already draws the
 * hairline between consecutive rows, which is what the old `.rows` gap did
 * by eye.
 */
function Row({ name, value }: { name: string; value: ReactNode }): ReactElement {
  return (
    <div className="dk-kv">
      <span>{name}</span>
      <span>{value}</span>
    </div>
  );
}

/**
 * A measuring lane: what it is, its one figure, why that figure means what it
 * means, and the counters underneath. `observed` is the whole distinction the
 * panel exists to make, so it reaches the figure itself (`.v.na`) rather than
 * only the frame.
 */
function Lane({
  label,
  observed,
  cost,
  caveat,
  children,
}: {
  label: string;
  observed: boolean;
  cost: number | null;
  caveat: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="dk-group">
      <div className="dk-big">
        <div className={observed ? "v" : "v na"}>{usd(cost)}</div>
        {/* `.dk-big .l` uppercases in CSS, so the label keeps its own casing
            in the DOM — it is read by this component's test. */}
        <div className="l">{label}</div>
      </div>
      <p className="dk-note sans">{caveat}</p>
      {children}
    </div>
  );
}

function Estimate({ report }: { report: UsageConsumption }): ReactElement {
  const { estimate, sessions } = report;
  const plural = estimate.sessions === 1 ? "" : "s";
  return (
    <Lane
      label={`Flat-rate estimate — lane ${estimate.lane}`}
      observed={estimate.observed}
      cost={estimate.cost_usd}
      caveat={
        (estimate.observed
          ? `This app's own figure for the ${estimate.sessions} session${plural} no vendor figure has displaced. Every model is priced at one flat rate, so it is an estimate and not a billed amount.`
          : "No session in this window is still carrying this app's own estimate.") +
        (sessions.superseded > 0
          ? ` ${sessions.superseded} session${sessions.superseded === 1 ? " is" : "s are"} excluded here: the vendor's own figure replaced the estimate on the session row, so no estimate survives to compare against.`
          : "")
      }
    >
      <Row name="tokens in" value={count(estimate.tokens_in)} />
      <Row name="tokens out" value={count(estimate.tokens_out)} />
    </Lane>
  );
}

function Vendor({ report }: { report: UsageConsumption }): ReactElement {
  const { vendor, sessions } = report;
  return (
    <Lane
      label={`Vendor-reported — lane ${vendor.lane}`}
      observed={vendor.observed}
      cost={vendor.cost_usd}
      caveat={
        vendor.observed
          ? `What Claude Code itself exported, for ${vendor.sessions} of the ${sessions.total} session${sessions.total === 1 ? "" : "s"} in this window. It prices each model at its real rate and covers whole sessions; a counter no export carried reads as not observed rather than as zero.`
          : "No metrics export has arrived for any session in this window. That is silence, not zero — telemetry is opt-in."
      }
    >
      <Row name="tokens input" value={count(vendor.tokens_input)} />
      <Row name="tokens output" value={count(vendor.tokens_output)} />
      <Row name="tokens cache read" value={count(vendor.tokens_cache_read)} />
      <Row
        name="tokens cache creation"
        value={count(vendor.tokens_cache_creation)}
      />
    </Lane>
  );
}

export function UsageLimits(): ReactElement {
  const [range, setRange] = useState<UsageWindow>("7d");
  const { data, isPending, isError, error } = useUsageConsumption(range);

  const windows = (
    <span className="dk-seg" role="group" aria-label="Window">
      {USAGE_WINDOWS.map((key) => (
        <button
          key={key}
          type="button"
          className={key === range ? "on" : undefined}
          aria-pressed={key === range}
          onClick={() => setRange(key)}
        >
          {key}
        </button>
      ))}
    </span>
  );

  return (
    <DeckGroup label="Usage & limits" actions={windows}>
      <p className="dk-note sans">
        Two separate questions. Above, how much of the plan is left — in the
        counters Claude desktop publishes without saying what they measure.
        Below, what was consumed in the {WINDOW_LABEL[range]}, split by the lane
        that measured it. The two consumption cards cover different sessions and
        are not two views of one number: adding them together would produce a
        figure nothing observed.
      </p>

      <PlanHeadroom />

      {isError ? (
        <p className="dk-note sans">
          Could not read consumption: {error.message}
        </p>
      ) : isPending || !data ? (
        <p className="dk-note sans">Reading&hellip;</p>
      ) : (
        <>
          <Estimate report={data} />
          <Vendor report={data} />
          <div className="dk-group">
            <Row name="sessions" value={data.sessions.total} />
            <Row name="with telemetry" value={data.sessions.vendor_observed} />
            <Row name="not observed" value={data.sessions.not_observed} />
            <Row name="since" value={data.since.replace("T", " ")} />
          </div>
          <p className="dk-note sans">
            The budgets below are measured against this app&rsquo;s own session
            totals, and a project-scoped budget against the flat-rate estimate —
            the vendor figure has no project dimension to split.
          </p>
        </>
      )}
    </DeckGroup>
  );
}
