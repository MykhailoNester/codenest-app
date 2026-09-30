// Lets the frontend boot in a plain browser, where window.__TAURI_INTERNALS__
// does not exist. The sidecar is reached over HTTP either way, so only the
// native shell commands are faked here.

type Handler = (payload: unknown) => void;

interface CallbackEntry {
  fn: Handler;
  once: boolean;
}

const callbacks = new Map<number, CallbackEntry>();
const listeners = new Map<string, Set<number>>();
let nextId = 1;

function transformCallback(fn: Handler, once = false): number {
  const id = nextId++;
  callbacks.set(id, { fn, once });
  return id;
}

function runCallback(id: number, payload: unknown): void {
  const entry = callbacks.get(id);
  if (!entry) return;
  entry.fn(payload);
  if (entry.once) callbacks.delete(id);
}

/** Deliver an event to everything that called `listen(name, …)`. */
export function emitMockEvent(event: string, payload: unknown): void {
  const ids = listeners.get(event);
  if (!ids) return;
  for (const id of [...ids]) {
    runCallback(id, { event, id, payload });
  }
}

/** Panes started through `agent_start` / `open_terminal` in this session. */
const livePanes = new Set<string>();

const WORKSPACE = "/workspace";

const COMMANDS: Record<string, (args: Record<string, unknown>) => unknown> = {
  // Clears the startup splash: the sidecar really is up, on :8002.
  get_sidecar_status: () => ({ running: true, version: "web-mock", pid: null }),
  get_workspace_path: () => WORKSPACE,
  get_app_data_path: () => `${WORKSPACE}/.app-data`,
  get_org_agents_path: () => `${WORKSPACE}/.claude/agents`,

  list_live_panes: () => [...livePanes],
  get_active_terminal_count: () => livePanes.size,

  open_terminal: (a) => {
    const id = `web-term-${nextId++}`;
    livePanes.add(id);
    const args = (a.args ?? {}) as Record<string, unknown>;
    setTimeout(() => {
      emitMockEvent(`terminal://${id}`, {
        data: `web mock — no pty in the browser\r\ncwd ${String(args.cwd ?? WORKSPACE)}\r\n$ `,
      });
    }, 60);
    return { id, cols: 80, rows: 24 };
  },
  terminal_input: () => null,
  terminal_resize: () => null,
  close_terminal: (a) => {
    const args = (a.args ?? {}) as Record<string, unknown>;
    livePanes.delete(String(args.id ?? ""));
    return null;
  },

  agent_start: (a) => {
    const args = (a.args ?? {}) as Record<string, unknown>;
    const paneId = String(args.paneId ?? `web-agent-${nextId++}`);
    livePanes.add(paneId);
    const sessionId = `web-${paneId}`;
    setTimeout(() => {
      emitMockEvent(`agent://${paneId}`, {
        kind: "system",
        subtype: "init",
        session_id: sessionId,
        model: args.model ?? "claude-opus-5",
        permission_mode: args.mode ?? "default",
      });
    }, 80);
    return { paneId, sessionId };
  },
  agent_send: (a) => {
    const args = (a.args ?? {}) as Record<string, unknown>;
    const paneId = String(args.paneId ?? "");
    setTimeout(() => {
      emitMockEvent(`agent://${paneId}`, {
        kind: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: "Web mock: no agent process runs in the browser. This pane echoes so the composer, permission dialogs and HUD can be exercised.",
            },
          ],
        },
      });
    }, 220);
    return null;
  },
  agent_interrupt: () => null,
  agent_stop: (a) => {
    const args = (a.args ?? {}) as Record<string, unknown>;
    livePanes.delete(String(args.paneId ?? ""));
    return null;
  },
  agent_stop_task: () => null,
  agent_set_model: () => null,
  agent_set_permission_mode: () => null,
  agent_respond_permission: () => null,

  fs_list_dir: () => ({ entries: [] }),
  fs_build_file_index: () => ({ files: [], truncated: false }),
  fs_watch_set_roots: () => null,
  fs_watch_status: () => ({ watching: false, roots: [] }),
  paths_exist: (a) => {
    const paths = (a.paths ?? []) as string[];
    return Object.fromEntries(paths.map((p) => [p, true]));
  },
  read_file_text: () => ({ contents: "", truncated: false, sizeBytes: 0 }),

  git_status_for_roots: () => ({}),
  get_git_pane_status: () => null,
  get_recent_commits: () => [],

  request_notification_permission: () => true,
  emit_native_notification: () => null,
  run_hook_probe: () => ({ ok: false, detail: "not available in the browser" }),
  get_schedule_run_pty_id: () => null,

  open_path: () => null,
  open_external_url: (a) => {
    const url = String(a.url ?? (a.args as Record<string, unknown> | undefined)?.url ?? "");
    if (url) window.open(url, "_blank", "noopener");
    return null;
  },
  open_in_editor: () => null,
  reveal_in_finder: () => null,
  convert_file_src: (a) => String(a.path ?? ""),
};

// Shell affordances a browser tab has no equivalent for.
for (const noop of [
  "open_terminals_window",
  "close_terminals_window",
  "emit_focus_pane_to_terminals",
  "emit_stop_agent_pane_to_terminals",
  "open_command_center_session",
  "open_project_session",
  "open_screenshot_ring",
  "close_screenshot_ring",
  "capture_screenshot",
  "ring_capture",
  "preview_open",
  "preview_close",
  "preview_navigate",
  "preview_show",
  "preview_set_bounds",
]) {
  COMMANDS[noop] = () => null;
}

function mockInvoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (cmd === "plugin:event|listen") {
    const event = String(args.event);
    const id = Number(args.handler);
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(id);
    return Promise.resolve(id);
  }
  if (cmd === "plugin:event|unlisten") {
    listeners.get(String(args.event))?.delete(Number(args.eventId));
    return Promise.resolve(null);
  }
  if (cmd.startsWith("plugin:global-shortcut|")) {
    return Promise.resolve(cmd.endsWith("isRegistered") ? false : null);
  }
  if (cmd.startsWith("plugin:dialog|")) return Promise.resolve(null);
  if (cmd.startsWith("plugin:")) return Promise.resolve(null);

  const impl = COMMANDS[cmd];
  if (!impl) {
    console.warn(`[tauri-web-mock] unhandled command: ${cmd}`);
    return Promise.resolve(null);
  }
  try {
    return Promise.resolve(impl(args));
  } catch (err) {
    return Promise.reject(err);
  }
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** No-op inside Tauri. Returns true when the browser mock was installed. */
export function installTauriWebMock(): boolean {
  if (typeof window === "undefined" || isTauri()) return false;

  const w = window as unknown as Record<string, unknown>;
  w.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    plugins: {},
    callbacks,
    transformCallback,
    runCallback,
    unregisterCallback: (id: number) => void callbacks.delete(id),
    invoke: mockInvoke,
    convertFileSrc: (path: string) => path,
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (event: string, eventId: number) =>
      void listeners.get(event)?.delete(eventId),
  };

  document.documentElement.dataset.webMock = "1";
  return true;
}
