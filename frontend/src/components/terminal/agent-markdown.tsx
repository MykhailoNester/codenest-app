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
 */

import type { ReactElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openExternalUrl } from "../../lib/ipc";
import { toast } from "sonner";
import styles from "./agent-markdown.module.css";

export function AgentMarkdown({ text }: { text: string }): ReactElement {
  return (
    <div className={styles.md}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href ?? "#"}
              title={href ?? undefined}
              onClick={(e) => {
                // Also covers ⌘-click: with the default prevented there is no
                // browser-level "open in new tab" to fall back on, so the
                // modifier must not change what happens.
                e.preventDefault();
                if (href === undefined || href === "") return;
                void openExternalUrl(href).catch((err: unknown) => {
                  // Reported, never swallowed. A silently dropped rejection is
                  // exactly why a link that opened nothing looked like a dead
                  // element rather than a refused call.
                  toast.error(
                    `Could not open ${href}: ${err instanceof Error ? err.message : String(err)}`,
                  );
                });
              }}
            >
              {children}
            </a>
          ),
          // A pane is narrow and a model's table is often not. The wrapper is
          // what scrolls, so a wide table cannot widen the pane and force the
          // whole conversation to scroll sideways.
          table: ({ children }) => (
            <div className={styles.tableWrap}>
              <table>{children}</table>
            </div>
          ),
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
              <a
                href={href || "#"}
                className={styles.imgLink}
                title={title ?? href}
                onClick={(e) => {
                  e.preventDefault();
                  if (href === "") return;
                  void openExternalUrl(href).catch((err: unknown) => {
                    toast.error(
                      `Could not open ${href}: ${err instanceof Error ? err.message : String(err)}`,
                    );
                  });
                }}
              >
                🖼 {alt !== undefined && alt !== "" ? alt : "image"}
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
