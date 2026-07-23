import { useEffect, useRef, useState, type ReactElement } from "react";
import { useSearchParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import {
  useMarkdownDiff,
  useMarkdownFile,
  useSaveMarkdownFile,
  type MarkdownDiff,
  type MarkdownKind,
} from "../lib/api";
import { Shell } from "../components/layout/shell";
import { useEscapeKey } from "../hooks/use-escape-key";

export function MarkdownEditorPage(): ReactElement {
  const [params, setParams] = useSearchParams();
  const projectId = Number(params.get("project_id") ?? "0");
  const kind: MarkdownKind =
    params.get("kind") === "agents" ? "agents" : "claude";

  const { data, isPending, isError, error } = useMarkdownFile(projectId, kind);
  const diff = useMarkdownDiff();
  const save = useSaveMarkdownFile();

  const [draft, setDraft] = useState<string>("");
  const [originalSha, setOriginalSha] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [pendingDiff, setPendingDiff] = useState<MarkdownDiff | null>(null);
  const [seeded, setSeeded] = useState(false);
  const seededRef = useRef(false);

  // Seed the editor once when the on-disk file loads. The ref guard
  // prevents the seed effect from re-running on refetch; the `seeded`
  // state mirror is what render code consults so we don't read a ref
  // during render (React 19 disallows that pattern).
  useEffect(() => {
    if (!seededRef.current && data) {
      seededRef.current = true;
      setSeeded(true);
      setDraft(data.content);
      setOriginalSha(data.sha);
    }
  }, [data]);

  function handleCompare(): void {
    if (!projectId) return;
    diff.mutate(
      { projectId, kind, content: draft },
      {
        onSuccess: (d) => {
          setPendingDiff(d);
          setShowDiff(true);
        },
        onError: (e) => toast.error(`Diff failed: ${e.message}`),
      },
    );
  }

  function handleSave(): void {
    if (!projectId) return;
    save.mutate(
      { projectId, kind, content: draft, expected_sha: originalSha },
      {
        onSuccess: (file) => {
          setOriginalSha(file.sha);
          setShowDiff(false);
          toast.success(`Saved ${file.path}`);
        },
        onError: (e) => toast.error(`Save failed: ${e.message}`),
      },
    );
  }

  function switchKind(next: MarkdownKind): void {
    if (save.isPending || diff.isPending) {
      // A save / diff against the *previous* kind is still in flight.
      // Settling it after the switch would mis-attribute the result to
      // the new kind. Block the switch and wait it out.
      toast.error("Finish the current save/diff before switching kinds");
      return;
    }
    params.set("kind", next);
    setParams(params);
    // Reset state so the new file loads cleanly.
    seededRef.current = false;
    setSeeded(false);
    setOriginalSha(null);
    setDraft("");
    setShowDiff(false);
    setPendingDiff(null);
  }

  // Until the file actually loads, treat the editor as pristine so the
  // Save button doesn't briefly enable against the empty draft.
  const dirty = seeded && data ? draft !== data.content : false;

  return (
    <Shell
      topbarTitle={`${kind === "claude" ? "CLAUDE.md" : "AGENTS.md"} · project #${projectId || "?"}`}
      topbarCrumbs="Workspace ·"
      actions={
        <div style={{ display: "flex", gap: 8 }}>
          <select
            value={kind}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
              switchKind(e.target.value as MarkdownKind)
            }
            style={{
              padding: "6px 10px",
              background: "var(--bg-3)",
              border: "1px solid var(--line-2)",
              color: "var(--fg-0)",
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            <option value="claude">CLAUDE.md</option>
            <option value="agents">AGENTS.md</option>
          </select>
          <button
            className="d3-btn d3-btn--ghost"
            type="button"
            onClick={handleCompare}
            disabled={!dirty || diff.isPending}
          >
            Compare
          </button>
          <button
            className="d3-btn d3-btn--primary"
            type="button"
            onClick={handleSave}
            disabled={!dirty || save.isPending}
          >
            Save
          </button>
        </div>
      }
    >
      <div
        style={{
          padding: "0 24px 24px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div style={{ fontSize: 11, color: "var(--fg-4)" }}>
          {data?.path ?? "—"} · {data?.exists ? "saved on disk" : "new file"}
          {dirty ? " · unsaved changes" : ""}
        </div>

        {isError && (
          <div className="d3-card" style={{ padding: 12, color: "#ef4444" }}>
            {error.message}
          </div>
        )}
        {isPending && (
          <div style={{ fontSize: 13, color: "var(--fg-3)" }}>Loading…</div>
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 12,
            minHeight: "60vh",
          }}
        >
          <textarea
            value={draft}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
              setDraft(e.target.value)
            }
            placeholder={
              data?.exists
                ? "Edit the markdown here…"
                : "This file doesn't exist yet. Type to create it."
            }
            spellCheck={false}
            style={{
              width: "100%",
              height: "100%",
              minHeight: "60vh",
              padding: "12px 14px",
              background: "var(--bg-3)",
              border: "1px solid var(--line-2)",
              color: "var(--fg-0)",
              borderRadius: 8,
              fontFamily: "monospace",
              fontSize: 13,
              lineHeight: 1.55,
              resize: "vertical",
              boxSizing: "border-box",
            }}
          />
          <div
            className="d3-card"
            style={{
              padding: "12px 16px",
              overflowY: "auto",
              maxHeight: "70vh",
              fontSize: 13,
              color: "var(--fg-1)",
            }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft}</ReactMarkdown>
          </div>
        </div>
      </div>

      {showDiff && pendingDiff && (
        <DiffModal
          diff={pendingDiff}
          onClose={() => setShowDiff(false)}
          onConfirm={() => {
            setShowDiff(false);
            handleSave();
          }}
        />
      )}
    </Shell>
  );
}

function DiffModal({
  diff,
  onClose,
  onConfirm,
}: {
  diff: MarkdownDiff;
  onClose: () => void;
  onConfirm: () => void;
}): ReactElement {
  useEscapeKey(onClose);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: "min(900px, 92vw)",
          maxHeight: "82vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-2)",
          border: "1px solid var(--line-2)",
          borderRadius: 10,
          boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid var(--line-2)",
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-0)" }}>
            Diff against on-disk
          </div>
          <div style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 2 }}>
            {diff.path}
          </div>
        </div>
        <div style={{ overflowY: "auto", padding: "12px 18px", flex: 1 }}>
          {diff.no_op ? (
            <div style={{ fontSize: 13, color: "var(--fg-3)" }}>
              No changes to save.
            </div>
          ) : (
            <pre
              style={{
                fontFamily: "monospace",
                fontSize: 12,
                lineHeight: 1.55,
                whiteSpace: "pre-wrap",
                margin: 0,
              }}
            >
              {diff.unified_diff.split("\n").map((line, idx) => {
                let color = "var(--fg-1)";
                if (line.startsWith("+") && !line.startsWith("+++"))
                  color = "#22c55e";
                else if (line.startsWith("-") && !line.startsWith("---"))
                  color = "#ef4444";
                else if (line.startsWith("@@")) color = "#60a5fa";
                return (
                  <span key={idx} style={{ color, display: "block" }}>
                    {line}
                  </span>
                );
              })}
            </pre>
          )}
        </div>
        <div
          style={{
            padding: "12px 18px",
            borderTop: "1px solid var(--line-2)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <button
            className="d3-btn d3-btn--ghost"
            type="button"
            onClick={onClose}
          >
            Close
          </button>
          <button
            className="d3-btn d3-btn--primary"
            type="button"
            onClick={onConfirm}
            disabled={diff.no_op}
          >
            Save anyway
          </button>
        </div>
      </div>
    </div>
  );
}
