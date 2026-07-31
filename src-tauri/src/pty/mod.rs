use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::Path,
    sync::{Arc, Mutex},
    thread,
};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
pub struct TerminalHandle {
    pub id: String,
}

#[derive(Debug, serde::Deserialize)]
pub struct OpenTerminalArgs {
    pub cwd: Option<String>,
    /// Optional environment variable overlay.  Each key-value pair is set on
    /// the spawned shell's environment **without** clearing the inherited env.
    /// An empty map is a no-op.
    pub env: Option<HashMap<String, String>>,
    /// Optional shell binary path (e.g. `/bin/bash`).  When present it
    /// overrides `$SHELL`.  The path must exist and be executable; an absent
    /// or inaccessible path is returned as an `Err` before any PTY is
    /// allocated.
    pub shell: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
pub struct TerminalInputArgs {
    pub id: String,
    /// Base64-encoded bytes to write to the PTY master.
    pub data: String,
}

#[derive(Debug, serde::Deserialize)]
pub struct ResizeTerminalArgs {
    pub id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, serde::Deserialize)]
pub struct CloseTerminalArgs {
    pub id: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PtyExitedPayload {
    pub id: String,
    pub exit_code: Option<i32>,
}

// ---------------------------------------------------------------------------
// Internal handle
// ---------------------------------------------------------------------------

struct PtyHandle {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    /// Shared with the reader thread so both the explicit `close_terminal`
    /// path and the self-cleanup path can call `kill()`.
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    _reader_thread: thread::JoinHandle<()>,
}

// ---------------------------------------------------------------------------
// Tilde expansion helper
// ---------------------------------------------------------------------------

/// Expand a leading `~` or `~/` to the value of `$HOME`.
///
/// - `"~"` alone    → `$HOME`
/// - `"~/foo"`      → `$HOME/foo`
/// - anything else  → unchanged
///
/// If `$HOME` is not set the string is returned as-is.
fn expand_tilde(value: &str) -> String {
    if value == "~" {
        return std::env::var("HOME").unwrap_or_else(|_| value.to_string());
    }
    if let Some(rest) = value.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return format!("{home}/{rest}");
        }
    }
    value.to_string()
}

// ---------------------------------------------------------------------------
// PtyManager
// ---------------------------------------------------------------------------

type HandleMap = Arc<Mutex<HashMap<String, PtyHandle>>>;

pub struct PtyManager {
    handles: HandleMap,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            handles: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn open_terminal(
        &self,
        args: OpenTerminalArgs,
        app: AppHandle,
    ) -> Result<TerminalHandle, String> {
        let handles_arc = Arc::clone(&self.handles);
        let app_for_exit = app.clone();
        self.open_terminal_inner(
            args,
            move |event, chunk| {
                let _ = app.emit(event, chunk);
            },
            Some((handles_arc, app_for_exit)),
        )
    }

    /// Internal entry point shared by the public `open_terminal` and by tests.
    ///
    /// `emit_output` is called for every chunk of PTY output.
    ///
    /// `exit_ctx` is `Some((handles_arc, app_handle))` for the production path
    /// and `None` for unit tests (which have no Tauri runtime).  When `Some`,
    /// the reader thread's EOF handler removes the entry from the handles map
    /// and broadcasts a `pty-exited` event; when `None` it is a no-op.
    fn open_terminal_inner<F>(
        &self,
        args: OpenTerminalArgs,
        emit_output: F,
        exit_ctx: Option<(HandleMap, AppHandle)>,
    ) -> Result<TerminalHandle, String>
    where
        F: Fn(&str, String) + Send + 'static,
    {
        let id = Uuid::new_v4().to_string();

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("openpty failed: {e}"))?;

        let shell = if let Some(ref requested) = args.shell {
            let p = Path::new(requested);
            if !p.exists() {
                return Err(format!("shell not found: {requested}"));
            }
            if !p.is_file() {
                return Err(format!("shell path is not a file: {requested}"));
            }
            requested.clone()
        } else {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
        };

        let mut cmd = CommandBuilder::new(&shell);
        if let Some(cwd) = args.cwd {
            let expanded = expand_tilde(&cwd);
            if !Path::new(&expanded).exists() {
                return Err(format!("cwd does not exist: {expanded}"));
            }
            cmd.cwd(expanded);
        }

        // Inject Kitty keyboard protocol env vars so Claude Code (v2.1.0+)
        // recognises this terminal as a supported host and pushes the Kitty
        // protocol on startup.  Without these vars Claude stays in legacy mode
        // and there is no byte sequence that can distinguish Shift+Enter from
        // Enter at the wire level.
        //
        // `ghostty` is on Claude's hard-coded allow-list for TERM_PROGRAM, is
        // safe for non-Claude programs, and matches what real Ghostty users see.
        // We leave TERM as xterm-256color; switching to xterm-kitty would
        // require shipping custom terminfo.
        //
        // These are set before the caller-supplied env overlay so the caller
        // can still override them if needed.
        cmd.env("TERM_PROGRAM", "ghostty");
        cmd.env("TERM_PROGRAM_VERSION", "1.0.0");
        cmd.env("COLORTERM", "truecolor");

        if let Some(env_map) = args.env {
            for (k, v) in env_map {
                cmd.env(k, expand_tilde(&v));
            }
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn failed: {e}"))?;

        let child_arc: Arc<Mutex<Box<dyn Child + Send + Sync>>> = Arc::new(Mutex::new(child));
        let child_arc_for_thread = Arc::clone(&child_arc);

        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

        let output_event = format!("terminal_output:{id}");
        let thread_id = id.clone();

        let reader_thread = thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Err(_) => break,
                    Ok(n) => {
                        let chunk = B64.encode(&buf[..n]);
                        emit_output(&output_event, chunk);
                    }
                }
            }

            // Non-blocking reap: try_wait returns immediately.  If the child
            // is still alive (unlikely after master EOF) we accept None rather
            // than blocking.
            let exit_code = child_arc_for_thread
                .lock()
                .unwrap()
                .try_wait()
                .ok()
                .flatten()
                .map(|s| s.exit_code() as i32);

            if let Some((handles, app)) = exit_ctx {
                handles.lock().unwrap().remove(&thread_id);
                let _ = app.emit(
                    "pty-exited",
                    PtyExitedPayload {
                        id: thread_id,
                        exit_code,
                    },
                );
            }
        });

        let handle = PtyHandle {
            master: pair.master,
            writer,
            child: child_arc,
            _reader_thread: reader_thread,
        };

        self.handles.lock().unwrap().insert(id.clone(), handle);

        Ok(TerminalHandle { id })
    }

    /// Number of currently-open PTY handles.
    pub fn active_count(&self) -> usize {
        self.handles.lock().unwrap().len()
    }

    /// The ids of every PTY this process currently holds.
    ///
    /// Feeds the run reconciliation in `list_live_panes` (`lib.rs`): the shell
    /// owns the child processes, so it is the only honest answer to "is this
    /// pane still alive?" — the sidecar can only know what someone told it, and
    /// a report is exactly what goes missing when a window is torn down or the
    /// app exits.
    pub fn live_pane_ids(&self) -> Vec<String> {
        self.handles.lock().unwrap().keys().cloned().collect()
    }

    #[cfg(test)]
    pub(crate) fn contains(&self, id: &str) -> bool {
        self.handles.lock().unwrap().contains_key(id)
    }

    pub fn terminal_input(&self, args: TerminalInputArgs) -> Result<(), String> {
        let mut map = self.handles.lock().unwrap();
        let handle = map
            .get_mut(&args.id)
            .ok_or_else(|| format!("unknown terminal: {}", args.id))?;
        let bytes = B64
            .decode(&args.data)
            .map_err(|e| format!("base64 decode: {e}"))?;
        handle.writer.write_all(&bytes).map_err(|e| e.to_string())
    }

    pub fn terminal_resize(&self, args: ResizeTerminalArgs) -> Result<(), String> {
        let cols = args.cols.clamp(10, 500);
        let rows = args.rows.clamp(3, 200);
        let map = self.handles.lock().unwrap();
        let handle = map
            .get(&args.id)
            .ok_or_else(|| format!("unknown terminal: {}", args.id))?;
        handle
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }

    /// Close and remove the PTY handle for `args.id`.
    ///
    /// Idempotent: if the handle was already removed by the reader thread's
    /// self-cleanup (because the shell exited naturally), returns `Ok(())`.
    pub fn close_terminal(&self, args: CloseTerminalArgs) -> Result<(), String> {
        let mut map = self.handles.lock().unwrap();
        if let Some(handle) = map.remove(&args.id) {
            let _ = handle.child.lock().unwrap().kill();
            drop(handle);
        }
        Ok(())
    }

    pub fn close_all(&self) {
        let mut map = self.handles.lock().unwrap();
        for (_, handle) in map.drain() {
            let _ = handle.child.lock().unwrap().kill();
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn open_for_test(mgr: &PtyManager) -> String {
        mgr.open_terminal_inner(
            OpenTerminalArgs {
                cwd: None,
                env: None,
                shell: None,
            },
            |_event, _chunk| {},
            None,
        )
        .expect("open_terminal_inner succeeds in test")
        .id
    }

    /// The input to run reconciliation: a pane id missing from this list is
    /// what tells the sidecar a `running` row is stale.
    #[test]
    fn live_pane_ids_tracks_open_handles() {
        let mgr = PtyManager::new();
        assert!(mgr.live_pane_ids().is_empty());

        let id_a = open_for_test(&mgr);
        let id_b = open_for_test(&mgr);
        let live = mgr.live_pane_ids();
        assert_eq!(live.len(), 2);
        assert!(live.contains(&id_a));
        assert!(live.contains(&id_b));

        mgr.close_terminal(CloseTerminalArgs { id: id_a.clone() })
            .expect("close_terminal succeeds");

        let live = mgr.live_pane_ids();
        assert_eq!(live, vec![id_b], "a closed handle must drop out of the list");
    }

    #[test]
    fn close_terminal_removes_only_target_handle() {
        let mgr = PtyManager::new();
        let id_a = open_for_test(&mgr);
        let id_b = open_for_test(&mgr);

        assert_eq!(mgr.active_count(), 2);
        assert!(mgr.contains(&id_a));
        assert!(mgr.contains(&id_b));

        mgr.close_terminal(CloseTerminalArgs { id: id_a.clone() })
            .expect("close_terminal succeeds");

        assert_eq!(mgr.active_count(), 1);
        assert!(!mgr.contains(&id_a));
        assert!(mgr.contains(&id_b));

        mgr.close_all();
        assert_eq!(mgr.active_count(), 0);
    }

    #[test]
    fn close_all_drains_multiple_handles() {
        let mgr = PtyManager::new();
        let ids: Vec<String> = (0..3).map(|_| open_for_test(&mgr)).collect();

        assert_eq!(mgr.active_count(), 3);
        for id in &ids {
            assert!(mgr.contains(id));
        }

        mgr.close_all();

        assert_eq!(mgr.active_count(), 0);
        for id in &ids {
            assert!(!mgr.contains(id));
        }
    }

    #[test]
    fn close_terminal_unknown_id_is_idempotent() {
        let mgr = PtyManager::new();
        mgr.close_terminal(CloseTerminalArgs {
            id: "does-not-exist".into(),
        })
        .expect("closing an unknown id must succeed (idempotent)");
    }

    #[test]
    fn close_terminal_twice_is_idempotent() {
        let mgr = PtyManager::new();
        let id = open_for_test(&mgr);

        mgr.close_terminal(CloseTerminalArgs { id: id.clone() })
            .expect("first close succeeds");
        mgr.close_terminal(CloseTerminalArgs { id: id.clone() })
            .expect("second close must also succeed (idempotent)");

        assert_eq!(mgr.active_count(), 0);
    }

    #[test]
    fn env_overlay_does_not_break_open_terminal() {
        let mgr = PtyManager::new();
        let mut env_map = HashMap::new();
        env_map.insert("TEST_VAR".to_string(), "hello_from_test".to_string());
        env_map.insert("ANOTHER_VAR".to_string(), "42".to_string());

        let result = mgr.open_terminal_inner(
            OpenTerminalArgs {
                cwd: None,
                env: Some(env_map),
                shell: None,
            },
            |_event, _chunk| {},
            None,
        );
        let handle = result.expect("PTY with env overlay should open successfully");
        assert!(mgr.contains(&handle.id), "handle must be registered");
        mgr.close_all();
    }

    #[test]
    fn expand_tilde_produces_absolute_paths() {
        let home = std::env::var("HOME").expect("HOME must be set for this test");

        assert_eq!(expand_tilde("~"), home);
        assert_eq!(expand_tilde("~/foo"), format!("{home}/foo"));
        assert_eq!(expand_tilde("~/a/b/c"), format!("{home}/a/b/c"));

        assert_eq!(expand_tilde("/absolute/path"), "/absolute/path");
        assert_eq!(expand_tilde("relative/path"), "relative/path");
        assert_eq!(expand_tilde(""), "");
    }

    #[test]
    fn missing_cwd_returns_descriptive_error() {
        let mgr = PtyManager::new();
        let err = mgr
            .open_terminal_inner(
                OpenTerminalArgs {
                    cwd: Some("/this/cwd/does/absolutely/not/exist/ever".to_string()),
                    env: None,
                    shell: None,
                },
                |_event, _chunk| {},
                None,
            )
            .expect_err("non-existent cwd must return Err");
        assert!(
            err.contains("cwd does not exist"),
            "error message should mention 'cwd does not exist', got: {err}"
        );
        assert_eq!(mgr.active_count(), 0, "no PTY should be allocated on error");
    }

    #[test]
    fn terminal_resize_clamps_extreme_values() {
        let mgr = PtyManager::new();
        let id = open_for_test(&mgr);

        mgr.terminal_resize(ResizeTerminalArgs {
            id: id.clone(),
            cols: 0,
            rows: 0,
        })
        .expect("resize with 0 cols/rows should not error after clamping");

        mgr.terminal_resize(ResizeTerminalArgs {
            id: id.clone(),
            cols: 9999,
            rows: 9999,
        })
        .expect("resize with oversized cols/rows should not error after clamping");

        mgr.close_all();
    }

    #[test]
    fn invalid_shell_path_returns_error() {
        let mgr = PtyManager::new();
        let err = mgr
            .open_terminal_inner(
                OpenTerminalArgs {
                    cwd: None,
                    env: None,
                    shell: Some("/this/shell/does/not/exist".to_string()),
                },
                |_event, _chunk| {},
                None,
            )
            .expect_err("non-existent shell must return Err");
        assert!(
            err.contains("shell not found"),
            "error message should mention 'shell not found', got: {err}"
        );
        assert_eq!(mgr.active_count(), 0, "no PTY should be allocated on error");
    }

    // E5.1 — verify that a CLAUDE_CONFIG_DIR-style env key with a tilde value
    // is tilde-expanded by expand_tilde before being handed to the PTY.
    // This is the Rust-side leg of the E5 env chain:
    //   mergeEnv (TS) → spec.env → openTerminal({ env }) → IPC → open_terminal_inner
    //   → expand_tilde per value → cmd.env(k, expanded_v) → spawned shell.
    #[test]
    fn env_overlay_tilde_expansion_for_claude_config_dir() {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());

        // ~ alone → $HOME
        assert_eq!(expand_tilde("~"), home);

        // ~/foo → $HOME/foo (typical CLAUDE_CONFIG_DIR value)
        assert_eq!(
            expand_tilde("~/.claude-alt"),
            format!("{home}/.claude-alt")
        );
        assert_eq!(
            expand_tilde("~/.claude-alt2"),
            format!("{home}/.claude-alt2")
        );
        assert_eq!(expand_tilde("~/.claude"), format!("{home}/.claude"));

        // Absolute paths pass through unchanged — already expanded by the OS or by the UI.
        let abs = format!("{home}/.claude-alt");
        assert_eq!(expand_tilde(&abs), abs);

        // A PTY with a tilde CLAUDE_CONFIG_DIR in the env overlay opens successfully.
        // This exercises the full open_terminal_inner env path without a Tauri runtime.
        let mgr = PtyManager::new();
        let mut env_map = HashMap::new();
        env_map.insert(
            "CLAUDE_CONFIG_DIR".to_string(),
            "~/.claude-alt".to_string(),
        );
        // CLAUDE_PROJECT_DIR co-existing must not clobber CLAUDE_CONFIG_DIR (E5.4).
        env_map.insert(
            "CLAUDE_PROJECT_DIR".to_string(),
            "/repos/my-project".to_string(),
        );
        let result = mgr.open_terminal_inner(
            OpenTerminalArgs {
                cwd: None,
                env: Some(env_map),
                shell: None,
            },
            |_event, _chunk| {},
            None,
        );
        let handle = result.expect("PTY with CLAUDE_CONFIG_DIR env overlay should open");
        assert!(mgr.contains(&handle.id));
        mgr.close_all();
    }
}
