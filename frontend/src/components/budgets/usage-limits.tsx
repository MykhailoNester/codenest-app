import { useState, type ReactElement, type ReactNode } from "react";
import {
  USAGE_WINDOWS,
  useUsageConsumption,
  type UsageConsumption,
  type UsageWindow,
} from "../../lib/api";
import { PlanHeadroom } from "../dashboard/plan-headroom";
import styles from "./usage-limits.module.css";

const WINDOW_LABEL: Record<UsageWindow, string> = {
  "24h": "last 24 hours",
  "7d": "last 7 days",
  "30d": "last 30 days",
};

function NotObserved(): ReactElement {
  return <span className={styles.unknown}>not observed</span>;
}

function usd(value: number | null): ReactNode {
  return value === null ? <NotObserved /> : `$${value.toFixed(4)}`;
}

function count(value: number | null): ReactNode {
  return value === null ? <NotObserved /> : value.toLocaleString();
}

function Row({
  name,
  value,
}: {
  name: string;
  value: ReactNode;
}): ReactElement {
  return (
    <div className={styles.row}>
      <span>{name}</span>
      <span>{value}</span>
    </div>
  );
}

function Estimate({ report }: { report: UsageConsumption }): ReactElement {
  const { estimate, sessions } = report;
  const plural = estimate.sessions === 1 ? "" : "s";
  return (
    <div
      className={
        estimate.observed ? styles.card : `${styles.card} ${styles.quiet}`
      }
    >
      <div className={styles.label}>
        Flat-rate estimate — lane {estimate.lane}
      </div>
      <div className={styles.value}>{usd(estimate.cost_usd)}</div>
      <div className={styles.caveat}>
        {estimate.observed
          ? `This app's own figure for the ${estimate.sessions} session${plural} no vendor figure has displaced. Every model is priced at one flat rate, so it is an estimate and not a billed amount.`
          : "No session in this window is still carrying this app's own estimate."}
        {sessions.superseded > 0
          ? ` ${sessions.superseded} session${sessions.superseded === 1 ? " is" : "s are"} excluded here: the vendor's own figure replaced the estimate on the session row, so no estimate survives to compare against.`
          : ""}
      </div>
      <div className={styles.rows}>
        <Row name="tokens in" value={count(estimate.tokens_in)} />
        <Row name="tokens out" value={count(estimate.tokens_out)} />
      </div>
    </div>
  );
}

function Vendor({ report }: { report: UsageConsumption }): ReactElement {
  const { vendor, sessions } = report;
  return (
    <div
      className={
        vendor.observed ? styles.card : `${styles.card} ${styles.quiet}`
      }
    >
      <div className={styles.label}>Vendor-reported — lane {vendor.lane}</div>
      <div className={styles.value}>{usd(vendor.cost_usd)}</div>
      <div className={styles.caveat}>
        {vendor.observed
          ? `What Claude Code itself exported, for ${vendor.sessions} of the ${sessions.total} session${sessions.total === 1 ? "" : "s"} in this window. It prices each model at its real rate and covers whole sessions; a counter no export carried reads as not observed rather than as zero.`
          : "No metrics export has arrived for any session in this window. That is silence, not zero — telemetry is opt-in."}
      </div>
      <div className={styles.rows}>
        <Row name="tokens input" value={count(vendor.tokens_input)} />
        <Row name="tokens output" value={count(vendor.tokens_output)} />
        <Row name="tokens cache read" value={count(vendor.tokens_cache_read)} />
        <Row
          name="tokens cache creation"
          value={count(vendor.tokens_cache_creation)}
        />
      </div>
    </div>
  );
}

export function UsageLimits(): ReactElement {
  const [range, setRange] = useState<UsageWindow>("7d");
  const { data, isPending, isError, error } = useUsageConsumption(range);

  return (
    <section className={styles.section}>
      <div className={styles.head}>
        <h2 className={styles.title}>Usage &amp; limits</h2>
        <div className={styles.windows}>
          {USAGE_WINDOWS.map((key) => (
            <button
              key={key}
              type="button"
              className={
                key === range
                  ? `${styles.window} ${styles.windowOn}`
                  : styles.window
              }
              onClick={() => setRange(key)}
            >
              {key}
            </button>
          ))}
        </div>
      </div>

      <p className={styles.note}>
        Two separate questions. Above, how much of the plan is left — in the
        counters Claude desktop publishes without saying what they measure.
        Below, what was consumed in the {WINDOW_LABEL[range]}, split by the lane
        that measured it. The two consumption cards cover different sessions and
        are not two views of one number: adding them together would produce a
        figure nothing observed.
      </p>

      <PlanHeadroom />

      {isError ? (
        <p className={styles.note}>
          Could not read consumption: {error.message}
        </p>
      ) : isPending || !data ? (
        <p className={styles.note}>Reading&hellip;</p>
      ) : (
        <>
          <div className={styles.cards}>
            <Estimate report={data} />
            <Vendor report={data} />
          </div>
          <div className={styles.coverage}>
            <span>
              Sessions started in this window{" "}
              <strong>{data.sessions.total}</strong>
            </span>
            <span>
              With vendor telemetry{" "}
              <strong>{data.sessions.vendor_observed}</strong>
            </span>
            <span>
              Not observed <strong>{data.sessions.not_observed}</strong>
            </span>
            <span>
              Since <strong>{data.since.replace("T", " ")}</strong>
            </span>
          </div>
          <p className={styles.note}>
            The budgets below are measured against this app&rsquo;s own session
            totals, and a project-scoped budget against the flat-rate estimate —
            the vendor figure has no project dimension to split.
          </p>
        </>
      )}
    </section>
  );
}
