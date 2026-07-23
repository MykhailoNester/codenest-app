import { useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import { useTasks, useProjects, useTeamMembers } from "../lib/api";
import { Shell } from "../components/layout/shell";

const PRIORITY_COLORS: Record<string, string> = {
  high: "#ef4444",
  medium: "#f59e0b",
  low: "#22c55e",
};

export function InProgressPage(): ReactElement {
  const navigate = useNavigate();
  const [projectFilter, setProjectFilter] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState("");

  const filters: Record<string, string> = {
    status: "in-progress",
    sort: "project",
  };
  if (projectFilter) filters.project_id = projectFilter;
  if (assigneeFilter) filters.assignee_id = assigneeFilter;

  const { data: tasks = [] } = useTasks(filters);
  const { data: projects = [] } = useProjects();
  const { data: members = [] } = useTeamMembers();

  // Group by project
  const grouped: Record<string, typeof tasks> = {};
  for (const t of tasks) {
    const key = t.project_name ?? "Unassigned";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(t);
  }

  return (
    <Shell>
      <div style={{ padding: "0 24px 24px" }}>
        {/* Filters */}
        <div
          style={{
            display: "flex",
            gap: 8,
            marginBottom: 16,
            alignItems: "center",
          }}
        >
          <span style={{ fontSize: 13, color: "var(--fg-3)" }}>Filter:</span>
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            style={{
              fontSize: 13,
              padding: "4px 8px",
              background: "var(--bg-2)",
              border: "1px solid var(--line-2)",
              color: "var(--fg-1)",
              borderRadius: 6,
            }}
          >
            <option value="">All Projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            value={assigneeFilter}
            onChange={(e) => setAssigneeFilter(e.target.value)}
            style={{
              fontSize: 13,
              padding: "4px 8px",
              background: "var(--bg-2)",
              border: "1px solid var(--line-2)",
              color: "var(--fg-1)",
              borderRadius: 6,
            }}
          >
            <option value="">All Assignees</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          {(projectFilter || assigneeFilter) && (
            <button
              className="d3-btn d3-btn--ghost"
              type="button"
              style={{ fontSize: 12 }}
              onClick={() => {
                setProjectFilter("");
                setAssigneeFilter("");
              }}
            >
              Clear
            </button>
          )}
        </div>

        {tasks.length === 0 ? (
          <div
            style={{
              color: "var(--fg-3)",
              fontSize: 13,
              padding: "32px 0",
              textAlign: "center",
            }}
          >
            No tasks in progress
            {projectFilter || assigneeFilter ? " for the selected filters" : ""}
            .
          </div>
        ) : (
          Object.entries(grouped).map(([project, projectTasks]) => (
            <div key={project}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--fg-3)",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  margin: "20px 0 8px",
                }}
              >
                {project}
              </div>
              {projectTasks.map((t) => (
                <div
                  key={t.id}
                  className="d3-card"
                  style={{ padding: "12px 16px", marginBottom: 6 }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <div>
                      <button
                        type="button"
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: "var(--fg-0)",
                          fontSize: 14,
                          fontWeight: 500,
                          padding: 0,
                        }}
                        onClick={() => void navigate(`/tasks/${t.id}`)}
                      >
                        {t.title}
                      </button>
                      <span
                        style={{
                          fontSize: 12,
                          color: "var(--fg-4)",
                          marginLeft: 8,
                        }}
                      >
                        #{t.id}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "center",
                        flexShrink: 0,
                      }}
                    >
                      {t.assignee_name && (
                        <span style={{ fontSize: 12, color: "var(--fg-3)" }}>
                          {t.assignee_name}
                        </span>
                      )}
                      <span
                        style={{
                          fontSize: 11,
                          padding: "2px 7px",
                          borderRadius: 3,
                          border: `1px solid ${PRIORITY_COLORS[t.priority] ?? "var(--line-2)"}50`,
                          color: PRIORITY_COLORS[t.priority] ?? "var(--fg-3)",
                        }}
                      >
                        {t.priority}
                      </span>
                      <button
                        className="d3-btn d3-btn--ghost"
                        type="button"
                        style={{ fontSize: 12 }}
                        onClick={() => void navigate(`/tasks/${t.id}`)}
                      >
                        View
                      </button>
                    </div>
                  </div>
                  {t.started_date && (
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--fg-4)",
                        marginTop: 4,
                      }}
                    >
                      Started: {t.started_date}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </Shell>
  );
}
