import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useEscapeKey } from "../hooks/use-escape-key";
import { pickDirectory } from "../lib/ipc";
import {
  useScanProjects,
  useRichImportProjects,
  useProfiles,
  useSystemInfo,
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

/** Scan depth for the modal: four levels below the chosen root. Four, not
 * three, because the default root is the home directory and a repo that sits
 * at e.g. `~/Documents/Work/Acme` only reveals the repos nested inside it on
 * the level below that. */
const SCAN_MAX_DEPTH = 4;

/** Build a placeholder row for a manually added folder that hasn't (yet)
 * been confirmed by a scan — no stack/tools/git metadata is known for it. */
function manualCandidate(path: string): DiscoveryCandidate {
  return {
    name: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
    path,
    stack: null,
    git: false,
    tools: [],
    git_remote: null,
    already_imported: false,
  };
}

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
  const { data: systemInfo } = useSystemInfo();
  // The scan root: a folder the user picked, or the sidecar's home directory
  // once /api/v1/system/info answers. Derived (not an effect-driven state) so
  // there is no render where it lags behind either source.
  const [pickedRoot, setPickedRoot] = useState<string | null>(null);
  const rootPath = pickedRoot ?? systemInfo?.home ?? "";
  // `scanned` mirrors the last scan response verbatim so a rescan can keep
  // replacing it wholesale without discarding manually added folders, which
  // live separately in `manualPaths` and are merged into `candidates` below.
  const [scanned, setScanned] = useState<DiscoveryCandidate[]>([]);
  const [manualPaths, setManualPaths] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hint, setHint] = useState<string | null>(null);
  const autoScanned = useRef(false);

  const candidates = useMemo<DiscoveryCandidate[]>(() => {
    const scannedPaths = new Set(scanned.map((c) => c.path));
    const extras = manualPaths
      .filter((p) => !scannedPaths.has(p))
      .map(manualCandidate);
    return [...extras, ...scanned];
  }, [scanned, manualPaths]);

  function runScan(root: string): void {
    if (!root) return;
    scan.mutate(
      { roots: [root], git_only: true, max_depth: SCAN_MAX_DEPTH },
      {
        onSuccess: (data) => {
          setScanned(data.candidates);
          const importedPaths = new Set(
            data.candidates
              .filter((c) => c.already_imported)
              .map((c) => c.path),
          );
          setSelected(
            new Set([
              ...manualPaths.filter((p) => !importedPaths.has(p)),
              ...data.candidates
                .filter((c) => !c.already_imported)
                .map((c) => c.path),
            ]),
          );
          setHint(null);
        },
      },
    );
  }

  // Auto-scan once the root is known (home from the sidecar, or a folder the
  // user picked before /system/info answered). "Rescan" re-runs it on demand.
  useEffect(() => {
    if (autoScanned.current || !rootPath) return;
    autoScanned.current = true;
    runScan(rootPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath]);

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
    const picked = await pickDirectory();
    if (picked === null) return;
    // Claim the auto-scan slot so the rootPath change below cannot fire a
    // second scan.
    autoScanned.current = true;
    setPickedRoot(picked);
    setHint(null);
    runScan(picked);
  }

  async function handleAddFolder(): Promise<void> {
    const picked = await pickDirectory();
    if (picked === null) return;
    if (candidates.some((c) => c.path === picked)) {
      setHint(`Already in the list: ${picked}`);
      return;
    }
    setManualPaths((prev) => [picked, ...prev]);
    setSelected((prev) => new Set(prev).add(picked));
    setHint(null);
  }

  function handleRescan(): void {
    runScan(rootPath);
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
            <div
              style={{
                fontSize: 12,
                color: "var(--fg-3)",
                marginTop: 2,
                fontFamily: "monospace",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: 380,
              }}
              title={rootPath || undefined}
            >
              {rootPath ? `Scanning ${rootPath}` : "No folder selected yet."}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="d3-btn d3-btn--ghost"
              type="button"
              onClick={() => void handlePickFolder()}
              disabled={scan.isPending}
              title="Choose the folder to scan for git repositories"
            >
              Pick folder...
            </button>
            <button
              className="d3-btn d3-btn--ghost"
              type="button"
              onClick={() => void handleAddFolder()}
              disabled={scan.isPending}
              title="Add this folder to the list even if it is not a git repository"
            >
              Add folder...
            </button>
            <button
              className="d3-btn d3-btn--ghost"
              type="button"
              onClick={handleRescan}
              disabled={scan.isPending || !rootPath}
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
              {!rootPath
                ? "Pick a folder to scan for git repositories."
                : `No git repositories found under ${rootPath}. Use "Pick folder..." to scan somewhere else, or "Add folder..." to add a folder directly.`}
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
