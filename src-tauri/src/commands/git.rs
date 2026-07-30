//! Git utility commands for the dashboard shell.
//!
//! Process spawning belongs in the Rust shell per the architectural boundary
//! rules — the sidecar must never exec subprocesses.  This module provides a
//! single Tauri command that runs `git log` against a list of absolute
//! project paths and returns the most recent commits, suitable for the
//! "Recent Commits" dashboard widget.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

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
/// widget.  The Rust shell owns process spawning; the sidecar is never
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

/// Arguments for [`get_git_pane_status`].
#[derive(Debug, Deserialize)]
pub struct GitPaneStatusArgs {
    /// Absolute working directory of the terminal pane to inspect.
    pub cwd: String,
}

/// Branch/dirty/ahead-behind facts for one pane's working directory, used by
/// the session-state HUD's git cell. The sidecar tracks none of this — it
/// has no reason to shell out — so it comes from the Rust shell instead.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPaneStatus {
    /// Current branch name, `None` when HEAD is detached.
    pub branch: Option<String>,
    /// First 7 characters of the current commit, `None` on the initial
    /// (parentless) commit before any commit exists.
    pub head_short: Option<String>,
    /// `true` when any tracked or untracked change is present.
    pub dirty: bool,
    /// Commits ahead of the upstream branch, `None` when there is no upstream.
    pub ahead: Option<u32>,
    /// Commits behind the upstream branch. Read from the same porcelain line
    /// as `ahead` but not rendered by the HUD today.
    pub behind: Option<u32>,
}

/// Run one `git status --porcelain=v2 --branch` against a pane's live cwd and
/// return branch/dirty/ahead-behind facts for the session-state HUD's git
/// cell.
///
/// `Ok(None)` — not `Err` — covers every "there is nothing to show" case: an
/// empty or relative `cwd`, a path that no longer exists, or a directory that
/// is not a git work tree (`git` exits non-zero). `Err` is reserved for
/// nothing today; the `Result` return keeps the calling convention of
/// [`get_recent_commits`].
///
/// `--no-optional-locks` keeps this poll from ever taking the index lock, so
/// it never contends with the user's own git commands.
#[tauri::command]
pub async fn get_git_pane_status(
    args: GitPaneStatusArgs,
) -> Result<Option<GitPaneStatus>, String> {
    let cwd = args.cwd;
    if cwd.is_empty() || !cwd.starts_with('/') || !Path::new(&cwd).exists() {
        return Ok(None);
    }

    let output = Command::new("git")
        .args([
            "--no-optional-locks",
            "-C",
            &cwd,
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=normal",
        ])
        .output();

    let output = match output {
        Ok(o) if o.status.success() => o,
        // Not a git repo, git missing, or any other non-zero exit — no cell.
        _ => return Ok(None),
    };

    Ok(Some(parse_git_status_porcelain_v2(&String::from_utf8_lossy(
        &output.stdout,
    ))))
}

/// Parse `git status --porcelain=v2 --branch` output into [`GitPaneStatus`].
///
/// Pure and unit-tested without spawning git. Requires git >= 2.11 (the
/// version that introduced the `--porcelain=v2` format).
fn parse_git_status_porcelain_v2(stdout: &str) -> GitPaneStatus {
    let mut branch: Option<String> = None;
    let mut head_short: Option<String> = None;
    let mut ahead: Option<u32> = None;
    let mut behind: Option<u32> = None;
    let mut dirty = false;

    for line in stdout.lines() {
        if let Some(oid) = line.strip_prefix("# branch.oid ") {
            head_short = if oid == "(initial)" || oid.len() < 7 {
                None
            } else {
                Some(oid[..7].to_owned())
            };
        } else if let Some(head) = line.strip_prefix("# branch.head ") {
            branch = if head == "(detached)" {
                None
            } else {
                Some(head.to_owned())
            };
        } else if let Some(ab) = line.strip_prefix("# branch.ab ") {
            // e.g. "+2 -0" — split on whitespace, strip the leading sign
            // before parsing (`"-0".parse::<u32>()` fails; the value itself
            // is always non-negative).
            let mut parts = ab.split_whitespace();
            ahead = parts
                .next()
                .and_then(|s| s.trim_start_matches(['+', '-']).parse().ok());
            behind = parts
                .next()
                .and_then(|s| s.trim_start_matches(['+', '-']).parse().ok());
        } else if !line.starts_with('#') && !line.is_empty() {
            dirty = true;
        }
    }

    GitPaneStatus {
        branch,
        head_short,
        dirty,
        ahead,
        behind,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_ahead_and_clean() {
        let status = parse_git_status_porcelain_v2(
            "# branch.oid abc1234567890\n# branch.head develop\n# branch.ab +2 -0\n",
        );
        assert_eq!(status.branch.as_deref(), Some("develop"));
        assert_eq!(status.head_short.as_deref(), Some("abc1234"));
        assert_eq!(status.ahead, Some(2));
        assert_eq!(status.behind, Some(0));
        assert!(!status.dirty);
    }

    #[test]
    fn marks_dirty_on_any_entry_line() {
        let status = parse_git_status_porcelain_v2(
            "# branch.oid abc1234567890\n# branch.head develop\n1 .M N... 100644 100644 100644 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 file.rs\n",
        );
        assert!(status.dirty);
    }

    #[test]
    fn no_upstream_yields_none_ahead() {
        let status = parse_git_status_porcelain_v2(
            "# branch.oid abc1234567890\n# branch.head develop\n",
        );
        assert_eq!(status.ahead, None);
        assert_eq!(status.behind, None);
    }

    #[test]
    fn detached_head_yields_none_branch_and_short_oid() {
        let status = parse_git_status_porcelain_v2(
            "# branch.oid abc1234567890\n# branch.head (detached)\n",
        );
        assert_eq!(status.branch, None);
        assert_eq!(status.head_short.as_deref(), Some("abc1234"));
    }

    #[test]
    fn initial_commit_yields_none_head_short() {
        let status =
            parse_git_status_porcelain_v2("# branch.oid (initial)\n# branch.head develop\n");
        assert_eq!(status.head_short, None);
        assert_eq!(status.branch.as_deref(), Some("develop"));
    }

    #[test]
    fn empty_output_is_clean_and_unknown() {
        let status = parse_git_status_porcelain_v2("");
        assert_eq!(status.branch, None);
        assert_eq!(status.head_short, None);
        assert_eq!(status.ahead, None);
        assert_eq!(status.behind, None);
        assert!(!status.dirty);
    }
}
