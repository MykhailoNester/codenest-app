import { useEffect, type ReactElement } from "react";
import { useWorkspaceProjects, useOrgAgents } from "../../lib/api";
import {
  ProjectAgents,
  ProjectSkills,
} from "../../components/project-agents-panel";
import { DeckGrid, DeckLine } from "../../components/deck/deck-grid";
import { StepHead, StepNote, StepHint } from "./step-chrome";

const ORG_COLS = "14px minmax(0, 1fr) 150px";

/**
 * `project-agents-panel` is outside this ticket's file scope, so its markup
 * stays its own; every class it draws with is an optional prop, and these are
 * the Deck equivalents. `.dk-seg` + `.on` is Deck's segmented control, which is
 * exactly what its project/workspace toggle is, and its row becomes a
 * `.dk-line` — the one primitive — laid out by the `--cols` on its wrapper.
 */
const PANEL_CLASSES = {
  classMuted: "dk-meta",
  classRow: "dk-line",
  classRowGrow: "trunc",
  classRowName: "sub",
  segToggleCls: "dk-seg",
  segOnProjectCls: "on",
  segOnWorkspaceCls: "on",
} as const;

/**
 * The panel's rows are name + scope toggle, so they need a two-column track
 * rather than any of `.dk-list`'s named presets. Plain `.dk-list` (no grid
 * role) because these rows are containers for a control, not addressable
 * cells — claiming `role="grid"` over them would be a lie to assistive tech.
 */
const PANEL_LIST_STYLE: React.CSSProperties = {
  ["--cols" as string]: "minmax(0, 1fr) 160px",
};

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
  const totalAgents = projects.reduce((sum, p) => sum + (p.agent_count ?? 0), 0);

  return (
    <>
      <StepHead kicker="step 04 · curate" title="Review agents & skills">
        We detected these in your imported projects. By default they stay{" "}
        <strong>project-level</strong> — promote the ones you want available in
        every workspace session.
      </StepHead>

      <StepNote glyph="?">
        <strong>Why project-level by default?</strong> It avoids name collisions
        in the workspace, keeps a project&apos;s agents and skills out of
        unrelated sessions, and makes promotion an explicit, auditable choice.
        Promotion creates a symlink in the <strong>workspace root</strong> —
        never in your project.
      </StepNote>

      {orgAgents.length > 0 && (
        <div className="dk-group">
          <h2 className="dk-group__h">
            <span>Shared · Codenest org agents</span>
            <span className="n">{orgAgents.length}</span>
            <span className="note">workspace-wide</span>
          </h2>
          <DeckGrid cols={ORG_COLS} label="Codenest org agents">
            {orgAgents.map((a) => (
              <DeckLine
                key={a.id}
                state="done"
                cells={[
                  { v: a.name, cls: "sub" },
                  {
                    cls: "r",
                    v: (
                      <span className="dk-tag" data-s="done">
                        shared · workspace
                      </span>
                    ),
                  },
                ]}
              />
            ))}
          </DeckGrid>
        </div>
      )}

      <div className="dk-group">
        <h2 className="dk-group__h">
          <span>Detected in projects</span>
          {totalAgents > 0 && <span className="n">{totalAgents}</span>}
          <span className="note">
            {totalAgents > 0
              ? `${totalEnabled} promoted to workspace`
              : "project ↔ workspace"}
          </span>
        </h2>

        {projects.length === 0 && (
          <StepHint>
            No imported projects with agents yet. Import projects first (Step 02)
            or skip this step.
          </StepHint>
        )}

        {projects.map((p) => (
          <div key={p.id} style={{ marginBottom: "var(--u4)" }}>
            <h3 className="dk-group__h" style={{ margin: 0 }}>
              <span>{p.name}</span>
              <span className="note">
                {p.enabled_count ?? 0}/{p.agent_count ?? 0} agents in workspace
              </span>
            </h3>

            <div className="dk-label" style={{ padding: "0 var(--u3) var(--u)" }}>
              Agents
            </div>
            <div className="dk-list" style={PANEL_LIST_STYLE}>
              <ProjectAgents projectId={p.id} {...PANEL_CLASSES} />
            </div>

            <div
              className="dk-label"
              style={{ padding: "var(--u3) var(--u3) var(--u)" }}
            >
              Skills
            </div>
            <div className="dk-list" style={PANEL_LIST_STYLE}>
              <ProjectSkills projectId={p.id} {...PANEL_CLASSES} />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
