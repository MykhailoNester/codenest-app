//! Shared filesystem-scope policy for the workspace-navigator surface
//! (`fs_nav`, `fswatch`, `git_status_for_roots`).
//!
//! This is the **third** reader of the app's home-scope policy, after
//! `commands/docs.rs` (the Rust shell's own trust boundary) and
//! `app/services/project_scanner_service.py`'s `_SENSITIVE_SEGMENTS` (the
//! sidecar's mirror of the same denylist — see the comment at that module's
//! `_SENSITIVE_SEGMENTS` definition). It must not become the weak one, so it
//! *wraps* `docs::require_home_scope` rather than reimplementing a second
//! denylist.
//!
//! `require_home_scope` matches on the raw string it is given
//! (`starts_with($HOME)` plus a `contains` check per denied segment), so
//! `$HOME/../../etc/passwd` passes it today — the lexical check never sees an
//! escaped path because it never resolves one. The sidecar's equivalent
//! (`project_scanner_service._require_scan_scope`) never has this gap because
//! it is only ever handed an already `.resolve()`d path. `resolve_in_home_scope`
//! brings the Rust side up to the same standard: check the raw path first
//! (so a lexically-refused path fails before any I/O happens), canonicalize,
//! then check the canonical path again. The second check is what closes both
//! `..` traversal and a symlink that points outside `$HOME` — a real risk here
//! because every caller of this module (directory listings, the file index,
//! git status, and the live watcher) reads from an unauthenticated local
//! surface.

use std::path::{Path, PathBuf};

use crate::commands::docs::require_home_scope;

/// Eight noisy directories. Seven are the build-output/dependency subset of
/// `_NOISY_DIRS` (`app/services/project_discovery_service.py`) — that set also
/// skips vendored trees (`vendor`, `Pods`, …) which the navigator deliberately
/// still shows. `.git` is added here because it alone fires hundreds of events
/// per git operation.
pub(crate) const EXCLUDED_DIRS: [&str; 8] = [
    ".git",
    "node_modules",
    "venv",
    ".venv",
    "target",
    "dist",
    "build",
    "__pycache__",
];

/// `$HOME`-relative tilde expansion, mirroring `scheduler::expand_tilde`
/// (`scheduler/mod.rs:1064-1074`) — kept private to this module because the
/// two copies serve different callers and a third would be the point to
/// extract a shared helper.
fn expand_tilde(s: &str) -> String {
    if s == "~" {
        return std::env::var("HOME").unwrap_or_else(|_| s.to_string());
    }
    if let Some(rest) = s.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return format!("{home}/{rest}");
        }
    }
    s.to_string()
}

/// Expand a leading `~`, enforce the shared home-scope policy lexically,
/// canonicalize, then enforce it again on the canonical path. Returns the
/// canonical path.
///
/// Two calls to one policy function, zero duplicated denylists. The lexical
/// call fails closed before any I/O touches disk; the post-canonicalize call
/// is the one that actually defends against `..` traversal and a symlink
/// escape, per the module doc above.
pub(crate) fn resolve_in_home_scope(raw: &str) -> Result<PathBuf, String> {
    let expanded = expand_tilde(raw);
    require_home_scope(&expanded)?;
    let canonical =
        std::fs::canonicalize(&expanded).map_err(|_| format!("path does not exist: {raw}"))?;
    let canonical_str = canonical.to_string_lossy();
    require_home_scope(&canonical_str)?;
    Ok(canonical)
}

/// True when `path` has any `EXCLUDED_DIRS` component *relative to `root`*,
/// or is not under `root` at all (fail-closed default).
///
/// Matching is deliberately done on the path *relative to its watched root*
/// rather than on the absolute path's components — matching the absolute
/// path would exclude every project that itself lives under a directory
/// named e.g. `build/` or `dist/`.
pub(crate) fn is_excluded_relative(root: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return true;
    };
    rel.components().any(|c| {
        c.as_os_str()
            .to_str()
            .is_some_and(|s| EXCLUDED_DIRS.contains(&s))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_in_home_scope_rejects_path_outside_home() {
        let result = resolve_in_home_scope("/etc/passwd");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("outside $HOME"));
    }

    #[test]
    fn resolve_in_home_scope_rejects_sensitive_segment() {
        let home = std::env::var("HOME").unwrap();
        let path = format!("{home}/.ssh/id_rsa");
        let result = resolve_in_home_scope(&path);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("sensitive directory"));
    }

    #[test]
    fn resolve_in_home_scope_rejects_parent_traversal_escape() {
        let home = std::env::var("HOME").unwrap();
        // Passes the raw `require_home_scope` check today (it's a string
        // `starts_with`), so this pins the post-canonicalize second check —
        // the entire reason this wrapper exists rather than calling
        // `require_home_scope` directly.
        let path = format!("{home}/../../etc/passwd");
        let result = resolve_in_home_scope(&path);
        assert!(result.is_err());
    }

    #[test]
    fn resolve_in_home_scope_accepts_and_canonicalizes_home_dir() {
        let home = std::env::var("HOME").unwrap();
        let via_home = resolve_in_home_scope(&home).expect("resolve $HOME");
        let via_tilde = resolve_in_home_scope("~").expect("resolve ~");
        assert_eq!(via_home, via_tilde);
    }

    #[test]
    fn is_excluded_relative_excludes_known_noisy_dirs_at_any_depth() {
        let root = Path::new("/home/user/project");
        assert!(is_excluded_relative(
            root,
            &root.join(".git").join("index")
        ));
        assert!(is_excluded_relative(
            root,
            &root.join("node_modules").join("a").join("b.js")
        ));
        assert!(is_excluded_relative(
            root,
            &root.join("src").join("target").join("x")
        ));
        assert!(is_excluded_relative(
            root,
            &root.join("a").join("__pycache__").join("m.pyc")
        ));
    }

    #[test]
    fn is_excluded_relative_ignores_segments_in_the_root_itself() {
        // Regression: a naive absolute-component match would exclude
        // everything under a project that happens to live at .../build/app.
        let root = Path::new("/home/user/dev/build/app");
        let path = root.join("src").join("main.rs");
        assert!(!is_excluded_relative(root, &path));
    }

    #[test]
    fn is_excluded_relative_excludes_path_outside_root() {
        let root = Path::new("/home/user/project");
        let path = Path::new("/home/user/other/file.txt");
        assert!(is_excluded_relative(root, path));
    }
}
