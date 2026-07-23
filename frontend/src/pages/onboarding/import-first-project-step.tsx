import { useState, useEffect, useRef, type ReactElement } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  fetchSidecar,
  useScanProjects,
  useRichImportProjects,
  type DiscoveryCandidate,
} from "../../lib/api";
import styles from "./onboarding-page.module.css";

interface Props {
  registerCommit: (fn: () => Promise<void>) => void;
}

const TICK_SVG = (
  <svg viewBox="0 0 12 12" fill="none" width={11} height={11} aria-hidden>
    <path
      d="M2 6.5l2.5 2.5 5.5-6"
      stroke="#fff"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export function ImportFirstProjectStep({
  registerCommit,
}: Props): ReactElement {
  const [rootPath, setRootPath] = useState("");
  const [candidates, setCandidates] = useState<DiscoveryCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanDone, setScanDone] = useState(false);

  const scan = useScanProjects();
  const richImport = useRichImportProjects();

  // Keep a ref to the latest commit logic so the registered wrapper always
  // captures current candidates/selected without re-registering on every render.
  const doImportRef = useRef<() => Promise<void>>(async () => undefined);

  // Seed root with home directory on first mount.
  useEffect(() => {
    fetchSidecar<{ home?: string }>("/api/v1/system/info")
      .then((info) => {
        if (info.home) setRootPath(info.home);
      })
      .catch(() => undefined);
  }, []);

  // Register a stable wrapper once; the wrapper delegates to doImportRef
  // so it always runs the latest version.
  useEffect(() => {
    registerCommit(() => doImportRef.current());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep doImportRef up to date whenever candidates/selected change.
  useEffect(() => {
    doImportRef.current = async (): Promise<void> => {
      const items = candidates
        .filter((c) => selected.has(c.path))
        .map((c) => ({ path: c.path, name: c.name, stack: c.stack ?? null }));
      if (items.length === 0) {
        // Nothing selected — advance with defaults (import nothing).
        return;
      }
      const result = await richImport.mutateAsync(items);
      const msg =
        result.imported > 0
          ? `Imported ${result.imported} project${result.imported !== 1 ? "s" : ""}${result.skipped > 0 ? ` · ${result.skipped} skipped` : ""}`
          : `${result.skipped} project${result.skipped !== 1 ? "s" : ""} already imported, skipped`;
      toast.success(msg);
      if (result.errors.length > 0) {
        toast.error(`Import warnings: ${result.errors.join("; ")}`);
      }
    };
  }, [candidates, selected, richImport]);

  const pickFolder = async (): Promise<void> => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked !== "string") return; // cancelled or unexpected type
    setRootPath(picked);
  };

  const runScan = async (): Promise<void> => {
    if (!rootPath.trim()) {
      toast.error("Enter a folder to scan");
      return;
    }
    try {
      const result = await scan.mutateAsync({
        roots: [rootPath.trim()],
        max_depth: 3,
        max_results: 50,
        git_only: true,
      });
      const list = result.candidates;
      setCandidates(list);
      setScanDone(true);
      // Default-select repos that have Claude tooling and aren't already imported.
      const defaultSel = new Set(
        list
          .filter((c) => c.tools.includes("claude") && !c.already_imported)
          .map((c) => c.path),
      );
      setSelected(defaultSel);
      if (list.length === 0) {
        toast.info("No git repositories found under that folder");
      }
    } catch (err) {
      toast.error(`Scan failed: ${(err as Error).message}`);
    }
  };

  const toggleAll = (): void => {
    const allSelected = candidates.every((c) => selected.has(c.path));
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(candidates.map((c) => c.path)));
    }
  };

  const toggle = (path: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const claudeCount = candidates.filter((c) => c.tools.includes("claude")).length;

  return (
    <>
      <div className={styles.kicker}>Step 02 &middot; Discover</div>
      <h1 className={styles.title}>Import your projects</h1>
      <p className={styles.lead}>
        Point us at a root folder. We recursively find{" "}
        <strong>git repositories</strong>, detect which AI tooling each one
        uses, and let you choose what to bring into the workspace.
      </p>

      <div className={styles.card}>
        <label className={styles.fieldLabel}>Root folder to scan</label>
        <div style={{ display: "flex", gap: 10 }}>
          <input
            className={`${styles.fld} ${styles.fldMono}`}
            value={rootPath}
            onChange={(e) => setRootPath(e.target.value)}
            placeholder="/Users/you/Code"
          />
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            onClick={() => void pickFolder()}
            disabled={scan.isPending}
          >
            Browse…
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={() => void runScan()}
            disabled={scan.isPending}
          >
            {scan.isPending ? "⟳ Scanning…" : "⟲ Scan"}
          </button>
        </div>
        <p className={styles.hint}>
          Recursive walk for{" "}
          <code
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "10px",
              background: "rgba(255,255,255,.06)",
              border: "1px solid var(--line-2)",
              borderRadius: 4,
              padding: "1px 5px",
              color: "var(--fg-2)",
            }}
          >
            .git
          </code>{" "}
          repos &rarr; per-repo tool detection (
          <code
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "10px",
              background: "rgba(255,255,255,.06)",
              border: "1px solid var(--line-2)",
              borderRadius: 4,
              padding: "1px 5px",
              color: "var(--fg-2)",
            }}
          >
            .claude/
          </code>{" "}
          &rArr; Claude). Other tools coming via an extensible registry.
        </p>
      </div>

      {scanDone && (
        <>
          <div className={styles.sectionH}>
            Discovered repositories
            <span className={styles.sectionHLine} />
            <span
              className={styles.muted}
              style={{ fontFamily: "var(--font-mono)", fontSize: 10.5 }}
            >
              {candidates.length} git repos &middot; {claudeCount} with Claude
            </span>
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 10,
            }}
          >
            <button
              type="button"
              className={`${styles.btn} ${styles.btnGhost} ${styles.btnSm}`}
              onClick={toggleAll}
            >
              Toggle all
            </button>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10.5,
                color: "var(--fg-4)",
              }}
            >
              {selected.size} of {candidates.length} selected for import
            </span>
          </div>

          <div className={styles.scrollList}>
            {candidates.map((c) => {
              const isSel = selected.has(c.path);
              const hasClaude = c.tools.includes("claude");
              return (
                <div
                  key={c.path}
                  className={`${styles.row} ${isSel ? styles.rowSel : ""}`}
                  onClick={() => toggle(c.path)}
                >
                  <div className={`${styles.chk} ${isSel ? styles.chkOn : ""}`}>
                    {isSel && TICK_SVG}
                  </div>
                  <div className={styles.rowGrow}>
                    <div className={styles.rowName}>{c.name}</div>
                    <div className={styles.rowPath}>{c.path}</div>
                  </div>
                  <div className={styles.tags}>
                    {hasClaude ? (
                      <span className={`${styles.tag} ${styles.tagClaude}`}>
                        ⌁ Claude &middot; .claude/
                      </span>
                    ) : (
                      <span className={styles.tag}>no AI tool</span>
                    )}
                    {c.git && (
                      <span className={`${styles.tag} ${styles.tagGit}`}>
                        git
                      </span>
                    )}
                    {(c.agents ?? 0) > 0 && (
                      <span className={styles.tag}>{c.agents} agents</span>
                    )}
                    {(c.skills ?? 0) > 0 && (
                      <span className={styles.tag}>{c.skills} skills</span>
                    )}
                    {c.already_imported && (
                      <span className={`${styles.tag} ${styles.tagOk}`}>
                        already imported
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className={styles.listMeta}>
            {candidates.length} repos found &middot; scroll for more
          </div>
        </>
      )}

      {!scanDone && (
        <p className={styles.muted} style={{ marginTop: 0 }}>
          Scan a folder to discover projects, or continue to skip this step.
        </p>
      )}
    </>
  );
}
