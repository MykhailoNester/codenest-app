import { type ReactElement } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  useProjectContext,
  type ProjectContextLink,
  type ProjectContextRan,
  type ProjectContextReport,
} from "../lib/api";
import { Shell } from "../components/layout/shell";
import { DetailHeader } from "../components/layout/detail-header";
import styles from "./project-context.module.css";

function clock(stamp: string | null | undefined): string {
  if (!stamp) return "—";
  return stamp.replace("T", " ").slice(0, 19);
}

function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function Roots({ report }: { report: ProjectContextReport }): ReactElement {
  return (
    <section>
      <h2 className={styles.sectionTitle}>Roots this repo sits under</h2>
      {report.roots.length === 0 ? (
        <div className={styles.empty}>
          No root parents this repo. It was imported on its own, so nothing
          rescans the directory above it and a sibling repo appearing next to it
          will not be noticed.
        </div>
      ) : (
        <div className={`${styles.card} ${styles.tableWrap}`}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Root</th>
                <th>Label</th>
                <th>Added by</th>
                <th>Scanning</th>
              </tr>
            </thead>
            <tbody>
              {report.roots.map((root) => (
                <tr key={root.id}>
                  <td className={styles.mono}>{root.path}</td>
                  <td>{root.label ?? <span className={styles.unknown}>—</span>}</td>
                  <td>{root.source}</td>
                  <td>
                    {root.enabled ? (
                      "enabled"
                    ) : (
                      <span className={styles.unknown}>
                        disabled — this repo is not rediscovered
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Cost({ report }: { report: ProjectContextReport }): ReactElement {
  const { cost } = report;
  const laneB = cost.lane_b_whole_session_usd;
  return (
    <section>
      <h2 className={styles.sectionTitle}>What this repo has cost</h2>
      <p className={styles.note}>
        Both figures below are real, and neither is a per-project vendor price —
        there is no such number anywhere. Vendor telemetry counts a session, not
        a repo, so the only per-repo split that exists is the hook lane&rsquo;s
        flat-rate estimate. The Budgets page shows the same gap for the whole
        install.
      </p>
      <div className={styles.costRow}>
        <div className={styles.costCard}>
          <div className={styles.costLabel}>
            Attributed to this repo — Lane {cost.lane} estimate
          </div>
          <div className={styles.costValue}>{usd(cost.estimate_usd)}</div>
          <div className={styles.costCaveat}>
            Hook-lane flat rate, split across the repos each turn touched, over{" "}
            {cost.estimated_sessions} session
            {cost.estimated_sessions === 1 ? "" : "s"}. An estimate, not a
            billed amount. {cost.estimate_tokens_in.toLocaleString()} in ·{" "}
            {cost.estimate_tokens_out.toLocaleString()} out.
          </div>
        </div>
        <div
          className={
            laneB === null
              ? `${styles.costCard} ${styles.costQuiet}`
              : styles.costCard
          }
        >
          <div className={styles.costLabel}>
            Vendor figure — whole sessions, not this repo
          </div>
          <div className={styles.costValue}>
            {laneB === null ? (
              <span className={styles.unknown}>not observed</span>
            ) : (
              usd(laneB)
            )}
          </div>
          <div className={styles.costCaveat}>
            {laneB === null
              ? "No telemetry was exported for any session that touched this repo. That is silence, not zero — telemetry is opt-in."
              : `Lane B priced ${cost.lane_b_sessions} of these sessions end to end. Those sessions also worked in other repos, so this total cannot be read as this repo's cost — it is an upper bound on the part of it Lane B ever saw.`}
          </div>
        </div>
      </div>
    </section>
  );
}

function Sessions({ report }: { report: ProjectContextReport }): ReactElement {
  const navigate = useNavigate();
  const spanned = report.sessions.filter((s) => s.attributed_by === "span");
  return (
    <section>
      <h2 className={styles.sectionTitle}>Sessions that worked here</h2>
      {report.sessions.length === 0 ? (
        <div className={styles.empty}>
          No session has been observed in this repo. It may have been imported
          and never opened, or its sessions ran before hooks were installed.
        </div>
      ) : (
        <>
          <p className={styles.note}>
            {spanned.length} of these were placed here by a directory span — the
            session was measured entering and leaving this repo, so a session
            that also worked in five other repos appears here only for its
            stretch in this one. The rest never changed directory, so their own
            session row is the whole record.
            {report.sessions_truncated
              ? " Showing the most recent 200."
              : ""}
          </p>
          <div className={`${styles.card} ${styles.tableWrap}`}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Placed here by</th>
                  <th>Profile</th>
                  <th>First here</th>
                  <th>Last here</th>
                  <th className={styles.num}>Time here</th>
                  <th className={styles.num}>Estimate</th>
                </tr>
              </thead>
              <tbody>
                {report.sessions.map((session) => (
                  <tr key={session.session_id}>
                    <td>
                      <button
                        type="button"
                        className={`${styles.link} ${styles.mono}`}
                        onClick={() =>
                          void navigate(`/sessions/${session.session_id}`)
                        }
                      >
                        {session.session_id.slice(0, 8)}
                      </button>
                      <div className={styles.sub}>{session.status}</div>
                    </td>
                    <td>
                      {session.attributed_by === "span" ? (
                        <>
                          <span className={styles.badge}>span</span>
                          <div className={styles.sub}>
                            {session.spans} span
                            {session.spans === 1 ? "" : "s"}
                            {session.session_project_name &&
                            session.session_project_name !==
                              report.project.name
                              ? ` · session opened in ${session.session_project_name}`
                              : ""}
                          </div>
                        </>
                      ) : (
                        <>
                          <span className={styles.badge}>session</span>
                          <div className={styles.sub}>
                            never changed directory
                          </div>
                        </>
                      )}
                    </td>
                    <td>{session.profile}</td>
                    <td className={styles.mono}>
                      {clock(session.first_here_at)}
                    </td>
                    <td className={styles.mono}>
                      {session.open_span ? (
                        <span className={styles.unknown}>
                          still here at {clock(session.last_here_at)}
                        </span>
                      ) : (
                        clock(session.last_here_at)
                      )}
                    </td>
                    <td className={styles.num}>
                      {session.attributed_by === "span" ? (
                        duration(session.seconds_here)
                      ) : (
                        <span className={styles.unknown}>not measured</span>
                      )}
                    </td>
                    <td className={styles.num}>
                      {session.estimated_cost_usd === null ? (
                        <span className={styles.unknown}>not observed</span>
                      ) : (
                        usd(session.estimated_cost_usd)
                      )}
                    </td>
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

function RanList({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: ProjectContextRan[];
  empty: string;
}): ReactElement {
  return (
    <div className={styles.column}>
      <div className={styles.columnHead}>{title}</div>
      {rows.length === 0 ? (
        <div className={styles.sub}>{empty}</div>
      ) : (
        <table className={styles.table}>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name}>
                <td className={styles.mono}>{row.name}</td>
                <td className={styles.num}>{row.runs}</td>
                <td className={styles.mono}>{clock(row.last_run_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Ran({ report }: { report: ProjectContextReport }): ReactElement {
  return (
    <section>
      <h2 className={styles.sectionTitle}>What actually ran here</h2>
      <p className={styles.note}>
        A subagent or skill invocation carries no directory of its own, so each
        one is placed by the span it fell inside. An invocation from a session
        that never moved counts wholly here.
      </p>
      <div className={styles.columns}>
        <RanList
          title="Agents"
          rows={report.agents_ran}
          empty="No subagent invocation has been observed in this repo."
        />
        <RanList
          title="Skills"
          rows={report.skills_ran}
          empty="No skill invocation has been observed in this repo."
        />
      </div>
    </section>
  );
}

function LinkPills({ rows }: { rows: ProjectContextLink[] }): ReactElement {
  if (rows.length === 0) {
    return <div className={styles.sub}>Nothing linked into this repo.</div>;
  }
  return (
    <div className={styles.pills}>
      {rows.map((row) => (
        <span
          key={row.name}
          className={`${styles.pill} ${row.enabled ? "" : styles.pillOff} ${
            row.verify_status === "ok" ? "" : styles.pillBad
          }`}
          title={`${row.link_path} · ${row.verify_status}`}
        >
          {row.name}
          {row.verify_status === "ok" ? "" : ` · ${row.verify_status}`}
        </span>
      ))}
    </div>
  );
}

function Configured({ report }: { report: ProjectContextReport }): ReactElement {
  const { configured } = report;
  return (
    <section>
      <h2 className={styles.sectionTitle}>What is configured for this repo</h2>
      <p className={styles.note}>
        What a session opened here would find, whether or not anything has used
        it. A dashed pill is disabled; a red one failed its last link check.
      </p>
      <div className={styles.columns}>
        <div className={styles.column}>
          <div className={styles.columnHead}>Agents</div>
          <LinkPills rows={configured.agents} />
        </div>
        <div className={styles.column}>
          <div className={styles.columnHead}>Skills</div>
          <LinkPills rows={configured.skills} />
        </div>
        <div className={styles.column}>
          <div className={styles.columnHead}>Commands</div>
          <LinkPills rows={configured.commands} />
        </div>
        <div className={styles.column}>
          <div className={styles.columnHead}>MCP servers</div>
          {configured.mcp_servers.length === 0 ? (
            <div className={styles.sub}>
              No server is scoped to this repo. Servers with no scope at all
              apply everywhere and are not listed here.
            </div>
          ) : (
            <div className={styles.pills}>
              {configured.mcp_servers.map((server) => (
                <span
                  key={server.slug}
                  className={`${styles.pill} ${server.enabled ? "" : styles.pillOff}`}
                >
                  {server.name}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className={styles.column}>
          <div className={styles.columnHead}>Launch presets</div>
          {configured.launch_presets.length === 0 ? (
            <div className={styles.sub}>No preset opens this repo.</div>
          ) : (
            <div className={styles.pills}>
              {configured.launch_presets.map((preset) => (
                <span key={preset.id} className={styles.pill}>
                  {preset.name} · {preset.target}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Attention({ report }: { report: ProjectContextReport }): ReactElement {
  return (
    <section>
      <h2 className={styles.sectionTitle}>Attention</h2>
      {report.attention.length === 0 ? (
        <div className={styles.empty}>
          This repo has never queued anything for you.
        </div>
      ) : (
        <div className={`${styles.card} ${styles.tableWrap}`}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Item</th>
                <th>Severity</th>
                <th>State</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {report.attention.map((item) => (
                <tr key={item.id}>
                  <td>
                    {item.title}
                    {item.detail ? (
                      <div className={styles.sub}>{item.detail}</div>
                    ) : null}
                  </td>
                  <td>{item.severity}</td>
                  <td>
                    {item.state === "open"
                      ? "open"
                      : `${item.state}${item.resolution ? ` · ${item.resolution}` : ""}`}
                  </td>
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

export function ProjectContextPage(): ReactElement {
  const { projectId = "" } = useParams<{ projectId: string }>();
  const parsed = Number(projectId);
  const query = useProjectContext(Number.isFinite(parsed) ? parsed : null);
  const report = query.data;
  const project = report?.project;

  return (
    <Shell>
      <div className={styles.page}>
        <DetailHeader
          crumbs="Workspace · Projects · Context"
          title={(project?.name as string | undefined) ?? "Project"}
          subtitle={
            (project?.root_path as string | undefined) ??
            (project?.path as string | undefined) ??
            undefined
          }
          fallbackRoute="/projects"
        />

        {query.isPending ? (
          <div className={styles.empty}>Reading…</div>
        ) : query.isError || !report ? (
          <div className={styles.empty}>
            Could not read this project: {query.error?.message ?? "not found"}
          </div>
        ) : (
          <>
            <div className={`${styles.card} ${styles.facts}`}>
              <span className={styles.fact}>
                Status <strong>{String(report.project.status ?? "—")}</strong>
              </span>
              <span className={styles.fact}>
                Sessions here <strong>{report.sessions.length}</strong>
              </span>
              <span className={styles.fact}>
                Roots <strong>{report.roots.length}</strong>
              </span>
              <span className={styles.fact}>
                Provider{" "}
                <strong>
                  {(report.project.provider_name as string | null) ?? "default"}
                </strong>
              </span>
              <span className={styles.fact}>
                Profile{" "}
                <strong>
                  {(report.project.profile_name as string | null) ?? "none"}
                </strong>
              </span>
              <span className={styles.fact}>
                Open attention{" "}
                <strong>
                  {report.attention.filter((a) => a.state === "open").length}
                </strong>
              </span>
            </div>

            <Cost report={report} />
            <Sessions report={report} />
            <Ran report={report} />
            <Configured report={report} />
            <Roots report={report} />
            <Attention report={report} />
          </>
        )}
      </div>
    </Shell>
  );
}

export default ProjectContextPage;
