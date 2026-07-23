//! Session launch commands for the Command Center.
//!
//! Two modes:
//!   - `command_center`: cwd = workspace dir; injects org-level env vars.
//!   - `project`: cwd = project `root_path` resolved from the sidecar; injects
//!     project-scoped env vars.
//!
//! Both commands delegate PTY allocation to [`crate::pty::PtyManager`] so that
//! all terminal sessions share a single lifecycle manager and are closed
//! correctly when the main window is destroyed.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::pty::{OpenTerminalArgs, PtyManager, TerminalHandle};
use crate::workspace::WorkspaceManager;

// ---------------------------------------------------------------------------
// Argument structs
// ---------------------------------------------------------------------------

/// Arguments for [`open_command_center_session`].
///
/// All fields are optional; sensible defaults are applied before the PTY is
/// opened.  `rows` and `cols` are accepted for forward-compatibility but are
/// not yet forwarded to the PTY (the xterm.js resize handshake handles sizing
/// after open).
#[derive(Debug, Deserialize)]
#[allow(dead_code)] // `rows` / `cols` reserved for future PTY pre-sizing
pub struct OpenCommandCenterArgs {
    #[serde(default)]
    pub shell: Option<String>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    /// Initial terminal rows (reserved for future PTY pre-sizing).
    #[serde(default)]
    pub rows: Option<u16>,
    /// Initial terminal columns (reserved for future PTY pre-sizing).
    #[serde(default)]
    pub cols: Option<u16>,
}

/// Arguments for [`open_project_session`].
#[derive(Debug, Deserialize)]
#[allow(dead_code)] // `rows` / `cols` reserved for future PTY pre-sizing
pub struct OpenProjectSessionArgs {
    pub project_id: i64,
    #[serde(default)]
    pub shell: Option<String>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    /// Initial terminal rows (reserved for future PTY pre-sizing).
    #[serde(default)]
    pub rows: Option<u16>,
    /// Initial terminal columns (reserved for future PTY pre-sizing).
    #[serde(default)]
    pub cols: Option<u16>,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Open a PTY session in the Command Center workspace directory.
///
/// The spawned shell inherits the caller-supplied `env` overlay (if any) and
/// receives two additional variables that Claude Code and project tooling can
/// inspect:
///
/// | Variable               | Value                        |
/// |------------------------|------------------------------|
/// | `CLAUDE_PROJECT_DIR`   | absolute workspace directory |
/// | `CODENEST_SESSION_MODE`| `command-center`             |
///
/// On success returns the [`TerminalHandle`] (containing the unique PTY `id`)
/// that the frontend should retain for subsequent `terminal_input`,
/// `terminal_resize`, and `close_terminal` calls.
#[tauri::command]
pub async fn open_command_center_session(
    args: OpenCommandCenterArgs,
    ws: State<'_, WorkspaceManager>,
    pty: State<'_, Arc<PtyManager>>,
    app: AppHandle,
) -> Result<TerminalHandle, String> {
    let cwd = ws
        .workspace_dir()
        .to_str()
        .ok_or_else(|| "workspace path contains non-UTF-8 characters".to_owned())?
        .to_owned();

    let mut env = args.env.unwrap_or_default();
    env.insert("CLAUDE_PROJECT_DIR".into(), cwd.clone());
    env.insert("CODENEST_SESSION_MODE".into(), "command-center".into());

    let pty_args = OpenTerminalArgs {
        cwd: Some(cwd),
        env: Some(env),
        shell: args.shell,
    };

    pty.open_terminal(pty_args, app)
}

/// Open a PTY session scoped to a specific project.
///
/// The project's `root_path` is resolved from the sidecar
/// (`GET /api/v1/projects/{id}`).  The spawned shell receives:
///
/// | Variable               | Value                       |
/// |------------------------|-----------------------------|
/// | `CLAUDE_PROJECT_DIR`   | absolute project root path  |
/// | `CODENEST_SESSION_MODE`| `project`                   |
/// | `CODENEST_PROJECT_ID`  | numeric project id (string) |
///
/// Returns an error if the sidecar is unreachable, the project does not exist,
/// or the project row has no `root_path`.
#[tauri::command]
pub async fn open_project_session(
    args: OpenProjectSessionArgs,
    pty: State<'_, Arc<PtyManager>>,
    app: AppHandle,
) -> Result<TerminalHandle, String> {
    let root_path = resolve_project_root(args.project_id).await?;

    let mut env = args.env.unwrap_or_default();
    env.insert("CLAUDE_PROJECT_DIR".into(), root_path.clone());
    env.insert("CODENEST_SESSION_MODE".into(), "project".into());
    env.insert("CODENEST_PROJECT_ID".into(), args.project_id.to_string());

    let pty_args = OpenTerminalArgs {
        cwd: Some(root_path),
        env: Some(env),
        shell: args.shell,
    };

    pty.open_terminal(pty_args, app)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Fetch the `root_path` for a project from the sidecar.
///
/// Tries the `root_path` key first, then falls back to `path` for
/// forward-compatibility with schema variations.  Returns `Err` if the sidecar
/// is unreachable, returns a non-2xx status, or the response body lacks both
/// keys.
async fn resolve_project_root(project_id: i64) -> Result<String, String> {
    let url = format!("http://127.0.0.1:8002/api/v1/projects/{project_id}");

    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("sidecar unreachable: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!(
            "sidecar returned {} for project {project_id}",
            resp.status()
        ));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("invalid sidecar response: {e}"))?;

    body.get("root_path")
        .and_then(|v| v.as_str())
        .or_else(|| body.get("path").and_then(|v| v.as_str()))
        .map(|s| s.to_owned())
        .ok_or_else(|| format!("project {project_id} has no root_path in sidecar response"))
}
