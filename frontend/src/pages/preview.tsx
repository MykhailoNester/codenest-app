import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { toast } from "sonner";
import {
  useCreateInboxItem,
  usePreviewVisits,
  useRecordPreviewVisit,
} from "../lib/api";
import {
  previewClose,
  previewOpen,
  previewSetBounds,
  previewShow,
  type PreviewBounds,
} from "../lib/ipc";
import { Shell } from "../components/layout/shell";
import styles from "./preview.module.css";

/**
 * Turn whatever the user typed into a navigable URL without hardcoding
 * anything. If a scheme is already present (http/https/data/file) it is used
 * as-is. Otherwise we pick the scheme from the host: loopback, raw IPs and
 * `.local` names get `http://` (typical dev servers / LAN devices), everything
 * else gets `https://`.
 */
function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (/^(https?|data|file):/i.test(s)) return s;
  const host = (s.split(/[/:?#]/)[0] ?? "").toLowerCase();
  const isLocal =
    host === "localhost" ||
    host.endsWith(".local") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  return `${isLocal ? "http" : "https"}://${s}`;
}

export function PreviewPage(): ReactElement {
  const visits = usePreviewVisits();
  const record = useRecordPreviewVisit();
  const createInbox = useCreateInboxItem();

  const [url, setUrl] = useState("");
  const [loaded, setLoaded] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  // The `.frameWrap` div acts as the reserved rectangle for the native overlay.
  const frameWrapRef = useRef<HTMLDivElement>(null);

  // rAF token used to throttle ResizeObserver / resize event callbacks.
  const rafRef = useRef<number | null>(null);

  /**
   * Read the current logical-pixel bounds of the frameWrap element.
   *
   * `vw`/`vh` are the CSS viewport dimensions (`window.inner*`), which
   * measure only the *inset* web content area — excluding the macOS
   * title-bar on full-size-content-view windows. Rust uses them to derive
   * the title-bar inset before mapping CSS coordinates to NSView space.
   */
  const measure = useCallback((): PreviewBounds => {
    const el = frameWrapRef.current;
    if (!el)
      return {
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        vw: window.innerWidth,
        vh: window.innerHeight,
      };
    const r = el.getBoundingClientRect();
    return {
      x: r.left,
      y: r.top,
      w: r.width,
      h: r.height,
      vw: window.innerWidth,
      vh: window.innerHeight,
    };
  }, []);

  // Note: the preview pane never loads anything on its own — no auto-load,
  // no detection, no hardcoded URLs. The native overlay stays empty (showing
  // the placeholder) until the user explicitly types a URL and navigates.

  // Unmount cleanup: destroy the native overlay so it doesn't float over
  // other pages when the user navigates away from /preview.
  useEffect(() => {
    return () => {
      void previewClose();
    };
  }, []);

  // Visibility: hide/show the overlay when the app goes to the background.
  useEffect(() => {
    function onVisibility(): void {
      void previewShow(!document.hidden);
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // ResizeObserver on frameWrap + window resize: reposition the native
  // overlay whenever the layout changes (window drag, sidebar toggle, devtools).
  useEffect(() => {
    const el = frameWrapRef.current;
    if (!el) return;

    function syncBounds(): void {
      // Only sync if a page has been loaded; otherwise there's no webview to move.
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        void previewSetBounds(measure());
      });
    }

    const ro = new ResizeObserver(syncBounds);
    ro.observe(el);
    window.addEventListener("resize", syncBounds);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", syncBounds);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [measure]);

  function navigate(target: string): void {
    setLoaded(target);
    void previewOpen(target, measure())
      .then(() => {
        // Re-sync bounds on the next animation frame so that any React
        // re-render triggered by setLoaded() has settled and the DOM
        // measurements are final.  apply_frame() in Rust already flushes
        // AppKit layout before computing the frame, so one rAF is enough.
        requestAnimationFrame(() => {
          void previewSetBounds(measure());
        });
      })
      .catch((e: unknown) => {
        toast.error(`Preview failed: ${String(e)}`);
      });
    record.mutate(
      { url: target, title: null },
      { onError: (e) => toast.error(`Record failed: ${e.message}`) },
    );
  }

  function handleNavigate(): void {
    const trimmed = url.trim();
    if (!trimmed) return;
    navigate(normalizeUrl(trimmed));
  }

  function handleCapture(): void {
    if (!loaded) {
      toast.error("Nothing to capture — load a URL first");
      return;
    }
    createInbox.mutate(
      {
        title: `Preview capture: ${loaded}`,
        description: `# Captured from preview pane\n\nURL: ${loaded}\nTimestamp: ${new Date().toISOString()}\n\n_Real bitmap capture requires a Tauri Rust command — see inbox follow-up._`,
        source: "preview",
        type: "screenshot",
      },
      {
        onSuccess: (d) => toast.success(`Captured to inbox #${d.id}`),
        onError: (e) => toast.error(`Capture failed: ${e.message}`),
      },
    );
  }

  function pickVisit(v: { url: string }): void {
    setUrl(v.url);
    navigate(v.url);
    setShowHistory(false);
  }

  function toggleHistory(next: boolean): void {
    setShowHistory(next);
    if (loaded) {
      if (next) {
        // Hide native overlay so the History dropdown is not occluded.
        void previewShow(false);
      } else {
        // Restore overlay and re-sync bounds (layout may have shifted).
        void previewShow(true);
        void previewSetBounds(measure());
      }
    }
  }

  return (
    // `scrollable={false}`: the preview is a fill-the-space layout (fixed
    // toolbar + flex webview region), NOT a scrolling document. The native
    // webview is pinned to absolute window coordinates, so the content region
    // must never scroll or its measured bounds desync from the overlay.
    <Shell scrollable={false}>
      <div className={styles.page}>
        <div className={styles.toolbar}>
          <input
            type="text"
            className={styles.input}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleNavigate();
              }
            }}
            placeholder="Type a URL or address to open — e.g. github.com or localhost:3000"
            aria-label="URL to preview"
          />
          <button type="button" className={styles.btn} onClick={handleNavigate}>
            Go
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            onClick={() => toggleHistory(!showHistory)}
          >
            History
          </button>
          <button
            type="button"
            className={styles.btn}
            onClick={handleCapture}
            disabled={createInbox.isPending}
          >
            {createInbox.isPending ? "Capturing…" : "Capture"}
          </button>
        </div>

        {showHistory ? (
          <div className={styles.history} role="listbox">
            {(visits.data?.visits ?? []).length === 0 ? (
              <div className={styles.historyRow}>No history yet.</div>
            ) : (
              (visits.data?.visits ?? []).map((v) => (
                <div
                  key={v.id}
                  className={styles.historyRow}
                  role="option"
                  aria-selected={false}
                  onClick={() => pickVisit(v)}
                >
                  <div>{v.url}</div>
                  <div className={styles.historyMeta}>{v.visited_at}</div>
                </div>
              ))
            )}
          </div>
        ) : null}

        {/* This div is the reserved rectangle that the native overlay covers.
            It stays in the DOM at all times so measure() always returns valid
            bounds for the ResizeObserver / repositioning logic. */}
        <div ref={frameWrapRef} className={styles.frameWrap}>
          {loaded === null ? (
            <div className={styles.empty}>
              Type a URL above to start browsing.
            </div>
          ) : null}
        </div>
      </div>
    </Shell>
  );
}
