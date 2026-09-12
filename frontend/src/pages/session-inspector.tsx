import { type ReactElement } from "react";
import { useParams } from "react-router-dom";
import {
  useSessionInspector,
  type InspectorField,
  type InspectorLane,
  type SessionInspectorReport,
} from "../lib/api";
import { Shell } from "../components/layout/shell";
import { DetailHeader } from "../components/layout/detail-header";
import styles from "./session-inspector.module.css";

const FIELD_LABELS: Record<string, string> = {
  cost_usd: "Cost (USD)",
  tokens_in: "Tokens in",
  tokens_out: "Tokens out",
  context_tokens: "Context tokens",
  model: "Model",
};

function ms(value: number): string {
  if (value >= 10_000) return `${(value / 1000).toFixed(1)} s`;
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  if (value >= 10) return `${Math.round(value)} ms`;
  return `${value.toFixed(1)} ms`;
}

function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function clock(stamp: string | null): string {
  if (!stamp) return "—";
  return stamp.replace("T", " ").slice(0, 19);
}

function fieldValue(field: InspectorField): ReactElement {
  if (field.state === "unobserved") {
    return <span className={styles.unknown}>not observed</span>;
  }
  const value = field.value;
  const text =
    field.field === "cost_usd" && typeof value === "number"
      ? `$${value.toFixed(4)}`
      : typeof value === "number"
        ? value.toLocaleString()
        : String(value ?? "");
  return <span className={styles.mono}>{text}</span>;
}

function LaneBadge({ lane }: { lane: string }): ReactElement {
  return (
    <span className={`${styles.badge} ${styles.badgeOwner}`} title={`Lane ${lane}`}>
      {lane}
    </span>
  );
}

function Owner({ field }: { field: InspectorField }): ReactElement {
  if (field.winning_lane) return <LaneBadge lane={field.winning_lane} />;
  if (field.state === "untracked") {
    return <span className={styles.unknown}>no lane recorded</span>;
  }
  return <span className={styles.unknown}>—</span>;
}

function History({ field }: { field: InspectorField }): ReactElement {
  if (field.claims.length === 0) {
    return (
      <span className={styles.unknown}>
        {field.state === "untracked"
          ? "written before this session's lanes were tracked"
          : "nothing claimed it"}
      </span>
    );
  }
  return (
    <div className={styles.history}>
      {field.claims.map((claim) => (
        <div
          key={`${claim.lane}-${claim.claimed_at}`}
          className={styles.historyLine}
        >
          <span className={styles.badge}>{claim.lane}</span>
          <span>said {claim.value_text ?? "null"}</span>
          <span>· {clock(claim.claimed_at)}</span>
        </div>
      ))}
    </div>
  );
}

function Lanes({ lanes }: { lanes: InspectorLane[] }): ReactElement {
  return (
    <section>
      <h2 className={styles.sectionTitle}>Which lanes saw this session</h2>
      <p className={styles.note}>
        Three ingest lanes write the same session row and they do not agree.
        Every figure below names the lane that wrote it; a lane that never
        reported on this session cannot be the reason a number is missing.
      </p>
      <div className={styles.lanes}>
        {lanes.map((lane) => (
          <div
            key={lane.lane}
            className={
              lane.observed ? styles.lane : `${styles.lane} ${styles.laneQuiet}`
            }
          >
            <div className={styles.laneHead}>
              <span className={styles.badge}>{lane.lane}</span>
              {lane.label}
            </div>
            <div className={styles.laneEvidence}>{lane.evidence}</div>
            <div className={styles.laneWon}>
              {lane.fields_won === 0
                ? "owns no field here"
                : `owns ${lane.fields_won} field${lane.fields_won === 1 ? "" : "s"}`}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Fields({ report }: { report: SessionInspectorReport }): ReactElement {
  const money = report.fields.filter((f) => f.group === "money");
  const other = report.fields.filter((f) => f.group === "other");
  return (
    <>
      <section>
        <h2 className={styles.sectionTitle}>Money and tokens</h2>
        <p className={styles.note}>
          Precedence for these is OTLP over transcript over hooks: the hook lane
          prices every model at Sonnet rates, so its cost is an estimate that
          vendor telemetry supersedes outright. The claim history is what
          changed, and when.
        </p>
        <div className={`${styles.card} ${styles.tableWrap}`}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Field</th>
                <th>Value in use</th>
                <th>Owner</th>
                <th>What each lane said</th>
              </tr>
            </thead>
            <tbody>
              {money.map((field) => (
                <tr key={field.field}>
                  <td>{FIELD_LABELS[field.field] ?? field.field}</td>
                  <td>{fieldValue(field)}</td>
                  <td>
                    <Owner field={field} />
                  </td>
                  <td>
                    <History field={field} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {other.length > 0 ? (
        <section>
          <h2 className={styles.sectionTitle}>Everything else with a value</h2>
          <div className={`${styles.card} ${styles.tableWrap}`}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Value in use</th>
                  <th>Owner</th>
                  <th>What each lane said</th>
                </tr>
              </thead>
              <tbody>
                {other.map((field) => (
                  <tr key={field.field}>
                    <td className={styles.mono}>{field.field}</td>
                    <td>{fieldValue(field)}</td>
                    <td>
                      <Owner field={field} />
                    </td>
                    <td>
                      <History field={field} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
}

function Spans({ report }: { report: SessionInspectorReport }): ReactElement {
  const { spans, session } = report;
  return (
    <section>
      <h2 className={styles.sectionTitle}>Where the work happened</h2>
      {spans.length === 0 ? (
        <div className={styles.empty}>
          No directory change was ever observed, so this session is one stretch
          of work attributed wholly to{" "}
          <span className={styles.mono}>
            {session.project_name ?? session.cwd ?? "no project"}
          </span>
          .
        </div>
      ) : (
        <>
          <p className={styles.note}>
            One row per repo this session worked in, in the order it entered
            them. A span still open ends where the session did.
          </p>
          <div className={`${styles.card} ${styles.tableWrap}`}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Project</th>
                  <th>Directory</th>
                  <th>Entered</th>
                  <th>Left</th>
                  <th className={styles.num}>Attributed</th>
                </tr>
              </thead>
              <tbody>
                {spans.map((span) => (
                  <tr key={span.seq}>
                    <td className={styles.num}>{span.seq}</td>
                    <td>
                      {span.project_name ?? (
                        <span className={styles.unknown}>unattributed</span>
                      )}
                    </td>
                    <td className={styles.mono}>{span.cwd}</td>
                    <td className={styles.mono}>{clock(span.started_at)}</td>
                    <td className={styles.mono}>
                      {span.open ? (
                        <span className={styles.unknown}>
                          still there at {clock(span.last_seen_at)}
                        </span>
                      ) : (
                        clock(span.ended_at)
                      )}
                    </td>
                    <td className={styles.num}>{duration(span.seconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function Operations({ report }: { report: SessionInspectorReport }): ReactElement {
  const laneB = report.lanes.find((lane) => lane.lane === "B");
  return (
    <section>
      <h2 className={styles.sectionTitle}>Tool and hook timing</h2>
      {report.operations.length === 0 ? (
        <div className={styles.empty}>
          Nothing here, and nothing is broken: these durations come from Claude
          Code&rsquo;s own traces exporter, which is opt-in. {laneB?.evidence}.
          Turn telemetry on and future sessions will carry it; this one cannot
          be reconstructed.
        </div>
      ) : (
        <>
          <p className={styles.note}>
            One row per operation, not per call — the exporter aggregates, so
            these are counts and totals, never a timeline.
          </p>
          <div className={`${styles.card} ${styles.tableWrap}`}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Operation</th>
                  <th>Kind</th>
                  <th className={styles.num}>Runs</th>
                  <th className={styles.num}>Failed</th>
                  <th className={styles.num}>Avg</th>
                  <th className={styles.num}>Max</th>
                  <th className={styles.num}>Total</th>
                </tr>
              </thead>
              <tbody>
                {report.operations.map((op) => (
                  <tr key={`${op.span_name}::${op.operation}`}>
                    <td className={styles.mono}>
                      {op.operation || op.span_name.replace(/^claude_code\./, "")}
                    </td>
                    <td>{op.category}</td>
                    <td className={styles.num}>{op.count}</td>
                    <td
                      className={`${styles.num} ${op.error_count > 0 ? styles.failing : ""}`}
                    >
                      {op.error_count}
                    </td>
                    <td className={styles.num}>{ms(op.avg_duration_ms)}</td>
                    <td className={styles.num}>{ms(op.max_duration_ms)}</td>
                    <td className={styles.num}>{ms(op.total_duration_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function Attention({ report }: { report: SessionInspectorReport }): ReactElement {
  return (
    <section>
      <h2 className={styles.sectionTitle}>Attention</h2>
      {report.attention.length === 0 ? (
        <div className={styles.empty}>
          This session has never queued anything for you.
        </div>
      ) : (
        <div className={`${styles.card} ${styles.tableWrap}`}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Item</th>
                <th>Severity</th>
                <th>State</th>
                <th>First seen</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {report.attention.map((item) => (
                <tr key={item.id}>
                  <td>
                    {item.title}
                    {item.detail ? (
                      <div className={styles.history}>{item.detail}</div>
                    ) : null}
                  </td>
                  <td>{item.severity}</td>
                  <td>
                    {item.state === "open"
                      ? "open"
                      : `${item.state}${item.resolution ? ` · ${item.resolution}` : ""}`}
                  </td>
                  <td className={styles.mono}>{clock(item.first_seen_at)}</td>
                  <td className={styles.mono}>{clock(item.last_seen_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Events({ report }: { report: SessionInspectorReport }): ReactElement {
  if (report.events.length === 0) {
    return (
      <section>
        <h2 className={styles.sectionTitle}>Events</h2>
        <div className={styles.empty}>
          No hook events are stored for this session. They may have been pruned
          by retention, or the hooks were never installed while it ran.
        </div>
      </section>
    );
  }
  return (
    <section>
      <h2 className={styles.sectionTitle}>Events</h2>
      <div className={styles.pills}>
        {report.event_counts.map((row) => (
          <span key={row.event_type} className={styles.pill}>
            {row.event_type} · {row.count}
          </span>
        ))}
      </div>
      <p className={styles.note}>
        {report.events_truncated
          ? `Most recent ${report.events.length} events, newest first.`
          : "Every stored event, newest first."}
      </p>
      <div className={`${styles.card} ${styles.tableWrap}`}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>When</th>
              <th>Event</th>
              <th>Tool</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>
            {report.events.map((event) => (
              <tr key={event.id}>
                <td className={styles.mono}>{clock(event.created_at)}</td>
                <td>{event.event_type}</td>
                <td className={styles.mono}>{event.tool_name ?? "—"}</td>
                <td>{event.summary ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function SessionInspectorPage(): ReactElement {
  const { sessionId = "" } = useParams<{ sessionId: string }>();
  const query = useSessionInspector(sessionId);
  const report = query.data;

  return (
    <Shell>
      <div className={styles.page}>
        <DetailHeader
          crumbs="Command Center · Session"
          title={
            (report?.session.title as string | undefined) ??
            `Session ${sessionId.slice(0, 8)}`
          }
          subtitle={sessionId}
          fallbackRoute="/command"
        />

        {query.isPending ? (
          <div className={styles.empty}>Reading…</div>
        ) : query.isError || !report ? (
          <div className={styles.empty}>
            Could not read this session: {query.error?.message ?? "not found"}
          </div>
        ) : (
          <>
            <div className={`${styles.card} ${styles.facts}`}>
              <span className={styles.fact}>
                Profile <strong>{report.session.profile}</strong>
              </span>
              <span className={styles.fact}>
                Status <strong>{report.session.status}</strong>
              </span>
              <span className={styles.fact}>
                Project{" "}
                <strong>{report.session.project_name ?? "unattributed"}</strong>
              </span>
              <span className={styles.fact}>
                Started <strong>{clock(report.session.started_at)}</strong>
              </span>
              <span className={styles.fact}>
                Ended <strong>{clock(report.session.ended_at)}</strong>
              </span>
              <span className={styles.fact}>
                Tool calls <strong>{report.session.total_tool_calls}</strong>
              </span>
            </div>

            <Lanes lanes={report.lanes} />
            <Fields report={report} />
            <Spans report={report} />
            <Operations report={report} />
            <Attention report={report} />
            <Events report={report} />
          </>
        )}
      </div>
    </Shell>
  );
}

export default SessionInspectorPage;
