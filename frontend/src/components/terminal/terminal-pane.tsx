import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import {
  sendTerminalInput,
  resizeTerminal,
  useTerminalOutput,
  usePtyExited,
  openPath,
} from "../../lib/ipc";
import { upsertSetting, TERMINAL_SETTING_DEFAULTS } from "../../lib/api";
import { decodeOsc7, decodeOscTitle } from "./osc-handlers";
import { useTerminalStore } from "../../stores/terminal-store";
import { usePanePathDrop } from "../../hooks/use-pane-path-drop";
import { SearchBar } from "./search-bar";
import { PaneContextMenu, type ContextMenuTarget } from "./pane-context-menu";
import { SessionHud } from "./session-hud";
import { Icon } from "../icon";
import styles from "./terminal-pane.module.css";

// ---------------------------------------------------------------------------
// Theme helpers
// ---------------------------------------------------------------------------

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

/** Build an xterm theme object from the Direction-3 CSS custom properties. */
function computeTheme(): Record<string, string> {
  return {
    background: cssVar("--bg-1"),
    foreground: cssVar("--fg-1"),
    cursor: cssVar("--accent"),
    cursorAccent: cssVar("--bg-1"),
    selectionBackground: alphaHex(cssVar("--accent"), 0.33),
    selectionForeground: cssVar("--fg-0"),
    // 16-color ANSI palette from --term-ansi-* tokens.
    black: cssVar("--term-ansi-0"),
    red: cssVar("--term-ansi-1"),
    green: cssVar("--term-ansi-2"),
    yellow: cssVar("--term-ansi-3"),
    blue: cssVar("--term-ansi-4"),
    magenta: cssVar("--term-ansi-5"),
    cyan: cssVar("--term-ansi-6"),
    white: cssVar("--term-ansi-7"),
    brightBlack: cssVar("--term-ansi-8"),
    brightRed: cssVar("--term-ansi-9"),
    brightGreen: cssVar("--term-ansi-10"),
    brightYellow: cssVar("--term-ansi-11"),
    brightBlue: cssVar("--term-ansi-12"),
    brightMagenta: cssVar("--term-ansi-13"),
    brightCyan: cssVar("--term-ansi-14"),
    brightWhite: cssVar("--term-ansi-15"),
  };
}

/**
 * Apply an alpha channel to a CSS hex color (`#rrggbb` or `#rgb`).
 * Falls back to a fixed rgba if the value can't be parsed cleanly.
 */
function alphaHex(hex: string, alpha: number): string {
  const clean = hex.replace(/^#/, "");
  let r = 0,
    g = 0,
    b = 0;
  if (clean.length === 3) {
    r = parseInt(clean[0]! + clean[0]!, 16);
    g = parseInt(clean[1]! + clean[1]!, 16);
    b = parseInt(clean[2]! + clean[2]!, 16);
  } else if (clean.length === 6) {
    r = parseInt(clean.slice(0, 2), 16);
    g = parseInt(clean.slice(2, 4), 16);
    b = parseInt(clean.slice(4, 6), 16);
  }
  return `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
}

// ---------------------------------------------------------------------------
// CWD display helper
// ---------------------------------------------------------------------------

function shortCwd(cwd: string | undefined): string {
  if (!cwd) return "";
  // Replace macOS-style (/Users/name) and Linux-style (/home/name) prefixes.
  return cwd.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

// ---------------------------------------------------------------------------
// POSIX path detector — used by the custom link provider and context menu.
// ---------------------------------------------------------------------------

/** Matches an absolute POSIX path or a relative path starting with ./ or ../ */
// eslint-disable-next-line no-control-regex
const POSIX_PATH_RE = /(?:^|(?<=\s|:))((?:\/|\.\.?\/)[^\s"'`\x00-\x1f]*)/g;

function detectPathAtPoint(text: string): string | null {
  POSIX_PATH_RE.lastIndex = 0;
  const matches = [...text.matchAll(POSIX_PATH_RE)];
  if (matches.length > 0 && matches[0]?.[1]) {
    return matches[0][1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Settings helpers — terminal settings from the sidecar API
// ---------------------------------------------------------------------------

/** Read the latest terminal settings snapshot from the in-process store. */
function getTerminalSettings(): {
  font_family: string;
  font_size: number;
  scrollback: number;
  copy_on_select: boolean;
} {
  // The settings are broadcast via a CustomEvent detail whenever the user
  // saves in Settings → Terminal.  We keep a module-level mutable snapshot so
  // panes initialised before the first save still get sensible defaults.
  return _cachedTerminalSettings;
}

const _cachedTerminalSettings = {
  font_family: TERMINAL_SETTING_DEFAULTS.font_family,
  font_size: TERMINAL_SETTING_DEFAULTS.font_size,
  scrollback: TERMINAL_SETTING_DEFAULTS.scrollback,
  copy_on_select: TERMINAL_SETTING_DEFAULTS.copy_on_select,
};

// Listen for live settings updates from the Settings → Terminal save action
// and from any future bootstrap that hydrates them.
if (typeof document !== "undefined") {
  document.addEventListener("terminal:settings-changed", (e) => {
    const detail = (e as CustomEvent<Partial<typeof _cachedTerminalSettings>>)
      .detail;
    if (detail.font_family !== undefined)
      _cachedTerminalSettings.font_family = detail.font_family;
    if (detail.font_size !== undefined)
      _cachedTerminalSettings.font_size = detail.font_size;
    if (detail.scrollback !== undefined)
      _cachedTerminalSettings.scrollback = detail.scrollback;
    if (detail.copy_on_select !== undefined)
      _cachedTerminalSettings.copy_on_select = detail.copy_on_select;
  });
}

function readCopyOnSelect(): boolean {
  return getTerminalSettings().copy_on_select;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface TerminalPaneProps {
  terminalId: string;
  title: string;
  cwd?: string;
  profileId?: string;
  showHeader?: boolean;
  /**
   * Whether this pane's owning tab is the active one. Required (no default)
   * so the two `document.body` portals below (context menu, paste modal) are
   * always deliberately gated — see `SplitContainer`'s `active` prop doc.
   */
  active: boolean;
}

export function TerminalPane({
  terminalId,
  title,
  showHeader = true,
  active,
}: TerminalPaneProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // searchAddon is exposed via state so the SearchBar component can receive it
  // as a prop without reading a ref during render.
  const [searchAddonState, setSearchAddonState] = useState<SearchAddon | null>(
    null,
  );
  // hasSelection mirrors the terminal selection state so the context menu can
  // read it during render without touching a ref.
  const [hasSelection, setHasSelection] = useState(false);

  // -- store subscriptions --
  const focusedLeafId = useTerminalStore((s) => s.focusedLeafId);
  const setFocusedLeaf = useTerminalStore((s) => s.setFocusedLeaf);
  const closePane = useTerminalStore((s) => s.closePane);
  const setLeafTitle = useTerminalStore((s) => s.setLeafTitle);
  const renameTab = useTerminalStore((s) => s.renameTab);
  const setLeafCwd = useTerminalStore((s) => s.setLeafCwd);
  const maximizedLeafId = useTerminalStore((s) => s.maximizedLeafId);
  const toggleMaximize = useTerminalStore((s) => s.toggleMaximize);
  const storeMarkLeafExited = useTerminalStore((s) => s.markLeafExited);

  // -- workspace-navigator drop target (in-window HTML5 drag, not the
  // Tauri OS-drop path that useTerminalFileDrop owns) --
  const { dropActive, handlers: panePathDropHandlers } =
    usePanePathDrop(terminalId);

  usePtyExited(terminalId, ({ exit_code }) => {
    storeMarkLeafExited(terminalId);
    const msg =
      exit_code != null
        ? `\r\n\x1b[2m[Process exited (code ${exit_code})]\x1b[0m\r\n`
        : `\r\n\x1b[2m[Process exited]\x1b[0m\r\n`;
    termRef.current?.write(msg);
  });

  // Subscribe to the live leaf node so we get up-to-date cwd and manualTitle.
  const tabs = useTerminalStore((s) => s.tabs);
  const liveLeaf = (() => {
    for (const tab of tabs) {
      const found = findLeafInLayout(tab.layout, terminalId);
      if (found) return found;
    }
    return null;
  })();
  const liveCwd = liveLeaf?.cwd;

  // -- local UI state --
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);
  const [searchOpen, setSearchOpen] = useState(false);
  const [pastePayload, setPastePayload] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    target: ContextMenuTarget;
  } | null>(null);

  // Debounce ref for copy-on-select.
  const copyDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // -------------------------------------------------------------------------
  // PTY output handler
  // -------------------------------------------------------------------------

  const handleChunk = useCallback((chunk: string) => {
    const binary = atob(chunk);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    termRef.current?.write(bytes);
  }, []);

  useTerminalOutput(terminalId, handleChunk);

  // -------------------------------------------------------------------------
  // Terminal mount / addons
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Live-apply terminal settings (18.5)
  // -------------------------------------------------------------------------

  useEffect(() => {
    const handler = (e: Event) => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term) return;
      const detail = (e as CustomEvent<Partial<typeof _cachedTerminalSettings>>)
        .detail;
      if (detail.font_family !== undefined)
        term.options.fontFamily = detail.font_family;
      if (detail.font_size !== undefined)
        term.options.fontSize = detail.font_size;
      // Reflow after any font change.
      if (detail.font_family !== undefined || detail.font_size !== undefined) {
        try {
          fit?.fit();
        } catch {
          /* ignore */
        }
        void resizeTerminal(terminalId, term.cols, term.rows);
      }
    };
    document.addEventListener("terminal:settings-changed", handler);
    return () => {
      document.removeEventListener("terminal:settings-changed", handler);
    };
  }, [terminalId]);

  // A pane hidden with `visibility: hidden` keeps its DOM/canvas up to date,
  // but force a full repaint from the buffer when it is revealed so the
  // visible rows can never depend on the child process redrawing — a pane
  // whose process already exited has no child left to ask.
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    if (!term) return;
    term.refresh(0, term.rows - 1);
  }, [active]);

  useEffect(() => {
    if (!containerRef.current) return;

    const { font_family, font_size, scrollback } = getTerminalSettings();

    const term = new Terminal({
      scrollback,
      cursorBlink: true,
      fontFamily: font_family,
      fontSize: font_size,
      theme: computeTheme(),
      macOptionIsMeta: true, // Option key → ESC+<key> for readline word-nav (bug #9)
      rightClickSelectsWord: false, // context menu is handled by PaneContextMenu
    });

    // FitAddon is always loaded.
    const fit = new FitAddon();
    term.loadAddon(fit);

    // SearchAddon.
    const search = new SearchAddon();
    term.loadAddon(search);
    setSearchAddonState(search);

    // WebLinksAddon — handle ⌘+click: open the URL; plain click does nothing
    // extra (xterm's default selection behaviour handles it).
    const webLinks = new WebLinksAddon((event, uri) => {
      if (event.metaKey) {
        void openPath(uri);
      }
    });
    term.loadAddon(webLinks);

    // Custom POSIX path link provider.
    term.registerLinkProvider({
      provideLinks(y, callback) {
        const line = term.buffer.active.getLine(y);
        if (!line) {
          callback([]);
          return;
        }
        const text = line.translateToString(true);
        POSIX_PATH_RE.lastIndex = 0;
        const links: Array<{
          range: {
            start: { x: number; y: number };
            end: { x: number; y: number };
          };
          text: string;
          activate: (event: MouseEvent) => void;
          hover?: (event: MouseEvent, text: string) => void;
        }> = [];
        for (const match of text.matchAll(POSIX_PATH_RE)) {
          const path = match[1];
          if (!path) continue;
          const startCol = match.index ?? 0;
          // Adjust for any capture group offset.
          const captureStart = match[0].indexOf(path);
          const col = startCol + captureStart;
          links.push({
            range: {
              start: { x: col + 1, y },
              end: { x: col + path.length, y },
            },
            text: path,
            activate(event) {
              if (event.metaKey) {
                void openPath(path);
              } else {
                // Plain click: select the path text so the user can copy.
                term.select(col, y - 1, path.length);
              }
            },
          });
        }
        callback(links);
      },
    });

    term.open(containerRef.current);

    termRef.current = term;
    fitRef.current = fit;

    // -- PTY input --
    const dataDisposable = term.onData((data) => {
      void sendTerminalInput(terminalId, data);
    });

    // -- focus tracking --
    const onFocusIn = (): void => setFocusedLeaf(terminalId);
    containerRef.current.addEventListener("focusin", onFocusIn);

    // Track whether the first real fit (and WebGL init) has happened.
    // WebglAddon MUST be loaded only after the container has non-zero pixel
    // dimensions.  Loading it on a 0px canvas bakes incorrect cell metrics into
    // the WebGL renderer's texture atlas; subsequent resizes re-flow the
    // col/row grid but the stale atlas metrics remain, causing erase sequences
    // (backspace → \b \b \b) to paint spaces at the wrong pixel offsets.
    // This is invisible on pane 1 (already sized at mount) but breaks every
    // subsequent split pane (container is 0px until react-resizable-panels
    // finishes its first layout pass).
    let webglAddon: WebglAddon | null = null;
    let firstFitDone = false;

    const doFirstFit = (): void => {
      if (firstFitDone) return;
      firstFitDone = true;
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
      // Activate WebGL now that the canvas has real pixel dimensions.
      try {
        webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          // Context lost — dispose WebGL and let xterm fall back to canvas.
          webglAddon?.dispose();
          webglAddon = null;
        });
        term.loadAddon(webglAddon);
      } catch {
        // WebGL not available; canvas renderer already active. Proceed.
      }
      // Force a full renderer repaint so the newly-activated WebGL (or canvas)
      // renderer is fully in sync with the terminal buffer after the first fit.
      term.refresh(0, term.rows - 1);
      void resizeTerminal(terminalId, term.cols, term.rows);
    };

    // -- resize --
    const ro = new ResizeObserver(() => {
      const el = containerRef.current;
      // Don't fit while hidden / zero-sized (inactive tab is display:none, or a
      // split is mid-layout) — a 0px fit collapses the grid to 1 col and squeezes
      // the text. The observer fires again when the pane gains real dimensions.
      if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) return;
      if (!firstFitDone) {
        doFirstFit();
        return;
      }
      try {
        const prevCols = term.cols;
        const prevRows = term.rows;
        fit.fit();
        // Full repaint only when the fit actually changed dimensions, so the
        // WebGL renderer rebuilds its render model with current atlas metrics.
        // Without this, incremental renderRows() calls after an atlas
        // reallocation use stale glyph UV coordinates and paint erase-spaces at
        // wrong pixel offsets (bug #9). Gating on a real size change avoids a
        // full GPU scene rebuild on every no-op ResizeObserver tick during a
        // drag, which can otherwise tear frames on slower Macs.
        if (term.cols !== prevCols || term.rows !== prevRows) {
          term.refresh(0, term.rows - 1);
        }
        void resizeTerminal(terminalId, term.cols, term.rows);
      } catch {
        // ignore
      }
    });
    ro.observe(containerRef.current);

    // Attempt the first fit in the next animation frame.  term.open() appends
    // the xterm DOM synchronously but the browser hasn't run a layout pass yet.
    // Waiting one rAF lets the browser finish layout so FitAddon measures the
    // true content-box height.  If the container is still 0px (split pane not
    // yet laid out), we skip here and let the ResizeObserver handle it on the
    // first non-zero measurement.
    let rafId = requestAnimationFrame(() => {
      rafId = 0;
      const el = containerRef.current;
      if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) return;
      doFirstFit();
    });

    // -- copy-on-select + selection tracking --
    const selDisposable = term.onSelectionChange(() => {
      const sel = term.getSelection();
      // Update has-selection flag so the context menu can read it during render.
      setHasSelection(sel.length > 0);
      if (!readCopyOnSelect()) return;
      if (copyDebounceRef.current) clearTimeout(copyDebounceRef.current);
      copyDebounceRef.current = setTimeout(() => {
        if (sel) void navigator.clipboard.writeText(sel).catch(() => undefined);
      }, 50);
    });

    // -- OSC 7: cwd tracking --
    const osc7 = term.parser.registerOscHandler(7, (payload) => {
      const path = decodeOsc7(payload);
      if (path) setLeafCwd(terminalId, path);
      return true;
    });

    // -- OSC 0 / OSC 2: title --
    // Read manualTitle from the store directly (not via ref) to avoid
    // the React compiler's "cannot modify ref used in effect" constraint.
    const oscTitleHandler = (payload: string): boolean => {
      const leaf = useTerminalStore
        .getState()
        .tabs.flatMap((tab) => {
          const l = findLeafInLayout(tab.layout, terminalId);
          return l ? [l] : [];
        })
        .at(0);
      if (leaf?.manualTitle) return true; // user has pinned a title
      const t = decodeOscTitle(payload);
      if (t) setLeafTitle(terminalId, t);
      return true;
    };
    const osc0 = term.parser.registerOscHandler(0, oscTitleHandler);
    const osc2 = term.parser.registerOscHandler(2, oscTitleHandler);

    // -- OSC 9: finish notification --
    const osc9 = term.parser.registerOscHandler(9, (payload) => {
      // Only notify when this pane is NOT the focused one.
      const storeState = useTerminalStore.getState();
      if (storeState.focusedLeafId !== terminalId) {
        // Import emitNativeNotification lazily to avoid a circular import.
        void import("../../lib/ipc").then(({ emitNativeNotification }) => {
          void emitNativeNotification({
            title:
              storeState.tabs
                .flatMap((tab) => {
                  const l = findLeafInLayout(tab.layout, terminalId);
                  return l ? [l.title] : [];
                })
                .at(0) ?? "Terminal",
            body: payload,
            priority: "default",
          }).catch(() => undefined);
        });
      }
      return true;
    });

    // -- keyboard shortcuts --
    // attachCustomKeyEventHandler returns void (replaces the previous handler).
    // The whole terminal is disposed on cleanup, so no explicit un-register needed.
    term.attachCustomKeyEventHandler((ev) => {
      // Shift+Enter — insert a literal newline without submitting.
      //
      // Claude Code v2.1.0+ uses the Kitty keyboard protocol to distinguish
      // Shift+Enter from plain Enter.  It pushes the protocol on startup with
      // `\x1b[>1u` when `TERM_PROGRAM` is in its allow-list.  We set
      // `TERM_PROGRAM=ghostty` on every PTY child (pty/mod.rs) so Claude
      // always enables Kitty mode, after which Shift+Enter is `\x1b[13;2u`
      // (CSI 13 ; 2 u — the Kitty modifier formula: base=1 + Shift=1 → 2).
      //
      // We intercept keydown only; keyup/keypress are passed through untouched.
      if (
        ev.key === "Enter" &&
        ev.shiftKey &&
        !ev.metaKey &&
        !ev.ctrlKey &&
        !ev.altKey &&
        ev.type === "keydown"
      ) {
        void sendTerminalInput(terminalId, "\x1b[13;2u");
        return false; // swallow — do not let xterm send its default \r
      }

      if (!ev.metaKey) return true; // let xterm handle non-meta

      // ⌘F — open search
      if (ev.key === "f" && ev.type === "keydown") {
        setSearchOpen(true);
        return false; // swallow so xterm doesn't see it
      }
      // ⌘K — clear viewport
      if (ev.key === "k" && ev.type === "keydown" && !ev.shiftKey) {
        term.clear();
        return false;
      }
      // ⌘⇧K — hard clear (viewport + scrollback)
      if (ev.key === "K" && ev.type === "keydown" && ev.shiftKey) {
        term.clear();
        term.write("\x1bc");
        return false;
      }
      // ⌘V — handled at DOM level below; swallow here so xterm doesn't paste twice.
      if (ev.key === "v" && ev.type === "keydown") {
        return false;
      }
      // ⌘= — increase font size (18.6)
      if ((ev.key === "=" || ev.key === "+") && ev.type === "keydown") {
        const next = Math.min(24, _cachedTerminalSettings.font_size + 1);
        if (next !== _cachedTerminalSettings.font_size) {
          void upsertSetting("terminal.font_size", next)
            .then(() => {
              document.dispatchEvent(
                new CustomEvent("terminal:settings-changed", {
                  detail: { font_size: next },
                }),
              );
            })
            .catch(() => undefined);
        }
        return false;
      }
      // ⌘- — decrease font size (18.6)
      if (ev.key === "-" && ev.type === "keydown") {
        const next = Math.max(9, _cachedTerminalSettings.font_size - 1);
        if (next !== _cachedTerminalSettings.font_size) {
          void upsertSetting("terminal.font_size", next)
            .then(() => {
              document.dispatchEvent(
                new CustomEvent("terminal:settings-changed", {
                  detail: { font_size: next },
                }),
              );
            })
            .catch(() => undefined);
        }
        return false;
      }
      // ⌘0 — reset font size to default (18.6)
      if (ev.key === "0" && ev.type === "keydown") {
        const reset = TERMINAL_SETTING_DEFAULTS.font_size;
        void upsertSetting("terminal.font_size", reset)
          .then(() => {
            document.dispatchEvent(
              new CustomEvent("terminal:settings-changed", {
                detail: { font_size: reset },
              }),
            );
          })
          .catch(() => undefined);
        return false;
      }
      return true;
    });

    // -- ⌘V paste with multiline confirmation --
    const hostEl = containerRef.current;
    const handlePasteKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.key === "v" && ev.metaKey && !ev.shiftKey && !ev.ctrlKey) {
        ev.preventDefault();
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (text.includes("\n")) {
              setPastePayload(text);
            } else {
              void sendTerminalInput(terminalId, text);
            }
          })
          .catch(() => undefined);
      }
    };
    hostEl.addEventListener("keydown", handlePasteKey);

    // -- theme:changed subscription --
    const onThemeChanged = () => {
      if (termRef.current) {
        termRef.current.options.theme = computeTheme();
      }
    };
    document.addEventListener("theme:changed", onThemeChanged);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      if (copyDebounceRef.current) clearTimeout(copyDebounceRef.current);
      ro.disconnect();
      dataDisposable.dispose();
      selDisposable.dispose();
      osc7.dispose();
      osc0.dispose();
      osc2.dispose();
      osc9.dispose();
      hostEl.removeEventListener("focusin", onFocusIn);
      hostEl.removeEventListener("keydown", handlePasteKey);
      document.removeEventListener("theme:changed", onThemeChanged);
      webglAddon?.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      setSearchAddonState(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId]);

  // -------------------------------------------------------------------------
  // Right-click context menu
  // -------------------------------------------------------------------------

  const handleContextMenu = (ev: React.MouseEvent<HTMLDivElement>) => {
    ev.preventDefault();
    const term = termRef.current;

    // Try to detect URL or path at click position — best-effort only.
    let target: ContextMenuTarget = {};
    if (term) {
      // Map mouse position to terminal cell.
      const bounds = (ev.currentTarget as HTMLElement).getBoundingClientRect();
      const charWidth = term.element
        ? ((term.element.querySelector(".xterm-rows") as HTMLElement | null)
            ?.offsetWidth ?? 0)
        : 0;
      const col =
        charWidth > 0
          ? Math.floor(((ev.clientX - bounds.left) / charWidth) * term.cols)
          : 0;
      const row =
        term.buffer.active.viewportY +
        Math.floor(
          ((ev.clientY - bounds.top) / (term.element?.offsetHeight ?? 1)) *
            term.rows,
        );

      const line = term.buffer.active.getLine(
        Math.max(0, Math.min(row, term.buffer.active.length - 1)),
      );
      if (line) {
        const text = line.translateToString(true);
        // URL detection — simple heuristic.
        const urlMatch = /https?:\/\/[^\s"'`]+/.exec(text);
        if (urlMatch) {
          const matchStart = urlMatch.index;
          const matchEnd = matchStart + urlMatch[0].length;
          if (col >= matchStart && col <= matchEnd) {
            target = { url: urlMatch[0] };
          }
        }
        // Path detection.
        if (!target.url) {
          const path = detectPathAtPoint(text);
          if (path) target = { path };
        }
      }
    }

    setContextMenu({ x: ev.clientX, y: ev.clientY, target });
  };

  const handleCopy = useCallback(() => {
    const sel = termRef.current?.getSelection();
    if (sel) void navigator.clipboard.writeText(sel).catch(() => undefined);
  }, []);

  const handlePaste = useCallback(() => {
    void navigator.clipboard
      .readText()
      .then((text) => {
        if (text.includes("\n")) {
          setPastePayload(text);
        } else {
          void sendTerminalInput(terminalId, text);
        }
      })
      .catch(() => undefined);
  }, [terminalId]);

  const handleClear = useCallback(() => {
    termRef.current?.clear();
  }, []);

  const confirmPaste = () => {
    if (pastePayload !== null) {
      void sendTerminalInput(terminalId, pastePayload);
    }
    setPastePayload(null);
    termRef.current?.focus();
  };

  const cancelPaste = () => {
    setPastePayload(null);
    termRef.current?.focus();
  };

  // -------------------------------------------------------------------------
  // Header / focus
  // -------------------------------------------------------------------------

  const isFocused = focusedLeafId === terminalId;

  const onTerminalClick = (): void => {
    setFocusedLeaf(terminalId);
    termRef.current?.focus();
  };

  const commitTitle = (): void => {
    const trimmed = draftTitle.trim();
    if (trimmed && trimmed !== title) {
      // Pass manual=true so OSC 0/2 won't overwrite the user's label.
      setLeafTitle(terminalId, trimmed, true);
      // Keep the tab strip in sync — find the owning tab and update its label.
      const owningTab = useTerminalStore
        .getState()
        .tabs.find((t) => findLeafInLayout(t.layout, terminalId) !== null);
      if (owningTab) renameTab(owningTab.id, trimmed);
    }
    setEditing(false);
  };

  const onTitleKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") commitTitle();
    if (e.key === "Escape") {
      setDraftTitle(title);
      setEditing(false);
    }
  };

  return (
    <div
      className={`${styles.pane} ${isFocused ? styles.paneFocused : ""} ${dropActive ? styles.paneDrop : ""}`}
      data-terminal-id={terminalId}
      {...panePathDropHandlers}
    >
      {showHeader ? (
        <div className={styles.header}>
          {editing ? (
            <input
              autoFocus
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={onTitleKey}
              className={styles.titleInput}
            />
          ) : (
            <span
              className={styles.title}
              onDoubleClick={() => {
                setDraftTitle(title);
                setEditing(true);
              }}
            >
              {title}
            </span>
          )}
          <span className={styles.cwd} title={liveCwd ?? ""}>
            {shortCwd(liveCwd)}
          </span>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => toggleMaximize(terminalId)}
            aria-label={
              maximizedLeafId === terminalId ? "Restore pane" : "Expand pane"
            }
            title={
              maximizedLeafId === terminalId ? "Restore pane" : "Expand pane"
            }
          >
            <Icon
              name={maximizedLeafId === terminalId ? "minimize" : "maximize"}
              size={14}
              stroke={1.6}
            />
          </button>
          <button
            type="button"
            className={styles.close}
            onClick={() => void closePane(terminalId)}
            aria-label="Close pane"
          >
            ×
          </button>
        </div>
      ) : null}

      {/* Session-state strip — gated on content only (D9): the default
          single-terminal tab renders this pane with no header at all, and
          this strip is the one piece of chrome that must still show up
          there. `.pane` is a column flexbox, so this renders directly
          beneath the header when one exists and as the first visible child
          when it does not. */}
      <SessionHud
        paneId={terminalId}
        cwd={liveCwd}
        exited={liveLeaf?.exited === true}
      />

      {/* Search bar overlay */}
      {searchOpen ? (
        <SearchBar
          searchAddon={searchAddonState}
          onClose={() => {
            setSearchOpen(false);
            termRef.current?.focus();
          }}
        />
      ) : null}

      <div
        ref={containerRef}
        className={styles.terminal}
        onMouseDown={onTerminalClick}
        onContextMenu={handleContextMenu}
      />

      {/* Context menu — gated on `active` (not cleared in an effect: doing so
          would be a `react-hooks/set-state-in-effect` lint error, and the
          state harmlessly survives to reappear if the user switches back
          with the menu still open). */}
      {active && contextMenu !== null
        ? createPortal(
            <PaneContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              hasSelection={hasSelection}
              target={contextMenu.target}
              onCopy={handleCopy}
              onPaste={handlePaste}
              onClear={handleClear}
              onClose={() => setContextMenu(null)}
            />,
            document.body,
          )
        : null}

      {/* Multi-line paste confirmation — gated on `active`, same rationale
          as the context menu above. */}
      {active && pastePayload !== null
        ? createPortal(
            <div className={styles.pasteOverlay}>
              <div className={styles.pasteModal}>
                <h3>Paste multi-line content?</h3>
                <pre className={styles.pastePreview}>{pastePayload}</pre>
                <div className={styles.pasteActions}>
                  <button
                    type="button"
                    className={styles.pasteBtnCancel}
                    onClick={cancelPaste}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className={styles.pasteBtnConfirm}
                    onClick={confirmPaste}
                  >
                    Paste
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Private helper — find a leaf in a layout tree by terminalId
// ---------------------------------------------------------------------------

function findLeafInLayout(
  node: import("../../lib/layout-tree").LayoutNode,
  targetId: string,
): import("../../lib/layout-tree").PaneLeaf | null {
  if (node.type === "leaf") {
    return node.terminalId === targetId ? node : null;
  }
  return (
    findLeafInLayout(node.children[0], targetId) ??
    findLeafInLayout(node.children[1], targetId)
  );
}
