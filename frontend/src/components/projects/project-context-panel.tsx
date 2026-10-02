/**
 * The project context map (#273), folded off `pages/project-context.tsx` onto
 * the Projects surface as a project's detail.
 *
 * Same report, same copy, same refusals: the per-repo cost names the lane that
 * estimated it and says it is not a billed amount, an unexported vendor figure
 * reads "not observed" rather than zero, and a session placed here by a
 * directory span is kept visibly distinct from one whose own row is the whole
 * record. The page it came from had a route and a stylesheet; this has neither.
 */

import { type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import {
  useProjectContext,
  type ProjectContextLink,
  type ProjectContextRan,
  type ProjectContextReport,
} from "../../lib/api";
import { sessionRoute } from "../../lib/search-results";
import { DeckGrid, DeckGroup, DeckHead, DeckLine } from "../deck/deck-grid";

const COLS_ROOT = "14px minmax(0, 1fr) 130px 100px 260px";
const COLS_SESSION = "14px 110px 160px 90px 150px 180px 80px 80px";
const COLS_RAN = "14px minmax(0, 1fr) 52px 150px";
const COLS_ATTN = "14px minmax(0, 1fr) 80px 150px 150px";

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

function Cost({ report }: { report: ProjectContextReport }): ReactElement {
  const { cost } = report;
  const laneB = cost.lane_b_whole_session_usd;
  return (
    <DeckGroup label="what this repo has cost">
      <div className="dk-note sans">
        Both figures below are real, and neither is a per-project vendor price —
        there is no such number anywhere. Vendor telemetry counts a session, not
        a repo, so the only per-repo split that exists is the hook lane&rsquo;s
        flat-rate estimate. The Budgets page shows the same gap for the whole
        install.
      </div>
      <div className="dk-bigs">
        <div className="dk-big">
          <div className="v">{usd(cost.estimate_usd)}</div>
          <div className="l">
            Attributed to this repo — Lane {cost.lane} estimate
          </div>
        </div>
        <div className="dk-big">
          <div className={laneB === null ? "v na" : "v"}>
            {laneB === null ? "not observed" : usd(laneB)}
          </div>
          <div className="l">Vendor figure — whole sessions, not this repo</div>
        </div>
      </div>
      <div className="dk-note sans">
        <p>
          Hook-lane flat rate, split across the repos each turn touched, over{" "}
          {cost.estimated_sessions} session
          {cost.estimated_sessions === 1 ? "" : "s"}. An estimate, not a billed
          amount. {cost.estimate_tokens_in.toLocaleString()} in ·{" "}
          {cost.estimate_tokens_out.toLocaleString()} out.
        </p>
        <p>
          {laneB === null
            ? "No telemetry was exported for any session that touched this repo. That is silence, not zero — telemetry is opt-in."
            : `Lane B priced ${cost.lane_b_sessions} of these sessions end to end. Those sessions also worked in other repos, so this total cannot be read as this repo's cost — it is an upper bound on the part of it Lane B ever saw.`}
        </p>
      </div>
    </DeckGroup>
  );
}

function Sessions({ report }: { report: ProjectContextReport }): ReactElement {
  const navigate = useNavigate();
  const spanned = report.sessions.filter((s) => s.attributed_by === "span");
  return (
    <DeckGroup label="sessions that worked here" count={report.sessions.length}>
      {report.sessions.length === 0 ? (
        <div className="dk-note sans">
          No session has been observed in this repo. It may have been imported
          and never opened, or its sessions ran before hooks were installed.
        </div>
      ) : (
        <>
          <div className="dk-note sans">
            {spanned.length} of these were placed here by a directory span — the
            session was measured entering and leaving this repo, so a session
            that also worked in five other repos appears here only for its
            stretch in this one. The rest never changed directory, so their own
            session row is the whole record.
            {report.sessions_truncated ? " Showing the most recent 200." : ""}
          </div>
          <DeckGrid
            cols={COLS_SESSION}
            label="Sessions that worked here"
            className="prose"
          >
            <DeckHead
              cells={[
                "id",
                "placed here by",
                "profile",
                "first here",
                "last here",
                "r time here",
                "r estimate",
              ]}
            />
            {report.sessions.map((s) => (
              <DeckLine
                key={s.session_id}
                state={s.open_span ? "run" : "done"}
                onOpen={() => void navigate(sessionRoute(s.session_id))}
                cells={[
                  {
                    v: (
                      <>
                        {s.session_id.slice(0, 8)}
                        <span className="dim"> · {s.status}</span>
                      </>
                    ),
                    cls: "id",
                    title: s.session_id,
                  },
                  {
                    v: (
                      <>
                        <span className="dk-tag">
                          {s.attributed_by === "span" ? "span" : "session"}
                        </span>{" "}
                        <span className="dim">
                          {s.attributed_by === "span"
                            ? `${s.spans} span${s.spans === 1 ? "" : "s"}${
                                s.session_project_name &&
                                s.session_project_name !== report.project.name
                                  ? ` · session opened in ${s.session_project_name}`
                                  : ""
                              }`
                            : "never changed directory"}
                        </span>
                      </>
                    ),
                  },
                  s.profile,
                  clock(s.first_here_at),
                  {
                    v: s.open_span ? (
                      <span className="dim">
                        still here at {clock(s.last_here_at)}
                      </span>
                    ) : (
                      clock(s.last_here_at)
                    ),
                  },
                  {
                    v:
                      s.attributed_by === "span" ? (
                        duration(s.seconds_here)
                      ) : (
                        <span className="dim">not measured</span>
                      ),
                    cls: "r",
                  },
                  {
                    v:
                      s.estimated_cost_usd === null ? (
                        <span className="dim">not observed</span>
                      ) : (
                        usd(s.estimated_cost_usd)
                      ),
                    cls: "r",
                  },
                ]}
              />
            ))}
          </DeckGrid>
        </>
      )}
    </DeckGroup>
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
  if (rows.length === 0) {
    return (
      <div className="dk-note sans">
        {title}: {empty}
      </div>
    );
  }
  return (
    <DeckGrid cols={COLS_RAN} label={title}>
      <DeckHead cells={[title.toLowerCase(), "r runs", "r last run"]} />
      {rows.map((row) => (
        <DeckLine
          key={row.name}
          state="done"
          cells={[
            { v: row.name, cls: "sub" },
            { v: String(row.runs), cls: "r" },
            { v: clock(row.last_run_at), cls: "r" },
          ]}
        />
      ))}
    </DeckGrid>
  );
}

function Ran({ report }: { report: ProjectContextReport }): ReactElement {
  return (
    <DeckGroup label="what actually ran here">
      <div className="dk-note sans">
        A subagent or skill invocation carries no directory of its own, so each
        one is placed by the span it fell inside. An invocation from a session
        that never moved counts wholly here.
      </div>
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
    </DeckGroup>
  );
}

function LinkPills({ rows }: { rows: ProjectContextLink[] }): ReactElement {
  if (rows.length === 0) {
    return <span className="dim">Nothing linked into this repo.</span>;
  }
  return (
    <span>
      {rows.map((row) => (
        <span
          key={row.name}
          className="dk-tag"
          data-s={
            !row.enabled ? "idle" : row.verify_status === "ok" ? "done" : "fail"
          }
          title={`${row.link_path} · ${row.verify_status}`}
        >
          {row.name}
          {row.verify_status === "ok" ? "" : ` · ${row.verify_status}`}
        </span>
      ))}
    </span>
  );
}

function Configured({ report }: { report: ProjectContextReport }): ReactElement {
  const { configured } = report;
  return (
    <DeckGroup label="what is configured for this repo">
      <div className="dk-note sans">
        What a session opened here would find, whether or not anything has used
        it. A dimmed pill is disabled; a red one failed its last link check.
      </div>
      <div className="dk-kv">
        <span>agents</span>
        <LinkPills rows={configured.agents} />
      </div>
      <div className="dk-kv">
        <span>skills</span>
        <LinkPills rows={configured.skills} />
      </div>
      <div className="dk-kv">
        <span>commands</span>
        <LinkPills rows={configured.commands} />
      </div>
      <div className="dk-kv">
        <span>mcp servers</span>
        {configured.mcp_servers.length === 0 ? (
          <span className="dim">
            No server is scoped to this repo. Servers with no scope at all apply
            everywhere and are not listed here.
          </span>
        ) : (
          <span>
            {configured.mcp_servers.map((server) => (
              <span
                key={server.slug}
                className="dk-tag"
                data-s={server.enabled ? "done" : "idle"}
              >
                {server.name}
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="dk-kv">
        <span>launch presets</span>
        {configured.launch_presets.length === 0 ? (
          <span className="dim">No preset opens this repo.</span>
        ) : (
          <span>
            {configured.launch_presets.map((preset) => (
              <span key={preset.id} className="dk-tag">
                {preset.name} · {preset.target}
              </span>
            ))}
          </span>
        )}
      </div>
    </DeckGroup>
  );
}

function Roots({ report }: { report: ProjectContextReport }): ReactElement {
  return (
    <DeckGroup label="roots this repo sits under" count={report.roots.length}>
      {report.roots.length === 0 ? (
        <div className="dk-note sans">
          No root parents this repo. It was imported on its own, so nothing
          rescans the directory above it and a sibling repo appearing next to it
          will not be noticed.
        </div>
      ) : (
        <DeckGrid cols={COLS_ROOT} label="Roots" className="prose">
          <DeckHead cells={["root", "label", "added by", "scanning"]} />
          {report.roots.map((root) => (
            <DeckLine
              key={root.id}
              state={root.enabled ? "done" : "idle"}
              cells={[
                { v: root.path, cls: "sub", title: root.path },
                { v: root.label ?? <span className="dim">—</span> },
                root.source,
                {
                  v: root.enabled ? (
                    "enabled"
                  ) : (
                    <span className="dim">
                      disabled — this repo is not rediscovered
                    </span>
                  ),
                },
              ]}
            />
          ))}
        </DeckGrid>
      )}
    </DeckGroup>
  );
}

function Attention({ report }: { report: ProjectContextReport }): ReactElement {
  return (
    <DeckGroup label="attention" count={report.attention.length}>
      {report.attention.length === 0 ? (
        <div className="dk-note sans">
          This repo has never queued anything for you.
        </div>
      ) : (
        <DeckGrid cols={COLS_ATTN} label="Attention raised by this repo">
          <DeckHead cells={["item", "severity", "state", "r last seen"]} />
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
                { v: clock(item.last_seen_at), cls: "r" },
              ]}
            />
          ))}
        </DeckGrid>
      )}
    </DeckGroup>
  );
}

export function ProjectContextPanel({
  projectId,
}: {
  projectId: number;
}): ReactElement {
  const query = useProjectContext(Number.isFinite(projectId) ? projectId : null);
  const report = query.data;

  if (query.isPending) return <div className="dk-note">Reading&hellip;</div>;
  if (query.isError || !report) {
    return (
      <div className="dk-note sans">
        Could not read this project: {query.error?.message ?? "not found"}
      </div>
    );
  }

  return (
    <>
      <div className="dk-kv">
        <span>status</span>
        <span>{String(report.project.status ?? "—")}</span>
      </div>
      <div className="dk-kv">
        <span>sessions here</span>
        <span>{report.sessions.length}</span>
      </div>
      <div className="dk-kv">
        <span>roots</span>
        <span>{report.roots.length}</span>
      </div>
      <div className="dk-kv">
        <span>provider</span>
        <span>
          {(report.project.provider_name as string | null) ?? "default"}
        </span>
      </div>
      <div className="dk-kv">
        <span>profile</span>
        <span>{(report.project.profile_name as string | null) ?? "none"}</span>
      </div>
      <div className="dk-kv">
        <span>open attention</span>
        <span>{report.attention.filter((a) => a.state === "open").length}</span>
      </div>

      <Cost report={report} />
      <Sessions report={report} />
      <Ran report={report} />
      <Configured report={report} />
      <Roots report={report} />
      <Attention report={report} />
    </>
  );
}
