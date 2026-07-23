import { useMemo, useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import {
  useConfiguredAgents,
  useAgentRuns,
  type ConfiguredAgentInfo,
  type ConfiguredSkillInfo,
} from "../lib/api";
import { Shell } from "../components/layout/shell";
import styles from "./team.module.css";

function toTitleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ── Icons (inline, monochrome — inherit currentColor) ──────────────── */

function ChevronIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M4 6l4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronRightIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M6 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function WorkspaceIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect
        x="2"
        y="3"
        width="12"
        height="10"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path d="M2 6h12" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function ProjectIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2 5.5l5.2-2.8 5.2 2.8v5L7.2 13.3 2 10.5v-5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M2 5.5l5.2 2.8 5.2-2.8M7.2 8.3v5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AgentGlyph(): ReactElement {
  // A small "chip / processor" mark — reads as an autonomous agent.
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect
        x="4.5"
        y="4.5"
        width="7"
        height="7"
        rx="1.4"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2M4.5 5.5h-2M4.5 10.5h-2M11.5 5.5h2M11.5 10.5h2"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SkillGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8.5 2L4 9h3.2L7 14l4.5-7H8.3L8.5 2z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="0.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ── Rows ────────────────────────────────────────────────────────────── */

function AgentRow({
  agent,
  isRunning,
}: {
  agent: ConfiguredAgentInfo;
  isRunning: boolean;
}): ReactElement {
  const navigate = useNavigate();
  const displayName = agent.display_name ?? toTitleCase(agent.name);
  const isOrg = agent.kind === "org";

  const open = (): void => {
    void navigate(`/team/${encodeURIComponent(agent.name)}`);
  };

  return (
    <div
      className={`${styles.row} ${styles.rowClickable}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`Open ${displayName}`}
    >
      <span
        className={`${styles.glyph} ${
          isOrg ? styles.glyphOrg : styles.glyphProject
        }`}
      >
        <AgentGlyph />
      </span>
      <span className={styles.name}>{displayName}</span>
      {isRunning && (
        <span className={styles.runningDot} title="Running" aria-label="Running" />
      )}
      {agent.description ? (
        <span className={styles.desc}>{agent.description}</span>
      ) : (
        <span className={styles.descEmpty} />
      )}
      <span className={styles.meta}>
        {agent.model && <span className={styles.modelChip}>{agent.model}</span>}
        <span className={styles.kind}>{isOrg ? "org" : "project"}</span>
        {agent.is_shared === true && <span className={styles.shared}>shared</span>}
        {agent.verify_status && agent.verify_status !== "ok" && (
          <span className={styles.status}>{agent.verify_status}</span>
        )}
        <span className={styles.chevronRight}>
          <ChevronRightIcon />
        </span>
      </span>
    </div>
  );
}

function SkillRow({ skill }: { skill: ConfiguredSkillInfo }): ReactElement {
  const displayName = toTitleCase(skill.name.replace(/-/g, " "));
  return (
    <div className={styles.row}>
      <span className={`${styles.glyph} ${styles.glyphSkill}`}>
        <SkillGlyph />
      </span>
      <span className={styles.name}>{displayName}</span>
      <span className={styles.descEmpty} />
      <span className={styles.meta}>
        <span className={styles.kind}>skill</span>
        {skill.is_shared === true && <span className={styles.shared}>shared</span>}
        {skill.verify_status && skill.verify_status !== "ok" && (
          <span className={styles.status}>{skill.verify_status}</span>
        )}
      </span>
    </div>
  );
}

/* ── Group (collapsible) ─────────────────────────────────────────────── */

function AgentGroup({
  label,
  isWorkspace,
  agents,
  skills,
  runningNames,
}: {
  label: string;
  isWorkspace?: boolean;
  agents: ConfiguredAgentInfo[];
  skills: ConfiguredSkillInfo[];
  runningNames: Set<string>;
}): ReactElement {
  const [open, setOpen] = useState(true);
  const hasAgents = agents.length > 0;
  const hasSkills = skills.length > 0;
  if (!hasAgents && !hasSkills) return <></>;

  return (
    <div className={styles.group}>
      <button
        type="button"
        className={styles.groupHead}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={`${styles.chevron} ${open ? styles.open : ""}`}>
          <ChevronIcon />
        </span>
        <span className={styles.groupIcon}>
          {isWorkspace ? <WorkspaceIcon /> : <ProjectIcon />}
        </span>
        <span
          className={`${styles.groupName} ${
            isWorkspace ? styles.workspace : ""
          }`}
        >
          {label}
        </span>
        <span className={styles.count}>{agents.length + skills.length}</span>
        <span className={styles.groupLine} />
      </button>
      {open && (
        <div className={styles.list}>
          {hasAgents && (
            <>
              <div className={styles.subHead}>Agents</div>
              {agents.map((a) => (
                <AgentRow
                  key={`${a.kind}-${a.id}`}
                  agent={a}
                  isRunning={runningNames.has(a.name)}
                />
              ))}
            </>
          )}
          {hasSkills && (
            <>
              <div className={styles.subHead}>Skills</div>
              {skills.map((s) => (
                <SkillRow key={s.id} skill={s} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Filtering ───────────────────────────────────────────────────────── */

function matchesAgent(a: ConfiguredAgentInfo, q: string): boolean {
  const hay = `${a.display_name ?? a.name} ${a.description ?? ""} ${
    a.model ?? ""
  }`.toLowerCase();
  return hay.includes(q);
}

function matchesSkill(s: ConfiguredSkillInfo, q: string): boolean {
  return s.name.toLowerCase().includes(q);
}

function AgentListSection(): ReactElement {
  const { data, isLoading, isError } = useConfiguredAgents();
  const { data: runs = [] } = useAgentRuns(undefined, "running");
  const [filter, setFilter] = useState("");

  const runningNames = useMemo(
    () =>
      new Set(
        runs.filter((r) => r.profile != null).map((r) => r.profile as string),
      ),
    [runs],
  );

  const q = filter.trim().toLowerCase();

  const { shared, sharedSkills, byProject, agentCount, skillCount } =
    useMemo(() => {
      const allShared = data?.shared ?? [];
      const allSharedSkills = data?.shared_skills ?? [];
      const allByProject = data?.by_project ?? [];

      const shared = q ? allShared.filter((a) => matchesAgent(a, q)) : allShared;
      const sharedSkills = q
        ? allSharedSkills.filter((s) => matchesSkill(s, q))
        : allSharedSkills;
      const byProject = allByProject
        .map((g) => ({
          ...g,
          agents: q ? g.agents.filter((a) => matchesAgent(a, q)) : g.agents,
          skills: q ? g.skills.filter((s) => matchesSkill(s, q)) : g.skills,
        }))
        .filter((g) => g.agents.length > 0 || g.skills.length > 0);

      // Totals (unfiltered) — describe the whole workspace, deduped by name.
      const agentNames = new Set<string>();
      allByProject.forEach((g) => g.agents.forEach((a) => agentNames.add(a.name)));
      allShared.forEach((a) => agentNames.add(a.name));
      const skillNames = new Set<string>();
      allByProject.forEach((g) => g.skills.forEach((s) => skillNames.add(s.name)));
      allSharedSkills.forEach((s) => skillNames.add(s.name));

      return {
        shared,
        sharedSkills,
        byProject,
        agentCount: agentNames.size,
        skillCount: skillNames.size,
      };
    }, [data, q]);

  if (isLoading) {
    return <div className={styles.state}>Loading agents…</div>;
  }
  if (isError) {
    return <div className={styles.state}>Failed to load agents.</div>;
  }

  const totalRaw =
    (data?.shared.length ?? 0) +
    (data?.shared_skills.length ?? 0) +
    (data?.by_project ?? []).reduce(
      (s, g) => s + g.agents.length + g.skills.length,
      0,
    );

  if (totalRaw === 0) {
    return (
      <div className={styles.empty}>
        No agents yet — import a project or finish onboarding.
      </div>
    );
  }

  const hasResults =
    shared.length > 0 || sharedSkills.length > 0 || byProject.length > 0;

  return (
    <>
      <div className={styles.toolbar}>
        <input
          className={styles.search}
          type="text"
          placeholder="Filter agents & skills…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter agents and skills"
        />
        <span className={styles.summary}>
          <span>
            <b>{agentCount}</b> agents
          </span>
          <span>
            <b>{skillCount}</b> skills
          </span>
          {runningNames.size > 0 && (
            <span>
              <b>{runningNames.size}</b> running
            </span>
          )}
        </span>
      </div>

      {!hasResults ? (
        <div className={styles.empty}>No agents or skills match “{filter}”.</div>
      ) : (
        <>
          {(shared.length > 0 || sharedSkills.length > 0) && (
            <AgentGroup
              label="Shared · workspace"
              isWorkspace
              agents={shared}
              skills={sharedSkills}
              runningNames={runningNames}
            />
          )}
          {byProject.map((group) => (
            <AgentGroup
              key={group.project_id}
              label={group.project_name}
              agents={group.agents}
              skills={group.skills}
              runningNames={runningNames}
            />
          ))}
        </>
      )}
    </>
  );
}

export function TeamPage(): ReactElement {
  return (
    <Shell>
      <div className={styles.page}>
        <AgentListSection />
      </div>
    </Shell>
  );
}
