import { useEffect, useState, type ReactElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { readFileText, type ReadFileTextResult } from "../lib/ipc";
import { formatBytes } from "../lib/format-helpers";
import styles from "./doc-preview-modal.module.css";

export interface DocPreviewModalProps {
  filePath: string;
  title: string;
  onClose: () => void;
}

function isMarkdown(path: string): boolean {
  return path.endsWith(".md") || path.endsWith(".mdx");
}

export function DocPreviewModal({
  filePath,
  title,
  onClose,
}: DocPreviewModalProps): ReactElement {
  const [result, setResult] = useState<ReadFileTextResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    readFileText(filePath)
      .then((r) => {
        if (!cancelled) {
          setResult(r);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className={styles.backdrop} onClick={onClose} role="presentation">
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="doc-preview-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <h2 id="doc-preview-title" className={styles.title}>
            {title}
          </h2>
          <button
            className={styles.closeBtn}
            type="button"
            onClick={onClose}
            aria-label="Close preview"
          >
            ×
          </button>
        </div>

        {result !== null && (
          <div className={styles.meta}>
            {formatBytes(result.sizeBytes)} · {filePath}
          </div>
        )}

        {result?.truncated === true && (
          <div className={styles.banner}>
            File truncated at 1 MB — open in editor for full content.
          </div>
        )}

        {loading && (
          <div className={styles.skeleton}>
            {[80, 60, 90, 40, 70].map((w, i) => (
              <div
                key={i}
                className={styles.skeletonLine}
                style={{ width: `${w}%` }}
              />
            ))}
          </div>
        )}

        {error !== null && <div className={styles.errorMsg}>{error}</div>}

        {result !== null && !loading && (
          <div className={styles.body}>
            {isMarkdown(filePath) ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {result.contents}
              </ReactMarkdown>
            ) : (
              <pre>{result.contents}</pre>
            )}
            {result.contents === "" && (
              <span style={{ color: "var(--fg-4)", fontStyle: "italic" }}>
                (empty file)
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
