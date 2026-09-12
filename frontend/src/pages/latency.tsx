import { useMemo, useState, type ReactElement } from "react";
import {
  useTraceOperations,
  type TraceOperationStat,
  type TraceOperationsReport,
} from "../lib/api";
import { Shell } from "../components/layout/shell";
import styles from "./latency.module.css";

const CATEGORY_TABS: { id: string; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "hook", label: "Hooks" },
  { id: "tool", label: "Tools" },
  { id: "mcp", label: "MCP" },
  { id: "llm", label: "LLM requests" },
  { id: "subagent", label: "Subagents" },
];

function ms(value: number): string {
  if (value >= 10_000) return `${(value / 1000).toFixed(1)} s`;
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  if (value >= 10) return `${Math.round(value)} ms`;
  return `${value.toFixed(1)} ms`;
}

function label(op: TraceOperationStat): string {
  if (op.operation) return op.operation;
  return op.span_name.replace(/^claude_code\./, "");
}

export function LatencyPage(): ReactElement {
  const query = useTraceOperations();
  const [category, setCategory] = useState("all");

  const report = query.data;
  const rows = useMemo(() => {
    const all = report?.operations ?? [];
    return category === "all"
      ? all
      : all.filter((op) => op.category === category);
  }, [report, category]);

  return (
    <Shell>
      <div className={styles.page}>
        <header>
          <h1 className={styles.sectionTitle}>Latency</h1>
          <p className={styles.subtitle}>
            How often each tool and each hook ran, how often it failed, and how
            long it took. These are spans Claude Code emitted on its traces
            signal and posted to this app&rsquo;s <code>/v1/traces</code>{" "}
            receiver — so this page covers only what that receiver observed. A
            session that ran before telemetry was turned on, or with the traces
            exporter off, is not here at all, and nothing on this page is
            reconstructed from anything else.
          </p>
        </header>

        {query.isError ? (
          <div className={`${styles.banner} ${styles.bannerWarn}`}>
            <div className={styles.bannerTitle}>
              Could not read the span aggregates
            </div>
            <div className={styles.bannerBody}>{query.error.message}</div>
          </div>
        ) : null}

        {query.isPending ? (
          <div className={styles.empty}>Reading…</div>
        ) : report && report.span_count > 0 ? (
          <>
            <Counters report={report} />
            <section>
              <div className={styles.tabs}>
                {CATEGORY_TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    className={
                      tab.id === category
                        ? `${styles.tab} ${styles.tabActive}`
                        : styles.tab
                    }
                    onClick={() => setCategory(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              <p className={styles.sectionNote}>
                One row per distinct operation. Durations are the span&rsquo;s
                own start-to-end time, so a hook&rsquo;s figure is the wall
                clock Claude Code waited on it — the number nothing else in this
                app can produce.
              </p>
              {rows.length === 0 ? (
                <div className={styles.empty}>
                  Nothing of this kind has been observed yet.
                </div>
              ) : (
                <div className={`${styles.card} ${styles.tableWrap}`}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>Operation</th>
                        <th>Span</th>
                        <th className={styles.num}>Runs</th>
                        <th className={styles.num}>Failed</th>
                        <th className={styles.num}>Avg</th>
                        <th className={styles.num}>Min</th>
                        <th className={styles.num}>Max</th>
                        <th className={styles.num}>Total</th>
                        <th className={styles.num}>Sessions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((op) => (
                        <tr key={`${op.span_name}::${op.operation}`}>
                          <td className={styles.mono}>{label(op)}</td>
                          <td>
                            <span className={styles.badge}>{op.span_name}</span>
                          </td>
                          <td className={styles.num}>{op.count}</td>
                          <td
                            className={`${styles.num} ${
                              op.error_count > 0 ? styles.failing : styles.clean
                            }`}
                          >
                            {op.error_count === 0
                              ? "—"
                              : `${op.error_count} (${Math.round(
                                  (op.error_count / op.count) * 100,
                                )}%)`}
                          </td>
                          <td className={styles.num}>
                            {ms(op.avg_duration_ms)}
                          </td>
                          <td className={styles.num}>
                            {ms(op.min_duration_ms)}
                          </td>
                          <td className={styles.num}>
                            {ms(op.max_duration_ms)}
                          </td>
                          <td className={styles.num}>
                            {ms(op.total_duration_ms)}
                          </td>
                          <td className={styles.num}>{op.sessions}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        ) : (
          <EmptyState report={report} />
        )}
      </div>
    </Shell>
  );
}

function Counters({ report }: { report: TraceOperationsReport }): ReactElement {
  const hooks = report.operations.filter((o) => o.category === "hook");
  const tools = report.operations.filter((o) => o.category === "tool");
  const hookTime = hooks.reduce((sum, o) => sum + o.total_duration_ms, 0);
  const hookRuns = hooks.reduce((sum, o) => sum + o.count, 0);
  const slowest = report.operations.reduce<TraceOperationStat | null>(
    (best, o) =>
      best === null || o.avg_duration_ms > best.avg_duration_ms ? o : best,
    null,
  );

  return (
    <div className={styles.counters}>
      <div className={styles.counter}>
        <div className={styles.counterValue}>{report.span_count}</div>
        <div className={styles.counterLabel}>
          operations observed across {report.session_count} session
          {report.session_count === 1 ? "" : "s"}
        </div>
      </div>
      <div className={styles.counter}>
        <div className={styles.counterValue}>
          {hookRuns > 0 ? ms(hookTime / hookRuns) : "—"}
        </div>
        <div className={styles.counterLabel}>
          average hook run, over {hookRuns} hook run
          {hookRuns === 1 ? "" : "s"} in {hooks.length} distinct event
          {hooks.length === 1 ? "" : "s"}
        </div>
      </div>
      <div className={styles.counter}>
        <div className={styles.counterValue}>{tools.length}</div>
        <div className={styles.counterLabel}>distinct tools observed</div>
      </div>
      <div className={styles.counter}>
        <div className={styles.counterValue}>
          {slowest ? ms(slowest.avg_duration_ms) : "—"}
        </div>
        <div className={styles.counterLabel}>
          {slowest
            ? `average for ${label(slowest)}, the slowest operation`
            : "slowest operation"}
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  report,
}: {
  report: TraceOperationsReport | undefined;
}): ReactElement {
  const rejected = report?.receiver.spans_rejected ?? 0;
  const requests = report?.receiver.requests ?? 0;

  return (
    <div className={styles.card}>
      <div className={styles.bannerTitle}>No spans have arrived yet</div>
      <div className={styles.bannerBody}>
        Claude Code sends nothing until telemetry is turned on. Settings &rarr;
        Telemetry writes the environment variables that switch on both the
        metrics and the traces signal and point them at this app; hook and tool
        timing only exists on the traces one.
      </div>
      {requests > 0 ? (
        <div className={styles.bannerBody}>
          {requests} trace export{requests === 1 ? " has" : "s have"} reached
          this app since it started
          {rejected > 0
            ? `, and ${rejected} span${rejected === 1 ? " was" : "s were"} rejected — most often because the span named a session this app has no record of.`
            : "."}
        </div>
      ) : null}
    </div>
  );
}

export default LatencyPage;
