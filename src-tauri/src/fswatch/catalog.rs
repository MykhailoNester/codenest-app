//! Live `.claude/` watcher for the invocables catalog (#48).
//!
//! The composer's pickers are only as fresh as the last scan, and a scan used to
//! need a user action. This module makes the scan follow the filesystem: it
//! watches each active project's `.claude/` tree and asks the sidecar to rescan
//! the *one* project a change belongs to, which regenerates the workspace links
//! and publishes `workspace.catalog.changed` — the event every open webview
//! refetches on.
//!
//! Four things this module is responsible for, not just implementing:
//!
//! 1. **It does not share [`super::FsWatchManager`].** That watcher is the
//!    navigator's, its root set is declarative and app-global, and it is
//!    rewritten every time the user expands a tree row (`use-explorer-sync.ts`).
//!    Two writers would fight, and the navigator legitimately watches *nothing*
//!    while the panel is closed — which is exactly when the catalog still has to
//!    stay live. Same `notify` plumbing, separate debouncer, separate root set.
//!
//! 2. **The shell asks the sidecar; it never touches the DB or the workspace.**
//!    `POST /command-center/projects/{id}/rescan` is the same endpoint the
//!    Command Center's Rescan button calls, so a watcher-driven refresh and a
//!    user-driven one cannot diverge, and alias/conflict recomputation (#45)
//!    comes along for free because both end in `regenerate_workspace_links`.
//!
//! 3. **One rescan per burst, never one per file event.** `notify`'s debouncer
//!    coalesces a 500 ms window; on top of that the loop below holds a
//!    trailing-edge quiet period, so a `git checkout` that churns for two
//!    seconds still costs one rescan per affected project. [`MAX_COALESCE_MS`]
//!    caps the wait so a *continuous* writer cannot defer the flush forever.
//!
//! 4. **The workspace `.claude/` is deliberately NOT watched.** It has exactly
//!    one writer, `regenerate_workspace_links`, which already publishes the
//!    change event from inside the same critical section that swaps the tree
//!    into place. Watching it would echo the app's own writes back as a second
//!    refetch, and any watch there that triggered a regeneration would be a
//!    feedback loop. A file dropped into it by hand has no DB row and so is not
//!    in the catalog either way.
//!
//! Degradation is always "the picker is up to `staleTime` stale", never an
//! error: a failed watcher build, a project over [`MAX_WATCHED_ROOTS`] and an
//! unreachable sidecar are all logged and left to the client's
//! refetch-on-focus (`useInvocables`).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{
    new_debouncer, DebounceEventResult, Debouncer, RecommendedCache,
};
use serde::Deserialize;

use crate::commands::docs::require_home_scope;
use crate::commands::fs_scope::{is_excluded_relative, resolve_in_home_scope};

const SIDECAR_BASE: &str = "http://127.0.0.1:8002";

/// Debounce window handed to `notify`. Deliberately looser than the
/// navigator's 150 ms (`super::DEBOUNCE_MS`): nothing here repaints, and the
/// work behind one batch is a project scan plus a workspace link regeneration.
const DEBOUNCE_MS: u64 = 500;

/// Trailing-edge quiet period on top of the debouncer: the flush waits until
/// this long after the *last* event of a burst.
const COALESCE_MS: u64 = 500;

/// …but never longer than this after the burst's *first* event, so a writer
/// that never goes quiet still gets its rescan.
const MAX_COALESCE_MS: u64 = 5_000;

/// How often the project list is re-read from the sidecar. This is also the
/// window in which a project that had no `.claude/` at all when the app started
/// gets picked up — the alternative, watching each project root so the
/// directory's *creation* is an event, means an FSEvents stream over the whole
/// repository (`node_modules`, `.git`, build output) for one directory name.
const ROOTS_REFRESH_SECS: u64 = 30;

/// Retry cadence until the first successful project fetch — the sidecar is
/// still starting when this thread spawns, and waiting a full refresh period to
/// find that out would leave the catalog cold for half a minute.
const ROOTS_RETRY_SECS: u64 = 3;

/// Watched `.claude/` trees, at most. macOS FSEvents gives one cheap kernel
/// watch per tree, Linux inotify needs a descriptor per directory; a `.claude/`
/// tree is tiny either way, so this is a runaway guard rather than a real
/// budget. Projects past the cap simply do not get live refresh.
const MAX_WATCHED_ROOTS: usize = 16;

/// HTTP timeout for both the project fetch and the rescan call. A rescan walks
/// one `.claude/` tree and regenerates the workspace links.
const HTTP_TIMEOUT_SECS: u64 = 20;

/// The three buckets the catalog is built from. A change anywhere else under
/// `.claude/` (`settings.local.json`, a transcript, a plugin cache) is not a
/// catalog change and must not spend a rescan.
const CATALOG_BUCKETS: [&str; 3] = ["agents", "skills", "commands"];

/// One project's watched `.claude/` directory, canonical.
#[derive(Debug, Clone, PartialEq, Eq)]
struct WatchRoot {
    project_id: i64,
    claude_dir: PathBuf,
}

/// The shape this module reads out of `GET /api/v1/command-center/projects`.
/// That endpoint already excludes the workspace project and rows without a
/// `root_path`; `is_active` it does not filter, and an archived project is not
/// invocable (`command_center_service._resolve_invocable_scope`), so it is
/// filtered here.
#[derive(Debug, Clone, Deserialize)]
struct ProjectRow {
    id: i64,
    root_path: Option<String>,
    is_active: Option<i64>,
}

enum Msg {
    /// This project's `.claude/` changed.
    Changed(i64),
    /// The watcher lost events (or a batch overflowed its own cap), so which
    /// project changed is unknown — every watched one is suspect.
    ChangedAll,
    Stop,
}

/// An in-flight burst of changes: when it started, and when it was last fed.
#[derive(Debug, Clone, Copy)]
struct Burst {
    first: Instant,
    last: Instant,
}

/// When a burst may be flushed: one quiet period after its last event, or
/// [`MAX_COALESCE_MS`] after its first, whichever comes first.
fn flush_deadline(burst: &Burst) -> Instant {
    let quiet = burst.last + Duration::from_millis(COALESCE_MS);
    let cap = burst.first + Duration::from_millis(MAX_COALESCE_MS);
    if quiet < cap {
        quiet
    } else {
        cap
    }
}

/// `<root_path>/.claude` for every active project. Pure — no I/O, so the
/// filtering rules are directly testable; existence and scope are enforced by
/// [`resolve_watch_roots`].
fn candidate_claude_dirs(rows: &[ProjectRow]) -> Vec<(i64, PathBuf)> {
    rows.iter()
        .filter(|row| row.is_active.unwrap_or(0) == 1)
        .filter_map(|row| {
            let raw = row.root_path.as_deref()?.trim();
            if raw.is_empty() {
                return None;
            }
            Some((row.id, Path::new(raw).join(".claude")))
        })
        .collect()
}

/// Resolve each candidate through the shared home-scope policy (which also
/// canonicalises, and fails for a `.claude/` that does not exist yet) and cap
/// the set. Returns the accepted roots and how many candidates were dropped
/// once the cap was reached, so the caller can log the coverage it lost.
fn resolve_watch_roots(candidates: &[(i64, PathBuf)], max: usize) -> (Vec<WatchRoot>, usize) {
    let mut accepted: Vec<WatchRoot> = Vec::new();
    let mut over_cap = 0usize;
    for (project_id, dir) in candidates {
        if !dir.is_dir() {
            continue;
        }
        let Ok(canonical) = resolve_in_home_scope(&dir.to_string_lossy()) else {
            continue;
        };
        if accepted.iter().any(|r| r.claude_dir == canonical) {
            continue;
        }
        if accepted.len() >= max {
            over_cap += 1;
            continue;
        }
        accepted.push(WatchRoot {
            project_id: *project_id,
            claude_dir: canonical,
        });
    }
    (accepted, over_cap)
}

/// The project a changed path belongs to, or `None` when the change is not one
/// the catalog is built from.
///
/// Pure over `(roots, path)` — this is the whole filtering contract: deepest
/// matching root wins (a project checked out inside another project attributes
/// to itself), the path must sit under one of [`CATALOG_BUCKETS`], and both the
/// exclusion set and the home-scope policy are re-checked on the emitted path
/// because a symlink inside a watched tree can point anywhere.
fn attribute_change(roots: &[WatchRoot], path: &Path) -> Option<i64> {
    let root = roots
        .iter()
        .filter(|r| path.starts_with(&r.claude_dir))
        .max_by_key(|r| r.claude_dir.as_os_str().len())?;
    let rel = path.strip_prefix(&root.claude_dir).ok()?;
    let bucket = rel.components().next()?;
    if !CATALOG_BUCKETS.contains(&bucket.as_os_str().to_str()?) {
        return None;
    }
    if is_excluded_relative(&root.claude_dir, path) {
        return None;
    }
    if require_home_scope(&path.to_string_lossy()).is_err() {
        return None;
    }
    Some(root.project_id)
}

/// Build a debouncer over `roots`, sending one [`Msg`] per attributable path.
/// `None` when no watcher could be started at all — logged, and left to the
/// client's refetch-on-focus.
fn build_debouncer(
    roots: &[WatchRoot],
    tx: &Sender<Msg>,
) -> Option<Debouncer<RecommendedWatcher, RecommendedCache>> {
    if roots.is_empty() {
        return None;
    }
    let roots_for_events = roots.to_vec();
    let tx_for_events = tx.clone();

    let built = new_debouncer(
        Duration::from_millis(DEBOUNCE_MS),
        None,
        move |result: DebounceEventResult| match result {
            Ok(events) => {
                if events.iter().any(|e| e.event.need_rescan()) {
                    let _ = tx_for_events.send(Msg::ChangedAll);
                    return;
                }
                let mut seen: BTreeSet<i64> = BTreeSet::new();
                for event in &events {
                    for path in &event.event.paths {
                        if let Some(pid) = attribute_change(&roots_for_events, path) {
                            seen.insert(pid);
                        }
                    }
                }
                for pid in seen {
                    let _ = tx_for_events.send(Msg::Changed(pid));
                }
            }
            Err(errors) => {
                // Losing events is recoverable (the next real change rescans
                // anyway) so this stays a warning, not a degraded flag.
                log::warn!("[catalog-watch] watcher error batch: {errors:?}");
            }
        },
    );

    match built {
        Ok(mut debouncer) => {
            let mut watched = 0usize;
            for root in roots {
                match debouncer.watch(&root.claude_dir, RecursiveMode::Recursive) {
                    Ok(()) => watched += 1,
                    Err(e) => log::warn!(
                        "[catalog-watch] cannot watch {}: {e}",
                        root.claude_dir.display()
                    ),
                }
            }
            if watched == 0 {
                return None;
            }
            log::debug!("[catalog-watch] watching {watched} .claude tree(s)");
            Some(debouncer)
        }
        Err(e) => {
            log::warn!("[catalog-watch] failed to start watcher: {e}");
            None
        }
    }
}

fn fetch_projects(client: &reqwest::blocking::Client) -> Result<Vec<ProjectRow>, String> {
    let resp = client
        .get(format!("{SIDECAR_BASE}/api/v1/command-center/projects"))
        .send()
        .map_err(|e| format!("fetch_projects: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("fetch_projects status {}", resp.status()));
    }
    resp.json::<Vec<ProjectRow>>()
        .map_err(|e| format!("fetch_projects json: {e}"))
}

/// Rescan one project. The sidecar publishes `workspace.catalog.changed` on the
/// regeneration this triggers, so there is nothing for the shell to emit.
fn request_rescan(client: &reqwest::blocking::Client, project_id: i64) -> Result<(), String> {
    let resp = client
        .post(format!(
            "{SIDECAR_BASE}/api/v1/command-center/projects/{project_id}/rescan"
        ))
        .send()
        .map_err(|e| format!("rescan {project_id}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("rescan {project_id} status {}", resp.status()));
    }
    Ok(())
}

/// Owns the watcher thread's stop channel. Held as `Arc<CatalogWatcher>` by
/// `lib.rs` so the main window's `CloseRequested` handler can stop the thread
/// before the sidecar goes down — the same lifetime contract
/// [`super::FsWatchManager::stop`] has.
pub struct CatalogWatcher {
    tx: Mutex<Option<Sender<Msg>>>,
}

impl Default for CatalogWatcher {
    fn default() -> Self {
        Self::new()
    }
}

impl CatalogWatcher {
    pub fn new() -> Self {
        Self {
            tx: Mutex::new(None),
        }
    }

    /// Spawn the watcher thread. Called from `lib.rs` `setup` after the sidecar
    /// has been started; the first project fetch retries every
    /// [`ROOTS_RETRY_SECS`] until the sidecar answers, so it does not matter
    /// that it is not up yet. A second call is ignored.
    pub fn start(&self) {
        let mut slot = self.tx.lock().unwrap();
        if slot.is_some() {
            log::warn!("[catalog-watch] already started");
            return;
        }
        let (tx, rx) = mpsc::channel::<Msg>();
        let tx_for_thread = tx.clone();
        *slot = Some(tx);
        thread::spawn(move || run_loop(rx, tx_for_thread));
    }

    /// Stop the watcher thread and, with it, the debouncer it owns. No-op if it
    /// was never started.
    pub fn stop(&self) {
        if let Some(tx) = self.tx.lock().unwrap().take() {
            let _ = tx.send(Msg::Stop);
        }
    }
}

fn run_loop(rx: Receiver<Msg>, tx: Sender<Msg>) {
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            log::error!("[catalog-watch] failed to build reqwest client: {e}");
            return;
        }
    };

    // The debouncer is owned by this thread and dropped (stopping its own
    // thread) when the loop ends or the root set is replaced.
    let mut debouncer: Option<Debouncer<RecommendedWatcher, RecommendedCache>> = None;
    let mut roots: Vec<WatchRoot> = Vec::new();
    let mut pending: BTreeSet<i64> = BTreeSet::new();
    let mut burst: Option<Burst> = None;
    let mut next_roots_refresh = Instant::now();
    let mut bootstrapped = false;

    loop {
        let wait = {
            let now = Instant::now();
            let mut next = next_roots_refresh;
            if let Some(b) = &burst {
                next = next.min(flush_deadline(b));
            }
            next.saturating_duration_since(now)
        };

        match rx.recv_timeout(wait) {
            Ok(Msg::Stop) => break,
            // The sender is held by `CatalogWatcher` and by the debouncer
            // callback, so this only happens if both are gone.
            Err(RecvTimeoutError::Disconnected) => break,
            Ok(Msg::Changed(pid)) => {
                pending.insert(pid);
                let now = Instant::now();
                burst = Some(match burst {
                    Some(b) => Burst { last: now, ..b },
                    None => Burst {
                        first: now,
                        last: now,
                    },
                });
            }
            Ok(Msg::ChangedAll) => {
                pending.extend(roots.iter().map(|r| r.project_id));
                let now = Instant::now();
                burst = Some(match burst {
                    Some(b) => Burst { last: now, ..b },
                    None => Burst {
                        first: now,
                        last: now,
                    },
                });
            }
            Err(RecvTimeoutError::Timeout) => {}
        }

        if let Some(b) = burst {
            if Instant::now() >= flush_deadline(&b) {
                burst = None;
                for project_id in std::mem::take(&mut pending) {
                    match request_rescan(&client, project_id) {
                        Ok(()) => {
                            log::debug!("[catalog-watch] rescanned project {project_id}")
                        }
                        Err(e) => log::warn!("[catalog-watch] {e}"),
                    }
                }
            }
        }

        if Instant::now() >= next_roots_refresh {
            match fetch_projects(&client) {
                Ok(rows) => {
                    next_roots_refresh = Instant::now() + Duration::from_secs(ROOTS_REFRESH_SECS);
                    let candidates = candidate_claude_dirs(&rows);
                    let (desired, over_cap) = resolve_watch_roots(&candidates, MAX_WATCHED_ROOTS);
                    if over_cap > 0 {
                        log::warn!(
                            "[catalog-watch] {over_cap} project(s) past the {MAX_WATCHED_ROOTS}-root \
                             cap get no live refresh"
                        );
                    }
                    if desired != roots {
                        // A `.claude/` that appeared while the app was running
                        // holds assets no scan has ever seen, so adopting the
                        // root is not enough — it needs one rescan. Skipped on
                        // the first pass: that is every project at once, and
                        // startup is not a change.
                        if bootstrapped {
                            for root in &desired {
                                if !roots.iter().any(|r| r.claude_dir == root.claude_dir) {
                                    let _ = tx.send(Msg::Changed(root.project_id));
                                }
                            }
                        }
                        // Drop the old debouncer before building the new one so
                        // two never run over an overlapping root set.
                        drop(debouncer.take());
                        debouncer = build_debouncer(&desired, &tx);
                        roots = desired;
                    }
                    bootstrapped = true;
                }
                Err(e) => {
                    let backoff = if bootstrapped {
                        ROOTS_REFRESH_SECS
                    } else {
                        ROOTS_RETRY_SECS
                    };
                    next_roots_refresh = Instant::now() + Duration::from_secs(backoff);
                    log::debug!("[catalog-watch] {e} (sidecar may be starting)");
                }
            }
        }
    }

    log::debug!("[catalog-watch] stopped");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: i64, root: Option<&str>, is_active: i64) -> ProjectRow {
        ProjectRow {
            id,
            root_path: root.map(|s| s.to_string()),
            is_active: Some(is_active),
        }
    }

    /// Same rationale as `super::tests::home_path`: the scope check is a
    /// lexical prefix test, so a fabricated path only has to be under `$HOME`.
    fn home_path(sub: &str) -> PathBuf {
        PathBuf::from(std::env::var("HOME").expect("HOME")).join(sub)
    }

    fn root(project_id: i64, dir: PathBuf) -> WatchRoot {
        WatchRoot {
            project_id,
            claude_dir: dir,
        }
    }

    #[test]
    fn candidates_are_the_claude_dir_of_every_active_project() {
        let rows = vec![
            row(1, Some("/home/u/alpha"), 1),
            // Archived — not invocable, so not watched.
            row(2, Some("/home/u/beta"), 0),
            // Defensive: the endpoint filters these out, but a NULL/blank
            // root_path must never become a watch on `/.claude`.
            row(3, None, 1),
            row(4, Some("   "), 1),
        ];

        let candidates = candidate_claude_dirs(&rows);

        assert_eq!(candidates, vec![(1, PathBuf::from("/home/u/alpha/.claude"))]);
    }

    #[test]
    fn resolve_skips_projects_without_a_claude_dir_and_caps_the_rest() {
        let existing = home_path(".codenest-test-catalog-existing");
        std::fs::create_dir_all(&existing).expect("fixture dir");
        let canonical = std::fs::canonicalize(&existing).expect("canonicalize");

        let (accepted, over_cap) = resolve_watch_roots(
            &[
                (1, existing.clone()),
                (2, home_path(".codenest-test-catalog-missing")),
            ],
            8,
        );
        assert_eq!(accepted, vec![root(1, canonical.clone())]);
        assert_eq!(over_cap, 0);

        // Cap counts what it dropped, so the log can say what lost coverage.
        let (capped, dropped) = resolve_watch_roots(&[(1, existing.clone())], 0);
        assert!(capped.is_empty());
        assert_eq!(dropped, 1);

        std::fs::remove_dir_all(&existing).ok();
    }

    #[test]
    fn attributes_a_change_to_the_deepest_matching_project() {
        let outer = home_path("codenest-catalog-outer/.claude");
        let inner = home_path("codenest-catalog-outer/vendored/inner/.claude");
        let roots = vec![root(1, outer.clone()), root(2, inner.clone())];

        assert_eq!(
            attribute_change(&roots, &outer.join("agents/debugger.md")),
            Some(1)
        );
        assert_eq!(
            attribute_change(&roots, &inner.join("agents/debugger.md")),
            Some(2)
        );
    }

    #[test]
    fn only_the_three_catalog_buckets_spend_a_rescan() {
        let claude = home_path("codenest-catalog-buckets/.claude");
        let roots = vec![root(7, claude.clone())];

        for bucket in ["agents", "skills", "commands"] {
            assert_eq!(
                attribute_change(&roots, &claude.join(bucket).join("thing.md")),
                Some(7),
                "{bucket}"
            );
        }
        // Claude Code rewrites these on its own; a rescan for either would be a
        // project scan plus a workspace regeneration for nothing.
        assert_eq!(
            attribute_change(&roots, &claude.join("settings.local.json")),
            None
        );
        assert_eq!(
            attribute_change(&roots, &claude.join("plugins/cache/x.json")),
            None
        );
        // Not under any watched root at all.
        assert_eq!(
            attribute_change(&roots, &home_path("elsewhere/agents/x.md")),
            None
        );
    }

    #[test]
    fn excluded_dirs_inside_a_bucket_are_dropped() {
        let claude = home_path("codenest-catalog-excluded/.claude");
        let roots = vec![root(3, claude.clone())];

        assert_eq!(
            attribute_change(&roots, &claude.join("skills/mine/node_modules/a.md")),
            None
        );
        assert_eq!(
            attribute_change(&roots, &claude.join("skills/mine/SKILL.md")),
            Some(3)
        );
    }

    /// Unique per test AND per process — same rationale and shape as the
    /// identical helper in `super::tests`. Lives under `$HOME` because
    /// `attribute_change` re-checks the home-scope policy on every path.
    struct TestDir(PathBuf);

    impl TestDir {
        fn new(name: &str) -> Self {
            let home = std::env::var("HOME").expect("HOME");
            let dir = PathBuf::from(home).join(format!(
                ".codenest-test-catalog-{name}-{}-{}",
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

    /// The one test that exercises a real watcher on a real filesystem rather
    /// than the pure filters: an agent file dropped into a watched project has
    /// to produce a rescan request, which is the whole feature.
    #[test]
    fn a_dropped_agent_file_asks_for_that_project_to_be_rescanned() {
        let fixture = TestDir::new("dropped");
        let claude = fixture.path().join(".claude");
        std::fs::create_dir_all(claude.join("agents")).expect("agents dir");
        let canonical = std::fs::canonicalize(&claude).expect("canonicalize");

        let (tx, rx) = mpsc::channel::<Msg>();
        let debouncer = build_debouncer(&[root(42, canonical.clone())], &tx)
            .expect("watcher over a real .claude dir");

        std::fs::write(
            canonical.join("agents/debugger.md"),
            "---\nname: debugger\n---\n",
        )
        .expect("write agent file");

        // Generous: FSEvents latency plus the 500 ms debounce window, on a
        // machine that may be running the rest of the suite in parallel.
        let msg = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("a change event");
        match msg {
            Msg::Changed(pid) => assert_eq!(pid, 42),
            // Acceptable in principle (it also triggers a rescan) but not what
            // a single file write should produce.
            Msg::ChangedAll => panic!("a single file write must not force a full pass"),
            Msg::Stop => panic!("unexpected stop"),
        }

        drop(debouncer);
    }

    #[test]
    fn a_burst_flushes_one_quiet_period_after_its_last_event() {
        let start = Instant::now();
        let burst = Burst {
            first: start,
            last: start + Duration::from_millis(300),
        };

        let deadline = flush_deadline(&burst);

        assert_eq!(deadline, start + Duration::from_millis(300 + COALESCE_MS));
        // The point of the trailing edge: an event 300 ms in pushes the flush
        // out rather than letting a burst fan out into two rescans.
        assert!(deadline > start + Duration::from_millis(COALESCE_MS));
    }

    #[test]
    fn a_never_quiet_writer_still_flushes_at_the_cap() {
        let start = Instant::now();
        let burst = Burst {
            first: start,
            // Still being fed well past the cap.
            last: start + Duration::from_millis(MAX_COALESCE_MS + 5_000),
        };

        assert_eq!(
            flush_deadline(&burst),
            start + Duration::from_millis(MAX_COALESCE_MS)
        );
    }
}
