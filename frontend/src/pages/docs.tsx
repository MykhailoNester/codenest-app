import { useState, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useDocuments, useLookups, fetchSidecar } from "../lib/api";
import { Shell } from "../components/layout/shell";
import { DocRowActionsMenu } from "../components/doc-row-actions-menu";
import { DocPreviewModal } from "../components/doc-preview-modal";

export function DocsPage(): ReactElement {
  const qc = useQueryClient();
  const [categoryFilter, setCategoryFilter] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    title: "",
    category: "report",
    file_path: "",
    summary: "",
  });
  const [previewDoc, setPreviewDoc] = useState<{
    filePath: string;
    title: string;
  } | null>(null);

  const { data: docs = [] } = useDocuments(categoryFilter);
  const { data: lookups } = useLookups();
  const categories = lookups?.document_categories ?? [];
  const catColors = lookups?.document_category_colors ?? {};

  const handleCreate = async () => {
    if (!form.title.trim() || !form.file_path.trim()) return;
    await fetchSidecar("/api/v1/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: form.title,
        category: form.category,
        file_path: form.file_path,
        summary: form.summary || null,
      }),
    });
    void qc.invalidateQueries({ queryKey: ["documents"] });
    setShowForm(false);
    setForm({ title: "", category: "report", file_path: "", summary: "" });
  };

  const handleDelete = async (docId: number) => {
    if (!confirm("Remove this document reference?")) return;
    await fetchSidecar(`/api/v1/documents/${docId}`, { method: "DELETE" });
    void qc.invalidateQueries({ queryKey: ["documents"] });
  };

  // Group by category
  const grouped: Record<string, typeof docs> = {};
  for (const d of docs) {
    if (!grouped[d.category]) grouped[d.category] = [];
    grouped[d.category]!.push(d);
  }

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

  return (
    <Shell
      actions={
        <button
          className="d3-btn d3-btn--primary"
          type="button"
          onClick={() => setShowForm(!showForm)}
        >
          + Register Document
        </button>
      }
    >
      <div style={{ padding: "0 24px 24px" }}>
        {showForm && (
          <div
            className="d3-card"
            style={{ padding: "16px 20px", marginBottom: 16 }}
          >
            <span
              className="d3-h"
              style={{ display: "block", marginBottom: 12 }}
            >
              Register Document
            </span>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "2fr 1fr",
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
                  Title *
                </label>
                <input
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="Document title..."
                  style={inputStyle}
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
                  Category
                </label>
                <select
                  value={form.category}
                  onChange={(e) =>
                    setForm({ ...form, category: e.target.value })
                  }
                  style={inputStyle}
                >
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
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
                File Path *
              </label>
              <input
                value={form.file_path}
                onChange={(e) =>
                  setForm({ ...form, file_path: e.target.value })
                }
                placeholder="docs/reports/report.md"
                style={inputStyle}
              />
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
                Summary
              </label>
              <textarea
                value={form.summary}
                onChange={(e) => setForm({ ...form, summary: e.target.value })}
                rows={2}
                placeholder="Brief description..."
                style={{ ...inputStyle, resize: "vertical" }}
              />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="d3-btn d3-btn--primary"
                type="button"
                onClick={() => void handleCreate()}
              >
                Register
              </button>
              <button
                className="d3-btn d3-btn--ghost"
                type="button"
                onClick={() => setShowForm(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Category filter pills */}
        <div
          style={{
            display: "flex",
            gap: 6,
            marginBottom: 16,
            flexWrap: "wrap",
          }}
        >
          <button
            className={`d3-tag${!categoryFilter ? " is-on" : ""}`}
            type="button"
            onClick={() => setCategoryFilter("")}
          >
            All
          </button>
          {categories.map((c) => (
            <button
              key={c}
              className={`d3-tag${categoryFilter === c ? " is-on" : ""}`}
              type="button"
              onClick={() => setCategoryFilter(c)}
            >
              {c}
            </button>
          ))}
        </div>

        {Object.keys(grouped).length === 0 ? (
          <div
            style={{
              color: "var(--fg-3)",
              fontSize: 13,
              padding: "32px 0",
              textAlign: "center",
            }}
          >
            No documents registered yet.
          </div>
        ) : (
          Object.entries(grouped).map(([cat, catDocs]) => (
            <div
              key={cat}
              className="d3-card"
              style={{ padding: 0, overflow: "hidden", marginBottom: 16 }}
            >
              <div
                style={{
                  padding: "10px 16px",
                  borderBottom: "1px solid var(--line-2)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    padding: "2px 7px",
                    borderRadius: 4,
                    border: `1px solid ${catColors[cat] ?? "var(--line-2)"}50`,
                    color: catColors[cat] ?? "var(--fg-3)",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  {cat}
                </span>
                <span style={{ fontSize: 12, color: "var(--fg-4)" }}>
                  {catDocs.length} docs
                </span>
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--line-2)" }}>
                    {["Title", "File Path", "Author", "Created", ""].map(
                      (h) => (
                        <th
                          key={h}
                          style={{
                            padding: "7px 12px",
                            fontSize: 11,
                            color: "var(--fg-3)",
                            textAlign: "left",
                            fontWeight: 600,
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                          }}
                        >
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {catDocs.map((d) => (
                    <tr
                      key={d.id}
                      style={{ borderBottom: "1px solid var(--line-1)" }}
                    >
                      <td
                        style={{
                          padding: "9px 12px",
                          fontSize: 13,
                          color: "var(--fg-0)",
                          fontWeight: 500,
                        }}
                      >
                        {d.title}
                      </td>
                      <td
                        style={{
                          padding: "9px 12px",
                          fontSize: 11,
                          color: "var(--fg-4)",
                          fontFamily: "var(--font-mono)",
                        }}
                      >
                        {d.file_path}
                        {d.exists === false && (
                          <span
                            title="File not found at registered path. Use Locate… to update."
                            style={{
                              marginLeft: 6,
                              border: "1px solid #ef444499",
                              color: "#ef444499",
                              borderRadius: 4,
                              fontSize: 10,
                              padding: "1px 5px",
                            }}
                          >
                            missing
                          </span>
                        )}
                      </td>
                      <td
                        style={{
                          padding: "9px 12px",
                          fontSize: 13,
                          color: "var(--fg-3)",
                        }}
                      >
                        {d.author_name ?? "—"}
                      </td>
                      <td
                        style={{
                          padding: "9px 12px",
                          fontSize: 12,
                          color: "var(--fg-4)",
                        }}
                      >
                        {d.created_at?.slice(0, 10)}
                      </td>
                      <td style={{ padding: "9px 12px" }}>
                        <DocRowActionsMenu
                          docId={d.id}
                          filePath={d.file_path}
                          exists={d.exists}
                          onDelete={() => void handleDelete(d.id)}
                          onPreview={() =>
                            setPreviewDoc({
                              filePath: d.file_path,
                              title: d.title,
                            })
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))
        )}
      </div>

      {previewDoc !== null && (
        <DocPreviewModal
          filePath={previewDoc.filePath}
          title={previewDoc.title}
          onClose={() => setPreviewDoc(null)}
        />
      )}
    </Shell>
  );
}
