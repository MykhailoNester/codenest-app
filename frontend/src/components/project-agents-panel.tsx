/**
 * ProjectAgentsPanel — shared component for per-project agent/skill management.
 *
 * Used in:
 *  - onboarding/agents-review-step.tsx (Step 04 — scoped to onboarding CSS)
 *  - projects.tsx (per-project expand panel inside the Projects page)
 *
 * Provides enable/disable toggles (Project ↔ Workspace) and a "Promote to org"
 * action per agent that calls the promote endpoint.
 */

import { type ReactElement } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  fetchSidecar,
  useWorkspaceProjectAgents,
  useWorkspaceProjectSkills,
  useToggleWorkspaceProjectSkill,
  usePromoteAgentToOrg,
  type SidecarError,
  type WorkspaceAgent,
  type WorkspaceSkill,
} from "../lib/api";

// ─── Shared style tokens used in both contexts ────────────────────────────────
// The panel renders unstyled structural elements and expects the parent
// to supply a className for the row container (or uses inline styles directly).

interface ToggleProps {
  workspace: boolean;
  onProject: () => void;
  onWorkspace: () => void;
  disabled?: boolean;
  /** CSS class applied when the "Project" button is active */
  segOnProjectCls?: string;
  /** CSS class applied when the "Workspace" button is active */
  segOnWorkspaceCls?: string;
  /** CSS class for the toggle wrapper */
  segToggleCls?: string;
}

function ScopeToggle({
  workspace,
  onProject,
  onWorkspace,
  disabled = false,
  segOnProjectCls,
  segOnWorkspaceCls,
  segToggleCls,
}: ToggleProps): ReactElement {
  return (
    <div className={segToggleCls} style={segToggleCls ? undefined : TOGGLE_STYLE}>
      <button
        type="button"
        className={!workspace ? segOnProjectCls : undefined}
        style={
          !workspace && !segOnProjectCls ? ACTIVE_PROJECT_STYLE : undefined
        }
        onClick={() => {
          if (workspace) onProject();
        }}
        disabled={disabled}
      >
        Project
      </button>
      <button
        type="button"
        className={workspace ? segOnWorkspaceCls : undefined}
        style={
          workspace && !segOnWorkspaceCls ? ACTIVE_WORKSPACE_STYLE : undefined
        }
        onClick={() => {
          if (!workspace) onWorkspace();
        }}
        disabled={disabled}
      >
        Workspace
      </button>
    </div>
  );
}

const TOGGLE_STYLE: React.CSSProperties = {
  display: "inline-flex",
  background: "rgba(0,0,0,0.3)",
  border: "1px solid var(--line-1)",
  borderRadius: 999,
  padding: 2,
  flexShrink: 0,
};
const ACTIVE_PROJECT_STYLE: React.CSSProperties = {
  color: "#fff",
  background: "linear-gradient(135deg, var(--accent), #5b9bff)",
  borderRadius: 999,
};
const ACTIVE_WORKSPACE_STYLE: React.CSSProperties = {
  color: "#fff",
  background: "linear-gradient(135deg, var(--violet, #a855f7), #c084fc)",
  borderRadius: 999,
};
const TOGGLE_BTN_BASE: React.CSSProperties = {
  border: 0,
  background: "transparent",
  color: "var(--fg-3)",
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  fontSize: 10,
  textTransform: "uppercase" as const,
  letterSpacing: "0.05em",
  padding: "4px 11px",
  borderRadius: 999,
  cursor: "pointer",
};

// ─── Sub-components ───────────────────────────────────────────────────────────

interface AgentsProps {
  projectId: number;
  /** Optional: CSS class names forwarded from the parent (onboarding uses theirs). */
  classMuted?: string;
  classRow?: string;
  classRowGrow?: string;
  classRowName?: string;
  segToggleCls?: string;
  segOnProjectCls?: string;
  segOnWorkspaceCls?: string;
  /** When true, show a "Promote to org" button per agent. */
  showPromote?: boolean;
}

export function ProjectAgents({
  projectId,
  classMuted,
  classRow,
  classRowGrow,
  classRowName,
  segToggleCls,
  segOnProjectCls,
  segOnWorkspaceCls,
  showPromote = false,
}: AgentsProps): ReactElement {
  const qc = useQueryClient();
  const agentsQ = useWorkspaceProjectAgents(projectId);
  const promote = usePromoteAgentToOrg();

  const toggle = useMutation<unknown, SidecarError, WorkspaceAgent>({
    mutationFn: (a) =>
      fetchSidecar(
        `/api/v1/command-center/projects/${projectId}/agents/${a.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: !a.enabled }),
        },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["workspace", "project", projectId, "agents"],
      });
      void qc.invalidateQueries({ queryKey: ["workspace", "projects"] });
      void qc.invalidateQueries({ queryKey: ["command-center", "agents"] });
    },
  });

  if (!agentsQ.data || agentsQ.data.length === 0) {
    return (
      <p
        className={classMuted}
        style={classMuted ? undefined : { color: "var(--fg-3)", fontSize: 12 }}
      >
        No agents detected.
      </p>
    );
  }

  const handlePromote = (a: WorkspaceAgent): void => {
    promote.mutate(
      { projectId, agentId: a.id },
      {
        onSuccess: (result) => {
          if (result.already_existed) {
            toast.info(`"${a.name}" is already promoted to shared org.`);
          } else {
            toast.success(`"${a.name}" promoted to shared org agents.`);
          }
          if (result.regen.failed.length > 0) {
            toast.error(
              `Symlink warnings: ${result.regen.failed.map((f) => f.reason).join("; ")}`,
            );
          }
        },
        onError: (err) => {
          const msg = err.message ?? "Failed to promote agent";
          // 400 = name collision with a bundled org agent
          if (err.status === 400) {
            toast.error(
              `Cannot promote "${a.name}": name collides with a bundled org agent.`,
            );
          } else {
            toast.error(msg);
          }
        },
      },
    );
  };

  return (
    <>
      {agentsQ.data.map((a) => {
        const workspace = Boolean(a.enabled);
        const verifyBad =
          a.verify_status !== "ok" && a.verify_status !== undefined;
        return (
          <div
            key={a.id}
            className={classRow}
            style={
              classRow
                ? undefined
                : {
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "9px 12px",
                    border: "1px solid var(--line-1)",
                    borderRadius: 8,
                    background: "rgba(255,255,255,0.02)",
                    marginBottom: 6,
                  }
            }
          >
            <div
              className={classRowGrow}
              style={classRowGrow ? undefined : { flex: 1, minWidth: 0 }}
            >
              <div
                className={classRowName}
                style={
                  classRowName
                    ? undefined
                    : { fontSize: 13, color: "var(--fg-0)", fontWeight: 500 }
                }
              >
                {a.name}
                {verifyBad && (
                  <span
                    style={{
                      marginLeft: 6,
                      fontSize: 10,
                      color: "#f59e0b",
                      fontFamily: "var(--font-mono)",
                    }}
                    title={`Symlink status: ${a.verify_status}`}
                  >
                    {a.verify_status}
                  </span>
                )}
              </div>
            </div>

            {showPromote && (
              <button
                type="button"
                onClick={() => handlePromote(a)}
                disabled={promote.isPending}
                style={{
                  ...TOGGLE_BTN_BASE,
                  fontSize: 10,
                  padding: "4px 9px",
                  border: "1px solid var(--line-2)",
                  background: "rgba(255,255,255,0.04)",
                  color: "var(--fg-2)",
                }}
                title="Copy this agent into the shared org agents folder"
              >
                Promote to org
              </button>
            )}

            <ScopeToggle
              workspace={workspace}
              onProject={() => toggle.mutate(a)}
              onWorkspace={() => toggle.mutate(a)}
              disabled={toggle.isPending}
              segToggleCls={segToggleCls}
              segOnProjectCls={segOnProjectCls}
              segOnWorkspaceCls={segOnWorkspaceCls}
            />
          </div>
        );
      })}
    </>
  );
}

interface SkillsProps {
  projectId: number;
  classMuted?: string;
  classRow?: string;
  classRowGrow?: string;
  classRowName?: string;
  segToggleCls?: string;
  segOnProjectCls?: string;
  segOnWorkspaceCls?: string;
}

export function ProjectSkills({
  projectId,
  classMuted,
  classRow,
  classRowGrow,
  classRowName,
  segToggleCls,
  segOnProjectCls,
  segOnWorkspaceCls,
}: SkillsProps): ReactElement {
  const skillsQ = useWorkspaceProjectSkills(projectId);
  const toggle = useToggleWorkspaceProjectSkill();

  if (skillsQ.isLoading) {
    return (
      <p
        className={classMuted}
        style={classMuted ? undefined : { color: "var(--fg-3)", fontSize: 12 }}
      >
        Loading skills...
      </p>
    );
  }

  if (!skillsQ.data || skillsQ.data.length === 0) {
    return (
      <p
        className={classMuted}
        style={classMuted ? undefined : { color: "var(--fg-3)", fontSize: 12 }}
      >
        No skills detected.
      </p>
    );
  }

  return (
    <>
      {skillsQ.data.map((s: WorkspaceSkill) => {
        const workspace = Boolean(s.enabled);
        const verifyBad =
          s.verify_status != null &&
          s.verify_status !== "ok" &&
          s.verify_status !== undefined;
        return (
          <div
            key={s.id}
            className={classRow}
            style={
              classRow
                ? undefined
                : {
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "9px 12px",
                    border: "1px solid var(--line-1)",
                    borderRadius: 8,
                    background: "rgba(255,255,255,0.02)",
                    marginBottom: 6,
                  }
            }
          >
            <div
              className={classRowGrow}
              style={classRowGrow ? undefined : { flex: 1, minWidth: 0 }}
            >
              <div
                className={classRowName}
                style={
                  classRowName
                    ? undefined
                    : { fontSize: 13, color: "var(--fg-0)", fontWeight: 500 }
                }
              >
                {s.name}
                {verifyBad && (
                  <span
                    style={{
                      marginLeft: 6,
                      fontSize: 10,
                      color: "#f59e0b",
                      fontFamily: "var(--font-mono)",
                    }}
                    title={`Symlink status: ${s.verify_status ?? "unknown"}`}
                  >
                    {s.verify_status}
                  </span>
                )}
              </div>
            </div>

            <ScopeToggle
              workspace={workspace}
              onProject={() =>
                toggle.mutate({ projectId, skillId: s.id, enabled: false })
              }
              onWorkspace={() =>
                toggle.mutate({ projectId, skillId: s.id, enabled: true })
              }
              disabled={toggle.isPending}
              segToggleCls={segToggleCls}
              segOnProjectCls={segOnProjectCls}
              segOnWorkspaceCls={segOnWorkspaceCls}
            />
          </div>
        );
      })}
    </>
  );
}
