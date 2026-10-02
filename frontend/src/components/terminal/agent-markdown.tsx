/**
 * Markdown renderer for assistant text in an agent pane.
 *
 * `claude` emits GitHub-flavoured markdown — bold, bullets, headings, links,
 * fenced code and pipe tables — and the pane used to print it verbatim, so a
 * table arrived as a wall of `|---|---|` and every `**bold**` kept its
 * asterisks. This renders it, using the `react-markdown` + `remark-gfm` pair
 * already in the app (`doc-preview-modal.tsx`, `markdown-editor.tsx`) rather
 * than a second markdown stack.
 *
 * Two deliberate choices about *what* is rendered:
 *
 * * **Raw HTML is not.** `react-markdown` drops embedded HTML unless
 *   `rehype-raw` is added, and it is deliberately not added: this text is model
 *   output, frequently quoting a page the model just fetched, and the pane is
 *   inside the app's own webview.
 * * **Links do not navigate.** An `<a href>` click in a Tauri webview would
 *   replace the app with the page. Every link goes to `open_external_url`
 *   instead, which hands it to the OS default handler — the user's browser —
 *   leaving the session untouched. Deliberately the URL entry point and not
 *   `open_path`: the latter is filesystem-shaped, and routing a link through it
 *   is what stopped these links opening at all.
 *
 * ── On Deck ──────────────────────────────────────────────────────────────
 * The container is `.dk-prose`, which carries the base type and the rules for
 * `p`, `ul`/`ol`, `code` and `h1`-`h3`. `react-markdown` renders plain tags and
 * takes no per-element className, so everything Deck does *not* name is
 * supplied through its `components` map as an inline style — in particular
 * `pre`, which `.dk-prose` has no rule for at all, and which is the one block
 * that must not wrap: a wrapped command line or diff is harder to read than one
 * the reader scrolls.
 *
 * Declared here rather than in `components/deck/*` or `design/deck/*`, which
 * #283 does not touch — the precedent is the composer's `EDITOR_*` constants.
 */

import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openExternalUrl } from "../../lib/ipc";
import { toast } from "sonner";

/**
 * The reply's own box.
 *
 * `whiteSpace: normal` overrides the `pre-wrap` inherited from the enclosing
 * message block. Without it every source newline inside a paragraph would
 * survive as a line break on top of the block spacing, double-spacing the whole
 * reply.
 *
 * `maxWidth: none` turns off `.dk-prose`'s 80ch measure. Deck caps prose for
 * good reason, but this block sits directly under the user's own turn, which is
 * not capped — a reply that stopped at 80ch beside a full-width question would
 * read as a rendering fault rather than as a measure.
 *
 * The negative bottom margin is the old `.md > :last-child { margin-bottom: 0 }`
 * rule, which has no inline form: it cancels the trailing block's own margin so
 * the reply ends flush with its turn box. Exact for a reply that ends in a
 * paragraph, a list, a table or a fence (all `--u3`); a reply ending on a
 * heading leaves 4px, which the turn's own 16px gap absorbs.
 */
const MD_STYLE: CSSProperties = {
  whiteSpace: "normal",
  maxWidth: "none",
  marginBottom: "calc(var(--u3) * -1)",
};

const STRONG_STYLE: CSSProperties = { color: "var(--fg)", fontWeight: 600 };

const DEL_STYLE: CSSProperties = { color: "var(--fg-4)" };

/** Headings stay close to body size: a model reaches for `##` inside what is
 *  really a chat message, and a full typographic scale would read as a
 *  document rather than a reply. `.dk-prose` already sets the family, weight,
 *  colour and margins for `h1`-`h3`; `h2` matches it exactly, so only the sizes
 *  and the three headings Deck does not name are supplied here. */
const H1_STYLE: CSSProperties = { fontSize: 15 };
const H3_STYLE: CSSProperties = { fontSize: 13 };
const H456_STYLE: CSSProperties = {
  font: "500 13px/1.4 var(--sans)",
  color: "var(--fg)",
  margin: "var(--u4) 0 var(--u2)",
};

/** `.dk-prose ul, ol` already carries these; repeated because overriding `ul`
 *  for the task-list case replaces the element, not the rule. */
const LIST_STYLE: CSSProperties = {
  margin: "0 0 var(--u3)",
  paddingLeft: "var(--u4)",
};

/** GFM task lists. The checkbox is the marker here, and keeping the bullet as
 *  well reads as a rendering bug. Keyed off remark-gfm's own class, which no
 *  longer has to escape CSS-module hashing. */
const TASK_LIST_STYLE: CSSProperties = {
  ...LIST_STYLE,
  listStyle: "none",
  paddingLeft: "0.1em",
};

const LI_STYLE: CSSProperties = { margin: "0.2em 0" };

/** The checkbox is status, not a control — remark-gfm already emits it
 *  `disabled`; this keeps the cursor from implying otherwise. */
const CHECKBOX_STYLE: CSSProperties = {
  marginRight: "0.4em",
  accentColor: "var(--run)",
  pointerEvents: "none",
};

const LINK_STYLE: CSSProperties = {
  color: "var(--run)",
  textDecoration: "none",
  borderBottom: "1px solid color-mix(in srgb, var(--run) 35%, transparent)",
  cursor: "pointer",
};

const LINK_HOVER_STYLE: CSSProperties = {
  ...LINK_STYLE,
  borderBottomColor: "var(--run)",
};

/** `.dk-prose code` sets the family, size and colour; the chip around it is
 *  this file's. */
const CODE_STYLE: CSSProperties = {
  background: "var(--sel)",
  padding: "0 3px",
  borderRadius: 2,
  wordBreak: "break-word",
};

/**
 * The one block `.dk-prose` has no rule for. Fenced blocks scroll rather than
 * wrap, so a long path, a JSON payload or a stack trace stays inside the frame
 * instead of widening the pane and dragging the whole transcript sideways.
 */
const PRE_STYLE: CSSProperties = {
  margin: "0 0 var(--u3)",
  padding: "var(--u2) var(--u3)",
  background: "var(--bg-1)",
  border: "1px solid var(--line)",
  borderRadius: 3,
  overflowX: "auto",
};

/** Resets the inline chip above for the `code` inside a fence. */
const PRE_CODE_STYLE: CSSProperties = {
  display: "block",
  background: "none",
  border: "none",
  padding: 0,
  fontSize: "var(--fs-s)",
  lineHeight: 1.7,
  color: "var(--fg-2)",
  whiteSpace: "pre",
  wordBreak: "normal",
};

const BLOCKQUOTE_STYLE: CSSProperties = {
  margin: "0 0 var(--u3)",
  // No bottom padding: the quote's last paragraph brings its own `--u3`, which
  // the old `blockquote > :last-child` rule used to strip. Letting that margin
  // stand and dropping the padding keeps the same inner height.
  padding: "2px 0 0 var(--u3)",
  borderLeft: "2px solid var(--line-2)",
  color: "var(--fg-3)",
};

const HR_STYLE: CSSProperties = {
  margin: "var(--u4) 0",
  border: "none",
  borderTop: "1px solid var(--line)",
};

/** A pane is narrow and a model's table is often not. The wrapper is what
 *  scrolls, so a wide table cannot widen the pane and force the whole
 *  conversation to scroll sideways. */
const TABLE_WRAP_STYLE: CSSProperties = {
  margin: "0 0 var(--u3)",
  overflowX: "auto",
  border: "1px solid var(--line)",
  borderRadius: 3,
};

/** Mono inside, because a table is the one place in a reply where columns have
 *  to line up (Deck's rule 2). */
const TABLE_STYLE: CSSProperties = {
  borderCollapse: "collapse",
  width: "100%",
  fontFamily: "var(--mono)",
  fontSize: "var(--fs-s)",
  fontVariantNumeric: "tabular-nums",
};

const CELL_BASE_STYLE: CSSProperties = {
  padding: "var(--u) var(--u3)",
  textAlign: "left",
  verticalAlign: "top",
};

/**
 * The header rules below itself; a body cell rules *above* itself.
 *
 * The old stylesheet gave every cell a bottom border and took it back off the
 * last body row with `tbody tr:last-child td`, which has no inline form. Under
 * `border-collapse: collapse` the first body row's top border merges with the
 * header's bottom border into the one line, so this draws exactly the same
 * hairlines — including none after the last row — with no knowledge of which
 * row is last.
 */
const TH_STYLE: CSSProperties = {
  ...CELL_BASE_STYLE,
  borderBottom: "1px solid var(--line)",
  color: "var(--fg-3)",
  fontWeight: 400,
  fontSize: "var(--fs-xs)",
  letterSpacing: "1.1px",
  textTransform: "uppercase",
  whiteSpace: "nowrap",
};

const TD_STYLE: CSSProperties = {
  ...CELL_BASE_STYLE,
  borderTop: "1px solid var(--line)",
  color: "var(--fg-2)",
};

const ROW_HOVER_STYLE: CSSProperties = { background: "var(--sel)" };

/** An image renders as a click-to-open chip, never as a fetched `<img>`. */
const IMG_LINK_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--u)",
  padding: "0 var(--u2)",
  border: "1px dashed var(--line-2)",
  borderRadius: 3,
  color: "var(--run)",
  textDecoration: "none",
  cursor: "pointer",
};

const IMG_LINK_HOVER_STYLE: CSSProperties = {
  ...IMG_LINK_STYLE,
  borderStyle: "solid",
};

/** Lets a `tr` know whether it is a body row, so only body rows take the hover
 *  tone — the old `tbody tr:hover td` selector, as data. */
const InTableBody = createContext(false);

function openLink(href: string): void {
  if (href === "") return;
  void openExternalUrl(href).catch((err: unknown) => {
    // Reported, never swallowed. A silently dropped rejection is exactly why a
    // link that opened nothing looked like a dead element rather than a refused
    // call.
    toast.error(
      `Could not open ${href}: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

function MarkdownLink({
  href,
  title,
  style,
  hoverStyle,
  children,
}: {
  href: string;
  title: string | undefined;
  style: CSSProperties;
  hoverStyle: CSSProperties;
  children: ReactNode;
}): ReactElement {
  const [hover, setHover] = useState(false);
  return (
    <a
      href={href === "" ? "#" : href}
      title={title}
      style={hover ? hoverStyle : style}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(e) => {
        // Also covers ⌘-click: with the default prevented there is no
        // browser-level "open in new tab" to fall back on, so the modifier must
        // not change what happens.
        e.preventDefault();
        openLink(href);
      }}
    >
      {children}
    </a>
  );
}

function TableRow({ children }: { children: ReactNode }): ReactElement {
  const inBody = useContext(InTableBody);
  const [hover, setHover] = useState(false);
  return (
    <tr
      {...(inBody
        ? {
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false),
            ...(hover ? { style: ROW_HOVER_STYLE } : {}),
          }
        : {})}
    >
      {children}
    </tr>
  );
}

export function AgentMarkdown({ text }: { text: string }): ReactElement {
  return (
    <div className="dk-prose" style={MD_STYLE}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <MarkdownLink
              href={href ?? ""}
              title={href ?? undefined}
              style={LINK_STYLE}
              hoverStyle={LINK_HOVER_STYLE}
            >
              {children}
            </MarkdownLink>
          ),
          strong: ({ children }) => <strong style={STRONG_STYLE}>{children}</strong>,
          del: ({ children }) => <del style={DEL_STYLE}>{children}</del>,
          h1: ({ children }) => <h1 style={H1_STYLE}>{children}</h1>,
          h3: ({ children }) => <h3 style={H3_STYLE}>{children}</h3>,
          h4: ({ children }) => <h4 style={H456_STYLE}>{children}</h4>,
          h5: ({ children }) => <h5 style={H456_STYLE}>{children}</h5>,
          h6: ({ children }) => <h6 style={H456_STYLE}>{children}</h6>,
          ul: ({ className, children }) => (
            <ul
              style={
                className?.includes("contains-task-list") === true
                  ? TASK_LIST_STYLE
                  : LIST_STYLE
              }
            >
              {children}
            </ul>
          ),
          ol: ({ children }) => <ol style={LIST_STYLE}>{children}</ol>,
          li: ({ children }) => <li style={LI_STYLE}>{children}</li>,
          input: ({ type, checked }) => (
            <input type={type} checked={checked} disabled readOnly style={CHECKBOX_STYLE} />
          ),
          // `style` is only ever supplied by the `pre` override below, which
          // clones this element to swap the inline chip for the block set.
          // react-markdown v9 stopped passing an `inline` flag, so being
          // handed the style by one's own parent is what distinguishes a
          // fenced `code` from an inline one.
          code: ({ children, style }) => (
            <code style={style ?? CODE_STYLE}>{children}</code>
          ),
          // `.dk-prose` has no `pre` rule at all, so the fence is drawn here.
          pre: ({ children }) => (
            <pre style={PRE_STYLE}>
              {isValidElement<{ style?: CSSProperties }>(children)
                ? cloneElement(children, { style: PRE_CODE_STYLE })
                : children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote style={BLOCKQUOTE_STYLE}>{children}</blockquote>
          ),
          hr: () => <hr style={HR_STYLE} />,
          table: ({ children }) => (
            <div style={TABLE_WRAP_STYLE}>
              <table style={TABLE_STYLE}>{children}</table>
            </div>
          ),
          tbody: ({ children }) => (
            <InTableBody.Provider value={true}>
              <tbody>{children}</tbody>
            </InTableBody.Provider>
          ),
          tr: ({ children }) => <TableRow>{children}</TableRow>,
          th: ({ children }) => <th style={TH_STYLE}>{children}</th>,
          td: ({ children }) => <td style={TD_STYLE}>{children}</td>,
          // Images are offered, not fetched. `![](…)` is markdown, so unlike an
          // embedded `<img>` tag it survives the no-raw-HTML rule and would
          // otherwise hit the network the instant the reply renders — no CSP
          // stands in the way (`tauri.conf.json` sets `csp: null`). A tracking
          // pixel inside a page the model just quoted back would then report
          // the user's address with nothing clicked. Rendering the same
          // click-to-open affordance as a link keeps that a choice.
          img: ({ src, alt, title }) => {
            const href = typeof src === "string" ? src : "";
            return (
              <MarkdownLink
                href={href}
                title={title ?? href}
                style={IMG_LINK_STYLE}
                hoverStyle={IMG_LINK_HOVER_STYLE}
              >
                🖼 {alt !== undefined && alt !== "" ? alt : "image"}
              </MarkdownLink>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
