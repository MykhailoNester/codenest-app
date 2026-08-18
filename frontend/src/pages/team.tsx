/**
 * Agents page — what this workspace can actually invoke.
 *
 * The workspace group is fed by the invocables catalog (#44), not by the
 * configured-agents aggregate: the catalog is built from the same collector the
 * linker uses, so a row here is by construction a file `.claude/` really links,
 * under the name the CLI really resolves. The aggregate lists a project agent
 * under its declared frontmatter name, which is why three projects shipping a
 * `code-reviewer` used to read as three shared agents when the workspace links
 * one entry per project under a per-project alias (#45).
 *
 * The per-project groups keep coming from the aggregate — they are a project's
 * own assets, shared or not, and the workspace catalog by definition cannot
 * describe an unshared one.
 */

import { useMemo, useState, type ReactElement, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  useConfiguredAgents,
  useInvocables,
  useWorkspaceHealth,
  useRegenerateWorkspace,
  useAgentRuns,
  type ConfiguredAgentInfo,
  type ConfiguredSkillInfo,
  type InvocableItem,
  type ShadowedInvocable,
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

function CommandGlyph(): ReactElement {
  // A shell caret — reads as a slash command.
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M4 5l3 3-3 3M8.5 11.5H12"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AlertGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 2.8l5.6 9.7H2.4L8 2.8z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M8 6.4v3.1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="8" cy="11" r="0.75" fill="currentColor" />
    </svg>
  );
}

/* ── Workspace rows (the catalog — one row per invocable) ───────────── */

type Bucket = "agents" | "skills" | "commands";

/** Where the entry came from, in one word: a project name, or who owns it. */
function originLabel(item: InvocableItem): string {
  if (item.kind === "builtin") return "built-in";
  return item.project_name ?? "org";
}

function InvocableRow({
  item,
  bucket,
  isRunning,
}: {
  item: InvocableItem;
  bucket: Bucket;
  isRunning: boolean;
}): ReactElement {
  const navigate = useNavigate();
  const isAgent = bucket === "agents";
  // A linked file whose target has moved: the row is in `.claude/`, but nothing
  // is behind it, so invoking it fails. Say so rather than listing it as fine.
  const broken = item.verify_status !== "ok";

  // The invocation history is keyed by the name the CLI reports, which is the
  // resolved (possibly aliased) one — not the name the project's file declares.
  const open = (): void => {
    void navigate(`/team/${encodeURIComponent(item.name)}`);
  };

  const glyphClass =
    bucket === "skills"
      ? styles.glyphSkill
      : bucket === "commands"
        ? styles.glyphCommand
        : item.kind === "org"
          ? styles.glyphOrg
          : styles.glyphProject;

  const clickable = isAgent
    ? {
        onClick: open,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
          }
        },
        tabIndex: 0,
        role: "button",
        "aria-label": `Open ${item.alias}`,
      }
    : {};

  return (
    <div
      className={`${styles.row} ${isAgent ? styles.rowClickable : ""}`}
      {...clickable}
    >
      <span className={`${styles.glyph} ${glyphClass}`}>
        {bucket === "agents" ? (
          <AgentGlyph />
        ) : bucket === "skills" ? (
          <SkillGlyph />
        ) : (
          <CommandGlyph />
        )}
      </span>
      <span className={styles.name}>{item.alias}</span>
      {isRunning && (
        <span className={styles.runningDot} title="Running" aria-label="Running" />
      )}
      {/* What `.claude/` actually links this under — the literal text that
          resolves it. The whole point of the page telling the truth. */}
      <code className={styles.token} title={item.link_path ?? item.canonical_path}>
        {item.invoke_token}
      </code>
      {item.description ? (
        <span className={styles.desc}>{item.description}</span>
      ) : (
        <span className={styles.descEmpty} />
      )}
      <span className={styles.meta}>
        {item.model != null && item.model !== "" && (
          <span className={styles.modelChip}>{item.model}</span>
        )}
        <span className={styles.origin}>{originLabel(item)}</span>
        {item.materialized === true && (
          <span
            className={styles.copy}
            title="Generated copy — its name was rewritten to clear a collision, so edits here do not reach the project"
          >
            copy
          </span>
        )}
        {broken && <span className={styles.status}>{item.verify_status}</span>}
        {isAgent && (
          <span className={styles.chevronRight}>
            <ChevronRightIcon />
          </span>
        )}
      </span>
    </div>
  );
}

/* ── Project rows (a project's own assets, shared or not) ───────────── */

function AgentRow({
  agent,
  isRunning,
  isConflicted,
}: {
  agent: ConfiguredAgentInfo;
  isRunning: boolean;
  isConflicted: boolean;
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
        {/* `enabled` only means "asked to be shared". An agent whose name is
            already taken by one that cannot be aliased is enabled and still not
            in `.claude/`, so the shared badge would be a lie. */}
        {isConflicted ? (
          <span
            className={styles.status}
            title="Not linked into the workspace — another agent already answers to this name"
          >
            not linked
          </span>
        ) : (
          agent.is_shared === true && (
            <span className={styles.shared}>shared</span>
          )
        )}
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

function Group({
  label,
  isWorkspace,
  count,
  children,
}: {
  label: string;
  isWorkspace?: boolean;
  count: number;
  children: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(true);

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
        <span className={styles.count}>{count}</span>
        <span className={styles.groupLine} />
      </button>
      {open && <div className={styles.list}>{children}</div>}
    </div>
  );
}

function WorkspaceGroup({
  agents,
  skills,
  commands,
  runningNames,
}: {
  agents: InvocableItem[];
  skills: InvocableItem[];
  commands: InvocableItem[];
  runningNames: Set<string>;
}): ReactElement {
  const total = agents.length + skills.length + commands.length;
  if (total === 0) return <></>;

  const sections: Array<[string, Bucket, InvocableItem[]]> = [
    ["Agents", "agents", agents],
    ["Skills", "skills", skills],
    ["Commands", "commands", commands],
  ];

  return (
    <Group label="Shared · workspace" isWorkspace count={total}>
      {sections.map(([heading, bucket, items]) =>
        items.length === 0 ? null : (
          <div key={bucket}>
            <div className={styles.subHead}>{heading}</div>
            {items.map((item) => (
              <InvocableRow
                key={`${bucket}-${item.invoke_token}`}
                item={item}
                bucket={bucket}
                isRunning={runningNames.has(item.name)}
              />
            ))}
          </div>
        ),
      )}
    </Group>
  );
}

function ProjectGroup({
  label,
  agents,
  skills,
  runningNames,
  conflictedAgentIds,
}: {
  label: string;
  agents: ConfiguredAgentInfo[];
  skills: ConfiguredSkillInfo[];
  runningNames: Set<string>;
  conflictedAgentIds: Set<number>;
}): ReactElement {
  const hasAgents = agents.length > 0;
  const hasSkills = skills.length > 0;
  if (!hasAgents && !hasSkills) return <></>;

  return (
    <Group label={label} count={agents.length + skills.length}>
      {hasAgents && (
        <>
          <div className={styles.subHead}>Agents</div>
          {agents.map((a) => (
            <AgentRow
              key={`${a.kind}-${a.id}`}
              agent={a}
              isRunning={runningNames.has(a.name)}
              isConflicted={a.kind === "project" && conflictedAgentIds.has(a.id)}
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
    </Group>
  );
}

/* ── Conflicts ───────────────────────────────────────────────────────── */

function conflictReason(c: ShadowedInvocable): string {
  return c.shadowed_by_kind === "org_agent"
    ? `the shared org agent “${c.shadowed_by}”`
    : `${c.shadowed_by}’s agent`;
}

function ConflictNotice({
  conflicts,
}: {
  conflicts: ShadowedInvocable[];
}): ReactElement {
  const regen = useRegenerateWorkspace();
  const n = conflicts.length;

  return (
    <div className={styles.notice} role="status">
      <span className={styles.noticeIcon}>
        <AlertGlyph />
      </span>
      <div className={styles.noticeBody}>
        <div className={styles.noticeTitle}>
          {n === 1
            ? "1 agent is not linked into the workspace"
            : `${n} agents are not linked into the workspace`}
        </div>
        <ul className={styles.noticeList}>
          {conflicts.map((c) => (
            <li key={`${c.kind}-${c.row_id}`}>
              <code>{c.name}</code> from <b>{c.project}</b> — {conflictReason(c)}{" "}
              already answers to that name, and the file declares no{" "}
              <code>name:</code> to rewrite.
            </li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        className={styles.noticeBtn}
        onClick={() => regen.mutate()}
        disabled={regen.isPending}
      >
        {regen.isPending ? "Regenerating…" : "Regenerate links"}
      </button>
    </div>
  );
}

/* ── Filtering ───────────────────────────────────────────────────────── */

function matchesInvocable(i: InvocableItem, q: string): boolean {
  const hay = `${i.alias} ${i.name} ${i.invoke_token} ${i.description ?? ""} ${
    i.model ?? ""
  } ${i.project_name ?? ""}`.toLowerCase();
  return hay.includes(q);
}

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
  const catalogQ = useInvocables();
  const configuredQ = useConfiguredAgents();
  const healthQ = useWorkspaceHealth();
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

  const conflicts = healthQ.data?.agent_name_conflicts ?? [];
  const conflictedAgentIds = useMemo(
    () => new Set(conflicts.map((c) => c.row_id)),
    [conflicts],
  );

  const { agents, skills, commands, byProject, totals } = useMemo(() => {
    const allAgents = catalogQ.data?.agents ?? [];
    const allSkills = catalogQ.data?.skills ?? [];
    const allCommands = catalogQ.data?.commands ?? [];
    const allByProject = configuredQ.data?.by_project ?? [];

    const pick = (items: InvocableItem[]): InvocableItem[] =>
      q ? items.filter((i) => matchesInvocable(i, q)) : items;

    const byProject = allByProject
      .map((g) => ({
        ...g,
        agents: q ? g.agents.filter((a) => matchesAgent(a, q)) : g.agents,
        skills: q ? g.skills.filter((s) => matchesSkill(s, q)) : g.skills,
      }))
      .filter((g) => g.agents.length > 0 || g.skills.length > 0);

    return {
      agents: pick(allAgents),
      skills: pick(allSkills),
      commands: pick(allCommands),
      byProject,
      // Unfiltered, and deliberately counted off the catalog: these describe
      // what a workspace session can invoke, not what has been imported.
      totals: {
        agents: allAgents.length,
        skills: allSkills.length,
        commands: allCommands.length,
      },
    };
  }, [catalogQ.data, configuredQ.data, q]);

  if (catalogQ.isLoading || configuredQ.isLoading) {
    return <div className={styles.state}>Loading agents…</div>;
  }
  if (catalogQ.isError) {
    return <div className={styles.state}>Failed to load agents.</div>;
  }

  const totalRaw =
    totals.agents +
    totals.skills +
    totals.commands +
    (configuredQ.data?.by_project ?? []).reduce(
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
    agents.length > 0 ||
    skills.length > 0 ||
    commands.length > 0 ||
    byProject.length > 0;

  return (
    <>
      {conflicts.length > 0 && <ConflictNotice conflicts={conflicts} />}

      <div className={styles.toolbar}>
        <input
          className={styles.search}
          type="text"
          placeholder="Filter agents, skills & commands…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter agents and skills"
        />
        <span className={styles.summary}>
          <span>
            <b>{totals.agents}</b> agents
          </span>
          <span>
            <b>{totals.skills}</b> skills
          </span>
          <span>
            <b>{totals.commands}</b> commands
          </span>
          {runningNames.size > 0 && (
            <span>
              <b>{runningNames.size}</b> running
            </span>
          )}
        </span>
      </div>

      {!hasResults ? (
        <div className={styles.empty}>
          No agents, skills or commands match “{filter}”.
        </div>
      ) : (
        <>
          <WorkspaceGroup
            agents={agents}
            skills={skills}
            commands={commands}
            runningNames={runningNames}
          />
          {byProject.map((group) => (
            <ProjectGroup
              key={group.project_id}
              label={group.project_name}
              agents={group.agents}
              skills={group.skills}
              runningNames={runningNames}
              conflictedAgentIds={conflictedAgentIds}
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
