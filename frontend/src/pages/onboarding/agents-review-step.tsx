import { useEffect, type ReactElement } from "react";
import {
  useWorkspaceProjects,
  useOrgAgents,
} from "../../lib/api";
import {
  ProjectAgents,
  ProjectSkills,
} from "../../components/project-agents-panel";
import styles from "./onboarding-page.module.css";

/** Step 4 — review detected agents and skills; promote to workspace where wanted. */
export function AgentsReviewStep({
  registerCommit,
}: {
  registerCommit: (fn: () => Promise<void>) => void;
}): ReactElement {
  // Purely interactive review — toggling agents/skills fires mutations inline.
  // Continue just advances with whatever the user has set.
  useEffect(() => {
    registerCommit(() => Promise.resolve());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const projectsQ = useWorkspaceProjects();
  const projects = projectsQ.data ?? [];
  const orgAgentsQ = useOrgAgents();
  const orgAgents = orgAgentsQ.data ?? [];

  // Count how many project agents are promoted workspace-wide (for meta line).
  const totalEnabled = projects.reduce(
    (sum, p) => sum + (p.enabled_count ?? 0),
    0,
  );
  const totalAgents = projects.reduce(
    (sum, p) => sum + (p.agent_count ?? 0),
    0,
  );

  return (
    <>
      <div className={styles.kicker}>Step 04 &middot; Curate</div>
      <h1 className={styles.title}>Review agents &amp; skills</h1>
      <p className={styles.lead}>
        We detected these in your imported projects. By default they stay{" "}
        <strong>project-level</strong> — promote the ones you want available in
        every workspace session.
      </p>

      <div className={`${styles.infoBar} ${styles.infoBarViol}`}>
        <span className={styles.infoBarIc} aria-hidden="true">
          ?
        </span>
        <div>
          <strong>Why project-level by default?</strong> It avoids name
          collisions in the workspace, keeps a project&apos;s agents and skills
          out of unrelated sessions, and makes promotion an explicit, auditable
          choice. Promotion creates a symlink in the{" "}
          <strong>workspace root</strong> — never in your project.
        </div>
      </div>

      {/* Org agents (always workspace-wide) */}
      {orgAgents.length > 0 && (
        <>
          <div className={styles.sectionH}>
            Shared &middot; Codenest org agents
            <span className={styles.sectionHLine} />
            <span
              className={styles.muted}
              style={{ fontFamily: "var(--font-mono)", fontSize: 10.5 }}
            >
              workspace-wide
            </span>
          </div>
          {orgAgents.map((a) => (
            <div key={a.id} className={styles.row}>
              <div className={styles.rowGrow}>
                <div className={styles.rowName}>{a.name}</div>
              </div>
              <span className={`${styles.tag} ${styles.tagOk}`}>
                ⬡ shared &middot; workspace
              </span>
            </div>
          ))}
        </>
      )}

      {/* Per-project agents and skills */}
      <div className={styles.sectionH}>
        Detected in projects
        <span className={styles.sectionHLine} />
        <span
          className={styles.muted}
          style={{ fontFamily: "var(--font-mono)", fontSize: 10.5 }}
        >
          project &harr; workspace
        </span>
      </div>

      {projects.length === 0 && (
        <p className={styles.muted}>
          No imported projects with agents yet. Import projects first (Step 02)
          or skip this step.
        </p>
      )}

      <div className={styles.scrollList}>
        {projects.map((p) => (
          <div key={p.id}>
            {/* Project name header */}
            <div
              className={styles.sectionH}
              style={{ margin: "12px 0 4px", fontSize: 11 }}
            >
              {p.name}
              <span
                className={styles.muted}
                style={{ marginLeft: 8, textTransform: "none" }}
              >
                {p.enabled_count ?? 0}/{p.agent_count ?? 0} agents in workspace
              </span>
            </div>

            {/* Agents sub-section */}
            <div
              style={{
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                color: "var(--fg-4)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                marginBottom: 4,
              }}
            >
              Agents
            </div>
            <ProjectAgents
              projectId={p.id}
              classMuted={styles.muted}
              classRow={styles.row}
              classRowGrow={styles.rowGrow}
              classRowName={styles.rowName}
              segToggleCls={styles.segToggle}
              segOnProjectCls={styles.segOnProject}
              segOnWorkspaceCls={styles.segOnWorkspace}
            />

            {/* Skills sub-section */}
            <div
              style={{
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                color: "var(--fg-4)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                marginTop: 10,
                marginBottom: 4,
              }}
            >
              Skills
            </div>
            <ProjectSkills
              projectId={p.id}
              classMuted={styles.muted}
              classRow={styles.row}
              classRowGrow={styles.rowGrow}
              classRowName={styles.rowName}
              segToggleCls={styles.segToggle}
              segOnProjectCls={styles.segOnProject}
              segOnWorkspaceCls={styles.segOnWorkspace}
            />
          </div>
        ))}
      </div>

      {totalAgents > 0 && (
        <div className={styles.listMeta}>
          {totalAgents} agents detected &middot; {totalEnabled} promoted to
          workspace &middot; scroll for more
        </div>
      )}
    </>
  );
}
