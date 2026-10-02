import { useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient, useQueries } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  useProjects,
  useUpdateProject,
  useDeleteProjectLegacy,
  useProviders,
  useProfiles,
  useRescanWorkspaceProject,
  useRegenerateWorkspace,
  fetchSidecar,
  SIDECAR_BASE_URL,
  type Project,
  type Provider,
  type ProfileOut,
  type CostMetricsResponse,
} from "../lib/api";
import { isHiddenCatchAllProject } from "../lib/project-display";
import { DeckShell } from "../components/deck/deck-shell";
import { DeckGrid, DeckHead, DeckLine } from "../components/deck/deck-grid";
import { DeckMenu } from "../components/deck/deck-menu";

const COLS_PROJECT =
  "14px minmax(0, 1fr) 150px 110px 170px 90px auto";
import { ImportProjectsModal } from "../components/import-projects-modal";
import {
  ProjectAgents,
  ProjectSkills,
} from "../components/project-agents-panel";
import { LineChart, Line } from "recharts";
import css from "./projects.module.css";



// ─── Edit modal ───────────────────────────────────────────────────────────────

interface EditProjectModalProps {
  project: Project;
  onClose: () => void;
}

function EditProjectModal({
  project,
  onClose,
}: EditProjectModalProps): ReactElement {
  const updateProject = useUpdateProject();
  const { data: providers = [] } = useProviders();
  const { data: profiles = [] } = useProfiles();
  // Only show profile selector when more than one profile exists.
  const showProfileSelector = profiles.length > 1;
  const [form, setForm] = useState({
    name: project.name,
    description: project.description ?? "",
    tech_stack: project.tech_stack ?? "",
    status: project.status,
    path: project.path ?? "",
    default_provider_id: project.default_provider_id ?? null,
    profile_id: project.profile_id ?? null,
  });
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(): Promise<void> {
    setError(null);
    if (!form.name.trim()) {
      setError("Name is required");
      return;
    }
    const pathTrimmed = form.path.trim();
    if (pathTrimmed && !pathTrimmed.startsWith("/")) {
      setError("Path must be absolute (start with '/')");
      return;
    }
    try {
      await updateProject.mutateAsync({
        id: project.id,
        patch: {
          name: form.name.trim(),
          description: form.description.trim() || null,
          tech_stack: form.tech_stack.trim() || null,
          status: form.status,
          path: pathTrimmed || null,
          default_provider_id: form.default_provider_id,
          profile_id: form.profile_id,
        },
      });
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to save project");
    }
  }

  return (
    <div className={css.modalOverlay} onClick={onClose}>
      <div className={css.modalBox} onClick={(e) => e.stopPropagation()}>
        <div className={css.modalTitle}>Edit "{project.name}"</div>

        <div className={css.formGrid2}>
          <div>
            <label className={css.fieldLabel}>Name *</label>
            <input
              className={css.input}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              autoFocus
            />
          </div>
          <div>
            <label className={css.fieldLabel}>Status</label>
            <select
              className={css.input}
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
            >
              <option value="active">Active</option>
              <option value="archived">Archived</option>
              <option value="planned">Planned</option>
            </select>
          </div>
        </div>

        <div className={css.formField}>
          <label className={css.fieldLabel}>Description</label>
          <input
            className={css.input}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="What does this project do?"
          />
        </div>

        <div className={css.formGrid2}>
          <div>
            <label className={css.fieldLabel}>Tech Stack</label>
            <input
              className={css.input}
              value={form.tech_stack}
              onChange={(e) => setForm({ ...form, tech_stack: e.target.value })}
              placeholder="e.g. Python, FastAPI"
            />
          </div>
          <div>
            <label className={css.fieldLabel}>Path (absolute)</label>
            <input
              className={css.input}
              value={form.path}
              onChange={(e) => setForm({ ...form, path: e.target.value })}
              placeholder="/Users/me/Work/my-project"
              spellCheck={false}
            />
          </div>
        </div>

        <div className={css.formField}>
          <label className={css.fieldLabel}>Default provider</label>
          <select
            className={css.input}
            value={form.default_provider_id ?? ""}
            onChange={(e) =>
              setForm({
                ...form,
                default_provider_id: e.target.value ? Number(e.target.value) : null,
              })
            }
          >
            <option value="">None</option>
            {providers.map((p: Provider) => (
              <option key={p.id} value={p.id}>
                {p.display_name}
              </option>
            ))}
          </select>
        </div>

        {showProfileSelector && (
          <div className={css.formField}>
            <label className={css.fieldLabel}>Profile group</label>
            <select
              className={css.input}
              value={form.profile_id ?? ""}
              onChange={(e) =>
                setForm({
                  ...form,
                  profile_id: e.target.value ? Number(e.target.value) : null,
                })
              }
            >
              <option value="">Default</option>
              {profiles.map((pr: ProfileOut) => (
                <option key={pr.id} value={pr.id}>
                  {pr.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {error && <div className={css.errorText}>{error}</div>}

        <div className={css.modalFooter}>
          <button
            className="dk-btn pri"
            type="button"
            onClick={() => void handleSubmit()}
            disabled={updateProject.isPending}
          >
            {updateProject.isPending ? "Saving..." : "Save"}
          </button>
          <button
            className="dk-btn"
            type="button"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Per-project agents/skills panel ─────────────────────────────────────────

interface AgentsPanelModalProps {
  project: Project;
  onClose: () => void;
}

function AgentsPanelModal({
  project,
  onClose,
}: AgentsPanelModalProps): ReactElement {
  const [tab, setTab] = useState<"agents" | "skills">("agents");

  return (
    <div className={css.modalOverlay} onClick={onClose}>
      <div
        className={css.modalBox}
        style={{ width: 540, maxWidth: "92vw" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={css.modalTitle}>
          Agents &amp; Skills — {project.name}
        </div>

        {/* Tab selector */}
        <div
          style={{
            display: "flex",
            gap: 0,
            marginBottom: 14,
            borderBottom: "1px solid var(--line-2)",
          }}
        >
          {(["agents", "skills"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              style={{
                border: 0,
                background: "transparent",
                padding: "6px 14px",
                fontSize: 12,
                fontWeight: tab === t ? 600 : 400,
                color: tab === t ? "var(--fg-0)" : "var(--fg-3)",
                cursor: "pointer",
                borderBottom: tab === t ? "2px solid var(--accent)" : "2px solid transparent",
                marginBottom: -1,
                textTransform: "capitalize",
              }}
            >
              {t}
            </button>
          ))}
        </div>

        <div style={{ maxHeight: 360, overflowY: "auto" }}>
          {tab === "agents" ? (
            <ProjectAgents projectId={project.id} showPromote />
          ) : (
            <ProjectSkills projectId={project.id} />
          )}
        </div>

        <div className={css.modalFooter} style={{ justifyContent: "flex-end" }}>
          <button
            className="dk-btn"
            type="button"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function ProjectsPage(): ReactElement {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: rawProjects = [] } = useProjects();
  const { data: providers = [] } = useProviders();
  const { data: profiles = [] } = useProfiles();
  // Show profile selector only when more than one profile exists.
  const showProfileSelector = profiles.length > 1;
  const rescan = useRescanWorkspaceProject();
  const regenerate = useRegenerateWorkspace();
  // Track which project id is currently being rescanned so the busy indicator
  // is scoped per-card. rescan.isPending is shared across all cards (one
  // mutation instance), so reading it directly would flip every card at once.
  const [rescanningId, setRescanningId] = useState<number | null>(null);

  // Sort: workspace project first, then by natural order.
  const projects = [...rawProjects].sort((a, b) => {
    if (a.is_workspace && !b.is_workspace) return -1;
    if (!a.is_workspace && b.is_workspace) return 1;
    return 0;
  });

  // Per-project 30d cost queries batched via useQueries
  const costQueries = useQueries({
    queries: projects.map((p) => ({
      queryKey: [
        "metrics",
        "cost",
        { group_by: "day", range: "30d", project_id: p.id },
      ],
      queryFn: () =>
        fetch(
          `${SIDECAR_BASE_URL}/api/v1/metrics/cost?group_by=day&range=30d&project_id=${p.id}`,
          { headers: { Accept: "application/json" } },
        ).then((r) => r.json() as Promise<CostMetricsResponse>),
      staleTime: 60_000,
    })),
  });

  // Pairs of (project, original index into costQueries) with the empty
  // Unassigned catch-all filtered out (shared filter — see
  // isHiddenCatchAllProject). The idx is preserved so cost sparkline queries
  // still line up after filtering.
  const visibleProjects = projects
    .map((p, idx) => ({ p, idx }))
    .filter(({ p }) => !isHiddenCatchAllProject(p));

  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importProfileId, setImportProfileId] = useState<number | null>(null);
  const [form, setForm] = useState({
    name: "",
    description: "",
    tech_stack: "",
    status: "active",
    path: "",
    profile_id: null as number | null,
  });

  // Edit modal state
  const [editingProject, setEditingProject] = useState<Project | null>(null);

  // Agents/skills panel modal
  const [agentsPanelProject, setAgentsPanelProject] = useState<Project | null>(null);

  // Delete state: maps project id → "confirm-pending"
  const deleteProject = useDeleteProjectLegacy();
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const handleCreate = async () => {
    if (!form.name.trim()) return;
    await fetchSidecar("/api/v1/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name,
        description: form.description || null,
        tech_stack: form.tech_stack || null,
        status: form.status,
        path: form.path || null,
        ...(form.profile_id != null ? { profile_id: form.profile_id } : {}),
      }),
    });
    void qc.invalidateQueries({ queryKey: ["projects"] });
    setShowForm(false);
    setForm({
      name: "",
      description: "",
      tech_stack: "",
      status: "active",
      path: "",
      profile_id: null,
    });
  };

  const handleDelete = async (project: Project) => {
    if (confirmDeleteId !== project.id) {
      setConfirmDeleteId(project.id);
      return;
    }
    try {
      await deleteProject.mutateAsync(project.id);
      setConfirmDeleteId(null);
      toast.success(`Deleted "${project.name}".`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to delete project");
    }
  };

  const handleRescan = (project: Project): void => {
    setRescanningId(project.id);
    rescan.mutate(project.id, {
      onSuccess: (result) => {
        setRescanningId(null);
        const parts: string[] = [];
        const added = result.agents_added + result.skills_added;
        const updated = result.agents_updated + result.skills_updated;
        const disabled = result.agents_disabled + result.skills_disabled;
        if (added > 0) parts.push(`${added} added`);
        if (updated > 0) parts.push(`${updated} updated`);
        if (disabled > 0) parts.push(`${disabled} disabled`);
        const summary = parts.length > 0 ? parts.join(", ") : "nothing changed";
        toast.success(`Rescan "${project.name}": ${summary}.`);
      },
      onError: (err) => {
        setRescanningId(null);
        toast.error(
          `Rescan failed for "${project.name}": ${err.message ?? "unknown error"}`,
        );
      },
    });
  };

  const handleRegenerate = (): void => {
    regenerate.mutate(undefined, {
      onSuccess: () => {
        toast.success("Workspace symlinks regenerated.");
      },
      onError: (err) => {
        toast.error(
          `Regenerate failed: ${err.message ?? "unknown error"}`,
        );
      },
    });
  };

  return (
    <DeckShell
      title="projects"
      crumb="the agent-to-project binding"
      actions={
        <>
          <button
            className="dk-btn"
            type="button"
            onClick={handleRegenerate}
            disabled={regenerate.isPending}
            title="Rebuild all workspace symlinks (repairs dangling links)"
          >
            {regenerate.isPending ? "Regenerating..." : "Regenerate workspace"}
          </button>
          <button
            className="dk-btn"
            type="button"
            onClick={() => setShowImport(true)}
          >
            Import Projects
          </button>
          <button
            className="dk-btn pri"
            type="button"
            onClick={() => setShowForm(!showForm)}
          >
            + New Project
          </button>
        </>
      }
    >
      <div style={{ padding: "0 24px 24px" }}>
        {/* Edit modal */}
        {editingProject && (
          <EditProjectModal
            project={editingProject}
            onClose={() => setEditingProject(null)}
          />
        )}

        {/* Agents/skills panel modal */}
        {agentsPanelProject && (
          <AgentsPanelModal
            project={agentsPanelProject}
            onClose={() => setAgentsPanelProject(null)}
          />
        )}

        {showImport && (
          <ImportProjectsModal
            defaultProfileId={importProfileId}
            onClose={() => {
              setShowImport(false);
              setImportProfileId(null);
            }}
            onImported={(n) => {
              toast.success(`Imported ${n} project${n === 1 ? "" : "s"}.`);
              setShowImport(false);
              setImportProfileId(null);
            }}
          />
        )}

        {showForm && (
          <div
            className="d3-card"
            style={{ padding: "16px 20px", marginBottom: 16 }}
          >
            <span
              className="d3-h"
              style={{ display: "block", marginBottom: 12 }}
            >
              New Project
            </span>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
                marginBottom: 10,
              }}
            >
              <div>
                <label
                  style={{
                    fontSize: 11,
                    color: "var(--fg-3)",
                    display: "block",
                    marginBottom: 4,
                  }}
                >
                  Name *
                </label>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Project name"
                  style={{
                    width: "100%",
                    padding: "6px 10px",
                    background: "var(--bg-3)",
                    border: "1px solid var(--line-2)",
                    color: "var(--fg-0)",
                    borderRadius: 6,
                    fontSize: 13,
                    boxSizing: "border-box",
                  }}
                />
              </div>
              <div>
                <label
                  style={{
                    fontSize: 11,
                    color: "var(--fg-3)",
                    display: "block",
                    marginBottom: 4,
                  }}
                >
                  Status
                </label>
                <select
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value })}
                  style={{
                    width: "100%",
                    padding: "6px 10px",
                    background: "var(--bg-3)",
                    border: "1px solid var(--line-2)",
                    color: "var(--fg-0)",
                    borderRadius: 6,
                    fontSize: 13,
                  }}
                >
                  <option value="active">Active</option>
                  <option value="archived">Archived</option>
                  <option value="planned">Planned</option>
                </select>
              </div>
            </div>
            <div style={{ marginBottom: 10 }}>
              <label
                style={{
                  fontSize: 11,
                  color: "var(--fg-3)",
                  display: "block",
                  marginBottom: 4,
                }}
              >
                Description
              </label>
              <textarea
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
                placeholder="What does this project do?"
                rows={2}
                style={{
                  width: "100%",
                  padding: "6px 10px",
                  background: "var(--bg-3)",
                  border: "1px solid var(--line-2)",
                  color: "var(--fg-0)",
                  borderRadius: 6,
                  fontSize: 13,
                  resize: "vertical",
                  boxSizing: "border-box",
                }}
              />
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
                marginBottom: 12,
              }}
            >
              <div>
                <label
                  style={{
                    fontSize: 11,
                    color: "var(--fg-3)",
                    display: "block",
                    marginBottom: 4,
                  }}
                >
                  Tech Stack
                </label>
                <input
                  value={form.tech_stack}
                  onChange={(e) =>
                    setForm({ ...form, tech_stack: e.target.value })
                  }
                  placeholder="e.g. Python, FastAPI"
                  style={{
                    width: "100%",
                    padding: "6px 10px",
                    background: "var(--bg-3)",
                    border: "1px solid var(--line-2)",
                    color: "var(--fg-0)",
                    borderRadius: 6,
                    fontSize: 13,
                    boxSizing: "border-box",
                  }}
                />
              </div>
              <div>
                <label
                  style={{
                    fontSize: 11,
                    color: "var(--fg-3)",
                    display: "block",
                    marginBottom: 4,
                  }}
                >
                  Path
                </label>
                <input
                  value={form.path}
                  onChange={(e) => setForm({ ...form, path: e.target.value })}
                  placeholder="e.g. /Users/me/Work/myproject"
                  style={{
                    width: "100%",
                    padding: "6px 10px",
                    background: "var(--bg-3)",
                    border: "1px solid var(--line-2)",
                    color: "var(--fg-0)",
                    borderRadius: 6,
                    fontSize: 13,
                    boxSizing: "border-box",
                  }}
                />
              </div>
            </div>
            {showProfileSelector && (
              <div style={{ marginBottom: 12 }}>
                <label
                  style={{
                    fontSize: 11,
                    color: "var(--fg-3)",
                    display: "block",
                    marginBottom: 4,
                  }}
                >
                  Profile group
                </label>
                <select
                  value={form.profile_id ?? ""}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      profile_id: e.target.value ? Number(e.target.value) : null,
                    })
                  }
                  style={{
                    width: "100%",
                    padding: "6px 10px",
                    background: "var(--bg-3)",
                    border: "1px solid var(--line-2)",
                    color: "var(--fg-0)",
                    borderRadius: 6,
                    fontSize: 13,
                  }}
                >
                  <option value="">Default</option>
                  {profiles.map((pr: ProfileOut) => (
                    <option key={pr.id} value={pr.id}>
                      {pr.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="dk-btn pri"
                type="button"
                onClick={() => void handleCreate()}
              >
                Create Project
              </button>
              <button
                className="dk-btn"
                type="button"
                onClick={() => setShowForm(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {visibleProjects.length === 0 ? (
          <div
            style={{
              color: "var(--fg-3)",
              fontSize: 13,
              padding: "32px 0",
              textAlign: "center",
            }}
          >
            No projects yet.
          </div>
        ) : (
            <DeckGrid cols={COLS_PROJECT} label="projects">
              <DeckHead
                cells={["project", "stack", "status", "tasks", "r spend 30d", "r "]}
              />
              {visibleProjects.map(({ p, idx }) => {
                const isWorkspace = Boolean(p.is_workspace);
                const costData = costQueries[idx]?.data;
                const hasCost =
                  costData !== undefined &&
                  (costData.grand_total.total_cost_usd > 0 ||
                    costData.grand_total.run_count > 0);
                const sparkData = costData?.groups ?? [];
                const prov = providers.find(
                  (pr: Provider) => pr.id === p.default_provider_id,
                );
                const prof = profiles.find((pr: ProfileOut) => pr.id === p.profile_id);
                const open = (p.task_counts?.todo ?? 0) + (p.task_counts?.["in-progress"] ?? 0);
                const blocked = p.task_counts?.blocked ?? 0;

                return (
                  <DeckLine
                    key={p.id}
                    state={blocked > 0 ? "block" : isWorkspace ? "run" : open > 0 ? "todo" : "idle"}
                    cells={[
                      {
                        v: (
                          <>
                            {p.name}
                            {isWorkspace && (
                              <>
                                {" "}
                                <span className="dk-tag" data-s="run">
                                  workspace
                                </span>
                              </>
                            )}
                            {prof && (
                              <>
                                {" "}
                                <span className="dk-tag">{prof.name}</span>
                              </>
                            )}
                          </>
                        ),
                        cls: "sub",
                        title: p.root_path ?? p.path ?? p.name,
                      },
                      {
                        v: isWorkspace
                          ? "All imported agents + org agents"
                          : (p.tech_stack ?? p.description ?? ""),
                      },
                      {
                        v: isWorkspace ? (
                          ""
                        ) : (
                          <>
                            {p.status}
                            {prov && (
                              <>
                                {" "}
                                <span className="dim">· {prov.display_name}</span>
                              </>
                            )}
                          </>
                        ),
                      },
                      {
                        v: (
                          <>
                            {blocked > 0 && (
                              <span className="dk-tag" data-s="block">
                                {blocked} blocked
                              </span>
                            )}
                            {blocked > 0 && " "}
                            {open > 0 ? `${open} open` : null}
                            {(p.inbox_count ?? 0) > 0 && (
                              <span className="dim"> · {p.inbox_count} to triage</span>
                            )}
                            {(p.total_tasks ?? 0) === 0 &&
                              (p.inbox_count ?? 0) === 0 &&
                              "no tasks yet"}
                          </>
                        ),
                      },
                      {
                        v: hasCost ? (
                          <>
                            {sparkData.length > 0 && (
                              <LineChart width={54} height={14} data={sparkData}>
                                <Line
                                  type="monotone"
                                  dataKey="total_cost_usd"
                                  dot={false}
                                  strokeWidth={1.25}
                                  stroke="var(--fg-3)"
                                />
                              </LineChart>
                            )}
                            ${costData!.grand_total.total_cost_usd.toFixed(2)}
                          </>
                        ) : (
                          "—"
                        ),
                        cls: "r",
                      },
                      {
                        v: (
                          <span className="dk-actions end" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              className="dk-btn bare"
                              onClick={() => void navigate(`/tasks?project_id=${p.id}`)}
                            >
                              work
                            </button>
                            <button
                              type="button"
                              className="dk-btn bare"
                              onClick={() => void navigate(`/projects/${p.id}/context`)}
                            >
                              context
                            </button>
                            <DeckMenu
                              label={`Actions for ${p.name}`}
                              items={[
                                ...(p.path
                                  ? [
                                      {
                                        label: "Open CLAUDE.md",
                                        onSelect: () =>
                                          void navigate(`/editor?project_id=${p.id}&kind=claude`),
                                      },
                                    ]
                                  : []),
                                {
                                  label: "Edit project",
                                  onSelect: () => {
                                    setConfirmDeleteId(null);
                                    setEditingProject(p);
                                  },
                                },
                                {
                                  label: "Manage agents and skills",
                                  onSelect: () => setAgentsPanelProject(p),
                                },
                                {
                                  label: rescanningId === p.id ? "Rescanning…" : "Rescan for agents",
                                  disabled: rescanningId === p.id,
                                  onSelect: () => handleRescan(p),
                                },
                                {
                                  label:
                                    confirmDeleteId === p.id ? "Confirm delete" : "Delete project",
                                  danger: true,
                                  separated: true,
                                  disabled: deleteProject.isPending && confirmDeleteId === p.id,
                                  onSelect: () => void handleDelete(p),
                                },
                              ]}
                            />
                          </span>
                        ),
                        cls: "r",
                      },
                    ]}
                  />
                );
              })}
            </DeckGrid>
        )}
      </div>
    </DeckShell>
  );
}
