//! Directory listing and the file index for the workspace navigator.
//!
//! Two commands, one level of read each: [`fs_list_dir`] expands one tree
//! node per call so the frontend never crawls a directory tree itself, and
//! [`fs_build_file_index`] gives the ⌘P palette its complete file list —
//! preferring `git ls-files` (already respects `.gitignore`, already fast on
//! a cold monorepo) and falling back to a depth-bounded walk for a root that
//! is not a git repository. Every path taken by either command is resolved
//! through `fs_scope::resolve_in_home_scope`, the same policy the live
//! watcher and `git_status_for_roots` use — this is the third caller of that
//! wrapper, none of which may weaken it.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use super::fs_scope::{is_excluded_relative, resolve_in_home_scope};
use super::git::{run_with_timeout, GIT_TIMEOUT};

const MAX_DIR_ENTRIES: usize = 5_000;
/// Dirs given a child count per listing — bounding this keeps a listing of a
/// directory full of large subdirectories cheap.
const CHILD_COUNT_BUDGET: usize = 500;
/// Stop counting a dir's children once this many are seen.
const CHILD_COUNT_CAP: u32 = 1_000;
const DEFAULT_MAX_INDEX_FILES: usize = 50_000;
const MAX_WALK_DEPTH: usize = 8;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    /// Dirs only; `None` for a file, an unreadable dir, or a dir past the
    /// per-listing budget.
    pub child_count: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    /// Canonical absolute path that was listed.
    pub path: String,
    /// Dirs first, then case-insensitive name.
    pub entries: Vec<DirEntryInfo>,
    /// More than `MAX_DIR_ENTRIES` entries.
    pub truncated: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIndexArgs {
    pub root: String,
    pub max_files: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIndex {
    /// Canonical absolute.
    pub root: String,
    /// Root-relative, `/`-separated, sorted.
    pub files: Vec<String>,
    pub count: usize,
    /// Hit `max_files`.
    pub truncated: bool,
    pub source: String,
    pub elapsed_ms: u64,
    pub skipped_non_utf8: usize,
}

/// Count a directory's immediate children, up to `cap`, returning `None` if
/// the directory can't be read at all.
fn count_children_capped(dir: &Path, cap: u32) -> Option<u32> {
    let read_dir = std::fs::read_dir(dir).ok()?;
    let mut count: u32 = 0;
    for _ in read_dir.flatten() {
        count += 1;
        if count >= cap {
            break;
        }
    }
    Some(count)
}

fn list_dir_blocking(path: &str) -> Result<DirListing, String> {
    let canonical = resolve_in_home_scope(path)?;
    if !canonical.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let read_dir = std::fs::read_dir(&canonical).map_err(|e| e.to_string())?;

    let mut entries: Vec<DirEntryInfo> = Vec::new();
    let mut dirs_counted = 0usize;
    for entry in read_dir.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let is_dir = file_type.is_dir();
        let is_symlink = file_type.is_symlink();
        let entry_path = entry.path();
        let child_count = if is_dir && dirs_counted < CHILD_COUNT_BUDGET {
            dirs_counted += 1;
            count_children_capped(&entry_path, CHILD_COUNT_CAP)
        } else {
            None
        };
        entries.push(DirEntryInfo {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry_path.to_string_lossy().into_owned(),
            is_dir,
            is_symlink,
            child_count,
        });
    }

    let truncated = entries.len() > MAX_DIR_ENTRIES;
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries.truncate(MAX_DIR_ENTRIES);

    Ok(DirListing {
        path: canonical.to_string_lossy().into_owned(),
        entries,
        truncated,
    })
}

/// Split `git ls-files -z` output on NUL, dropping empty records. A record
/// that isn't valid UTF-8 is dropped and counted rather than lossily
/// decoded — a lossy path can never be reopened.
fn parse_ls_files_z(bytes: &[u8]) -> (Vec<String>, usize) {
    let mut files = Vec::new();
    let mut skipped = 0usize;
    for record in bytes.split(|&b| b == 0) {
        if record.is_empty() {
            continue;
        }
        match String::from_utf8(record.to_vec()) {
            Ok(path) => files.push(path),
            Err(_) => skipped += 1,
        }
    }
    (files, skipped)
}

/// `git ls-files --cached --others --exclude-standard -z` is already
/// relative to `cwd`, so no pathspec is needed here — its output is
/// root-relative and root-scoped by construction. `None` (non-repo, missing
/// git, timeout) tells the caller to fall back to [`index_from_walk`].
fn index_from_git(root: &Path, max_files: usize) -> Option<(Vec<String>, bool, usize)> {
    let output = run_with_timeout(
        "git",
        Some(root),
        &["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        GIT_TIMEOUT,
    )
    .ok()?;
    if output.code != Some(0) {
        return None;
    }
    let (mut files, skipped) = parse_ls_files_z(&output.stdout);
    files.sort();
    let truncated = files.len() > max_files;
    files.truncate(max_files);
    Some((files, truncated, skipped))
}

/// Depth-bounded BFS fallback for a root that is not a git repository.
/// Never descends into a symlinked directory (a directory symlink can point
/// anywhere, including outside `root`) and skips any entry excluded by
/// [`is_excluded_relative`] — without that a `node_modules` crawl is exactly
/// the blow-up the index exists to avoid.
fn index_from_walk(root: &Path, max_files: usize) -> (Vec<String>, bool, usize) {
    let mut files = Vec::new();
    let mut truncated = false;
    let mut skipped_non_utf8 = 0usize;
    let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::new();
    queue.push_back((root.to_path_buf(), 0));

    'walk: while let Some((dir, depth)) = queue.pop_front() {
        let Ok(read_dir) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in read_dir.flatten() {
            let entry_path = entry.path();
            if is_excluded_relative(root, &entry_path) {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                // Never traverse a symlink, whether it points at a
                // directory (do not descend) or a file (do not list it —
                // it can point outside `root` just as easily).
                continue;
            }
            if file_type.is_dir() {
                if depth < MAX_WALK_DEPTH {
                    queue.push_back((entry_path, depth + 1));
                }
            } else if file_type.is_file() {
                if files.len() >= max_files {
                    truncated = true;
                    break 'walk;
                }
                match entry_path.strip_prefix(root).ok().and_then(|p| p.to_str()) {
                    Some(rel) => files.push(rel.to_string()),
                    None => skipped_non_utf8 += 1,
                }
            }
        }
    }

    files.sort();
    (files, truncated, skipped_non_utf8)
}

fn build_file_index_blocking(root: &str, max_files: usize) -> Result<FileIndex, String> {
    let started = Instant::now();
    let canonical = resolve_in_home_scope(root)?;
    if !canonical.is_dir() {
        return Err(format!("not a directory: {root}"));
    }

    let (files, truncated, skipped_non_utf8, source) = match index_from_git(&canonical, max_files)
    {
        Some((files, truncated, skipped)) => (files, truncated, skipped, "git"),
        None => {
            let (files, truncated, skipped) = index_from_walk(&canonical, max_files);
            (files, truncated, skipped, "walk")
        }
    };

    let count = files.len();
    Ok(FileIndex {
        root: canonical.to_string_lossy().into_owned(),
        files,
        count,
        truncated,
        source: source.to_string(),
        elapsed_ms: started.elapsed().as_millis() as u64,
        skipped_non_utf8,
    })
}

#[tauri::command]
pub async fn fs_list_dir(path: String) -> Result<DirListing, String> {
    tauri::async_runtime::spawn_blocking(move || list_dir_blocking(&path))
        .await
        .map_err(|e| format!("fs_list_dir task panicked: {e}"))?
}

/// Builds the file index for `args.root` and records its file count into the
/// live watcher's managed state so [`crate::fswatch::fs_watch_status`] can
/// report `indexedFileCount` without the shell caching the list itself.
#[tauri::command]
pub async fn fs_build_file_index(
    args: FileIndexArgs,
    app: tauri::AppHandle,
) -> Result<FileIndex, String> {
    let FileIndexArgs { root, max_files } = args;
    let max_files = max_files.unwrap_or(DEFAULT_MAX_INDEX_FILES);

    let index = tauri::async_runtime::spawn_blocking(move || {
        build_file_index_blocking(&root, max_files)
    })
    .await
    .map_err(|e| format!("fs_build_file_index task panicked: {e}"))??;

    let mgr = app
        .state::<Arc<crate::fswatch::FsWatchManager>>()
        .inner()
        .clone();
    mgr.record_index(Path::new(&index.root), index.count);

    Ok(index)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique per test AND per process — see the identical helper in
    /// `commands/git.rs` for the rationale (`scheduler/mod.rs:1131-1136`
    /// precedent). The `fs_nav` slug keeps this module's fixtures from
    /// colliding with `fswatch`'s copy.
    struct TestDir(PathBuf);

    impl TestDir {
        fn new(name: &str) -> Self {
            let home = std::env::var("HOME").expect("HOME");
            let dir = PathBuf::from(home).join(format!(
                ".codenest-test-fs_nav-{name}-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&dir).expect("create fixture dir");
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn list_dir_sorts_dirs_first_then_case_insensitively() {
        let dir = TestDir::new("list_dir_sorts_dirs_first_then_case_insensitively");
        std::fs::create_dir(dir.path().join("Zeta")).unwrap();
        std::fs::create_dir(dir.path().join("alpha")).unwrap();
        std::fs::write(dir.path().join("Beta.txt"), b"b").unwrap();
        std::fs::write(dir.path().join("apple.txt"), b"a").unwrap();

        let listing = list_dir_blocking(dir.path().to_str().unwrap()).unwrap();
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "Zeta", "apple.txt", "Beta.txt"]);
    }

    #[test]
    fn list_dir_reports_child_count_for_dirs_and_none_for_files() {
        let dir = TestDir::new("list_dir_reports_child_count_for_dirs_and_none_for_files");
        let sub = dir.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join("a.txt"), b"a").unwrap();
        std::fs::write(sub.join("b.txt"), b"b").unwrap();
        std::fs::write(dir.path().join("file.txt"), b"f").unwrap();

        let listing = list_dir_blocking(dir.path().to_str().unwrap()).unwrap();
        let sub_entry = listing.entries.iter().find(|e| e.name == "sub").unwrap();
        assert_eq!(sub_entry.child_count, Some(2));
        let file_entry = listing.entries.iter().find(|e| e.name == "file.txt").unwrap();
        assert_eq!(file_entry.child_count, None);
    }

    #[test]
    fn list_dir_refuses_path_outside_home() {
        let result = list_dir_blocking("/etc");
        assert!(result.is_err());
    }

    #[test]
    fn list_dir_errors_on_a_file_path() {
        let dir = TestDir::new("list_dir_errors_on_a_file_path");
        let file = dir.path().join("plain.txt");
        std::fs::write(&file, b"x").unwrap();
        let result = list_dir_blocking(file.to_str().unwrap());
        assert!(result.is_err());
    }

    #[test]
    fn walk_index_skips_excluded_dirs() {
        let dir = TestDir::new("walk_index_skips_excluded_dirs");
        std::fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
        std::fs::write(dir.path().join("node_modules/pkg/index.js"), b"x").unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join(".git/HEAD"), b"x").unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/main.rs"), b"x").unwrap();

        let (files, truncated, skipped) = index_from_walk(dir.path(), 100);
        assert_eq!(files, vec!["src/main.rs".to_string()]);
        assert!(!truncated);
        assert_eq!(skipped, 0);
    }

    #[test]
    fn walk_index_respects_depth_cap() {
        let dir = TestDir::new("walk_index_respects_depth_cap");
        let mut cursor = dir.path().to_path_buf();
        for i in 1..=MAX_WALK_DEPTH {
            cursor = cursor.join(format!("d{i}"));
        }
        std::fs::create_dir_all(&cursor).unwrap();
        std::fs::write(cursor.join("cap.txt"), b"x").unwrap();
        let deeper_dir = cursor.join("d_over");
        std::fs::create_dir_all(&deeper_dir).unwrap();
        std::fs::write(deeper_dir.join("deep.txt"), b"x").unwrap();

        let (files, _truncated, _skipped) = index_from_walk(dir.path(), 1_000);
        assert!(files.iter().any(|f| f.ends_with("cap.txt")));
        assert!(!files.iter().any(|f| f.ends_with("deep.txt")));
    }

    #[test]
    fn walk_index_does_not_follow_symlinked_dirs() {
        let dir = TestDir::new("walk_index_does_not_follow_symlinked_dirs");
        std::fs::write(dir.path().join("real.txt"), b"x").unwrap();
        let home = std::env::var("HOME").unwrap();
        std::os::unix::fs::symlink(&home, dir.path().join("link_to_home")).unwrap();

        let (files, _truncated, _skipped) = index_from_walk(dir.path(), 10_000);
        assert_eq!(files, vec!["real.txt".to_string()]);
    }

    #[test]
    fn walk_index_truncates_at_max_files() {
        let dir = TestDir::new("walk_index_truncates_at_max_files");
        for i in 0..5 {
            std::fs::write(dir.path().join(format!("f{i}.txt")), b"x").unwrap();
        }
        let (files, truncated, _skipped) = index_from_walk(dir.path(), 2);
        assert_eq!(files.len(), 2);
        assert!(truncated);
    }

    #[test]
    fn ls_files_parser_skips_non_utf8_records_and_counts_them() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"good.txt");
        bytes.push(0);
        bytes.extend_from_slice(&[0xFF, 0xFE]);
        bytes.push(0);
        bytes.extend_from_slice(b"also_good.txt");
        bytes.push(0);

        let (files, skipped) = parse_ls_files_z(&bytes);
        assert_eq!(
            files,
            vec!["good.txt".to_string(), "also_good.txt".to_string()]
        );
        assert_eq!(skipped, 1);
    }
}
