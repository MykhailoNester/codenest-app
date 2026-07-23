import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useInboxItems,
  useInboxCounts,
  useProjects,
  fetchSidecar,
  updateInboxItem,
  type InboxItem,
} from "../lib/api";
import { Shell } from "../components/layout/shell";
import { RowActionsMenu, type RowAction } from "../components/row-actions-menu";
import { InboxPromoteModal } from "../components/inbox-promote-modal";
import {
  detectItemSource,
  levenshtein,
  normalizeTitle,
} from "../lib/inbox-utils";
import { openPath } from "../lib/ipc";
import { LaunchFromSourceButton } from "../components/launch/launch-from-source-button";

const VIRTUAL_THRESHOLD = 50;
const ESTIMATED_ROW_PX = 110;

type InboxStatus = "inbox" | "done" | "rejected";
const TABS: InboxStatus[] = ["inbox", "done", "rejected"];

const PRIORITY_COLORS: Record<string, string> = {
  high: "#ef4444",
  urgent: "#a855f7",
  medium: "#f59e0b",
  low: "#22c55e",
};

interface EditDraft {
  title: string;
  description: string;
}

interface InboxCardCallbacks {
  navigate: (path: string) => void;
  changeStatus: (id: number, status: string) => void;
  delete: (id: number) => void;
  openPromote: (item: InboxItem) => void;
  startEdit: (item: InboxItem) => void;
  saveEdit: (id: number) => Promise<void>;
  cancelEdit: () => void;
}

interface InboxCardProps {
  item: InboxItem;
  isSelected: boolean;
  isEditing: boolean;
  editDraft: EditDraft;
  setEditDraft: (draft: EditDraft) => void;
  cb: InboxCardCallbacks;
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

function InboxCardInner({
  item,
  isSelected,
  isEditing,
  editDraft,
  setEditDraft,
  cb,
}: InboxCardProps): ReactElement {
  const source = detectItemSource(item.source, item.description);
  const [showFull, setShowFull] = useState(false);
  const DESC_LIMIT = 400;

  async function handleOpenSource(): Promise<void> {
    if (source.kind === "url") {
      window.open(source.value, "_blank", "noopener,noreferrer");
    } else if (source.kind === "path") {
      try {
        await openPath(source.value);
      } catch {
        await navigator.clipboard.writeText(source.value);
      }
    }
  }

  const actions: RowAction[] = [
    {
      label: "Open source",
      disabled: source.kind === null,
      onSelect: () => {
        void handleOpenSource();
      },
    },
    {
      label: "Promote",
      disabled: item.status !== "inbox",
      onSelect: () => cb.openPromote(item),
    },
    {
      label: "Edit inline",
      onSelect: () => cb.startEdit(item),
    },
    {
      label: "Archive",
      disabled: ["done", "rejected"].includes(item.status),
      onSelect: () => cb.changeStatus(item.id, "done"),
    },
    {
      label: "Reject",
      disabled: ["done", "rejected"].includes(item.status),
      danger: true,
      onSelect: () => cb.changeStatus(item.id, "rejected"),
    },
  ];

  const description = item.description ?? "";
  const displayDesc =
    !showFull && description.length > DESC_LIMIT
      ? description.slice(0, DESC_LIMIT)
      : description;

  return (
    <div
      className="d3-card"
      style={{
        padding: "14px 18px",
        borderLeft: isSelected
          ? "2px solid var(--accent)"
          : "2px solid transparent",
        transition: "border-color 0.1s",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
        }}
      >
        <div style={{ flex: 1 }}>
          {isEditing ? (
            <>
              <input
                autoFocus
                value={editDraft.title}
                onChange={(e) =>
                  setEditDraft({ ...editDraft, title: e.target.value })
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.metaKey) void cb.saveEdit(item.id);
                  if (e.key === "Escape") cb.cancelEdit();
                }}
                style={{
                  ...inputStyle,
                  fontWeight: 600,
                  fontSize: 14,
                  marginBottom: 6,
                }}
              />
              <textarea
                value={editDraft.description}
                rows={3}
                onChange={(e) =>
                  setEditDraft({ ...editDraft, description: e.target.value })
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.metaKey) void cb.saveEdit(item.id);
                  if (e.key === "Escape") cb.cancelEdit();
                }}
                style={{ ...inputStyle, resize: "vertical" }}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <button
                  className="d3-btn d3-btn--primary"
                  type="button"
                  style={{ fontSize: 12 }}
                  onClick={() => void cb.saveEdit(item.id)}
                >
                  Save
                </button>
                <button
                  className="d3-btn d3-btn--ghost"
                  type="button"
                  style={{ fontSize: 12 }}
                  onClick={cb.cancelEdit}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  marginBottom: 4,
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    fontWeight: 600,
                    color: "var(--fg-0)",
                    fontSize: 14,
                  }}
                >
                  {item.title}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    padding: "1px 6px",
                    borderRadius: 3,
                    border: `1px solid ${PRIORITY_COLORS[item.priority] ?? "var(--line-2)"}50`,
                    color: PRIORITY_COLORS[item.priority] ?? "var(--fg-3)",
                  }}
                >
                  {item.priority}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    padding: "1px 6px",
                    borderRadius: 3,
                    background: "rgba(255,255,255,0.04)",
                    color: "var(--fg-3)",
                    border: "1px solid var(--line-2)",
                  }}
                >
                  {item.type}
                </span>
                {item.project_name && (
                  <span
                    style={{
                      fontSize: 11,
                      padding: "1px 6px",
                      borderRadius: 3,
                      border: "1px solid rgba(59,130,246,0.3)",
                      color: "#60a5fa",
                    }}
                  >
                    {item.project_name}
                  </span>
                )}
                {item.source === "insight" && (
                  <span
                    title="Generated by the daily insights job"
                    style={{
                      fontSize: 11,
                      padding: "1px 6px",
                      borderRadius: 3,
                      border: "1px solid rgba(168,85,247,0.45)",
                      color: "#c084fc",
                      background: "rgba(168,85,247,0.08)",
                    }}
                  >
                    Insight
                  </span>
                )}
              </div>
              {description && (
                <p
                  style={{
                    fontSize: 13,
                    color: "var(--fg-2)",
                    margin: "4px 0",
                    lineHeight: 1.4,
                  }}
                >
                  {displayDesc}
                  {!showFull && description.length > DESC_LIMIT && (
                    <>
                      …{" "}
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
                        onClick={() => setShowFull(true)}
                      >
                        show more
                      </button>
                    </>
                  )}
                  {showFull && description.length > DESC_LIMIT && (
                    <>
                      {" "}
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
                        onClick={() => setShowFull(false)}
                      >
                        show less
                      </button>
                    </>
                  )}
                </p>
              )}
              {item.source && (
                <p style={{ fontSize: 12, color: "var(--fg-4)" }}>
                  Source: {item.source}
                </p>
              )}
              <p style={{ fontSize: 11, color: "var(--fg-4)", marginTop: 4 }}>
                Submitted:{" "}
                {(item.submitted_date ?? item.created_at).slice(0, 16)}
                {item.task_id && (
                  <>
                    {" "}
                    | Linked to{" "}
                    <button
                      type="button"
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        color: "var(--accent)",
                        fontSize: 11,
                        padding: 0,
                      }}
                      onClick={() => cb.navigate(`/tasks/${item.task_id}`)}
                    >
                      Task #{item.task_id}
                    </button>
                  </>
                )}
              </p>
            </>
          )}
        </div>

        <div
          style={{
            flexShrink: 0,
            marginLeft: 12,
            display: "flex",
            alignItems: "flex-start",
            gap: 6,
          }}
        >
          <LaunchFromSourceButton kind="inbox" id={item.id} label="Launch" />
          <RowActionsMenu actions={actions} />
        </div>
      </div>
    </div>
  );
}
const InboxCard = memo(InboxCardInner);

function VirtualInboxList({
  items,
  selectedIndex,
  editId,
  editDraft,
  setEditDraft,
  cb,
  focusIndex,
}: {
  items: InboxItem[];
  selectedIndex: number | null;
  editId: number | null;
  editDraft: EditDraft;
  setEditDraft: (d: EditDraft) => void;
  cb: InboxCardCallbacks;
  focusIndex?: number | null;
}): ReactElement {
  const parentRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ESTIMATED_ROW_PX,
    overscan: 6,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  useEffect(() => {
    if (focusIndex != null && focusIndex >= 0 && focusIndex < items.length) {
      virtualizer.scrollToIndex(focusIndex, { align: "start" });
    }
    // Run only once when focusIndex first resolves alongside items
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusIndex, items.length > 0]);

  return (
    <div ref={parentRef} style={{ height: 700, overflowY: "auto" }}>
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: "relative",
          width: "100%",
        }}
      >
        {virtualizer.getVirtualItems().map((vRow) => {
          const item = items[vRow.index]!;
          return (
            <div
              key={item.id}
              data-index={vRow.index}
              ref={(el) => {
                if (el) virtualizer.measureElement(el);
              }}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${vRow.start}px)`,
                paddingBottom: 10,
              }}
            >
              <InboxCard
                item={item}
                isSelected={selectedIndex === vRow.index}
                isEditing={editId === item.id}
                editDraft={editDraft}
                setEditDraft={setEditDraft}
                cb={cb}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ShortcutsOverlay({ onClose }: { onClose: () => void }): ReactElement {
  const shortcuts = [
    { key: "j / k", desc: "Move row selection" },
    { key: "Enter", desc: "Promote selected item to task" },
    { key: "e", desc: "Edit selected item inline" },
    { key: "a", desc: "Archive selected item" },
    { key: "r", desc: "Reject selected item" },
    { key: "?", desc: "Toggle this overlay" },
    { key: "Esc", desc: "Close modal / cancel edit" },
  ];
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
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
          minWidth: 340,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 16,
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-0)" }}>
            Keyboard Shortcuts
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
        {shortcuts.map(({ key, desc }) => (
          <div
            key={key}
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: 10,
            }}
          >
            <code
              style={{
                background: "var(--bg-3)",
                padding: "2px 6px",
                borderRadius: 4,
                fontSize: 12,
                color: "var(--fg-0)",
              }}
            >
              {key}
            </code>
            <span style={{ fontSize: 13, color: "var(--fg-2)" }}>{desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function InboxPage(): ReactElement {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();

  // ?focus=<id> deep-link: highlight + scroll to the item (from notification bell click)
  const focusIdParam = searchParams.get("focus");
  const focusId = focusIdParam !== null ? parseInt(focusIdParam, 10) : null;

  const [activeTab, setActiveTab] = useState<InboxStatus>("inbox");
  const [projectFilter, setProjectFilter] = useState<number | undefined>(
    undefined,
  );
  const [showCreate, setShowCreate] = useState(false);
  const [promoteItem, setPromoteItem] = useState<InboxItem | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft>({
    title: "",
    description: "",
  });
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [form, setForm] = useState({
    title: "",
    description: "",
    type: "action",
    priority: "medium",
    source: "",
    project_id: "",
  });

  const { data: items = [] } = useInboxItems(activeTab, projectFilter);

  // Once items load, resolve the focused item's index and pre-select it.
  // This synchronises external state (the URL param) with React state exactly
  // once, which is the intended use of useEffect for external-source sync.
  const focusApplied = useRef(false);
  useEffect(() => {
    if (focusId === null || focusApplied.current || items.length === 0) return;
    const idx = items.findIndex((item) => item.id === focusId);
    if (idx !== -1) {
      focusApplied.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedIndex(idx);
    }
  }, [focusId, items]);
  const { data: counts } = useInboxCounts();
  const { data: projects = [] } = useProjects();

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["inbox"] });
    void qc.invalidateQueries({ queryKey: ["inbox-counts"] });
  }, [qc]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }, []);

  const handleCreate = async () => {
    if (!form.title.trim()) return;

    if (items.length < 200) {
      const norm = normalizeTitle(form.title);
      const dupe = items.find(
        (i) => levenshtein(normalizeTitle(i.title), norm) <= 3,
      );
      if (dupe)
        showToast(`Similar item already in inbox — #${dupe.id}: ${dupe.title}`);
    }

    await fetchSidecar("/api/v1/inbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: form.title,
        description: form.description || null,
        type: form.type,
        priority: form.priority,
        source: form.source || null,
        project_id: form.project_id ? parseInt(form.project_id) : null,
      }),
    });
    invalidate();
    setShowCreate(false);
    setForm({
      title: "",
      description: "",
      type: "action",
      priority: "medium",
      source: "",
      project_id: "",
    });
  };

  const handleStatus = async (itemId: number, status: string) => {
    await fetchSidecar(`/api/v1/inbox/${itemId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    invalidate();
  };

  const handleDelete = async (itemId: number) => {
    if (!confirm("Delete this item?")) return;
    await fetchSidecar(`/api/v1/inbox/${itemId}`, { method: "DELETE" });
    invalidate();
    if (selectedIndex !== null && selectedIndex >= items.length - 1) {
      setSelectedIndex(items.length > 1 ? items.length - 2 : null);
    }
  };

  const handleSaveEdit = async (itemId: number) => {
    await updateInboxItem(itemId, {
      title: editDraft.title,
      description: editDraft.description,
    });
    invalidate();
    setEditId(null);
  };

  const handleStartEdit = (item: InboxItem) => {
    if (editId !== null && editId !== item.id) {
      void handleSaveEdit(editId);
    }
    setEditDraft({ title: item.title, description: item.description ?? "" });
    setEditId(item.id);
    setPromoteItem(null);
  };

  const handleOpenPromote = (item: InboxItem) => {
    setPromoteItem(item);
    setEditId(null);
  };

  const isInteractive = () => {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select";
  };

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (showShortcuts && e.key === "Escape") {
        setShowShortcuts(false);
        return;
      }
      if (promoteItem && e.key === "Escape") {
        setPromoteItem(null);
        return;
      }
      if (editId !== null && e.key === "Escape") {
        setEditId(null);
        return;
      }
      if (isInteractive()) return;

      if (e.key === "j") {
        e.preventDefault();
        setSelectedIndex((prev) =>
          items.length === 0
            ? null
            : prev === null
              ? 0
              : (prev + 1) % items.length,
        );
      } else if (e.key === "k") {
        e.preventDefault();
        setSelectedIndex((prev) =>
          items.length === 0
            ? null
            : prev === null
              ? items.length - 1
              : (prev - 1 + items.length) % items.length,
        );
      } else if (e.key === "Enter" && selectedIndex !== null) {
        const item = items[selectedIndex];
        if (item?.status === "inbox") {
          setPromoteItem(item);
          setEditId(null);
        }
      } else if (e.key === "e" && selectedIndex !== null) {
        const item = items[selectedIndex];
        if (item) {
          setEditDraft({
            title: item.title,
            description: item.description ?? "",
          });
          setEditId(item.id);
          setPromoteItem(null);
        }
      } else if (e.key === "a" && selectedIndex !== null) {
        const item = items[selectedIndex];
        if (item && !["done", "rejected"].includes(item.status)) {
          void fetchSidecar(`/api/v1/inbox/${item.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "done" }),
          }).then(() => invalidate());
        }
      } else if (e.key === "r" && selectedIndex !== null) {
        const item = items[selectedIndex];
        if (item && !["done", "rejected"].includes(item.status)) {
          void fetchSidecar(`/api/v1/inbox/${item.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "rejected" }),
          }).then(() => invalidate());
        }
      } else if (e.key === "?") {
        e.preventDefault();
        setShowShortcuts((v) => !v);
      }
    }

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [items, selectedIndex, editId, promoteItem, showShortcuts, invalidate]);

  const inputStyle2 = {
    width: "100%",
    padding: "6px 10px",
    background: "var(--bg-3)",
    border: "1px solid var(--line-2)",
    color: "var(--fg-0)",
    borderRadius: 6,
    fontSize: 13,
    boxSizing: "border-box" as const,
  };

  // Latest-ref pattern for stable useMemo callbacks: keeps cardCallbacks
  // identity stable for memo'd children while always routing to the freshest closure.
  const navigateRef = useRef(navigate);
  const handleStatusRef = useRef(handleStatus);
  const handleDeleteRef = useRef(handleDelete);
  const handleSaveEditRef = useRef(handleSaveEdit);
  const handleStartEditRef = useRef(handleStartEdit);
  const handleOpenPromoteRef = useRef(handleOpenPromote);
  useEffect(() => {
    navigateRef.current = navigate;
    handleStatusRef.current = handleStatus;
    handleDeleteRef.current = handleDelete;
    handleSaveEditRef.current = handleSaveEdit;
    handleStartEditRef.current = handleStartEdit;
    handleOpenPromoteRef.current = handleOpenPromote;
  });

  const cardCallbacks = useMemo<InboxCardCallbacks>(
    () => ({
      navigate: (path) => void navigateRef.current(path),
      changeStatus: (id, status) => void handleStatusRef.current(id, status),
      delete: (id) => void handleDeleteRef.current(id),
      openPromote: (item) => handleOpenPromoteRef.current(item),
      startEdit: (item) => handleStartEditRef.current(item),
      saveEdit: (id) => handleSaveEditRef.current(id),
      cancelEdit: () => setEditId(null),
    }),
    [],
  );

  return (
    <Shell
      actions={
        <>
          <button
            className="d3-btn d3-btn--ghost"
            type="button"
            style={{ fontSize: 12, color: "var(--fg-3)" }}
            onClick={() => setShowShortcuts(true)}
          >
            ?
          </button>
          <button
            className="d3-btn d3-btn--primary"
            type="button"
            onClick={() => setShowCreate(!showCreate)}
          >
            + New Item
          </button>
        </>
      }
    >
      <div style={{ padding: "0 24px 24px" }}>
        {toast && (
          <div
            style={{
              position: "fixed",
              top: 20,
              right: 24,
              zIndex: 10001,
              background: "var(--bg-2)",
              border: "1px solid var(--line-2)",
              borderRadius: 8,
              padding: "10px 16px",
              fontSize: 13,
              color: "var(--fg-1)",
              boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
              maxWidth: 360,
            }}
          >
            {toast}
          </div>
        )}

        {showCreate && (
          <div
            className="d3-card"
            style={{ padding: "16px 20px", marginBottom: 16 }}
          >
            <span
              className="d3-h"
              style={{ display: "block", marginBottom: 12 }}
            >
              New Inbox Item
            </span>
            <div style={{ marginBottom: 10 }}>
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
                placeholder="What needs to be done..."
                style={inputStyle2}
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
                  Type
                </label>
                <select
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value })}
                  style={inputStyle2}
                >
                  {["action", "research", "idea", "decision"].map((t) => (
                    <option key={t} value={t}>
                      {t}
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
                  onChange={(e) =>
                    setForm({ ...form, priority: e.target.value })
                  }
                  style={inputStyle2}
                >
                  {["high", "medium", "low"].map((p) => (
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
                  Project
                </label>
                <select
                  value={form.project_id}
                  onChange={(e) =>
                    setForm({ ...form, project_id: e.target.value })
                  }
                  style={inputStyle2}
                >
                  <option value="">—</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
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
                Description
              </label>
              <textarea
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
                rows={2}
                style={{ ...inputStyle2, resize: "vertical" }}
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
                Source
              </label>
              <input
                value={form.source}
                onChange={(e) => setForm({ ...form, source: e.target.value })}
                placeholder="e.g., TASK-001 / https://..."
                style={inputStyle2}
              />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="d3-btn d3-btn--primary"
                type="button"
                onClick={() => void handleCreate()}
              >
                Add Item
              </button>
              <button
                className="d3-btn d3-btn--ghost"
                type="button"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 16,
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", gap: 2 }}>
            {TABS.map((tab) => (
              <button
                key={tab}
                type="button"
                className={`d3-tag${activeTab === tab ? " is-on" : ""}`}
                onClick={() => setActiveTab(tab)}
              >
                {tab} {counts ? `(${counts[tab]})` : ""}
              </button>
            ))}
          </div>
          <select
            value={projectFilter ?? ""}
            onChange={(e) =>
              setProjectFilter(
                e.target.value ? parseInt(e.target.value) : undefined,
              )
            }
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
        </div>

        {items.length === 0 ? (
          <div
            style={{
              color: "var(--fg-3)",
              fontSize: 13,
              padding: "32px 0",
              textAlign: "center",
            }}
          >
            No items in {activeTab}
            {projectFilter ? " for selected project" : ""}.
          </div>
        ) : items.length >= VIRTUAL_THRESHOLD ? (
          <VirtualInboxList
            items={items}
            selectedIndex={selectedIndex}
            editId={editId}
            editDraft={editDraft}
            setEditDraft={setEditDraft}
            cb={cardCallbacks}
            focusIndex={
              focusId !== null ? items.findIndex((i) => i.id === focusId) : null
            }
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {items.map((item, idx) => (
              <div
                key={item.id}
                data-item-id={item.id}
                ref={
                  item.id === focusId
                    ? (el) => {
                        el?.scrollIntoView({
                          block: "nearest",
                          behavior: "smooth",
                        });
                      }
                    : undefined
                }
              >
                <InboxCard
                  item={item}
                  isSelected={selectedIndex === idx}
                  isEditing={editId === item.id}
                  editDraft={editDraft}
                  setEditDraft={setEditDraft}
                  cb={cardCallbacks}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {promoteItem && (
        <InboxPromoteModal
          itemId={promoteItem.id}
          initialProjectId={promoteItem.project_id}
          initialPriority={promoteItem.priority}
          onClose={() => setPromoteItem(null)}
          onSuccess={() => {
            setPromoteItem(null);
            invalidate();
          }}
        />
      )}

      {showShortcuts && (
        <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />
      )}
    </Shell>
  );
}
