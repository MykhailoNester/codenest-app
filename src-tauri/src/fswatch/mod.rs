//! Live filesystem watcher for the workspace navigator.
//!
//! Built on `notify` + `notify-debouncer-full` rather than `tauri-plugin-fs`:
//! the plugin emits raw paths with no filtering and no policy hook, which
//! would push both the exclusion filter and the scope check into
//! TypeScript — the opposite of what this surface needs (see the research
//! doc's §12 trust-boundary callout). Three things this module is
//! responsible for enforcing, not just implementing:
//!
//! 1. **The exclusion set is applied before emission, in Rust.** `.git`
//!    alone fires hundreds of events per git operation; filtering in the
//!    frontend means paying the IPC cost for every event that gets thrown
//!    away on arrival.
//! 2. **Watch registration goes through the same `fs_scope::
//!    resolve_in_home_scope` policy as directory listings and the file
//!    index** — not a second denylist. A symlink inside a watched root can
//!    point anywhere, so every emitted change path is re-checked against the
//!    same policy in [`build_batch`], not just at registration time.
//! 3. **The root cap (`MAX_WATCHED_ROOTS`) has a documented degradation
//!    path.** macOS FSEvents gives one cheap kernel watch per tree; Linux
//!    inotify needs a watch descriptor per directory and hits
//!    `max_user_watches` on a large monorepo. Past the cap — or on an OS
//!    watch-limit error — the affected root is rejected and `degraded` is
//!    set, which is the caller's instruction to fall back to on-expand
//!    `fs_list_dir` refreshes instead of trusting live events.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::event::{ModifyKind, RenameMode};
use notify::{ErrorKind, EventKind, RecommendedWatcher, RecursiveMode, WatcherKind};
use notify_debouncer_full::{
    new_debouncer, DebounceEventResult, DebouncedEvent, Debouncer, RecommendedCache,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::docs::require_home_scope;
use crate::commands::fs_scope::{is_excluded_relative, resolve_in_home_scope, EXCLUDED_DIRS};

/// The catalog's own watcher over each project's `.claude/` tree. Same
/// `notify` plumbing, deliberately not the same root set — see the module doc.
pub mod catalog;

/// macOS FSEvents gives one cheap kernel watch per tree; Linux inotify needs
/// a descriptor per directory and hits `max_user_watches` on a large
/// monorepo. Past this many accepted roots, extras land in `rejected` with a
/// refresh-on-expand reason.
pub const MAX_WATCHED_ROOTS: usize = 8;

/// A UI tree wants tighter coalescing than Tauri's own dev-mode watcher
/// (which uses 1 s); 150 ms with `tick_rate: None` (→ debouncer ticks at
/// ~37 ms) is the research doc's 100–200 ms recommendation.
const DEBOUNCE_MS: u64 = 150;

/// A full rescan beats emitting hundreds of individual patches in one go —
/// past this many changes in one debounced batch, the batch is replaced with
/// `{ rescan: true, changes: [] }`.
const MAX_BATCH_CHANGES: usize = 400;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChange {
    pub kind: String,
    /// The watched root this path belongs to (absolute, canonical).
    pub root: String,
    /// Absolute; for `"moved"` this is the destination.
    pub path: String,
    /// Set only for `"moved"`.
    pub from_path: Option<String>,
    /// `None` when it could not be stat'd (e.g. after removal).
    pub is_dir: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChangeBatch {
    /// Monotonic, per app run; gaps mean nothing was emitted.
    pub seq: u64,
    /// Empty when `rescan` is true.
    pub changes: Vec<FsChange>,
    /// Backend lost events (or the batch was over cap) — refetch the
    /// affected roots.
    pub rescan: bool,
    /// Changes filtered out or over the batch cap.
    pub dropped: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedRoot {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchState {
    pub backend: String,
    /// Canonical, in the order accepted.
    pub watched_roots: Vec<String>,
    pub root_count: usize,
    pub max_roots: usize,
    pub rejected: Vec<RejectedRoot>,
    /// `true` => caller MUST refresh on expand, not trust events.
    pub degraded: bool,
    /// Sum of per-root counts recorded by `fs_build_file_index`.
    pub indexed_file_count: usize,
    pub indexed_root_count: usize,
    pub batches_emitted: u64,
    pub changes_emitted: u64,
    pub changes_dropped: u64,
    pub debounce_ms: u64,
    /// The directory names filtered out of every listing, index and watch
    /// batch. Sourced from `fs_scope::EXCLUDED_DIRS` so the navigator
    /// footer states the real policy rather than a duplicated literal.
    pub excluded_dirs: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetWatchRootsArgs {
    pub roots: Vec<String>,
}

/// Resolve each requested root through the shared scope policy and dedupe,
/// splitting into the paths that passed and the ones refused. Pure (no
/// watcher, no `AppHandle`) so the refusal behaviour `set_roots` depends on
/// is directly testable.
fn resolve_requested_roots(raw: &[String]) -> (Vec<PathBuf>, Vec<RejectedRoot>) {
    let mut accepted: Vec<PathBuf> = Vec::new();
    let mut rejected: Vec<RejectedRoot> = Vec::new();
    for path in raw {
        match resolve_in_home_scope(path) {
            Ok(canonical) => {
                if !accepted.contains(&canonical) {
                    accepted.push(canonical);
                }
            }
            Err(reason) => rejected.push(RejectedRoot {
                path: path.clone(),
                reason,
            }),
        }
    }
    (accepted, rejected)
}

/// Split a requested root list into accepted and rejected halves. Pure, so
/// the cap and its degradation reason are testable without a watcher.
fn plan_roots(requested: &[PathBuf], max: usize) -> (Vec<PathBuf>, Vec<RejectedRoot>) {
    if requested.len() <= max {
        return (requested.to_vec(), Vec::new());
    }
    let (kept, over) = requested.split_at(max);
    let rejected = over
        .iter()
        .map(|p| RejectedRoot {
            path: p.to_string_lossy().into_owned(),
            reason: format!("root cap reached ({max}) — refresh on expand"),
        })
        .collect();
    (kept.to_vec(), rejected)
}

/// The longest (most specific) watched root that is an ancestor of `path`,
/// or `None` if `path` isn't under any of them.
fn attribute_root<'a>(roots: &'a [PathBuf], path: &Path) -> Option<&'a PathBuf> {
    roots
        .iter()
        .filter(|root| path.starts_with(root.as_path()))
        .max_by_key(|root| root.as_os_str().len())
}

fn stat_is_dir(path: &Path) -> Option<bool> {
    std::fs::symlink_metadata(path).ok().map(|m| m.is_dir())
}

/// Map one raw `notify` event to `(kind, path, from_path)`, or `None` when it
/// should never become an `FsChange` at all (an access event, or a paired
/// rename whose destination *and* source both fall outside every watched
/// root). This is distinct from the exclusion/scope drops in [`build_batch`],
/// which happen after this classification and DO count toward `dropped`.
fn classify_event(
    kind: &EventKind,
    paths: &[PathBuf],
    roots: &[PathBuf],
) -> Option<(&'static str, PathBuf, Option<PathBuf>)> {
    match kind {
        EventKind::Create(_) => paths.first().map(|p| ("created", p.clone(), None)),
        EventKind::Remove(_) => paths.first().map(|p| ("removed", p.clone(), None)),
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
            if paths.len() < 2 {
                return None;
            }
            let from = &paths[0];
            let to = &paths[1];
            match (
                attribute_root(roots, from).is_some(),
                attribute_root(roots, to).is_some(),
            ) {
                (true, true) => Some(("moved", to.clone(), Some(from.clone()))),
                // Destination left every watched root: degrade to a removal
                // of the source rather than reporting a move to nowhere.
                (true, false) => Some(("removed", from.clone(), None)),
                // Source came from outside every watched root: degrade to a
                // creation of the destination.
                (false, true) => Some(("created", to.clone(), None)),
                (false, false) => None,
            }
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
            paths.first().map(|p| ("removed", p.clone(), None))
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => {
            paths.first().map(|p| ("created", p.clone(), None))
        }
        EventKind::Modify(_) => paths.first().map(|p| ("modified", p.clone(), None)),
        EventKind::Access(_) => None,
        EventKind::Other | EventKind::Any => paths.first().map(|p| ("modified", p.clone(), None)),
    }
}

/// Turn one debounced batch into at most one [`FsChangeBatch`]. Pure over
/// `(roots, events)` — this is the whole filtering + rename-pairing
/// contract, and is exercised directly by this module's tests without a real
/// watcher.
fn build_batch(roots: &[PathBuf], events: &[DebouncedEvent], seq: u64) -> FsChangeBatch {
    if events.iter().any(|e| e.event.need_rescan()) {
        return FsChangeBatch {
            seq,
            changes: Vec::new(),
            rescan: true,
            dropped: 0,
        };
    }

    let mut classified: Vec<(&'static str, PathBuf, Option<PathBuf>)> = Vec::new();
    let mut dropped: u32 = 0;

    for debounced in events {
        let event = &debounced.event;
        match classify_event(&event.kind, &event.paths, roots) {
            Some(entry) => classified.push(entry),
            None => {
                // An access event is simply not reported (never counted as
                // dropped — it was never a candidate change). A paired
                // rename with neither end inside any watched root has
                // nothing to attribute the change to.
                if !matches!(event.kind, EventKind::Access(_)) {
                    dropped += 1;
                }
            }
        }
    }

    let mut surviving: Vec<(&'static str, PathBuf, Option<PathBuf>)> = Vec::new();
    for (kind, path, from_path) in classified {
        let Some(root) = attribute_root(roots, &path) else {
            dropped += 1;
            continue;
        };
        if is_excluded_relative(root, &path) {
            dropped += 1;
            continue;
        }
        if require_home_scope(&path.to_string_lossy()).is_err() {
            dropped += 1;
            continue;
        }
        if let Some(from) = &from_path {
            if require_home_scope(&from.to_string_lossy()).is_err() {
                dropped += 1;
                continue;
            }
        }
        surviving.push((kind, path, from_path));
    }

    // Dedupe on (kind, path), keeping the last occurrence's data.
    let mut index_of: HashMap<(&'static str, PathBuf), usize> = HashMap::new();
    let mut deduped: Vec<(&'static str, PathBuf, Option<PathBuf>)> = Vec::new();
    for entry in surviving {
        let key = (entry.0, entry.1.clone());
        if let Some(&idx) = index_of.get(&key) {
            deduped[idx] = entry;
        } else {
            index_of.insert(key, deduped.len());
            deduped.push(entry);
        }
    }

    if deduped.len() > MAX_BATCH_CHANGES {
        // None of these are delivered — a full refetch beats hundreds of
        // patches — so every one of them counts as dropped, not just the
        // amount past the cap.
        dropped += deduped.len() as u32;
        return FsChangeBatch {
            seq,
            changes: Vec::new(),
            rescan: true,
            dropped,
        };
    }

    let changes: Vec<FsChange> = deduped
        .into_iter()
        .map(|(kind, path, from_path)| {
            let is_dir = stat_is_dir(&path);
            let root = attribute_root(roots, &path)
                .map(|r| r.to_string_lossy().into_owned())
                .unwrap_or_default();
            FsChange {
                kind: kind.to_string(),
                root,
                path: path.to_string_lossy().into_owned(),
                from_path: from_path.map(|p| p.to_string_lossy().into_owned()),
                is_dir,
            }
        })
        .collect();

    FsChangeBatch {
        seq,
        changes,
        rescan: false,
        dropped,
    }
}

/// Emit unless the target's label is `preview` or `screenshot-ring`.
/// `app.emit` broadcasts to every webview including `preview`, which loads
/// remote content and is deliberately excluded from all capabilities — its
/// JS cannot call `listen`, so this is defence in depth, not a live bug, but
/// broadcasting absolute filesystem paths into a remote-content webview is
/// not a thing to do on purpose.
fn should_emit_to(target: &tauri::EventTarget) -> bool {
    let label = match target {
        tauri::EventTarget::AnyLabel { label }
        | tauri::EventTarget::Window { label }
        | tauri::EventTarget::Webview { label }
        | tauri::EventTarget::WebviewWindow { label } => Some(label.as_str()),
        // `EventTarget` is `#[non_exhaustive]`; anything without a label
        // (today `Any`/`App`) is never excluded.
        _ => None,
    };
    !matches!(label, Some("preview") | Some("screenshot-ring"))
}

/// Owns the live debouncer (if any) and the counters `fs_watch_status`
/// reports. Held as `Arc<FsWatchManager>` in Tauri managed state; async
/// commands clone the `Arc` and do their work inside `spawn_blocking` so the
/// internal mutexes are never held across an `.await` (see the module-level
/// design note mirrored from `commands/hooks.rs`'s blocking pattern).
pub struct FsWatchManager {
    debouncer: Mutex<Option<Debouncer<RecommendedWatcher, RecommendedCache>>>,
    roots: Mutex<Vec<PathBuf>>,
    rejected: Mutex<Vec<RejectedRoot>>,
    index_counts: Mutex<HashMap<PathBuf, usize>>,
    seq: Arc<AtomicU64>,
    batches_emitted: Arc<AtomicU64>,
    changes_emitted: Arc<AtomicU64>,
    changes_dropped: Arc<AtomicU64>,
    degraded: Arc<AtomicBool>,
}

impl Default for FsWatchManager {
    fn default() -> Self {
        Self::new()
    }
}

impl FsWatchManager {
    pub fn new() -> Self {
        Self {
            debouncer: Mutex::new(None),
            roots: Mutex::new(Vec::new()),
            rejected: Mutex::new(Vec::new()),
            index_counts: Mutex::new(HashMap::new()),
            seq: Arc::new(AtomicU64::new(0)),
            batches_emitted: Arc::new(AtomicU64::new(0)),
            changes_emitted: Arc::new(AtomicU64::new(0)),
            changes_dropped: Arc::new(AtomicU64::new(0)),
            degraded: Arc::new(AtomicBool::new(false)),
        }
    }

    /// An associated function, not a method — the backend is reportable even
    /// with zero roots watched, since it comes from `Debouncer::kind()`
    /// (ultimately `<RecommendedWatcher as Watcher>::kind()`), not from any
    /// live instance.
    pub fn backend_name() -> &'static str {
        match Debouncer::<RecommendedWatcher, RecommendedCache>::kind() {
            WatcherKind::Fsevent => "fsevent",
            WatcherKind::Inotify => "inotify",
            WatcherKind::Kqueue => "kqueue",
            WatcherKind::PollWatcher => "poll",
            WatcherKind::ReadDirectoryChangesWatcher => "windows",
            WatcherKind::NullWatcher => "null",
            // `WatcherKind` is `#[non_exhaustive]`; fail closed to a known
            // slug rather than let a future notify release panic here.
            _ => "null",
        }
    }

    pub fn state(&self) -> WatchState {
        let roots = self.roots.lock().unwrap();
        let rejected = self.rejected.lock().unwrap();
        let index_counts = self.index_counts.lock().unwrap();
        WatchState {
            backend: Self::backend_name().to_string(),
            watched_roots: roots
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect(),
            root_count: roots.len(),
            max_roots: MAX_WATCHED_ROOTS,
            rejected: rejected.clone(),
            degraded: self.degraded.load(Ordering::Relaxed),
            indexed_file_count: index_counts.values().sum(),
            indexed_root_count: index_counts.len(),
            batches_emitted: self.batches_emitted.load(Ordering::Relaxed),
            changes_emitted: self.changes_emitted.load(Ordering::Relaxed),
            changes_dropped: self.changes_dropped.load(Ordering::Relaxed),
            debounce_ms: DEBOUNCE_MS,
            excluded_dirs: EXCLUDED_DIRS.iter().map(|s| (*s).to_string()).collect(),
        }
    }

    /// Record `count` files indexed for the canonical `root`, so
    /// `indexedFileCount`/`indexedRootCount` reflect what `fs_build_file_index`
    /// has actually built without the shell caching the file list itself.
    pub fn record_index(&self, root: &Path, count: usize) {
        self.index_counts
            .lock()
            .unwrap()
            .insert(root.to_path_buf(), count);
    }

    /// Declarative, idempotent set-swap: replaces the whole watched set.
    /// `{ roots: [] }` stops watching. The old debouncer (if any) is always
    /// dropped before the new one is built — incremental watch/unwatch would
    /// buy nothing at `N <= MAX_WATCHED_ROOTS` and adds bookkeeping that must
    /// stay in sync with the debouncer's own internal root list. Cost:
    /// events during the swap are lost, which is why the contract requires
    /// the caller to refresh after `set_roots` returns.
    pub fn set_roots(&self, app: &AppHandle, raw: Vec<String>) -> WatchState {
        let (candidate_paths, mut rejected) = resolve_requested_roots(&raw);
        let (candidates, capped_rejected) = plan_roots(&candidate_paths, MAX_WATCHED_ROOTS);
        rejected.extend(capped_rejected);

        // Drop the old debouncer (if any) before building the new one — its
        // `Drop` stops the background thread, so the swap never runs two
        // debouncers over an overlapping root set.
        *self.debouncer.lock().unwrap() = None;

        let mut degraded = !rejected.is_empty();
        let mut accepted: Vec<PathBuf> = Vec::new();

        if !candidates.is_empty() {
            let app_for_events = app.clone();
            let roots_for_events = candidates.clone();
            let seq_for_events = Arc::clone(&self.seq);
            let batches_for_events = Arc::clone(&self.batches_emitted);
            let changes_for_events = Arc::clone(&self.changes_emitted);
            let dropped_for_events = Arc::clone(&self.changes_dropped);
            let degraded_for_events = Arc::clone(&self.degraded);

            let built = new_debouncer(
                Duration::from_millis(DEBOUNCE_MS),
                None,
                move |result: DebounceEventResult| match result {
                    Ok(events) => {
                        let seq = seq_for_events.fetch_add(1, Ordering::Relaxed) + 1;
                        let batch = build_batch(&roots_for_events, &events, seq);
                        if batch.rescan || !batch.changes.is_empty() {
                            batches_for_events.fetch_add(1, Ordering::Relaxed);
                            changes_for_events
                                .fetch_add(batch.changes.len() as u64, Ordering::Relaxed);
                            dropped_for_events.fetch_add(u64::from(batch.dropped), Ordering::Relaxed);
                            log::debug!(
                                "[fswatch] batch {seq}: {} changes, rescan={}, dropped={}",
                                batch.changes.len(),
                                batch.rescan,
                                batch.dropped
                            );
                            let _ = app_for_events.emit_filter(
                                "fs_change_batch",
                                batch,
                                should_emit_to,
                            );
                        }
                    }
                    Err(errors) => {
                        log::warn!("[fswatch] watcher error batch: {errors:?}");
                        if errors
                            .iter()
                            .any(|e| matches!(e.kind, ErrorKind::MaxFilesWatch))
                        {
                            degraded_for_events.store(true, Ordering::Relaxed);
                        }
                    }
                },
            );

            match built {
                Ok(mut debouncer) => {
                    for root in &candidates {
                        match debouncer.watch(root, RecursiveMode::Recursive) {
                            Ok(()) => accepted.push(root.clone()),
                            Err(e) => {
                                degraded = true;
                                let reason = match e.kind {
                                    ErrorKind::MaxFilesWatch => {
                                        "OS watch limit reached — refresh on expand".to_string()
                                    }
                                    ErrorKind::PathNotFound => "root does not exist".to_string(),
                                    _ => format!("failed to watch: {e}"),
                                };
                                rejected.push(RejectedRoot {
                                    path: root.to_string_lossy().into_owned(),
                                    reason,
                                });
                            }
                        }
                    }
                    *self.debouncer.lock().unwrap() = Some(debouncer);
                }
                Err(e) => {
                    // Could not build a debouncer at all — every candidate
                    // is rejected and the manager is left with no watcher.
                    degraded = true;
                    for root in &candidates {
                        rejected.push(RejectedRoot {
                            path: root.to_string_lossy().into_owned(),
                            reason: format!("failed to start watcher: {e}"),
                        });
                    }
                }
            }
        }

        *self.roots.lock().unwrap() = accepted.clone();
        *self.rejected.lock().unwrap() = rejected;
        self.degraded.store(degraded, Ordering::Relaxed);

        // Prune index-count metadata for roots that left the set, so
        // `indexedFileCount` never describes a root we no longer watch.
        self.index_counts
            .lock()
            .unwrap()
            .retain(|root, _| accepted.contains(root));

        self.state()
    }

    /// Stop the debouncer (if any) and join its thread. Called from the
    /// main window's `CloseRequested` handler so a live watcher never
    /// outlives app teardown.
    pub fn stop(&self) {
        if let Some(debouncer) = self.debouncer.lock().unwrap().take() {
            debouncer.stop();
        }
    }
}

#[tauri::command]
pub async fn fs_watch_set_roots(
    args: SetWatchRootsArgs,
    app: AppHandle,
) -> Result<WatchState, String> {
    let mgr = app.state::<Arc<FsWatchManager>>().inner().clone();
    let app_for_blocking = app.clone();
    tauri::async_runtime::spawn_blocking(move || mgr.set_roots(&app_for_blocking, args.roots))
        .await
        .map_err(|e| format!("fs_watch_set_roots task panicked: {e}"))
}

#[tauri::command]
pub fn fs_watch_status(state: tauri::State<'_, Arc<FsWatchManager>>) -> WatchState {
    state.state()
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, DataChange, Flag, RemoveKind};
    use notify::Event;
    use std::time::Instant;

    /// Unique per test AND per process — same rationale and shape as the
    /// identical helper in `commands/fs_nav.rs` and `commands/git.rs`
    /// (`scheduler/mod.rs:1131-1136` precedent). The `fswatch` slug keeps
    /// this module's fixtures from colliding with the others.
    struct TestDir(PathBuf);

    impl TestDir {
        fn new(name: &str) -> Self {
            let home = std::env::var("HOME").expect("HOME");
            let dir = PathBuf::from(home).join(format!(
                ".codenest-test-fswatch-{name}-{}-{}",
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

    /// `build_batch` re-checks `require_home_scope` on every emitted path,
    /// so a fabricated (non-existent, no `TestDir`) root must still be a
    /// *lexical* descendant of the real `$HOME` — the check is a string
    /// prefix test, not a filesystem read, so this needs no fixture.
    fn home_path(sub: &str) -> PathBuf {
        PathBuf::from(std::env::var("HOME").expect("HOME")).join(sub)
    }

    #[test]
    fn build_batch_pairs_rename_into_single_moved_change() {
        let root = home_path("codenest-fswatch-fixture-1");
        let from = root.join("before.txt");
        let to = root.join("after.txt");
        let event = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(from.clone())
            .add_path(to.clone());
        let debounced = DebouncedEvent::new(event, Instant::now());

        let batch = build_batch(&[root], &[debounced], 1);

        assert_eq!(batch.changes.len(), 1);
        assert_eq!(batch.changes[0].kind, "moved");
        assert_eq!(batch.changes[0].path, to.to_string_lossy());
        assert_eq!(
            batch.changes[0].from_path.as_deref(),
            Some(from.to_string_lossy().as_ref())
        );
        // The point of the debouncer: a rename is one `moved` change, never
        // an accompanying `removed` + `created` pair.
        assert!(!batch
            .changes
            .iter()
            .any(|c| c.kind == "removed" || c.kind == "created"));
    }

    #[test]
    fn build_batch_maps_unpaired_rename_halves() {
        let root = home_path("codenest-fswatch-fixture-2");
        let from_only = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::From)))
            .add_path(root.join("gone.txt"));
        let to_only = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::To)))
            .add_path(root.join("arrived.txt"));
        let events = vec![
            DebouncedEvent::new(from_only, Instant::now()),
            DebouncedEvent::new(to_only, Instant::now()),
        ];

        let batch = build_batch(&[root], &events, 1);

        assert_eq!(batch.changes.len(), 2);
        assert!(batch
            .changes
            .iter()
            .any(|c| c.kind == "removed" && c.path.ends_with("gone.txt")));
        assert!(batch
            .changes
            .iter()
            .any(|c| c.kind == "created" && c.path.ends_with("arrived.txt")));
    }

    #[test]
    fn build_batch_moved_out_of_roots_degrades_to_removed() {
        let root = home_path("codenest-fswatch-fixture-3");
        let from = root.join("leaving.txt");
        let to = home_path("codenest-fswatch-fixture-3-elsewhere/leaving.txt");
        let event = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(from.clone())
            .add_path(to);
        let debounced = DebouncedEvent::new(event, Instant::now());

        let batch = build_batch(&[root], &[debounced], 1);

        assert_eq!(batch.changes.len(), 1);
        assert_eq!(batch.changes[0].kind, "removed");
        assert_eq!(batch.changes[0].path, from.to_string_lossy());
    }

    #[test]
    fn build_batch_drops_excluded_paths() {
        let root = home_path("codenest-fswatch-fixture-4");
        let events = vec![
            DebouncedEvent::new(
                Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
                    .add_path(root.join(".git").join("index")),
                Instant::now(),
            ),
            DebouncedEvent::new(
                Event::new(EventKind::Create(CreateKind::File))
                    .add_path(root.join("node_modules").join("x").join("y.js")),
                Instant::now(),
            ),
            DebouncedEvent::new(
                Event::new(EventKind::Create(CreateKind::File))
                    .add_path(root.join("src").join("a.ts")),
                Instant::now(),
            ),
        ];

        let batch = build_batch(&[root], &events, 1);

        assert_eq!(batch.changes.len(), 1);
        assert!(batch.changes[0].path.ends_with("a.ts"));
        assert_eq!(batch.dropped, 2);
    }

    #[test]
    fn build_batch_drops_paths_outside_watched_roots() {
        let root = home_path("codenest-fswatch-fixture-5");
        let outside = home_path("codenest-fswatch-fixture-5-not-watched/file.txt");
        let event = Event::new(EventKind::Create(CreateKind::File)).add_path(outside);
        let debounced = DebouncedEvent::new(event, Instant::now());

        let batch = build_batch(&[root], &[debounced], 1);

        assert!(batch.changes.is_empty());
        assert_eq!(batch.dropped, 1);
    }

    #[test]
    fn build_batch_dedupes_repeated_paths() {
        let root = home_path("codenest-fswatch-fixture-6");
        let path = root.join("busy.txt");
        let events: Vec<DebouncedEvent> = (0..3)
            .map(|_| {
                DebouncedEvent::new(
                    Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
                        .add_path(path.clone()),
                    Instant::now(),
                )
            })
            .collect();

        let batch = build_batch(&[root], &events, 1);

        assert_eq!(batch.changes.len(), 1);
        assert_eq!(batch.changes[0].kind, "modified");
    }

    #[test]
    fn build_batch_sets_rescan_and_clears_changes() {
        let root = home_path("codenest-fswatch-fixture-7");
        let rescan_event = Event::new(EventKind::Any).set_flag(Flag::Rescan);
        let debounced = DebouncedEvent::new(rescan_event, Instant::now());

        let batch = build_batch(&[root], &[debounced], 1);

        assert!(batch.rescan);
        assert!(batch.changes.is_empty());
    }

    #[test]
    fn build_batch_caps_and_reports_dropped() {
        let root = home_path("codenest-fswatch-fixture-8");
        let events: Vec<DebouncedEvent> = (0..(MAX_BATCH_CHANGES + 50))
            .map(|i| {
                DebouncedEvent::new(
                    Event::new(EventKind::Create(CreateKind::File))
                        .add_path(root.join(format!("f{i}.txt"))),
                    Instant::now(),
                )
            })
            .collect();

        let batch = build_batch(&[root], &events, 1);

        assert!(batch.rescan);
        assert!(batch.changes.is_empty());
        assert_eq!(batch.dropped, (MAX_BATCH_CHANGES + 50) as u32);
    }

    #[test]
    fn build_batch_reports_is_dir_for_a_real_directory() {
        let dir = TestDir::new("build_batch_reports_is_dir_for_a_real_directory");
        let root = dir.path().to_path_buf();
        let subdir = root.join("sub");
        std::fs::create_dir(&subdir).unwrap();
        let file = root.join("file.txt");
        std::fs::write(&file, b"x").unwrap();
        let missing = root.join("missing.txt");

        let events = vec![
            DebouncedEvent::new(
                Event::new(EventKind::Create(CreateKind::Folder)).add_path(subdir.clone()),
                Instant::now(),
            ),
            DebouncedEvent::new(
                Event::new(EventKind::Create(CreateKind::File)).add_path(file.clone()),
                Instant::now(),
            ),
            DebouncedEvent::new(
                Event::new(EventKind::Remove(RemoveKind::File)).add_path(missing.clone()),
                Instant::now(),
            ),
        ];

        let batch = build_batch(&[root], &events, 1);

        let find = |p: &PathBuf| {
            batch
                .changes
                .iter()
                .find(|c| c.path == p.to_string_lossy())
                .unwrap()
        };
        assert_eq!(find(&subdir).is_dir, Some(true));
        assert_eq!(find(&file).is_dir, Some(false));
        assert_eq!(find(&missing).is_dir, None);
    }

    #[test]
    fn plan_roots_caps_at_max_and_explains_the_rejection() {
        let roots: Vec<PathBuf> = (0..12)
            .map(|i| home_path(&format!("codenest-fswatch-root-{i}")))
            .collect();

        let (accepted, rejected) = plan_roots(&roots, MAX_WATCHED_ROOTS);

        assert_eq!(accepted.len(), MAX_WATCHED_ROOTS);
        assert_eq!(rejected.len(), 4);
        for r in &rejected {
            assert!(r.reason.contains("refresh on expand"));
        }
    }

    #[test]
    fn watch_state_reports_the_real_exclusion_list() {
        // No `AppHandle` needed — `state()` reads only its own mutexes and
        // the `EXCLUDED_DIRS` constant, so this pins that the footer's list
        // is sourced from the shared policy, not typed out separately.
        let state = FsWatchManager::new().state();
        let expected: Vec<String> = EXCLUDED_DIRS.iter().map(|s| s.to_string()).collect();
        assert_eq!(state.excluded_dirs, expected);
        assert!(state.excluded_dirs.contains(&".git".to_string()));
        assert!(state.excluded_dirs.contains(&"node_modules".to_string()));
    }

    #[test]
    fn backend_name_is_a_stable_slug() {
        let name = FsWatchManager::backend_name();
        assert!(["fsevent", "inotify", "kqueue", "poll", "windows", "null"].contains(&name));
        #[cfg(target_os = "macos")]
        assert_eq!(name, "fsevent");
    }

    #[test]
    fn set_roots_rejects_a_root_outside_home() {
        // `set_roots` itself needs a real `AppHandle`, which a unit test
        // cannot construct without a running app — this exercises the same
        // root-resolution step it calls first, the same reasoning that
        // keeps `plan_roots` itself a pure, watcher-free function.
        let (accepted, rejected) = resolve_requested_roots(&["/etc".to_string()]);

        assert!(accepted.is_empty());
        assert_eq!(rejected.len(), 1);
        assert_eq!(rejected[0].path, "/etc");
        assert!(!accepted.contains(&PathBuf::from("/etc")));
    }

    /// A real debouncer over a real rename, asserting the pairing this
    /// module exists to provide end to end. Left `#[ignore]`d — FSEvents
    /// latency makes it timing-dependent — the deterministic
    /// `build_batch_pairs_rename_into_single_moved_change` above is the one
    /// that must always pass; this one is a sanity check run by hand with
    /// `cargo test -- --ignored`.
    #[test]
    #[ignore = "timing-dependent on FSEvents latency; run with `cargo test -- --ignored`"]
    fn end_to_end_rename_emits_one_moved_batch() {
        let dir = TestDir::new("end_to_end_rename_emits_one_moved_batch");
        let root = dir.path().canonicalize().expect("canonicalize fixture root");

        // Seed the file at a throwaway path and move it into `from` via a
        // rename, rather than writing it there directly. Observed on macOS:
        // a path that was just the target of a raw create keeps carrying a
        // "just created" FSEvents flag for a long time (well past any
        // reasonable settle delay), which trips notify-debouncer-full's own
        // "don't emit Modify after Create" rule and collapses the very next
        // rename on that path into a plain create instead of pairing it.
        // Arriving at `from` via a rename sidesteps that path-level taint,
        // so the rename under test is exercised cleanly.
        let seed = root.join("seed.txt");
        let from = root.join("before.txt");
        let to = root.join("after.txt");
        std::fs::write(&seed, b"x").unwrap();

        let (tx, rx) = std::sync::mpsc::channel();
        let mut debouncer =
            new_debouncer(Duration::from_millis(DEBOUNCE_MS), None, tx).expect("build debouncer");
        debouncer
            .watch(&root, RecursiveMode::Recursive)
            .expect("watch fixture root");

        std::fs::rename(&seed, &from).unwrap();
        // Let that first rename's batch settle before the one under test.
        std::thread::sleep(Duration::from_millis(500));
        std::fs::rename(&from, &to).unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut saw_single_moved = false;
        while Instant::now() < deadline {
            if let Ok(Ok(events)) = rx.recv_timeout(Duration::from_millis(500)) {
                let batch = build_batch(std::slice::from_ref(&root), &events, 1);
                if batch.changes.len() == 1 && batch.changes[0].kind == "moved" {
                    saw_single_moved = true;
                    break;
                }
            }
        }
        assert!(saw_single_moved, "expected exactly one moved change");
    }
}
