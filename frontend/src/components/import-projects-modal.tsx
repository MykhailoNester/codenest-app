import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useEscapeKey } from "../hooks/use-escape-key";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  useScanProjects,
  useRichImportProjects,
  useProfiles,
  type DiscoveryCandidate,
  type ProfileOut,
} from "../lib/api";

interface ImportProjectsModalProps {
  onClose: () => void;
  onImported: (imported: number) => void;
  /** Pre-selected profile to attach imported projects to. */
  defaultProfileId?: number | null;
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const panelStyle: React.CSSProperties = {
  width: "min(720px, 92vw)",
  maxHeight: "82vh",
  display: "flex",
  flexDirection: "column",
  background: "var(--bg-2)",
  border: "1px solid var(--line-2)",
  borderRadius: 10,
  boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 16px",
  borderBottom: "1px solid var(--line-3)",
};

export function ImportProjectsModal({
  onClose,
  onImported,
  defaultProfileId = null,
}: ImportProjectsModalProps): ReactElement {
  const scan = useScanProjects();
  // Use the rich import so every new project gets scanned, has root_path
  // populated, and agents/skills are auto-enabled (D3).
  const richImport = useRichImportProjects();
  const { data: profiles = [] } = useProfiles();
  // Show profile selector only when more than one profile exists.
  const showProfileSelector = profiles.length > 1;
  const [profileId, setProfileId] = useState<number | null>(defaultProfileId);
  const [candidates, setCandidates] = useState<DiscoveryCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hint, setHint] = useState<string | null>(null);

  // Trigger initial auto-scan on modal open (no one-shot guard — the user can
  // also re-run discovery by clicking "Rescan").
  useEffect(() => {
    scan.mutate(undefined, {
      onSuccess: (data) => {
        setCandidates(data.candidates);
        setSelected(
          new Set(
            data.candidates
              .filter((c) => !c.already_imported)
              .map((c) => c.path),
          ),
        );
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEscapeKey(onClose);

  const importable = useMemo(
    () => candidates.filter((c) => !c.already_imported),
    [candidates],
  );

  function toggle(path: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function handlePickFolder(): Promise<void> {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    if (candidates.some((c) => c.path === picked)) {
      setHint(`Already in the list: ${picked}`);
      return;
    }
    const manual: DiscoveryCandidate = {
      name: picked.split(/[\\/]/).filter(Boolean).pop() ?? picked,
      path: picked,
      stack: null,
      git: false,
      tools: [],
      git_remote: null,
      already_imported: false,
    };
    setCandidates((prev) => [manual, ...prev]);
    setSelected((prev) => new Set(prev).add(picked));
    setHint(null);
  }

  function handleRescan(): void {
    scan.mutate(undefined, {
      onSuccess: (data) => {
        setCandidates(data.candidates);
        // Re-select all not-yet-imported entries.
        setSelected(
          new Set(
            data.candidates
              .filter((c) => !c.already_imported)
              .map((c) => c.path),
          ),
        );
        setHint(null);
      },
    });
  }

  function handleImport(): void {
    const items = candidates
      .filter((c) => selected.has(c.path) && !c.already_imported)
      .map((c) => ({
        path: c.path,
        name: c.name,
        stack: c.stack ?? null,
        ...(profileId != null ? { profile_id: profileId } : {}),
      }));
    if (items.length === 0) return;
    richImport.mutate(items, {
      onSuccess: (data) => {
        if (data.errors.length > 0) {
          // Surface per-item warnings without blocking the success flow.
          console.warn("Import warnings:", data.errors);
        }
        onImported(data.imported);
        onClose();
      },
    });
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid var(--line-2)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <div
              style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-0)" }}
            >
              Import Projects
            </div>
            <div style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 2 }}>
              Scanned common folders for git repos and recognised manifests.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="d3-btn d3-btn--ghost"
              type="button"
              onClick={() => void handlePickFolder()}
              disabled={scan.isPending}
            >
              Pick folder...
            </button>
            <button
              className="d3-btn d3-btn--ghost"
              type="button"
              onClick={handleRescan}
              disabled={scan.isPending}
            >
              {scan.isPending ? "Scanning..." : "Rescan"}
            </button>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto" }}>
          {scan.isPending ? (
            <div
              style={{ padding: 32, textAlign: "center", color: "var(--fg-3)" }}
            >
              Scanning...
            </div>
          ) : scan.isError ? (
            <div style={{ padding: 32, textAlign: "center", color: "#ef4444" }}>
              Scan failed: {scan.error.message}
            </div>
          ) : candidates.length === 0 ? (
            <div
              style={{ padding: 32, textAlign: "center", color: "var(--fg-3)" }}
            >
              No projects found in the default roots. Use "Pick folder..." to
              add one manually.
            </div>
          ) : (
            candidates.map((c) => {
              const checked = selected.has(c.path);
              return (
                <label
                  key={c.path}
                  style={{
                    ...rowStyle,
                    cursor: c.already_imported ? "not-allowed" : "pointer",
                    opacity: c.already_imported ? 0.55 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={c.already_imported}
                    onChange={() => toggle(c.path)}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        color: "var(--fg-0)",
                        fontWeight: 500,
                      }}
                    >
                      {c.name}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--fg-4)",
                        fontFamily: "monospace",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {c.path}
                    </div>
                  </div>
                  {c.stack && (
                    <span
                      style={{
                        fontSize: 11,
                        padding: "1px 7px",
                        borderRadius: 4,
                        border: "1px solid var(--line-2)",
                        color: "var(--fg-3)",
                      }}
                    >
                      {c.stack}
                    </span>
                  )}
                  {c.git && (
                    <span
                      style={{
                        fontSize: 11,
                        padding: "1px 7px",
                        borderRadius: 4,
                        border: "1px solid rgba(34,197,94,0.3)",
                        color: "#22c55e",
                      }}
                    >
                      git
                    </span>
                  )}
                  {c.already_imported && (
                    <span style={{ fontSize: 11, color: "var(--fg-4)" }}>
                      already imported
                    </span>
                  )}
                </label>
              );
            })
          )}
        </div>

        <div
          style={{
            padding: "12px 18px",
            borderTop: "1px solid var(--line-2)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: "var(--fg-3)" }}>
              {hint
                ? hint
                : importable.length === 0
                  ? "Nothing new to import."
                  : `${selected.size} of ${importable.length} selected`}
            </div>
            {showProfileSelector && (
              <select
                value={profileId ?? ""}
                onChange={(e) =>
                  setProfileId(e.target.value ? Number(e.target.value) : null)
                }
                style={{
                  padding: "3px 8px",
                  background: "var(--bg-3)",
                  border: "1px solid var(--line-2)",
                  color: "var(--fg-0)",
                  borderRadius: 5,
                  fontSize: 12,
                }}
                title="Profile group for imported projects"
              >
                <option value="">Default profile</option>
                {profiles.map((pr: ProfileOut) => (
                  <option key={pr.id} value={pr.id}>
                    {pr.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="d3-btn d3-btn--ghost"
              type="button"
              onClick={onClose}
              disabled={richImport.isPending}
            >
              Cancel
            </button>
            <button
              className="d3-btn d3-btn--primary"
              type="button"
              onClick={handleImport}
              disabled={
                richImport.isPending ||
                selected.size === 0 ||
                importable.length === 0
              }
            >
              {richImport.isPending
                ? "Importing..."
                : `Import ${selected.size}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
