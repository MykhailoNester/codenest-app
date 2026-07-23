import { useState, useRef, useLayoutEffect, type ReactElement } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  useTask,
  useTeamMembers,
  useTasks,
  useLookups,
  fetchSidecar,
} from "../lib/api";
import { Shell } from "../components/layout/shell";
import { DetailHeader } from "../components/layout/detail-header";
import { LaunchFromSourceButton } from "../components/launch/launch-from-source-button";

const PRIORITIES = ["high", "medium", "low"] as const;

export function TaskDetailPage(): ReactElement {
  const { id } = useParams<{ id: string }>();
  const taskId = parseInt(id ?? "0");
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: task } = useTask(taskId);
  const { data: members = [] } = useTeamMembers();
  const { data: allTasks = [] } = useTasks();
  const { data: lookups } = useLookups();
  const statuses = lookups?.statuses ?? [];
  const statusColors = lookups?.status_colors ?? {};
  const statusLabels: Record<string, string> = {};
  for (const e of lookups?.workflow_task_statuses ?? [])
    statusLabels[e.slug] = e.label;
  const priorityOptions =
    lookups?.workflow_task_priorities?.map((e) => ({
      value: e.slug,
      label: e.label,
    })) ?? PRIORITIES.map((p) => ({ value: p, label: p }));

  const [edits, setEdits] = useState<Partial<Record<string, string>>>({});
  const [saving, setSaving] = useState(false);
  const [blockerTaskId, setBlockerTaskId] = useState("");

  // Derived form: local edits take precedence, fall back to loaded task data
  const form = {
    title: edits.title ?? task?.title ?? "",
    description: edits.description ?? task?.description ?? "",
    status: edits.status ?? task?.status ?? "todo",
    priority: edits.priority ?? task?.priority ?? "medium",
    effort: edits.effort ?? task?.effort ?? "",
    assignee_id:
      edits.assignee_id ?? (task?.assignee_id ? String(task.assignee_id) : ""),
  };
  const setForm = (updates: Partial<Record<string, string>>) =>
    setEdits((prev) => ({ ...prev, ...updates }));

  const handleSave = async () => {
    setSaving(true);
    await fetchSidecar(`/api/v1/tasks/${taskId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: form.title,
        description: form.description || null,
        status: form.status,
        priority: form.priority,
        effort: form.effort || null,
        assignee_id: form.assignee_id ? parseInt(form.assignee_id) : null,
      }),
    });
    void qc.invalidateQueries({ queryKey: ["task", taskId] });
    void qc.invalidateQueries({ queryKey: ["tasks"] });
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!confirm("Delete this task?")) return;
    await fetchSidecar(`/api/v1/tasks/${taskId}`, { method: "DELETE" });
    void navigate("/tasks");
  };

  const handleAddBlocker = async () => {
    const parsed = parseInt(blockerTaskId, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) return;
    await fetchSidecar(`/api/v1/tasks/${taskId}/blockers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocking_task_id: parsed }),
    });
    void qc.invalidateQueries({ queryKey: ["task", taskId] });
    setBlockerTaskId("");
  };

  const handleRemoveBlocker = async (blockerId: number) => {
    await fetchSidecar(`/api/v1/tasks/${taskId}/blockers/${blockerId}`, {
      method: "DELETE",
    });
    void qc.invalidateQueries({ queryKey: ["task", taskId] });
  };

  const inputStyle = {
    width: "100%",
    padding: "6px 10px",
    background: "var(--bg-3)",
    border: "1px solid var(--line-2)",
    color: "var(--fg-0)",
    borderRadius: 6,
    fontSize: 13,
    boxSizing: "border-box" as const,
  };

  const descRef = useRef<HTMLTextAreaElement>(null);

  // Grow the description textarea to fit its content whenever the value changes.
  // useLayoutEffect fires synchronously after DOM update, so the initial server
  // value (which arrives after first render) expands the field without a flash.
  useLayoutEffect(() => {
    if (descRef.current) {
      descRef.current.style.height = "auto";
      descRef.current.style.height = `${descRef.current.scrollHeight}px`;
    }
  }, [form.description]);

  if (!task) {
    return (
      <Shell>
        <div
          style={{ padding: "0 24px 24px", color: "var(--fg-3)", fontSize: 13 }}
        >
          Loading task…
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div style={{ padding: "0 24px 24px" }}>
        <DetailHeader
          crumbs={`Workspace · Tasks · #${taskId}`}
          title={`Task #${taskId}`}
          fallbackRoute="/tasks"
          actions={
            <>
              <LaunchFromSourceButton
                kind="task"
                id={taskId}
                label="Launch agent"
                variant="primary"
              />
              <button
                className="d3-btn d3-btn--ghost"
                type="button"
                style={{ color: "#ef4444" }}
                onClick={() => void handleDelete()}
              >
                Delete
              </button>
            </>
          }
        />

        {/* Edit form */}
        <div
          className="d3-card"
          style={{ padding: "16px 20px", marginBottom: 16 }}
        >
          <div style={{ marginBottom: 10 }}>
            <label
              style={{
                fontSize: 11,
                color: "var(--fg-3)",
                display: "block",
                marginBottom: 4,
              }}
            >
              Title
            </label>
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              style={inputStyle}
            />
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
              ref={descRef}
              value={form.description}
              onChange={(e) => {
                setForm({ ...form, description: e.target.value });
                e.target.style.height = "auto";
                e.target.style.height = `${e.target.scrollHeight}px`;
              }}
              style={{
                ...inputStyle,
                minHeight: "calc(3 * 1.4em + 12px)",
                overflow: "hidden",
                resize: "none",
              }}
            />
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
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
                Status
              </label>
              <select
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value })}
                style={inputStyle}
              >
                {statuses.map((s) => (
                  <option key={s} value={s}>
                    {statusLabels[s] ?? s}
                  </option>
                ))}
              </select>
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
                Priority
              </label>
              <select
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: e.target.value })}
                style={inputStyle}
              >
                {priorityOptions.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
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
                Effort
              </label>
              <select
                value={form.effort}
                onChange={(e) => setForm({ ...form, effort: e.target.value })}
                style={inputStyle}
              >
                <option value="">—</option>
                <option value="small">Small</option>
                <option value="medium">Medium</option>
                <option value="large">Large</option>
              </select>
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label
              style={{
                fontSize: 11,
                color: "var(--fg-3)",
                display: "block",
                marginBottom: 4,
              }}
            >
              Assignee
            </label>
            <select
              value={form.assignee_id}
              onChange={(e) =>
                setForm({ ...form, assignee_id: e.target.value })
              }
              style={inputStyle}
            >
              <option value="">—</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <button
            className="d3-btn d3-btn--primary"
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>

        {/* Blockers */}
        <div
          className="d3-card"
          style={{ padding: "16px 20px", marginBottom: 16 }}
        >
          <span className="d3-h" style={{ display: "block", marginBottom: 12 }}>
            Blockers
          </span>
          {(task.blockers ?? []).length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--fg-3)", marginBottom: 12 }}>
              No blockers.
            </p>
          ) : (
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                marginBottom: 12,
              }}
            >
              <thead>
                <tr style={{ borderBottom: "1px solid var(--line-2)" }}>
                  {["Blocking Task", "Status", ""].map((h) => (
                    <th
                      key={h}
                      style={{
                        padding: "6px 8px",
                        fontSize: 11,
                        color: "var(--fg-3)",
                        textAlign: "left",
                        fontWeight: 600,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(task.blockers ?? []).map((b) => (
                  <tr
                    key={b.id}
                    style={{ borderBottom: "1px solid var(--line-1)" }}
                  >
                    <td style={{ padding: "6px 8px" }}>
                      <button
                        type="button"
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: "var(--accent)",
                          fontSize: 13,
                          padding: 0,
                        }}
                        onClick={() =>
                          void navigate(`/tasks/${b.blocking_task_id}`)
                        }
                      >
                        #{b.blocking_task_id} — {b.blocking_title}
                      </button>
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <span
                        style={{
                          fontSize: 11,
                          padding: "2px 6px",
                          borderRadius: 3,
                          border: `1px solid ${statusColors[b.blocking_status] ?? "var(--line-2)"}50`,
                          color:
                            statusColors[b.blocking_status] ?? "var(--fg-3)",
                        }}
                      >
                        {b.blocking_status}
                      </span>
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <button
                        className="d3-btn d3-btn--ghost"
                        type="button"
                        style={{ fontSize: 12, color: "#ef4444" }}
                        onClick={() => void handleRemoveBlocker(b.id)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}>
              <label
                style={{
                  fontSize: 11,
                  color: "var(--fg-3)",
                  display: "block",
                  marginBottom: 4,
                }}
              >
                Add Blocker
              </label>
              <select
                value={blockerTaskId}
                onChange={(e) => setBlockerTaskId(e.target.value)}
                style={inputStyle}
              >
                <option value="">Select task…</option>
                {allTasks
                  .filter((t) => t.id !== taskId)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      #{t.id} — {t.title}
                    </option>
                  ))}
              </select>
            </div>
            <button
              className="d3-btn d3-btn--primary"
              type="button"
              style={{ marginBottom: 0 }}
              onClick={() => void handleAddBlocker()}
            >
              Add
            </button>
          </div>
        </div>

        {/* Metadata */}
        <div style={{ fontSize: 12, color: "var(--fg-4)", marginTop: 8 }}>
          Created: {task.created_at?.slice(0, 16)}
          {task.started_date && ` | Started: ${task.started_date}`}
          {task.completed_date && ` | Completed: ${task.completed_date}`} |
          Updated: {task.updated_at?.slice(0, 16)}
        </div>
      </div>
    </Shell>
  );
}
