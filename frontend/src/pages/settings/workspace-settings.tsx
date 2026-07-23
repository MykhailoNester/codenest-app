import { useEffect, useState } from "react";
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
  type WorkspaceHealthData,
  type OrgAgent,
} from "../../lib/api";
import {
  getWorkspacePath,
  getOrgAgentsPath,
  getAppDataPath,
} from "../../lib/ipc";
import { Shell } from "../../components/layout/shell";
import styles from "./workspace-settings.module.css";

export function WorkspaceSettingsPage() {
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

  return (
    <Shell
      topbarTitle="Workspace Settings"
      topbarCrumbs="Settings ·"
      actions={
        <button
          type="button"
          className={styles.primaryBtn}
          onClick={() => regen.mutate()}
          disabled={regen.isPending}
        >
          {regen.isPending ? "Regenerating…" : "Regenerate symlinks"}
        </button>
      }
    >
      <div className={styles.page}>
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Paths</h2>
          {paths ? (
            <dl className={styles.paths}>
              <dt>App data</dt>
              <dd>
                <code>{paths.appData}</code>
              </dd>
              <dt>Workspace</dt>
              <dd>
                <code>{paths.workspace}</code>
              </dd>
              <dt>Org agents</dt>
              <dd>
                <code>{paths.orgAgents}</code>
              </dd>
            </dl>
          ) : (
            <p className={styles.muted}>Loading paths…</p>
          )}
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>
            Health
            {healthQ.data && healthQ.data.issue_count > 0 && (
              <span className={styles.warn}>
                {" "}
                {healthQ.data.issue_count} issue(s)
              </span>
            )}
          </h2>
          {healthQ.isLoading && (
            <p className={styles.muted}>Checking workspace health…</p>
          )}
          {healthQ.data?.issue_count === 0 && (
            <p className={styles.muted}>
              All workspace links resolve correctly.
            </p>
          )}
          {healthQ.data && healthQ.data.issue_count > 0 && (
            <div className={styles.tableWrapper}>
              <table className={styles.issues}>
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th>Name</th>
                    <th>Status</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {healthQ.data.issues.map(
                    (iss: WorkspaceHealthData["issues"][number], i: number) => (
                      <tr key={i}>
                        <td>{iss.kind}</td>
                        <td>
                          <code>{iss.name}</code>
                        </td>
                        <td className={styles.warn}>{iss.verify_status}</td>
                        <td className={styles.muted}>{iss.detail ?? ""}</td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>
            Org Agents ({orgAgentsQ.data?.length ?? 0})
          </h2>
          {orgAgentsQ.isLoading && (
            <p className={styles.muted}>Loading org agents…</p>
          )}
          {orgAgentsQ.data && orgAgentsQ.data.length === 0 && (
            <p className={styles.muted}>No org-level agents installed.</p>
          )}
          {orgAgentsQ.data && orgAgentsQ.data.length > 0 && (
            <ul className={styles.orgAgents}>
              {orgAgentsQ.data.map((a: OrgAgent) => (
                <li key={a.id}>
                  <strong>{a.display_name || a.name}</strong>
                  {a.model && <code className={styles.model}>v{a.model}</code>}
                  {a.description && (
                    <span className={styles.muted}>{a.description}</span>
                  )}
                  {!a.enabled && (
                    <span className={styles.disabledBadge}>disabled</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>
            Imported Projects ({projectsQ.data?.length ?? 0})
          </h2>
          {projectsQ.isLoading && (
            <p className={styles.muted}>Loading projects…</p>
          )}
          {projectsQ.data?.length === 0 && (
            <p className={styles.muted}>No projects imported yet.</p>
          )}
          {projectsQ.data?.map((p: WorkspaceProject) => (
            <ProjectRow key={p.id} project={p} />
          ))}
        </section>
      </div>
    </Shell>
  );
}

function ProjectRow({ project }: { project: WorkspaceProject }) {
  const agentsQ = useWorkspaceProjectAgents(project.id);
  const rescan = useRescanWorkspaceProject();
  const del = useDeleteWorkspaceProject();
  const [expanded, setExpanded] = useState(false);

  return (
    <article className={styles.projectRow}>
      <header
        className={styles.projectRowHeader}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={styles.disclosure}>{expanded ? "▾" : "▸"}</span>
        <strong className={styles.projectName}>{project.name}</strong>
        <span className={styles.agentCount}>
          {project.enabled_count}/{project.agent_count} agents
        </span>
        <span className={styles.path}>{project.root_path}</span>
        <span className={styles.rowActions}>
          <button
            type="button"
            className={styles.ghostBtn}
            onClick={(e) => {
              e.stopPropagation();
              rescan.mutate(project.id);
            }}
            disabled={rescan.isPending}
          >
            Rescan
          </button>
          <button
            type="button"
            className={styles.ghostBtn}
            onClick={(e) => {
              e.stopPropagation();
              if (
                window.confirm(`Remove ${project.name} from the workspace?`)
              ) {
                del.mutate(project.id);
              }
            }}
            disabled={del.isPending}
          >
            Remove
          </button>
        </span>
      </header>

      {expanded && (
        <div className={styles.agentListWrapper}>
          {agentsQ.isLoading && (
            <p className={styles.muted} style={{ padding: "8px 0" }}>
              Loading agents…
            </p>
          )}
          {agentsQ.data && agentsQ.data.length === 0 && (
            <p className={styles.muted} style={{ padding: "8px 0" }}>
              No agents found.
            </p>
          )}
          {agentsQ.data && agentsQ.data.length > 0 && (
            <ul className={styles.agentList}>
              {agentsQ.data.map((a: WorkspaceAgent) => (
                <li key={a.id}>
                  <code className={styles.agentName}>{a.name}</code>
                  {a.model && <span className={styles.model}>{a.model}</span>}
                  {a.has_name_mismatch === 1 && (
                    <span className={styles.warn}>name mismatch</span>
                  )}
                  <span className={styles.verify}>{a.verify_status}</span>
                  {a.enabled === 0 && (
                    <span className={styles.muted}>(disabled)</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}
