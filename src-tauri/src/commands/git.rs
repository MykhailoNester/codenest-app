//! Git utility commands for the dashboard shell.
//!
//! Process spawning belongs in the Rust shell per the architectural boundary
//! rules — the sidecar must never exec subprocesses. This module provides
//! [`get_recent_commits`] (a simple `git log` reader for the "Recent Commits"
//! dashboard widget) and [`git_status_for_roots`] (per-root status + diffstat
//! for the workspace navigator's Changed mode), plus the shared
//! [`run_with_timeout`] shell-out helper both future git-invoking commands in
//! this shell should use — `std::process::Command` has no built-in timeout,
//! and `Command::output()` blocks unbounded, so `run_with_timeout` is the
//! bounded replacement, mirroring the sidecar's `subprocess.run(..., timeout=2)`
//! pattern in `project_scanner_service.py`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::fs_scope::resolve_in_home_scope;

/// A single git commit entry returned by [`get_recent_commits`].
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitEntry {
    /// Short (7-char) commit hash.
    pub short_hash: String,
    /// Full commit message subject line.
    pub subject: String,
    /// Author display name.
    pub author: String,
    /// ISO-8601 commit timestamp (author date, UTC offset).
    pub date: String,
    /// Absolute path of the repository this commit came from.
    pub repo_path: String,
    /// Repository directory name (last path component), used as display label.
    pub repo_name: String,
}

/// Arguments for [`get_recent_commits`].
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetRecentCommitsArgs {
    /// Absolute paths to git repositories to query.
    pub paths: Vec<String>,
    /// Maximum total commits to return across all repos (default 20, max 50).
    #[serde(default)]
    pub limit: Option<usize>,
}

/// Run `git log` against each supplied absolute path and return the most
/// recent commits, merged and sorted by date descending.
///
/// Non-git directories and unreachable paths are silently skipped so a
/// project that has not been initialised as a git repo never breaks the
/// widget. The Rust shell owns process spawning; the sidecar is never
/// involved.
///
/// # Refresh cadence
/// The frontend polls this command every 60 s — frequent enough to feel live
/// for active coding sessions while staying below any reasonable process-
/// spawn rate limit.
#[tauri::command]
pub async fn get_recent_commits(args: GetRecentCommitsArgs) -> Result<Vec<CommitEntry>, String> {
    let limit = args.limit.unwrap_or(20).min(50);
    // We fetch `limit` per repo then merge; the final slice keeps at most
    // `limit` total so callers never get more than requested.
    let per_repo = limit;

    let mut all: Vec<CommitEntry> = Vec::new();

    for path in &args.paths {
        // Skip empty, relative, or non-existent paths silently.
        if path.is_empty() || !path.starts_with('/') {
            continue;
        }
        let p = std::path::Path::new(path);
        if !p.exists() {
            continue;
        }

        // --format: %h = short hash, %s = subject, %an = author name,
        //           %aI = ISO 8601 strict author date.
        // Fields are separated by RS (ASCII 0x1E) so that commit subjects
        // containing tabs or pipes do not break parsing.
        let output = Command::new("git")
            .args([
                "-C",
                path,
                "log",
                &format!("-{per_repo}"),
                "--format=%h\x1e%s\x1e%an\x1e%aI",
                "--no-merges",
            ])
            .output();

        let output = match output {
            Ok(o) if o.status.success() => o,
            // Not a git repo or git not available — skip silently.
            _ => continue,
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        let repo_name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(path.as_str())
            .to_owned();

        for line in stdout.lines() {
            let parts: Vec<&str> = line.splitn(4, '\x1e').collect();
            if parts.len() < 4 {
                continue;
            }
            all.push(CommitEntry {
                short_hash: parts[0].trim().to_owned(),
                subject: parts[1].trim().to_owned(),
                author: parts[2].trim().to_owned(),
                date: parts[3].trim().to_owned(),
                repo_path: path.clone(),
                repo_name: repo_name.clone(),
            });
        }
    }

    // Sort by date descending (ISO strings compare lexicographically).
    all.sort_by(|a, b| b.date.cmp(&a.date));
    all.truncate(limit);

    Ok(all)
}

// ---------------------------------------------------------------------------
// Bounded shell-out helper
// ---------------------------------------------------------------------------

/// Result of a [`run_with_timeout`] call that reached process exit.
pub(crate) struct CmdOutput {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub code: Option<i32>,
}

/// Why [`run_with_timeout`] did not produce a [`CmdOutput`].
#[derive(Debug)]
pub(crate) enum CmdError {
    /// The binary is not on `PATH` (or otherwise unresolvable by the OS).
    NotFound,
    /// The child outlived `timeout` and was killed.
    Timeout,
    /// Any other I/O failure spawning or waiting on the child.
    Io(String),
}

/// Spawn `bin` with piped stdio, drain both pipes on dedicated threads, and
/// kill the child if it outlives `timeout`.
///
/// The reader threads are mandatory, not an optimisation. A monorepo's
/// `git ls-files` output can be many megabytes — far more than the pipe
/// buffer backing a child's stdout (~64 KiB on macOS/Linux). Polling
/// `try_wait()` without draining the pipe concurrently means the child
/// blocks on its own `write()` the moment the buffer fills, so it never
/// reaches exit — every large-but-legitimate command would look identical
/// to a hang and eat the full `timeout` on every call. `Command::output()`
/// (the shape [`get_recent_commits`] uses) cannot be used here because it
/// blocks unbounded, with no way to enforce a deadline at all. This mirrors
/// the sidecar's bounded shell-out
/// (`app/services/project_scanner_service.py:111-124`,
/// `subprocess.run(..., timeout=2, check=False)`).
pub(crate) fn run_with_timeout(
    bin: &str,
    cwd: Option<&Path>,
    args: &[&str],
    timeout: Duration,
) -> Result<CmdOutput, CmdError> {
    let mut command = Command::new(bin);
    command.args(args);
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(CmdError::NotFound),
        Err(e) => return Err(CmdError::Io(e.to_string())),
    };

    let mut stdout_pipe = child.stdout.take().expect("stdout was piped");
    let mut stderr_pipe = child.stderr.take().expect("stderr was piped");

    let stdout_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buf);
        buf
    });
    let stderr_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf);
        buf
    });

    let deadline = Instant::now() + timeout;
    let wait_result = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err(CmdError::Timeout);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => break Err(CmdError::Io(e.to_string())),
        }
    };

    // Join unconditionally: once the child has exited (or been killed) its
    // pipes hit EOF, so these always return promptly — even on the timeout
    // path, where the buffered bytes are simply discarded below.
    let stdout = stdout_handle.join().unwrap_or_default();
    let stderr_bytes = stderr_handle.join().unwrap_or_default();

    let status = wait_result?;
    Ok(CmdOutput {
        stdout,
        stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
        code: status.code(),
    })
}

// ---------------------------------------------------------------------------
// git_status_for_roots
// ---------------------------------------------------------------------------

/// Shared with `fs_nav::index_from_git` — `ls-files` on a cold, large repo is
/// not instant the way `remote get-url` is, so this is longer than the
/// sidecar's 2 s shell-out timeout.
pub(crate) const GIT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_STATUS_FILES: usize = 2000;

/// Arguments for [`git_status_for_roots`].
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusArgs {
    pub paths: Vec<String>,
}

/// One changed file, as reported by `git status --porcelain=v2` merged with
/// `git diff --numstat`.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    /// Relative to the repo toplevel, exactly as git prints it — NOT relative
    /// to the requested root. See `GitRootStatus::repo_root`.
    pub path: String,
    pub status: String,
    pub staged: bool,
    pub added: Option<u32>,
    pub removed: Option<u32>,
    pub orig_path: Option<String>,
}

/// Git status for one requested root.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRootStatus {
    pub root: String,
    /// Canonical repo toplevel; the base for every `GitFileStatus::path`.
    /// `None` iff `is_repo` is false.
    pub repo_root: Option<String>,
    pub is_repo: bool,
    pub branch: Option<String>,
    pub detached: bool,
    pub dirty: bool,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub files: Vec<GitFileStatus>,
    pub truncated: bool,
    pub error: Option<String>,
}

/// Parsed `# branch.*` headers + per-file XY records from
/// `git status --porcelain=v2 --branch -z`.
#[derive(Debug, Default, PartialEq)]
struct PorcelainStatus {
    branch: Option<String>,
    detached: bool,
    unborn: bool,
    ahead: Option<u32>,
    behind: Option<u32>,
    files: Vec<GitFileStatus>,
}

/// Collapse the porcelain XY columns to one letter, for ordinary (`1 `) and
/// rename/copy (`2 `) records: the worktree column `Y` when it is not `.`,
/// else the index column `X`. Untracked (`? `) and unmerged (`u `) records
/// carry their own fixed letter (`?`, `U`) and never go through this — they
/// don't have a meaningful XY pair the same way.
fn status_letter(x: char, y: char) -> char {
    if y != '.' {
        y
    } else {
        x
    }
}

fn parse_branch_header(rest: &str, status: &mut PorcelainStatus) {
    if let Some(value) = rest.strip_prefix("branch.oid ") {
        if value.trim() == "(initial)" {
            status.unborn = true;
        }
    } else if let Some(value) = rest.strip_prefix("branch.head ") {
        let value = value.trim();
        if value == "(detached)" {
            status.detached = true;
        } else {
            status.branch = Some(value.to_string());
        }
    } else if let Some(value) = rest.strip_prefix("branch.ab ") {
        // "+<N> -<M>"
        let mut parts = value.split_whitespace();
        let ahead = parts
            .next()
            .and_then(|s| s.strip_prefix('+'))
            .and_then(|s| s.parse::<u32>().ok());
        let behind = parts
            .next()
            .and_then(|s| s.strip_prefix('-'))
            .and_then(|s| s.parse::<u32>().ok());
        status.ahead = ahead;
        status.behind = behind;
    }
    // `branch.upstream` is parsed for nothing today — the upstream's own name
    // isn't part of the Contract, only ahead/behind counts are.
}

/// `"<XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>"` (already stripped of the
/// leading `"1 "`). `path` is the remainder after 7 space-separated fields —
/// it can itself contain spaces, since `-z` disables git's path quoting.
fn parse_ordinary_entry(rest: &str) -> Option<GitFileStatus> {
    let mut parts = rest.splitn(8, ' ');
    let xy = parts.next()?;
    let mut xy_chars = xy.chars();
    let x = xy_chars.next()?;
    let y = xy_chars.next()?;
    for _ in 0..6 {
        parts.next()?;
    }
    let path = parts.next()?;
    Some(GitFileStatus {
        path: path.to_string(),
        status: status_letter(x, y).to_string(),
        staged: x != '.',
        added: None,
        removed: None,
        orig_path: None,
    })
}

/// `"<XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>"` (already
/// stripped of the leading `"2 "`). `orig_path` is the extra NUL field that
/// follows this record in the raw stream — see the module-level note on
/// rename records in `parse_porcelain_v2`.
fn parse_rename_entry(rest: &str, orig_path: String) -> Option<GitFileStatus> {
    let mut parts = rest.splitn(9, ' ');
    let xy = parts.next()?;
    let mut xy_chars = xy.chars();
    let x = xy_chars.next()?;
    let y = xy_chars.next()?;
    for _ in 0..7 {
        parts.next()?;
    }
    let path = parts.next()?;
    Some(GitFileStatus {
        path: path.to_string(),
        status: status_letter(x, y).to_string(),
        staged: x != '.',
        added: None,
        removed: None,
        orig_path: Some(orig_path),
    })
}

/// `"<XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>"` (already stripped
/// of the leading `"u "`).
fn parse_unmerged_entry(rest: &str) -> Option<GitFileStatus> {
    let mut parts = rest.splitn(10, ' ');
    parts.next()?; // XY — always "U?"/"?U"/"UU"/"AA"/"DD" etc, unused.
    for _ in 0..8 {
        parts.next()?;
    }
    let path = parts.next()?;
    Some(GitFileStatus {
        path: path.to_string(),
        status: "U".to_string(),
        staged: false,
        added: None,
        removed: None,
        orig_path: None,
    })
}

/// Parse `git status --porcelain=v2 --branch -z --untracked-files=all`
/// output.
///
/// With `-z`, records are NUL-terminated instead of newline-terminated and
/// paths are never quoted — except a rename/copy (`2 `) record, where the
/// normal `<path>\t<origPath>\n` tail becomes `<path>\0<origPath>\0`: TWO
/// NUL-terminated fields instead of one. Every other record type consumes
/// exactly one field. Getting this wrong desynchronises every record after
/// the first rename in the stream, which is exactly what
/// `parse_porcelain_v2_pairs_rename_orig_path` pins.
fn parse_porcelain_v2(bytes: &[u8]) -> PorcelainStatus {
    let mut status = PorcelainStatus::default();
    let mut fields = bytes.split(|&b| b == 0);
    while let Some(field) = fields.next() {
        if field.is_empty() {
            continue;
        }
        let Ok(text) = std::str::from_utf8(field) else {
            log::warn!("git status: dropping a non-UTF-8 record");
            continue;
        };
        if let Some(rest) = text.strip_prefix("# ") {
            parse_branch_header(rest, &mut status);
        } else if let Some(rest) = text.strip_prefix("1 ") {
            if let Some(file) = parse_ordinary_entry(rest) {
                status.files.push(file);
            }
        } else if let Some(rest) = text.strip_prefix("2 ") {
            let orig_field = fields.next().unwrap_or(&[]);
            match std::str::from_utf8(orig_field) {
                Ok(orig_path) => {
                    if let Some(file) = parse_rename_entry(rest, orig_path.to_string()) {
                        status.files.push(file);
                    }
                }
                Err(_) => log::warn!("git status: dropping a non-UTF-8 rename source path"),
            }
        } else if let Some(rest) = text.strip_prefix("u ") {
            if let Some(file) = parse_unmerged_entry(rest) {
                status.files.push(file);
            }
        } else if let Some(path) = text.strip_prefix("? ") {
            status.files.push(GitFileStatus {
                path: path.to_string(),
                status: "?".to_string(),
                staged: false,
                added: None,
                removed: None,
                orig_path: None,
            });
        }
        // `! ` (ignored) entries only appear with `--ignored`, which we never
        // pass; any other unrecognised prefix is silently skipped.
    }
    status
}

fn parse_numstat_count(raw: &str) -> Option<u32> {
    if raw == "-" {
        None
    } else {
        raw.parse::<u32>().ok()
    }
}

/// `(added, removed, orig_path)` for one file from `git diff --numstat -z`.
type NumstatEntry = (Option<u32>, Option<u32>, Option<String>);

/// `path -> (added, removed, orig_path)` from
/// `git diff --numstat -z HEAD -- .`.
///
/// Normal record: one NUL field, `added\tremoved\tpath`. Rename record: the
/// stats field ends with a trailing tab and nothing after it (the third
/// tab-component is empty), then two further NUL fields follow: `src`, then
/// `dst`. That empty third tab-component is the only discriminator — it is
/// what stops the parser from reading the rename's `src` path as the next
/// record's stats line.
fn parse_numstat_z(bytes: &[u8]) -> HashMap<String, NumstatEntry> {
    let mut map = HashMap::new();
    let mut fields = bytes.split(|&b| b == 0);
    while let Some(field) = fields.next() {
        if field.is_empty() {
            continue;
        }
        let Ok(text) = std::str::from_utf8(field) else {
            log::warn!("git diff --numstat: dropping a non-UTF-8 record");
            continue;
        };
        let mut parts = text.splitn(3, '\t');
        let added = parse_numstat_count(parts.next().unwrap_or(""));
        let removed = parse_numstat_count(parts.next().unwrap_or(""));
        let path_or_empty = parts.next().unwrap_or("");

        if path_or_empty.is_empty() {
            let src = fields
                .next()
                .and_then(|f| std::str::from_utf8(f).ok())
                .unwrap_or("")
                .to_string();
            let dst = fields
                .next()
                .and_then(|f| std::str::from_utf8(f).ok())
                .unwrap_or("")
                .to_string();
            map.insert(dst, (added, removed, Some(src)));
        } else {
            map.insert(path_or_empty.to_string(), (added, removed, None));
        }
    }
    map
}

/// Map a [`run_with_timeout`] failure onto the per-root `error` string.
fn cmd_error_message(prefix: &str, error: CmdError) -> String {
    match error {
        CmdError::NotFound => "git not found on PATH".to_string(),
        CmdError::Timeout => format!("git {prefix} timed out after {}s", GIT_TIMEOUT.as_secs()),
        CmdError::Io(msg) => msg,
    }
}

fn first_stderr_line(stderr: &str) -> String {
    stderr.lines().next().unwrap_or(stderr).trim().to_string()
}

/// Resolve the repo toplevel for `root` from `git rev-parse --show-cdup`,
/// keeping the result in the same canonical namespace as `root`.
///
/// `--show-cdup` (rather than `--show-toplevel`) prints a *relative* `../`
/// sequence — empty at the toplevel — so `root.join(cdup).canonicalize()`
/// stays in the same canonical namespace `root` is already in (macOS's
/// `/tmp` vs `/private/tmp` is exactly the kind of divergence
/// `--show-toplevel`'s own absolute path could introduce). Both `rev-parse`
/// forms exit 128 in a non-repo, so this single call doubles as the is-repo
/// probe: a non-repo root costs one process, not two.
///
/// `Ok(None)` = not a repo (exit 128). `Err` = refused or unusable.
fn repo_root_for(root: &Path) -> Result<Option<PathBuf>, String> {
    let output = run_with_timeout(
        "git",
        Some(root),
        &["rev-parse", "--show-cdup"],
        GIT_TIMEOUT,
    )
    .map_err(|e| cmd_error_message("rev-parse", e))?;

    if output.code != Some(0) {
        return Ok(None);
    }

    let cdup = String::from_utf8_lossy(&output.stdout);
    let cdup = cdup.trim();
    let top = if cdup.is_empty() {
        root.to_path_buf()
    } else {
        root.join(cdup)
    };
    let top =
        std::fs::canonicalize(&top).map_err(|e| format!("failed to resolve repo root: {e}"))?;
    Ok(Some(top))
}

fn refused_root(root: String, error: Option<String>) -> GitRootStatus {
    GitRootStatus {
        root,
        repo_root: None,
        is_repo: false,
        branch: None,
        detached: false,
        dirty: false,
        ahead: None,
        behind: None,
        files: Vec::new(),
        truncated: false,
        error,
    }
}

fn git_status_for_one_root(path: &str) -> GitRootStatus {
    let root = match resolve_in_home_scope(path) {
        Ok(p) => p,
        Err(e) => return refused_root(path.to_string(), Some(e)),
    };
    let root_str = root.to_string_lossy().into_owned();

    let top = match repo_root_for(&root) {
        Ok(Some(top)) => top,
        Ok(None) => return refused_root(root_str, None),
        Err(e) => return refused_root(root_str, Some(e)),
    };

    // The repo toplevel must itself be in scope — otherwise `files` would
    // carry toplevel-relative paths naming directories outside the allowed
    // scope, a scope leak through the *contents* of the response rather than
    // through its arguments (e.g. someone ran `git init` in `/Users`).
    let top_str = top.to_string_lossy().into_owned();
    if !root.starts_with(&top) || super::docs::require_home_scope(&top_str).is_err() {
        return refused_root(
            root_str,
            Some("repository root is outside the allowed scope".to_string()),
        );
    }

    let mut result = GitRootStatus {
        root: root_str,
        repo_root: Some(top_str),
        is_repo: true,
        branch: None,
        detached: false,
        dirty: false,
        ahead: None,
        behind: None,
        files: Vec::new(),
        truncated: false,
        error: None,
    };

    // The trailing `-- .` pathspec is load-bearing: it scopes `files` /
    // `dirty` / `truncated` to the subtree under `root` (cwd is `root`, so
    // `.` *is* `root`); at the repo toplevel it is a no-op.
    let status_output = run_with_timeout(
        "git",
        Some(&root),
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
            "--",
            ".",
        ],
        GIT_TIMEOUT,
    );

    let parsed = match status_output {
        Ok(output) if output.code == Some(0) => parse_porcelain_v2(&output.stdout),
        // A 128 here, after a successful rev-parse, is unexpected — but we
        // already know this root is a repo, so report the failure rather
        // than flipping `is_repo` back to false.
        Ok(output) => {
            result.error = Some(first_stderr_line(&output.stderr));
            return result;
        }
        Err(e) => {
            result.error = Some(cmd_error_message("status", e));
            return result;
        }
    };

    result.branch = parsed.branch;
    result.detached = parsed.detached;
    result.ahead = parsed.ahead;
    result.behind = parsed.behind;
    let mut files = parsed.files;

    // Untracked files never appear in `git diff`; an unborn HEAD has no
    // commit to diff against at all (`git diff … HEAD` exits 128). Either
    // way, skipping the diffstat is not a root failure — it just means
    // added/removed stay `None` for every file.
    if !parsed.unborn {
        if let Ok(diff_output) = run_with_timeout(
            "git",
            Some(&root),
            &["diff", "--numstat", "-z", "HEAD", "--", "."],
            GIT_TIMEOUT,
        ) {
            if diff_output.code == Some(0) {
                let numstat = parse_numstat_z(&diff_output.stdout);
                for file in &mut files {
                    if let Some((added, removed, _)) = numstat.get(&file.path) {
                        file.added = *added;
                        file.removed = *removed;
                    }
                }
            }
        }
    }

    result.truncated = files.len() > MAX_STATUS_FILES;
    files.truncate(MAX_STATUS_FILES);
    result.dirty = !files.is_empty();
    result.files = files;

    result
}

/// Git status + diffstat for each requested root, in order.
///
/// Never rejects because one root is broken — a refused, missing, or
/// non-repo root yields `{ isRepo: false, repoRoot: null, error: "…" }` in
/// its slot and every other root is still reported. See the module's
/// `GitRootStatus` / `GitFileStatus` docs for the path-base rules a caller
/// must follow when joining `path` back onto a file on disk.
#[tauri::command]
pub async fn git_status_for_roots(args: GitStatusArgs) -> Result<Vec<GitRootStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        args.paths
            .iter()
            .map(|path| git_status_for_one_root(path))
            .collect()
    })
    .await
    .map_err(|e| format!("git status task panicked: {e}"))
}

/// Branch/dirty/ahead facts for one terminal pane's working directory, used
/// by the session-state HUD's git cell. The sidecar tracks none of this — it
/// has no reason to shell out — so it comes from the Rust shell instead.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitPaneStatus {
    /// Current branch name, or the literal string `"(detached)"` when HEAD
    /// is detached — never absent, unlike [`CommitEntry`]'s optional fields.
    pub branch: String,
    /// `true` when any tracked or untracked change is present.
    pub dirty: bool,
    /// Commits ahead of the upstream branch, `None` when there is no upstream.
    pub ahead: Option<u32>,
}

/// Run one `git status --porcelain=v2 --branch` against a pane's live cwd and
/// return branch/dirty/ahead facts for the session-state HUD's git cell.
///
/// `None` — never `Err` — covers every "there is nothing to show" case: an
/// empty, relative, or non-existent `cwd`, `git` missing, a directory that is
/// not a git work tree, a non-zero exit, or output with no `# branch.head`
/// line. Same "skip silently" contract as [`get_recent_commits`].
///
/// # Refresh cadence
/// The frontend's `session-hud-store` polls this once per distinct cwd every
/// 30 s (not once per pane — panes in a split usually share a cwd).
/// `--no-optional-locks` keeps that poll from ever taking the index lock, so
/// it never contends with the agent's own git commands.
#[tauri::command]
pub async fn get_git_pane_status(cwd: String) -> Option<GitPaneStatus> {
    if cwd.is_empty() || !cwd.starts_with('/') || !Path::new(&cwd).exists() {
        return None;
    }

    let output = Command::new("git")
        .args([
            "--no-optional-locks",
            "-C",
            &cwd,
            "status",
            "--porcelain=v2",
            "--branch",
        ])
        .output();

    let output = match output {
        Ok(o) if o.status.success() => o,
        // Not a git repo, git missing, or any other non-zero exit — no cell.
        _ => return None,
    };

    parse_pane_porcelain_v2(&String::from_utf8_lossy(&output.stdout))
}

/// Parse `git status --porcelain=v2 --branch` output into [`GitPaneStatus`].
///
/// Pure and unit-tested without spawning git. Requires git >= 2.11 (the
/// version that introduced the `--porcelain=v2` format). Returns `None` when
/// no `# branch.head` line is present — that only happens for output this
/// function was never meant to parse (not a repo, or an unexpected git
/// version), so there is nothing honest to report.
///
/// Named apart from the navigator's [`parse_porcelain_v2`], which reads the
/// same git output for a different consumer: that one parses raw bytes into a
/// full per-file [`PorcelainStatus`] for Changed mode, this one folds the same
/// stream down to the three scalars the HUD's git cell shows. They were written
/// on parallel branches and merged here; keep them separate rather than
/// unifying, since the byte-vs-str and per-file-vs-scalar shapes are load
/// bearing for their respective callers.
fn parse_pane_porcelain_v2(stdout: &str) -> Option<GitPaneStatus> {
    let mut branch: Option<String> = None;
    let mut ahead: Option<u32> = None;
    let mut dirty = false;

    for line in stdout.lines() {
        if let Some(head) = line.strip_prefix("# branch.head ") {
            // "(detached)" passes through verbatim — it is itself the honest
            // label for this state, not a placeholder.
            branch = Some(head.to_owned());
        } else if let Some(ab) = line.strip_prefix("# branch.ab ") {
            // e.g. "+2 -0" — strip the sign before parsing: `"-0".parse::<u32>()`
            // fails, and the value itself is always non-negative.
            ahead = ab
                .split_whitespace()
                .next()
                .and_then(|s| s.trim_start_matches(['+', '-']).parse().ok());
        } else if !line.is_empty() && !line.starts_with('#') {
            // Covers `1`/`2`/`u` (tracked, staged, unmerged) and `?`
            // (untracked) — untracked-only counts as dirty, matching what
            // `git status -sb` shows the user.
            dirty = true;
        }
    }

    branch.map(|branch| GitPaneStatus {
        branch,
        dirty,
        ahead,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique per test AND per process, following the repo's own precedent
    /// (`scheduler/mod.rs:1131-1136`): `name` is the caller's test name (must
    /// equal the test function's own name — two tests must never share one),
    /// the pid disambiguates concurrent `cargo test` binaries, and the uuid
    /// disambiguates a retry within the same process. Creates and removes its
    /// own directory so a panic mid-test still leaves no `$HOME` litter.
    struct TestDir(PathBuf);

    impl TestDir {
        fn new(name: &str) -> Self {
            let home = std::env::var("HOME").expect("HOME");
            let dir = PathBuf::from(home).join(format!(
                ".codenest-test-git-{name}-{}-{}",
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
    fn parse_porcelain_v2_reads_branch_and_ahead_behind() {
        let fixture = "# branch.oid 9431f8f\0# branch.head master\0# branch.upstream origin/master\0# branch.ab +1 -2\0";
        let status = parse_porcelain_v2(fixture.as_bytes());
        assert_eq!(status.branch, Some("master".to_string()));
        assert_eq!(status.ahead, Some(1));
        assert_eq!(status.behind, Some(2));
        assert!(!status.detached);
        assert!(!status.unborn);
    }

    #[test]
    fn parse_porcelain_v2_detached_head() {
        let fixture = "# branch.oid 9431f8f\0# branch.head (detached)\0";
        let status = parse_porcelain_v2(fixture.as_bytes());
        assert_eq!(status.branch, None);
        assert!(status.detached);
    }

    #[test]
    fn parse_porcelain_v2_unborn_head_has_no_ahead_behind() {
        let fixture = "# branch.oid (initial)\0# branch.head master\0";
        let status = parse_porcelain_v2(fixture.as_bytes());
        assert!(status.unborn);
        assert_eq!(status.ahead, None);
        assert_eq!(status.behind, None);
    }

    #[test]
    fn parse_porcelain_v2_pairs_rename_orig_path() {
        let fixture = concat!(
            "2 R. N... 100644 100644 100644 dcc2781 dcc2781 R100 renamed.txt\0",
            "torename.txt\0",
            "1 .M N... 100644 100644 100644 de9804a de9804a tracked.txt\0",
        );
        let status = parse_porcelain_v2(fixture.as_bytes());
        assert_eq!(status.files.len(), 2);
        assert_eq!(status.files[0].path, "renamed.txt");
        assert_eq!(status.files[0].orig_path, Some("torename.txt".to_string()));
        assert_eq!(status.files[0].status, "R");
        // Pins that the rename's extra NUL field does not desynchronise the
        // parser: the following ordinary record is still read correctly.
        assert_eq!(status.files[1].path, "tracked.txt");
        assert_eq!(status.files[1].status, "M");
        assert_eq!(status.files[1].orig_path, None);
    }

    #[test]
    fn parse_porcelain_v2_status_letter_precedence() {
        let fixture = concat!(
            "1 .M N... 100644 100644 100644 aaa aaa dotm.txt\0",
            "1 A. N... 000000 100644 100644 000000 bbb staged.txt\0",
            "1 .D N... 100644 100644 000000 ccc ccc deleted.txt\0",
            "1 MM N... 100644 100644 100644 ddd ddd both.txt\0",
            "? untracked.txt\0",
            "u UU N... 100644 100644 100644 100644 eee eee fff conflicted.txt\0",
        );
        let status = parse_porcelain_v2(fixture.as_bytes());
        assert_eq!(status.files.len(), 6);
        assert_eq!(status.files[0].status, "M");
        assert!(!status.files[0].staged);
        assert_eq!(status.files[1].status, "A");
        assert!(status.files[1].staged);
        assert_eq!(status.files[2].status, "D");
        assert_eq!(status.files[3].status, "M");
        assert_eq!(status.files[4].status, "?");
        assert_eq!(status.files[5].status, "U");
    }

    #[test]
    fn parse_porcelain_v2_handles_paths_with_spaces() {
        let fixture = "? untracked new.txt\0";
        let status = parse_porcelain_v2(fixture.as_bytes());
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].path, "untracked new.txt");
        assert_eq!(status.files[0].status, "?");
    }

    #[test]
    fn parse_porcelain_v2_keeps_toplevel_relative_paths_for_a_subdir_root() {
        let fixture = concat!(
            "# branch.oid abc123\0",
            "# branch.head master\0",
            "1 .M N... 100644 100644 100644 aaa aaa sub/committed.txt\0",
            "? sub/deep.txt\0",
        );
        let status = parse_porcelain_v2(fixture.as_bytes());
        assert_eq!(status.branch, Some("master".to_string()));
        assert_eq!(status.files.len(), 2);
        // Pins that the parser does NOT rebase onto the requested root — the
        // Contract's `repoRoot` join rule depends on this staying untouched.
        assert_eq!(status.files[0].path, "sub/committed.txt");
        assert_eq!(status.files[1].path, "sub/deep.txt");
    }

    #[test]
    fn parse_numstat_z_reads_normal_records() {
        let fixture = "1\t0\tstaged.txt\0";
        let map = parse_numstat_z(fixture.as_bytes());
        assert_eq!(map.get("staged.txt"), Some(&(Some(1), Some(0), None)));
    }

    #[test]
    fn parse_numstat_z_handles_rename_three_field_record() {
        let fixture = "0\t0\t\0torename.txt\0renamed.txt\0";
        let map = parse_numstat_z(fixture.as_bytes());
        assert_eq!(map.len(), 1);
        assert_eq!(
            map.get("renamed.txt"),
            Some(&(Some(0), Some(0), Some("torename.txt".to_string())))
        );
    }

    #[test]
    fn parse_numstat_z_maps_binary_dashes_to_none() {
        let fixture = "-\t-\timg.png\0";
        let map = parse_numstat_z(fixture.as_bytes());
        assert_eq!(map.get("img.png"), Some(&(None, None, None)));
    }

    #[test]
    fn parse_numstat_z_keys_match_porcelain_paths_for_a_subdir_root() {
        let porcelain_fixture = "1 .M N... 100644 100644 100644 aaa aaa sub/committed.txt\0";
        let porcelain = parse_porcelain_v2(porcelain_fixture.as_bytes());
        let numstat_fixture = "1\t0\tsub/committed.txt\0";
        let numstat = parse_numstat_z(numstat_fixture.as_bytes());
        let file = &porcelain.files[0];
        assert!(numstat.contains_key(&file.path));
    }

    #[test]
    fn run_with_timeout_kills_a_hung_child() {
        let started = Instant::now();
        let result = run_with_timeout("sleep", None, &["30"], Duration::from_millis(100));
        assert!(matches!(result, Err(CmdError::Timeout)));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn run_with_timeout_reports_missing_binary() {
        let result = run_with_timeout(
            "codenest-no-such-binary",
            None,
            &[],
            Duration::from_secs(1),
        );
        assert!(matches!(result, Err(CmdError::NotFound)));
    }

    #[test]
    fn run_with_timeout_captures_output_larger_than_the_pipe_buffer() {
        // Without concurrent draining, `head`'s write would block the moment
        // the ~64 KiB pipe buffer fills, and `try_wait()` alone would never
        // see it exit — this is the deadlock regression this test pins.
        let result = run_with_timeout(
            "sh",
            None,
            &["-c", "yes | head -c 300000"],
            Duration::from_secs(5),
        )
        .expect("command should complete without deadlocking");
        assert_eq!(result.stdout.len(), 300_000);
        assert_eq!(result.code, Some(0));
    }

    #[test]
    fn repo_root_for_returns_none_outside_a_repo() {
        let dir = TestDir::new("repo_root_for_returns_none_outside_a_repo");
        let result = repo_root_for(dir.path());
        assert_eq!(result, Ok(None));
    }

    #[test]
    fn parses_branch_dirty_and_ahead() {
        let status = parse_pane_porcelain_v2(
            "# branch.oid abc1234567890\n# branch.head develop\n# branch.ab +2 -0\n1 .M N... 100644 100644 100644 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 file.rs\n",
        )
        .expect("branch.head present");
        assert_eq!(status.branch, "develop");
        assert_eq!(status.ahead, Some(2));
        assert!(status.dirty);
    }

    #[test]
    fn parses_clean_branch_without_upstream() {
        let status =
            parse_pane_porcelain_v2("# branch.oid abc1234567890\n# branch.head develop\n")
                .expect("branch.head present");
        assert_eq!(status.branch, "develop");
        assert_eq!(status.ahead, None);
        assert!(!status.dirty);
    }

    #[test]
    fn treats_untracked_as_dirty() {
        let status = parse_pane_porcelain_v2(
            "# branch.oid abc1234567890\n# branch.head develop\n? untracked.txt\n",
        )
        .expect("branch.head present");
        assert!(status.dirty);
    }

    #[test]
    fn parses_ahead_zero_as_zero_not_none() {
        let status = parse_pane_porcelain_v2(
            "# branch.oid abc1234567890\n# branch.head develop\n# branch.ab +0 -3\n",
        )
        .expect("branch.head present");
        assert_eq!(status.ahead, Some(0));
    }

    #[test]
    fn returns_none_without_branch_head() {
        assert_eq!(parse_pane_porcelain_v2(""), None);
        assert_eq!(parse_pane_porcelain_v2("# branch.oid abc1234567890\n"), None);
    }

    #[test]
    fn parses_detached_head() {
        let status = parse_pane_porcelain_v2(
            "# branch.oid abc1234567890\n# branch.head (detached)\n",
        )
        .expect("branch.head present");
        assert_eq!(status.branch, "(detached)");
    }
}
