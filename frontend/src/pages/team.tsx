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
import { DeckShell } from "../components/deck/deck-shell";
import {
  DeckGrid,
  DeckGroup,
  DeckHead,
  DeckLine,
  type DeckState,
} from "../components/deck/deck-grid";

function toTitleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ── Icons (inline, monochrome — inherit currentColor) ──────────────── */









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

  const state: DeckState = broken ? "fail" : isRunning ? "run" : "idle";

  return (
    <DeckLine
      state={state}
      onOpen={isAgent ? open : undefined}
      cells={[
        { v: <code title={item.link_path ?? item.canonical_path}>{item.invoke_token}</code> },
        { v: item.alias, cls: "sub" },
        item.description ?? "",
        item.model ?? "",
        {
          v: (
            <>
              {originLabel(item)}
              {item.materialized === true && (
                <>
                  {" "}
                  <span
                    className="dk-tag"
                    title="Generated copy — its name was rewritten to clear a collision, so edits here do not reach the project"
                  >
                    copy
                  </span>
                </>
              )}
              {broken && (
                <>
                  {" "}
                  <span className="dk-tag" data-s="fail">
                    {item.verify_status}
                  </span>
                </>
              )}
            </>
          ),
          cls: "r",
        },
      ]}
    />
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
  const broken = Boolean(agent.verify_status && agent.verify_status !== "ok");

  const open = (): void => {
    void navigate(`/team/${encodeURIComponent(agent.name)}`);
  };

  return (
    <DeckLine
      state={broken ? "fail" : isRunning ? "run" : "idle"}
      onOpen={open}
      cells={[
        { v: displayName, cls: "sub" },
        agent.description ?? "",
        agent.model ?? "",
        {
          v: (
            <>
              {isOrg ? "org" : "project"}
              {/* `enabled` only means "asked to be shared". An agent whose name
                  is already taken by one that cannot be aliased is enabled and
                  still not in `.claude/`, so a shared badge would be a lie. */}
              {isConflicted ? (
                <>
                  {" "}
                  <span
                    className="dk-tag"
                    data-s="wait"
                    title="Not linked into the workspace — another agent already answers to this name"
                  >
                    not linked
                  </span>
                </>
              ) : (
                agent.is_shared === true && (
                  <>
                    {" "}
                    <span className="dk-tag" data-s="done">
                      shared
                    </span>
                  </>
                )
              )}
              {broken && (
                <>
                  {" "}
                  <span className="dk-tag" data-s="fail">
                    {agent.verify_status}
                  </span>
                </>
              )}
            </>
          ),
          cls: "r",
        },
      ]}
    />
  );
}

function SkillRow({ skill }: { skill: ConfiguredSkillInfo }): ReactElement {
  const displayName = toTitleCase(skill.name.replace(/-/g, " "));
  const broken = Boolean(skill.verify_status && skill.verify_status !== "ok");
  return (
    <DeckLine
      state={broken ? "fail" : "idle"}
      cells={[
        { v: displayName, cls: "sub" },
        "",
        "",
        {
          v: (
            <>
              skill
              {skill.is_shared === true && (
                <>
                  {" "}
                  <span className="dk-tag" data-s="done">
                    shared
                  </span>
                </>
              )}
              {broken && (
                <>
                  {" "}
                  <span className="dk-tag" data-s="fail">
                    {skill.verify_status}
                  </span>
                </>
              )}
            </>
          ),
          cls: "r",
        },
      ]}
    />
  );
}

const COLS_INVOCABLE = "14px 190px 170px minmax(0, 1fr) 110px 200px";
const COLS_AGENT = "14px 190px minmax(0, 1fr) 110px 200px";

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
  return (
    <DeckGroup
      label={isWorkspace ? `${label}` : label}
      count={count}
      collapsible
      state={isWorkspace ? "run" : "idle"}
    >
      {children}
    </DeckGroup>
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
          <DeckGrid key={bucket} cols={COLS_INVOCABLE} label={heading}>
            <DeckHead cells={["token", heading.toLowerCase(), "what it does", "model", "r origin"]} />
            {items.map((item) => (
              <InvocableRow
                key={`${bucket}-${item.invoke_token}`}
                item={item}
                bucket={bucket}
                isRunning={runningNames.has(item.name)}
              />
            ))}
          </DeckGrid>
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
        <DeckGrid cols={COLS_AGENT} label={`${label} agents`}>
          <DeckHead cells={["agent", "what it does", "model", "r kind"]} />
          {agents.map((a) => (
            <AgentRow
              key={`${a.kind}-${a.id}`}
              agent={a}
              isRunning={runningNames.has(a.name)}
              isConflicted={a.kind === "project" && conflictedAgentIds.has(a.id)}
            />
          ))}
        </DeckGrid>
      )}
      {hasSkills && (
        <DeckGrid cols={COLS_AGENT} label={`${label} skills`}>
          <DeckHead cells={["skill", "what it does", "model", "r kind"]} />
          {skills.map((s) => (
            <SkillRow key={s.id} skill={s} />
          ))}
        </DeckGrid>
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
    <div className="dk-note sans" role="status" style={{ borderLeft: "2px solid var(--warn)" }}>
      <div style={{ color: "var(--fg-2)" }}>
        {n === 1
          ? "1 agent is not linked into the workspace"
          : `${n} agents are not linked into the workspace`}
      </div>
      <ul style={{ margin: "var(--u2) 0", paddingLeft: "var(--u4)" }}>
        {conflicts.map((c) => (
          <li key={`${c.kind}-${c.row_id}`}>
            <code>{c.name}</code> from <b>{c.project}</b> — {conflictReason(c)} already answers to
            that name, and the file declares no <code>name:</code> to rewrite.
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="dk-btn"
        onClick={() => regen.mutate()}
        disabled={regen.isPending}
      >
        {regen.isPending ? "regenerating…" : "regenerate links"}
      </button>
    </div>
  );
}

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
    return <div className="dk-note">Loading agents…</div>;
  }
  if (catalogQ.isError) {
    return <div className="dk-note">Failed to load agents.</div>;
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
      <div className="dk-note sans">No agents yet — import a project or finish onboarding.</div>
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

      <div className="dk-bigs" style={{ alignItems: "flex-end" }}>
        <div className="dk-field" style={{ width: 280 }}>
          <input
            type="text"
            placeholder="filter agents, skills & commands…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter agents and skills"
          />
        </div>
        <span style={{ display: "flex", gap: "var(--u4)", color: "var(--fg-3)" }}>
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
        <div className="dk-note sans">No agents, skills or commands match “{filter}”.</div>
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
    <DeckShell title="agents" crumb="what each project can invoke, and where it resolves from">
      <AgentListSection />
    </DeckShell>
  );
}
