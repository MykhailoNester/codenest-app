/**
 * Workspace settings — the symlink farm the Command Center runs out of: where
 * it lives on disk, which links do not resolve, which org agents are installed
 * and what each imported project contributes.
 *
 * One grid holds the projects and their agents. A project row expands in place
 * rather than opening a nested list, so the roving tabindex still walks the
 * whole thing top to bottom.
 */

import {
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  useWorkspaceProjects,
  useWorkspaceProjectAgents,
  useWorkspaceHealth,
  useRescanWorkspaceProject,
  useDeleteWorkspaceProject,
  useRegenerateWorkspace,
  useOrgAgents,
  type WorkspaceProject,
  type WorkspaceAgent,
  type OrgAgent,
} from "../../lib/api";
import {
  getWorkspacePath,
  getOrgAgentsPath,
  getAppDataPath,
} from "../../lib/ipc";
import { DeckShell } from "../../components/deck/deck-shell";
import {
  DeckGrid,
  DeckGroup,
  DeckHead,
  DeckLine,
} from "../../components/deck/deck-grid";
import { DeckMenu } from "../../components/deck/deck-menu";

const COLS_PATH = "14px 110px minmax(0, 1fr)";
const COLS_ISSUE = "14px 110px minmax(0, 1fr) 110px minmax(0, 1fr)";
const COLS_ORG = "14px 190px minmax(0, 1fr) 110px 90px";
const COLS_PROJECT = "14px minmax(0, 1fr) 118px minmax(0, 1fr) auto";

export function WorkspaceSettingsPage(): ReactElement {
  const [paths, setPaths] = useState<{
    workspace: string;
    orgAgents: string;
    appData: string;
  } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [workspace, orgAgents, appData] = await Promise.all([
          getWorkspacePath(),
          getOrgAgentsPath(),
          getAppDataPath(),
        ]);
        setPaths({ workspace, orgAgents, appData });
      } catch (err) {
        console.warn("paths unavailable", err);
      }
    })();
  }, []);

  const projectsQ = useWorkspaceProjects();
  const healthQ = useWorkspaceHealth();
  const orgAgentsQ = useOrgAgents();
  const regen = useRegenerateWorkspace();

  const issues = healthQ.data?.issues ?? [];
  const projects = projectsQ.data ?? [];
  const orgAgents = orgAgentsQ.data ?? [];

  return (
    <DeckShell
      title="workspace"
      crumb="where the command center resolves agents from"
      actions={
        <button
          type="button"
          className="dk-btn pri"
          onClick={() => regen.mutate()}
          disabled={regen.isPending}
        >
          {regen.isPending ? "regenerating…" : "regenerate symlinks"}
        </button>
      }
    >
      <DeckGroup label="paths" note="on this machine">
        {paths ? (
          <DeckGrid cols={COLS_PATH} label="Workspace paths">
            <DeckHead cells={["what", "where"]} />
            <DeckLine
              state="done"
              cells={[
                { v: "app data", cls: "sub" },
                { v: paths.appData, title: paths.appData },
              ]}
            />
            <DeckLine
              state="done"
              cells={[
                { v: "workspace", cls: "sub" },
                { v: paths.workspace, title: paths.workspace },
              ]}
            />
            <DeckLine
              state="done"
              cells={[
                { v: "org agents", cls: "sub" },
                { v: paths.orgAgents, title: paths.orgAgents },
              ]}
            />
          </DeckGrid>
        ) : (
          <div className="dk-note">Loading paths&hellip;</div>
        )}
      </DeckGroup>

      <DeckGroup
        label="health"
        count={healthQ.data?.issue_count}
        note="links that do not resolve"
        state={issues.length > 0 ? "fail" : undefined}
      >
        {healthQ.isLoading ? (
          <div className="dk-note">Checking workspace health&hellip;</div>
        ) : issues.length === 0 ? (
          <div className="dk-note sans">All workspace links resolve.</div>
        ) : (
          <DeckGrid cols={COLS_ISSUE} label="Workspace health issues">
            <DeckHead cells={["kind", "name", "status", "detail"]} />
            {issues.map((iss, i) => (
              <DeckLine
                key={`${iss.kind}-${iss.name}-${i}`}
                state="fail"
                cells={[
                  iss.kind,
                  { v: iss.name, cls: "sub", title: iss.name },
                  {
                    v: (
                      <span className="dk-tag" data-s="fail">
                        {iss.verify_status}
                      </span>
                    ),
                  },
                  iss.detail ?? "",
                ]}
              />
            ))}
          </DeckGrid>
        )}
      </DeckGroup>

      <DeckGroup
        label="org agents"
        count={orgAgents.length}
        note="installed for every project"
      >
        {orgAgentsQ.isLoading ? (
          <div className="dk-note">Loading org agents&hellip;</div>
        ) : orgAgents.length === 0 ? (
          <div className="dk-note sans">No org-level agents installed.</div>
        ) : (
          <DeckGrid cols={COLS_ORG} label="Org agents">
            <DeckHead cells={["agent", "what it does", "model", "r "]} />
            {orgAgents.map((a: OrgAgent) => (
              <DeckLine
                key={a.id}
                state={a.enabled ? "done" : "idle"}
                cells={[
                  {
                    v: a.display_name || a.name,
                    cls: "sub",
                    title: a.display_name || a.name,
                  },
                  a.description ?? "",
                  a.model ?? "—",
                  {
                    v: a.enabled ? (
                      ""
                    ) : (
                      <span className="dk-tag">disabled</span>
                    ),
                    cls: "r",
                  },
                ]}
              />
            ))}
          </DeckGrid>
        )}
      </DeckGroup>

      <DeckGroup
        label="imported projects"
        count={projects.length}
        note="open a row to see what it contributes"
      >
        {projectsQ.isLoading ? (
          <div className="dk-note">Loading projects&hellip;</div>
        ) : projects.length === 0 ? (
          <div className="dk-note sans">No projects imported yet.</div>
        ) : (
          <DeckGrid cols={COLS_PROJECT} label="Imported projects">
            <DeckHead cells={["project", "r agents", "path", "r "]} />
            {projects.map((p: WorkspaceProject) => (
              <ProjectRows key={p.id} project={p} />
            ))}
          </DeckGrid>
        )}
      </DeckGroup>
    </DeckShell>
  );
}

/** A child row's name cell: the indent is what says it belongs to the row above. */
function Indented({ children }: { children: ReactNode }): ReactElement {
  return <span style={{ paddingLeft: 18 }}>{children}</span>;
}

/**
 * A project and, when open, its agents — flat `DeckLine`s in the parent grid
 * rather than a nested list, so one roving tabindex covers both.
 */
function ProjectRows({
  project,
}: {
  project: WorkspaceProject;
}): ReactElement {
  const agentsQ = useWorkspaceProjectAgents(project.id);
  const rescan = useRescanWorkspaceProject();
  const del = useDeleteWorkspaceProject();
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const agents = agentsQ.data ?? [];

  return (
    <>
      <DeckLine
        state={project.enabled_count > 0 ? "done" : "idle"}
        onOpen={() => setOpen((v) => !v)}
        rowProps={{ "aria-expanded": open }}
        cells={[
          {
            v: (
              <>
                <span aria-hidden="true" style={{ color: "var(--fg-4)" }}>
                  {open ? "▾ " : "▸ "}
                </span>
                {project.name}
              </>
            ),
            cls: "sub",
            title: project.name,
          },
          {
            v: `${project.enabled_count}/${project.agent_count}`,
            cls: "r",
          },
          { v: project.root_path, title: project.root_path },
          {
            v: (
              <span
                className="dk-actions end"
                onClick={(e) => e.stopPropagation()}
              >
                <DeckMenu
                  label={`Actions for ${project.name}`}
                  items={[
                    {
                      label: rescan.isPending ? "Rescanning…" : "Rescan project",
                      disabled: rescan.isPending,
                      onSelect: () => rescan.mutate(project.id),
                    },
                    {
                      label: confirmDelete
                        ? "Confirm remove"
                        : "Remove from workspace",
                      danger: true,
                      separated: true,
                      disabled: del.isPending,
                      onSelect: () => {
                        if (!confirmDelete) {
                          setConfirmDelete(true);
                          return;
                        }
                        del.mutate(project.id);
                        setConfirmDelete(false);
                      },
                    },
                  ]}
                />
              </span>
            ),
            cls: "r",
          },
        ]}
      />

      {open && agentsQ.isLoading && (
        <DeckLine
          state="wait"
          cells={[{ v: <Indented>loading agents…</Indented> }, "", "", ""]}
        />
      )}
      {open && !agentsQ.isLoading && agents.length === 0 && (
        <DeckLine
          state="idle"
          cells={[{ v: <Indented>no agents found</Indented> }, "", "", ""]}
        />
      )}
      {open &&
        agents.map((a: WorkspaceAgent) => (
          <DeckLine
            key={a.id}
            state={
              a.verify_status === "ok" && a.enabled !== 0
                ? "done"
                : a.verify_status === "ok"
                  ? "idle"
                  : "fail"
            }
            cells={[
              { v: <Indented>{a.name}</Indented>, title: a.name },
              { v: a.model ?? "—", cls: "r" },
              {
                v: (
                  <>
                    {a.verify_status}
                    {a.has_name_mismatch === 1 && (
                      <>
                        {" "}
                        <span className="dk-tag" data-s="wait">
                          name mismatch
                        </span>
                      </>
                    )}
                    {a.enabled === 0 && (
                      <>
                        {" "}
                        <span className="dk-tag">disabled</span>
                      </>
                    )}
                  </>
                ),
              },
              "",
            ]}
          />
        ))}
    </>
  );
}
