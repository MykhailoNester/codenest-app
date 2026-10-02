/**
 * The session inspector (#271), folded off `pages/session-inspector.tsx` onto
 * the Sessions surface's session detail.
 *
 * It is the same report and the same copy — which lane wrote each figure, what
 * the other lanes had claimed, where the work happened, what each tool cost,
 * what this session queued for you, and every stored hook event. The page it
 * came from had its own stylesheet and its own route; here it is one tab on a
 * session, built from Deck lines.
 *
 * The honesty rules the page carried over come with it: an unmeasured field
 * says "not observed", never zero, and a lane that never reported explains
 * itself rather than leaving an empty table.
 */

import { type ReactElement } from "react";
import {
  useSessionInspector,
  type InspectorField,
  type InspectorLane,
  type SessionInspectorReport,
} from "../../lib/api";
import { DeckGrid, DeckGroup, DeckHead, DeckLine } from "../deck/deck-grid";

const FIELD_LABELS: Record<string, string> = {
  cost_usd: "Cost (USD)",
  tokens_in: "Tokens in",
  tokens_out: "Tokens out",
  context_tokens: "Context tokens",
  model: "Model",
};

const COLS_FIELD = "14px 130px 120px 90px minmax(0, 1fr)";
const COLS_LANE = "14px 40px 150px minmax(0, 1fr) 120px";
const COLS_SPAN = "14px 34px 130px minmax(0, 1fr) 150px 150px 80px";
const COLS_OP = "14px minmax(0, 1fr) 90px 52px 56px 70px 70px 76px";
const COLS_ATTN = "14px minmax(0, 1fr) 80px 150px 150px 150px";
const COLS_EVENT = "14px 150px 130px 110px minmax(0, 1fr)";

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
    return <span className="dim">not observed</span>;
  }
  const value = field.value;
  const text =
    field.field === "cost_usd" && typeof value === "number"
      ? `$${value.toFixed(4)}`
      : typeof value === "number"
        ? value.toLocaleString()
        : String(value ?? "");
  return <span>{text}</span>;
}

function Owner({ field }: { field: InspectorField }): ReactElement {
  if (field.winning_lane) {
    return (
      <span className="dk-tag" data-s="done" title={`Lane ${field.winning_lane}`}>
        {field.winning_lane}
      </span>
    );
  }
  if (field.state === "untracked") {
    return <span className="dim">no lane recorded</span>;
  }
  return <span className="dim">—</span>;
}

function History({ field }: { field: InspectorField }): ReactElement {
  if (field.claims.length === 0) {
    return (
      <span className="dim">
        {field.state === "untracked"
          ? "written before this session's lanes were tracked"
          : "nothing claimed it"}
      </span>
    );
  }
  return (
    <span>
      {field.claims.map((claim) => (
        <span
          key={`${claim.lane}-${claim.claimed_at}`}
          style={{ display: "block" }}
        >
          <span className="dk-tag">{claim.lane}</span>{" "}
          <span>said {claim.value_text ?? "null"}</span>{" "}
          <span className="dim">· {clock(claim.claimed_at)}</span>
        </span>
      ))}
    </span>
  );
}

function Lanes({ lanes }: { lanes: InspectorLane[] }): ReactElement {
  return (
    <DeckGroup label="which lanes saw this session" count={lanes.length}>
      <div className="dk-note sans">
        Three ingest lanes write the same session row and they do not agree.
        Every figure below names the lane that wrote it; a lane that never
        reported on this session cannot be the reason a number is missing.
      </div>
      <DeckGrid cols={COLS_LANE} label="Ingest lanes" className="prose">
        <DeckHead cells={["lane", "what it is", "evidence", "r owns"]} />
        {lanes.map((lane) => (
          <DeckLine
            key={lane.lane}
            state={lane.observed ? "done" : "idle"}
            cells={[
              { v: <span className="dk-tag">{lane.lane}</span> },
              { v: lane.label, cls: "sub" },
              lane.evidence,
              {
                v:
                  lane.fields_won === 0
                    ? "owns no field here"
                    : `owns ${lane.fields_won} field${lane.fields_won === 1 ? "" : "s"}`,
                cls: "r",
              },
            ]}
          />
        ))}
      </DeckGrid>
    </DeckGroup>
  );
}

function FieldGrid({
  label,
  fields,
  mono,
}: {
  label: string;
  fields: InspectorField[];
  mono?: boolean;
}): ReactElement {
  return (
    <DeckGrid cols={COLS_FIELD} label={label} className="prose">
      <DeckHead cells={["field", "value in use", "owner", "what each lane said"]} />
      {fields.map((field) => (
        <DeckLine
          key={field.field}
          state={field.state === "unobserved" ? "idle" : "done"}
          cells={[
            {
              v: mono ? field.field : (FIELD_LABELS[field.field] ?? field.field),
              cls: "sub",
            },
            { v: fieldValue(field) },
            { v: <Owner field={field} /> },
            { v: <History field={field} /> },
          ]}
        />
      ))}
    </DeckGrid>
  );
}

function Fields({ report }: { report: SessionInspectorReport }): ReactElement {
  const money = report.fields.filter((f) => f.group === "money");
  const other = report.fields.filter((f) => f.group === "other");
  return (
    <>
      <DeckGroup label="money and tokens" count={money.length}>
        <div className="dk-note sans">
          Precedence for these is OTLP over transcript over hooks: the hook lane
          prices every model at Sonnet rates, so its cost is an estimate that
          vendor telemetry supersedes outright. The claim history is what
          changed, and when.
        </div>
        <FieldGrid label="Money and tokens" fields={money} />
      </DeckGroup>

      {other.length > 0 && (
        <DeckGroup label="everything else with a value" count={other.length}>
          <FieldGrid label="Everything else with a value" fields={other} mono />
        </DeckGroup>
      )}
    </>
  );
}

function Spans({ report }: { report: SessionInspectorReport }): ReactElement {
  const { spans, session } = report;
  return (
    <DeckGroup label="where the work happened" count={spans.length}>
      {spans.length === 0 ? (
        <div className="dk-note sans">
          No directory change was ever observed, so this session is one stretch
          of work attributed wholly to{" "}
          {session.project_name ?? session.cwd ?? "no project"}.
        </div>
      ) : (
        <>
          <div className="dk-note sans">
            One row per repo this session worked in, in the order it entered
            them. A span still open ends where the session did.
          </div>
          <DeckGrid cols={COLS_SPAN} label="Directory spans">
            <DeckHead
              cells={[
                "#",
                "project",
                "directory",
                "entered",
                "left",
                "r attributed",
              ]}
            />
            {spans.map((span) => (
              <DeckLine
                key={span.seq}
                state={span.open ? "run" : "done"}
                cells={[
                  { v: String(span.seq), cls: "id" },
                  {
                    v: span.project_name ?? (
                      <span className="dim">unattributed</span>
                    ),
                    cls: "sub",
                  },
                  { v: span.cwd, title: span.cwd },
                  clock(span.started_at),
                  {
                    v: span.open ? (
                      <span className="dim">
                        still there at {clock(span.last_seen_at)}
                      </span>
                    ) : (
                      clock(span.ended_at)
                    ),
                  },
                  { v: duration(span.seconds), cls: "r" },
                ]}
              />
            ))}
          </DeckGrid>
        </>
      )}
    </DeckGroup>
  );
}

function Operations({ report }: { report: SessionInspectorReport }): ReactElement {
  const laneB = report.lanes.find((lane) => lane.lane === "B");
  return (
    <DeckGroup label="tool and hook timing" count={report.operations.length}>
      {report.operations.length === 0 ? (
        <div className="dk-note sans">
          Nothing here, and nothing is broken: these durations come from Claude
          Code&rsquo;s own traces exporter, which is opt-in. {laneB?.evidence}.
          Turn telemetry on and future sessions will carry it; this one cannot
          be reconstructed.
        </div>
      ) : (
        <>
          <div className="dk-note sans">
            One row per operation, not per call — the exporter aggregates, so
            these are counts and totals, never a timeline.
          </div>
          <DeckGrid cols={COLS_OP} label="Tool and hook timing">
            <DeckHead
              cells={[
                "operation",
                "kind",
                "r runs",
                "r failed",
                "r avg",
                "r max",
                "r total",
              ]}
            />
            {report.operations.map((op) => (
              <DeckLine
                key={`${op.span_name}::${op.operation}`}
                state={op.error_count > 0 ? "fail" : "done"}
                cells={[
                  {
                    v: op.operation || op.span_name.replace(/^claude_code\./, ""),
                    cls: "sub",
                  },
                  op.category,
                  { v: String(op.count), cls: "r" },
                  { v: String(op.error_count), cls: "r" },
                  { v: ms(op.avg_duration_ms), cls: "r" },
                  { v: ms(op.max_duration_ms), cls: "r" },
                  { v: ms(op.total_duration_ms), cls: "r" },
                ]}
              />
            ))}
          </DeckGrid>
        </>
      )}
    </DeckGroup>
  );
}

function Attention({ report }: { report: SessionInspectorReport }): ReactElement {
  return (
    <DeckGroup label="attention" count={report.attention.length}>
      {report.attention.length === 0 ? (
        <div className="dk-note sans">
          This session has never queued anything for you.
        </div>
      ) : (
        <DeckGrid cols={COLS_ATTN} label="Attention raised by this session">
          <DeckHead
            cells={["item", "severity", "state", "first seen", "last seen"]}
          />
          {report.attention.map((item) => (
            <DeckLine
              key={item.id}
              state={item.state === "open" ? "block" : "done"}
              cells={[
                {
                  v: (
                    <>
                      {item.title}
                      {item.detail ? (
                        <span className="dim"> · {item.detail}</span>
                      ) : null}
                    </>
                  ),
                  cls: "sub",
                  title: item.title,
                },
                item.severity,
                item.state === "open"
                  ? "open"
                  : `${item.state}${item.resolution ? ` · ${item.resolution}` : ""}`,
                clock(item.first_seen_at),
                clock(item.last_seen_at),
              ]}
            />
          ))}
        </DeckGrid>
      )}
    </DeckGroup>
  );
}

function Events({ report }: { report: SessionInspectorReport }): ReactElement {
  if (report.events.length === 0) {
    return (
      <DeckGroup label="events" count={0}>
        <div className="dk-note sans">
          No hook events are stored for this session. They may have been pruned
          by retention, or the hooks were never installed while it ran.
        </div>
      </DeckGroup>
    );
  }
  return (
    <DeckGroup
      label="events"
      count={report.events.length}
      note={
        report.events_truncated
          ? `most recent ${report.events.length}, newest first`
          : "every stored event, newest first"
      }
    >
      <div className="dk-note">
        {report.event_counts.map((row) => (
          <span key={row.event_type} className="dk-tag">
            {row.event_type} · {row.count}
          </span>
        ))}
      </div>
      <DeckGrid cols={COLS_EVENT} label="Stored hook events">
        <DeckHead cells={["when", "event", "tool", "summary"]} />
        {report.events.map((event) => (
          <DeckLine
            key={event.id}
            state="done"
            cells={[
              clock(event.created_at),
              { v: event.event_type, cls: "sub" },
              event.tool_name ?? "—",
              { v: event.summary ?? "", title: event.summary ?? undefined },
            ]}
          />
        ))}
      </DeckGrid>
    </DeckGroup>
  );
}

export function SessionInspect({
  sessionId,
}: {
  sessionId: string;
}): ReactElement {
  const query = useSessionInspector(sessionId);
  const report = query.data;

  if (query.isPending) return <div className="dk-note">Reading&hellip;</div>;
  if (query.isError || !report) {
    return (
      <div className="dk-note sans">
        Could not read this session: {query.error?.message ?? "not found"}
      </div>
    );
  }

  return (
    <>
      <div className="dk-kv">
        <span>profile</span>
        <span>{report.session.profile}</span>
      </div>
      <div className="dk-kv">
        <span>status</span>
        <span>{report.session.status}</span>
      </div>
      <div className="dk-kv">
        <span>project</span>
        <span>{report.session.project_name ?? "unattributed"}</span>
      </div>
      <div className="dk-kv">
        <span>started</span>
        <span>{clock(report.session.started_at)}</span>
      </div>
      <div className="dk-kv">
        <span>ended</span>
        <span>{clock(report.session.ended_at)}</span>
      </div>
      <div className="dk-kv">
        <span>tool calls</span>
        <span>{report.session.total_tool_calls}</span>
      </div>

      <Lanes lanes={report.lanes} />
      <Fields report={report} />
      <Spans report={report} />
      <Operations report={report} />
      <Attention report={report} />
      <Events report={report} />
    </>
  );
}
