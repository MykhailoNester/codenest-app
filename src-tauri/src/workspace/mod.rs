use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

// ---------------------------------------------------------------------------
// WorkspaceManager
// ---------------------------------------------------------------------------

/// Manages the on-disk layout for the Command Center workspace.
///
/// All paths are resolved once at startup via Tauri's `PathResolver` so
/// subsequent accesses are a cheap `&Path` borrow with no I/O.
///
/// # Directories
///
/// | Field                 | Path                                             |
/// |-----------------------|--------------------------------------------------|
/// | `app_data_dir`        | `~/Library/Application Support/<identifier>/`    |
/// | `workspace_dir`       | `<app_data_dir>/workspace/`                      |
/// | `org_agents_dir`      | `<app_data_dir>/org-agents/`                     |
/// | `bundle_resources_dir`| `<resource_dir>/org-agents/`  (dev fallback:     |
/// |                       |  `<CARGO_MANIFEST_DIR>/resources/org-agents/`)   |
pub struct WorkspaceManager {
    app_data_dir: PathBuf,
    workspace_dir: PathBuf,
    org_agents_dir: PathBuf,
    bundle_resources_dir: PathBuf,
}

impl WorkspaceManager {
    /// Resolve all workspace paths from the running Tauri app handle.
    ///
    /// In debug builds the `bundle_resources_dir` falls back to the repo-relative
    /// `<CARGO_MANIFEST_DIR>/resources/org-agents` directory so `cargo tauri dev`
    /// works without a bundled `.app`.
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("cannot resolve app_data_dir: {e}"))?;

        let workspace_dir = app_data_dir.join("workspace");
        let org_agents_dir = app_data_dir.join("org-agents");

        // In release, resources live inside the `.app` bundle at
        // `Contents/Resources/org-agents`.  In dev builds Tauri's resource_dir
        // may not be set up correctly, so we fall back to the repo-relative path.
        let bundle_resources_dir = {
            #[cfg(not(debug_assertions))]
            {
                app.path()
                    .resource_dir()
                    .map_err(|e| format!("cannot resolve resource_dir: {e}"))?
                    .join("org-agents")
            }

            #[cfg(debug_assertions)]
            {
                // resource_dir() in dev points at the Tauri-generated resource
                // directory which may not contain org-agents yet.  Use the repo
                // path as the canonical dev-time source.
                let _ = app; // suppress unused-variable lint in this branch
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("resources")
                    .join("org-agents")
            }
        };

        Ok(Self {
            app_data_dir,
            workspace_dir,
            org_agents_dir,
            bundle_resources_dir,
        })
    }

    /// Create all required workspace directories idempotently.
    ///
    /// Missing directories are created with `create_dir_all`; directories that
    /// already exist are left untouched.  Failure is returned as an
    /// `std::io::Error` so the caller can decide whether to abort or warn.
    pub fn bootstrap(&self) -> std::io::Result<()> {
        // App-data root
        std::fs::create_dir_all(&self.app_data_dir)?;

        // Org-agents install target
        std::fs::create_dir_all(&self.org_agents_dir)?;

        // Workspace root
        std::fs::create_dir_all(&self.workspace_dir)?;

        // Workspace .claude sub-directories
        std::fs::create_dir_all(self.workspace_dir.join(".claude").join("agents"))?;
        std::fs::create_dir_all(self.workspace_dir.join(".claude").join("skills"))?;
        std::fs::create_dir_all(self.workspace_dir.join(".claude").join("commands"))?;

        Ok(())
    }

    // -----------------------------------------------------------------------
    // Path accessors
    // -----------------------------------------------------------------------

    /// `~/Library/Application Support/<identifier>/` (macOS example).
    pub fn app_data_dir(&self) -> &Path {
        &self.app_data_dir
    }

    /// `<app_data_dir>/workspace/`
    pub fn workspace_dir(&self) -> &Path {
        &self.workspace_dir
    }

    /// `<app_data_dir>/org-agents/`
    pub fn org_agents_dir(&self) -> &Path {
        &self.org_agents_dir
    }

    /// Path to the bundled org-agents directory inside the app bundle
    /// (or the repo-relative fallback in dev builds).
    pub fn bundle_resources_dir(&self) -> &Path {
        &self.bundle_resources_dir
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Return the absolute workspace directory path as a string.
///
/// This is the `cwd` used for command-center PTY sessions.
#[tauri::command]
pub fn get_workspace_path(ws: State<'_, WorkspaceManager>) -> Result<String, String> {
    ws.workspace_dir()
        .to_str()
        .map(|s| s.to_owned())
        .ok_or_else(|| "workspace path contains non-UTF-8 characters".to_owned())
}

/// Return the absolute org-agents directory path as a string.
#[tauri::command]
pub fn get_org_agents_path(ws: State<'_, WorkspaceManager>) -> Result<String, String> {
    ws.org_agents_dir()
        .to_str()
        .map(|s| s.to_owned())
        .ok_or_else(|| "org_agents path contains non-UTF-8 characters".to_owned())
}

/// Return the absolute app-data directory path as a string.
#[tauri::command]
pub fn get_app_data_path(ws: State<'_, WorkspaceManager>) -> Result<String, String> {
    ws.app_data_dir()
        .to_str()
        .map(|s| s.to_owned())
        .ok_or_else(|| "app_data path contains non-UTF-8 characters".to_owned())
}
