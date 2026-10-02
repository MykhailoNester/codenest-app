import { useState, useEffect, useRef, type ReactElement } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  useScanProjects,
  useRichImportProjects,
  type DiscoveryCandidate,
} from "../../lib/api";
import { DeckGrid, DeckHead, DeckLine } from "../../components/deck/deck-grid";
import { StepHead, StepField, StepHint, Lit } from "./step-chrome";

interface Props {
  registerCommit: (fn: () => Promise<void>) => void;
}

/**
 * Deck has no fixed-height list — a page scrolls as one. The scan can return
 * 200 repos, which would push Continue off the end of a flow whose footer is
 * the only way forward, so this list keeps the cap the pre-Deck `.scrollList`
 * had. Same number, no mask.
 */
const CANDIDATE_LIST_STYLE: React.CSSProperties = {
  maxHeight: 380,
  overflowY: "auto",
};

const CANDIDATE_COLS = "14px minmax(0, 1fr) 220px";

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

  // The root is deliberately left empty. It used to be seeded with the
  // sidecar's home directory, which made the first press of Scan walk the
  // user's entire personal tree — the user chooses the folder, we never
  // pre-fill one broad enough to read the whole disk.

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
        max_depth: 4,
        max_results: 200,
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

  const claudeCount = candidates.filter((c) =>
    c.tools.includes("claude"),
  ).length;

  return (
    <>
      <StepHead kicker="step 02 · discover" title="Import your projects">
        Point us at a root folder. We recursively find{" "}
        <strong>git repositories</strong> — including ones nested inside another
        repo — detect which AI tooling each one uses, and let you choose what to
        bring into the workspace.
      </StepHead>

      <div className="dk-group">
        <h2 className="dk-group__h">
          <span>Scan</span>
        </h2>
        <div className="dk-form">
          <StepField
            label="Root folder to scan"
            htmlFor="ob-scan-root"
            hint={
              <>
                Recursive walk for <Lit>.git</Lit> repos → per-repo tool
                detection (<Lit>.claude/</Lit> ⇒ Claude). Other tools coming via
                an extensible registry.
              </>
            }
          >
            <div
              style={{ display: "flex", gap: "var(--u2)", alignItems: "center" }}
            >
              <input
                id="ob-scan-root"
                className="dk-ctl"
                value={rootPath}
                onChange={(e) => setRootPath(e.target.value)}
                placeholder="/path/to/your/code"
                spellCheck={false}
              />
              <span className="dk-actions">
                <button
                  type="button"
                  className="dk-btn"
                  onClick={() => void pickFolder()}
                  disabled={scan.isPending}
                >
                  Browse…
                </button>
                <button
                  type="button"
                  className="dk-btn pri"
                  onClick={() => void runScan()}
                  disabled={scan.isPending || !rootPath.trim()}
                >
                  {scan.isPending ? "⟳ Scanning…" : "⟲ Scan"}
                </button>
              </span>
            </div>
          </StepField>
        </div>
      </div>

      {scanDone && (
        <div className="dk-group">
          <h2 className="dk-group__h">
            <span>Discovered repositories</span>
            <span className="n">{candidates.length}</span>
            <span className="note">
              {claudeCount} with Claude · {selected.size} selected for import
            </span>
            <span className="sp" />
            <span className="dk-actions">
              <button type="button" className="dk-btn" onClick={toggleAll}>
                Toggle all
              </button>
            </span>
          </h2>
          <div style={CANDIDATE_LIST_STYLE}>
            <DeckGrid cols={CANDIDATE_COLS} label="Discovered repositories">
              <DeckHead cells={["repository", "r tools"]} />
              {candidates.map((c) => {
                const isSel = selected.has(c.path);
                const hasClaude = c.tools.includes("claude");
                return (
                  <DeckLine
                    key={c.path}
                    state={isSel ? "done" : "idle"}
                    selected={isSel}
                    onOpen={() => toggle(c.path)}
                    cells={[
                      {
                        v: (
                          <>
                            <span className="sub">{c.name}</span>{" "}
                            <span className="dim">{c.path}</span>
                          </>
                        ),
                        title: c.path,
                      },
                      {
                        cls: "r",
                        v: (
                          <span className="dk-actions end">
                            <span className="dk-tag" data-s={hasClaude ? "run" : undefined}>
                              {hasClaude ? "claude" : "no ai tool"}
                            </span>
                            {c.git && <span className="dk-tag">git</span>}
                            {(c.agents ?? 0) > 0 && (
                              <span className="dk-tag">{c.agents} agents</span>
                            )}
                            {(c.skills ?? 0) > 0 && (
                              <span className="dk-tag">{c.skills} skills</span>
                            )}
                            {c.already_imported && (
                              <span className="dk-tag" data-s="done">
                                imported
                              </span>
                            )}
                          </span>
                        ),
                      },
                    ]}
                  />
                );
              })}
            </DeckGrid>
          </div>
        </div>
      )}

      {!scanDone && (
        <StepHint>
          Scan a folder to discover projects, or continue to skip this step.
        </StepHint>
      )}
    </>
  );
}
