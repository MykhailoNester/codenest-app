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

    parse_porcelain_v2(&String::from_utf8_lossy(&output.stdout))
}

/// Parse `git status --porcelain=v2 --branch` output into [`GitPaneStatus`].
///
/// Pure and unit-tested without spawning git. Requires git >= 2.11 (the
/// version that introduced the `--porcelain=v2` format). Returns `None` when
/// no `# branch.head` line is present — that only happens for output this
/// function was never meant to parse (not a repo, or an unexpected git
/// version), so there is nothing honest to report.
fn parse_porcelain_v2(stdout: &str) -> Option<GitPaneStatus> {
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

    #[test]
    fn parses_branch_dirty_and_ahead() {
        let status = parse_porcelain_v2(
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
            parse_porcelain_v2("# branch.oid abc1234567890\n# branch.head develop\n")
                .expect("branch.head present");
        assert_eq!(status.branch, "develop");
        assert_eq!(status.ahead, None);
        assert!(!status.dirty);
    }

    #[test]
    fn treats_untracked_as_dirty() {
        let status = parse_porcelain_v2(
            "# branch.oid abc1234567890\n# branch.head develop\n? untracked.txt\n",
        )
        .expect("branch.head present");
        assert!(status.dirty);
    }

    #[test]
    fn parses_ahead_zero_as_zero_not_none() {
        let status = parse_porcelain_v2(
            "# branch.oid abc1234567890\n# branch.head develop\n# branch.ab +0 -3\n",
        )
        .expect("branch.head present");
        assert_eq!(status.ahead, Some(0));
    }

    #[test]
    fn returns_none_without_branch_head() {
        assert_eq!(parse_porcelain_v2(""), None);
        assert_eq!(parse_porcelain_v2("# branch.oid abc1234567890\n"), None);
    }

    #[test]
    fn parses_detached_head() {
        let status = parse_porcelain_v2(
            "# branch.oid abc1234567890\n# branch.head (detached)\n",
        )
        .expect("branch.head present");
        assert_eq!(status.branch, "(detached)");
    }
}
