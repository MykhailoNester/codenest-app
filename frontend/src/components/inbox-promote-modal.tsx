import { useState, useEffect, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useProjects, useTeamMembers, SIDECAR_BASE_URL } from "../lib/api";
import { LaunchFromSourceButton } from "./launch/launch-from-source-button";

interface PromoteForm {
  project_id: string;
  priority: string;
  assignee_id: string;
  notes: string;
}

interface InboxPromoteModalProps {
  itemId: number;
  initialProjectId: number | null;
  initialPriority: string;
  onClose: () => void;
  onSuccess: (taskId: number) => void;
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 10px",
  background: "var(--bg-3)",
  border: "1px solid var(--line-2)",
  color: "var(--fg-0)",
  borderRadius: 6,
  fontSize: 13,
  boxSizing: "border-box",
};

export function InboxPromoteModal({
  itemId,
  initialProjectId,
  initialPriority,
  onClose,
  onSuccess,
}: InboxPromoteModalProps): ReactElement {
  const qc = useQueryClient();
  const { data: projects = [] } = useProjects();
  const { data: members = [] } = useTeamMembers();

  const [form, setForm] = useState<PromoteForm>({
    project_id: initialProjectId ? String(initialProjectId) : "",
    priority: initialPriority || "medium",
    assignee_id: "",
    notes: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && e.metaKey) void handleSubmit();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  async function handleSubmit(): Promise<void> {
    if (!form.project_id) return;
    setSubmitting(true);
    setError(null);
    try {
      const resp = await fetch(
        `${SIDECAR_BASE_URL}/api/v1/inbox/${itemId}/promote`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            project_id: parseInt(form.project_id),
            priority: form.priority || undefined,
            assignee_id: form.assignee_id
              ? parseInt(form.assignee_id)
              : undefined,
            notes: form.notes || undefined,
          }),
        },
      );
      if (resp.status === 400) {
        const body = (await resp.json()) as { detail: string };
        setError(body.detail);
        return;
      }
      if (!resp.ok) {
        setError(`Server error: ${resp.status}`);
        return;
      }
      const data = (await resp.json()) as { task_id: number };
      void qc.invalidateQueries({ queryKey: ["inbox"] });
      void qc.invalidateQueries({ queryKey: ["inbox-counts"] });
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      onSuccess(data.task_id);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        zIndex: 10000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--line-2)",
          borderRadius: 10,
          padding: "24px 28px",
          width: 480,
          maxWidth: "90vw",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 18,
          }}
        >
          <span style={{ fontSize: 16, fontWeight: 600, color: "var(--fg-0)" }}>
            Promote to Task
          </span>
          <button
            type="button"
            style={{
              background: "none",
              border: "none",
              color: "var(--fg-3)",
              cursor: "pointer",
              fontSize: 18,
            }}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label
            style={{
              fontSize: 11,
              color: "var(--fg-3)",
              display: "block",
              marginBottom: 4,
            }}
          >
            Project *
          </label>
          <select
            value={form.project_id}
            onChange={(e) => setForm({ ...form, project_id: e.target.value })}
            style={inputStyle}
          >
            <option value="">— select project —</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {error && (
            <p style={{ fontSize: 12, color: "#ef4444", marginTop: 4 }}>
              {error}
            </p>
          )}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 12,
            marginBottom: 14,
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
              Priority
            </label>
            <select
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: e.target.value })}
              style={inputStyle}
            >
              {["low", "medium", "high", "urgent"].map((p) => (
                <option key={p} value={p}>
                  {p}
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
              Assignee
            </label>
            <select
              value={form.assignee_id}
              onChange={(e) =>
                setForm({ ...form, assignee_id: e.target.value })
              }
              style={inputStyle}
            >
              <option value="">— unassigned —</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ marginBottom: 18 }}>
          <label
            style={{
              fontSize: 11,
              color: "var(--fg-3)",
              display: "block",
              marginBottom: 4,
            }}
          >
            Notes (optional)
          </label>
          <textarea
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            rows={3}
            placeholder="Additional context appended to the task description..."
            style={{ ...inputStyle, resize: "vertical" }}
          />
        </div>

        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            flexWrap: "wrap",
          }}
        >
          <button
            className="d3-btn d3-btn--ghost"
            type="button"
            onClick={onClose}
          >
            Cancel
          </button>
          <LaunchFromSourceButton
            kind="inbox"
            id={itemId}
            label="Launch agent"
          />
          <button
            className="d3-btn d3-btn--primary"
            type="button"
            disabled={!form.project_id || submitting}
            onClick={() => void handleSubmit()}
          >
            {submitting ? "Creating…" : "Create Task"}
          </button>
        </div>
      </div>
    </div>
  );
}
