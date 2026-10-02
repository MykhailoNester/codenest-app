/**
 * DocPreviewModal — read a document without leaving the app. On Deck (#283).
 *
 * The panel, its header, its scrolling body and its close button are all
 * things `.dk-scrim` / `.dk-modal` already draw, so most of the 144-line
 * stylesheet was restating them. What is left is noted where it is declared.
 *
 * Fenced code, and the `pre` gap
 * ------------------------------
 * `.dk-prose` styles `p`, `ul`/`ol`, `code` and `h1`–`h3` and stops there —
 * there is no `pre` rule, so a fenced block in a markdown file renders at the
 * browser's default `white-space: pre` and runs straight out of the dialog.
 * `CodeBlock` below is the override, handed to `ReactMarkdown` as
 * `components={{ pre }}`, and `<pre>` for a non-markdown file goes through
 * the same component so both paths wrap identically.
 *
 * This component renders in place rather than through a portal, so it inherits
 * the `.deck` scope from whatever mounts it; there is no `display: contents`
 * wrapper to add. (`position: fixed` changes where a box paints, never where
 * it sits in the tree, so the tokens still cascade.)
 */
import {
  useEffect,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { readFileText, type ReadFileTextResult } from "../lib/ipc";
import { formatBytes } from "../lib/format-helpers";

/**
 * A pinned strip between the header and the scrolling body. `.dk-side__row`
 * is Deck's own "flex: none, hairline under it" row — the find palette uses it
 * for its field inside a panel — and it is what keeps the path and the
 * truncation warning from scrolling away with the document.
 */
const STRIP = "dk-side__row";

/**
 * Deck colours exactly one thing in its error ramp that is not a glyph, a tag
 * or a terminal line: `.dk-btn.danger`. There is no error *text* class, so
 * this is a missing primitive and a local constant — the same call
 * `pages/terminal-window-root.tsx` makes for its crash banner.
 */
const ERROR_TEXT: CSSProperties = { color: "var(--err)" };

export interface DocPreviewModalProps {
  filePath: string;
  title: string;
  onClose: () => void;
}

function isMarkdown(path: string): boolean {
  return path.endsWith(".md") || path.endsWith(".mdx");
}

/**
 * A fenced block, or a whole plain-text file. `.dk-out` is Deck's standalone
 * output pane — a framed, capped box — and `.dk-term__b` inside it is the
 * scrolling `pre-wrap` body. Together they are the `pre` rule `.dk-prose`
 * does not have: long lines wrap instead of escaping the dialog, and a long
 * block scrolls inside its own frame rather than pushing the document down.
 */
function CodeBlock({
  children,
  fill,
}: {
  children?: ReactNode;
  /**
   * The whole file is the block (a non-markdown preview). `.dk-out`'s 420px
   * ceiling and frame are right for one fence among paragraphs and wrong for
   * the document itself — it would scroll inside a box inside the already
   * scrolling body.
   */
  fill?: boolean;
}): ReactElement {
  return (
    <div className="dk-out" style={fill ? FILL_BLOCK : undefined}>
      <div className="dk-term__b">{children}</div>
    </div>
  );
}

const FILL_BLOCK: CSSProperties = {
  maxHeight: "none",
  border: 0,
  borderRadius: 0,
  background: "none",
};

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
    <div className="dk-scrim" onClick={onClose} role="presentation">
      <div
        className="dk-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="doc-preview-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dk-modal__h">
          <h2 id="doc-preview-title" style={{ margin: 0, font: "inherit" }}>
            {title}
          </h2>
          <span className="sp" />
          <button
            className="dk-btn bare icon"
            type="button"
            onClick={onClose}
            aria-label="Close preview"
          >
            ×
          </button>
        </div>

        {result !== null && (
          <div className={STRIP}>
            <span className="dk-meta trunc" title={filePath}>
              {formatBytes(result.sizeBytes)} · {filePath}
            </span>
          </div>
        )}

        {result?.truncated === true && (
          <div className={STRIP}>
            {/* The amber `=` — Deck's "stalled": you are not seeing all of it. */}
            <span className="dk-s" data-s="stall" role="img" aria-label="stalled" />
            <span className="dk-meta">
              File truncated at 1 MB — open in editor for full content.
            </span>
          </div>
        )}

        {loading && (
          // Was five shimmering placeholder bars on a 1.4s loop. Deck draws
          // almost nothing and says what is happening instead; the bars never
          // carried the filename, which is the one useful thing here.
          <div className="dk-note">Reading {filePath}…</div>
        )}

        {error !== null && (
          <div className="dk-note" style={ERROR_TEXT} role="alert">
            {error}
          </div>
        )}

        {result !== null && !loading && (
          <div className="dk-modal__b">
            {isMarkdown(filePath) ? (
              <div className="dk-prose">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{ pre: CodeBlock }}
                >
                  {result.contents}
                </ReactMarkdown>
              </div>
            ) : (
              <CodeBlock fill>{result.contents}</CodeBlock>
            )}
            {result.contents === "" && (
              <span className="dim">(empty file)</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
