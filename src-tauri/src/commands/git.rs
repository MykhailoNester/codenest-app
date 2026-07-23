//! Git utility commands for the dashboard shell.
//!
//! Process spawning belongs in the Rust shell per the architectural boundary
//! rules — the sidecar must never exec subprocesses.  This module provides a
//! single Tauri command that runs `git log` against a list of absolute
//! project paths and returns the most recent commits, suitable for the
//! "Recent Commits" dashboard widget.

use serde::{Deserialize, Serialize};
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
