use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const SIDECAR_PORT: u16 = 8002;
/// Generous overall budget for the sidecar to become healthy after a single
/// spawn. A packaged onedir sidecar boots in <1 s; a slow disk, a cold cache,
/// or a one-time OS verification pass can still take several seconds. We poll
/// the REAL /health endpoint and NEVER kill a child that is merely still
/// booting — this budget only bounds a genuinely hung sidecar before we give
/// up. (The old 5 s-per-attempt timeout + kill-and-respawn loop was the direct
/// cause of the ~20 s first-launch: it killed a still-initializing sidecar and
/// re-paid the full cold-start cost on every retry.)
const STARTUP_BUDGET: Duration = Duration::from_secs(60);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const CRASH_WATCH_INTERVAL: Duration = Duration::from_millis(500);
const STALE_KILL_GRACE: Duration = Duration::from_secs(3);
/// Per-poll timeout for the HTTP /health probe.
const HEALTH_TIMEOUT: Duration = Duration::from_millis(400);
/// A sidecar that EXITS before ever becoming healthy is a real failure: either
/// a hard crash (import error → won't fix itself) or the transient
/// orphaned-WAL-lock case where a prior sidecar is still releasing :8002. We
/// respawn a small, bounded number of times with a back-off (the parent-PID
/// watchdog in the Python sidecar releases the lock within ~1-2 s), then give
/// up. We do NOT respawn on a slow-but-alive boot — only on a genuine exit.
const MAX_REAL_CRASH_RESPAWNS: u32 = 2;
/// Pause between respawns so an orphan's watchdog can release the WAL lock.
const RESPAWN_BACKOFF: Duration = Duration::from_secs(2);

#[derive(Clone, serde::Serialize)]
pub struct SidecarStatus {
    pub running: bool,
    pub version: Option<String>,
    pub pid: Option<u32>,
}

/// Manages the FastAPI sidecar process lifecycle.
///
/// In debug builds: spawns uvicorn via the project venv.
/// In release builds: spawns the PyInstaller binary from the app bundle.
pub struct SidecarManager {
    child: Arc<Mutex<Option<std::process::Child>>>,
    running: Arc<Mutex<bool>>,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            running: Arc::new(Mutex::new(false)),
        }
    }

    /// Spawn the sidecar and begin health polling. Non-blocking — runs on a background thread.
    ///
    /// `app_data_dir` and `bundle_resources_dir` are forwarded to the sidecar
    /// as `CODENEST_APP_DATA_DIR` and `CODENEST_BUNDLE_RESOURCES` so the
    /// Python config layer can resolve workspace paths without hardcoding them.
    pub fn start(
        &self,
        app: AppHandle,
        app_data_dir: &std::path::Path,
        bundle_resources_dir: &std::path::Path,
    ) {
        let child_arc = self.child.clone();
        let running_arc = self.running.clone();

        // Clone the paths into owned values so they can be moved into the thread.
        let app_data_dir = app_data_dir.to_path_buf();
        let bundle_resources_dir = bundle_resources_dir.to_path_buf();

        std::thread::spawn(move || {
            // One-time pre-flight: reclaim a leaked port from a prior orphaned
            // run. macOS will not let us rebind :SIDECAR_PORT while an old
            // uvicorn is still holding it, even if its parent Tauri shell is
            // gone. This runs ONCE — on a healthy launch the port is free and
            // it returns immediately. (Previously this ran on every retry,
            // paying the kill-grace repeatedly.)
            reclaim_stale_port(SIDECAR_PORT);

            // A reusable blocking HTTP client for the /health readiness probe.
            let health_client = reqwest::blocking::Client::builder()
                .timeout(HEALTH_TIMEOUT)
                .build()
                .ok();

            let mut crash_respawns: u32 = 0;
            // C1 (plans/one-workspace-scaling.md): attribute the first-launch
            // wait. Every phase measured on the sidecar side is sub-second
            // (import 0.12 s, migrations 0.017 s, bootstrap 0.024 s,
            // spawn->health 0.38 s in dev, archive extraction 0.19 s), so the
            // seconds a fresh install spends here belong to something these
            // marks will name -- first execution of the freshly extracted
            // binary being the leading suspect. Without them the cost is
            // "somewhere in startup", which is not something to optimise
            // against.
            let t_thread_start = Instant::now();

            // Single spawn for the happy path. We only loop to RESPAWN on a
            // genuine early process exit (real crash / orphan-lock), never on a
            // slow-but-alive boot.
            let (final_pid, t_spawned, t_first_connect): (u32, Instant, Option<Instant>) = 'lifecycle: loop {
                let child = match spawn_sidecar(&app_data_dir, &bundle_resources_dir) {
                    Ok(c) => c,
                    Err(e) => {
                        eprintln!("[sidecar] spawn failed: {e}");
                        let _ = app.emit("sidecar_crashed", ());
                        return;
                    }
                };

                let pid = child.id();
                let t_spawned = Instant::now();
                let mut t_first_connect: Option<Instant> = None;
                *child_arc.lock().unwrap() = Some(child);

                // Poll the REAL /health endpoint until ready, the child exits
                // early (genuine failure), or the generous budget is exhausted
                // (genuinely hung). We do NOT kill a child that is simply still
                // booting.
                let deadline = Instant::now() + STARTUP_BUDGET;
                loop {
                    // Genuine early exit before becoming healthy?
                    let exited = {
                        let mut guard = child_arc.lock().unwrap();
                        match *guard {
                            None => true,
                            Some(ref mut c) => matches!(c.try_wait(), Ok(Some(_))),
                        }
                    };
                    if exited {
                        *child_arc.lock().unwrap() = None;
                        eprintln!("[sidecar] process exited before becoming healthy");
                        if crash_respawns < MAX_REAL_CRASH_RESPAWNS {
                            crash_respawns += 1;
                            eprintln!(
                                "[sidecar] respawn {crash_respawns}/{MAX_REAL_CRASH_RESPAWNS} after {RESPAWN_BACKOFF:?} back-off"
                            );
                            std::thread::sleep(RESPAWN_BACKOFF);
                            reclaim_stale_port(SIDECAR_PORT);
                            continue 'lifecycle;
                        }
                        let _ = app.emit("sidecar_crashed", ());
                        return;
                    }

                    // Split "the process is up" from "it is ready": uvicorn
                    // binds only after lifespan startup finishes (see
                    // `health_ok`), so a connection accepted is the child's own
                    // boot cost, which is the span the 5 s question is about.
                    if t_first_connect.is_none() && port_in_use() {
                        t_first_connect = Some(Instant::now());
                    }

                    if health_client.as_ref().is_some_and(health_ok) {
                        break 'lifecycle (pid, t_spawned, t_first_connect);
                    }

                    if Instant::now() >= deadline {
                        // Alive but never healthy within the budget → hung.
                        eprintln!(
                            "[sidecar] startup budget ({}s) exhausted; sidecar never became healthy",
                            STARTUP_BUDGET.as_secs()
                        );
                        if let Some(ref mut c) = *child_arc.lock().unwrap() {
                            let _ = c.kill();
                        }
                        *child_arc.lock().unwrap() = None;
                        let _ = app.emit("sidecar_crashed", ());
                        return;
                    }

                    std::thread::sleep(POLL_INTERVAL);
                }
            };

            log::info!(
                "[sidecar] startup {}",
                format_startup_marks(t_thread_start, t_spawned, t_first_connect, Instant::now())
            );

            *running_arc.lock().unwrap() = true;
            let _ = app.emit(
                "sidecar_ready",
                SidecarStatus {
                    running: true,
                    version: None,
                    pid: Some(final_pid),
                },
            );

            // Watch for unexpected crash after a successful startup.
            let watch_child = child_arc.clone();
            let watch_running = running_arc.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(CRASH_WATCH_INTERVAL);
                let exited = {
                    let mut guard = watch_child.lock().unwrap();
                    match *guard {
                        None => true,
                        Some(ref mut c) => matches!(c.try_wait(), Ok(Some(_))),
                    }
                };
                if exited {
                    *watch_child.lock().unwrap() = None;
                    *watch_running.lock().unwrap() = false;
                    let _ = app.emit("sidecar_crashed", ());
                    break;
                }
            });
        });
    }

    pub fn status(&self) -> SidecarStatus {
        SidecarStatus {
            running: *self.running.lock().unwrap(),
            version: None,
            pid: self.child.lock().unwrap().as_ref().map(|c| c.id()),
        }
    }

    /// Kill the sidecar. Called on window close, Drop, and signal handlers.
    ///
    /// We SIGTERM the *process group* (the child was spawned via setsid in
    /// its own group) so any helper processes uvicorn forked also die.
    /// After a short grace, we SIGKILL whatever is still alive. The Python
    /// side also self-terminates when our PID disappears (parent-PID
    /// watchdog) — this is the belt-and-suspenders Rust-side path.
    pub fn shutdown(&self) {
        let pid_opt = {
            let mut guard = self.child.lock().unwrap();
            let pid = guard.as_ref().map(|c| c.id());
            if let Some(ref mut c) = *guard {
                // SIGTERM first (graceful), wait briefly, then SIGKILL.
                kill_group_term(c.id());
                let deadline = Instant::now() + STALE_KILL_GRACE;
                loop {
                    if matches!(c.try_wait(), Ok(Some(_))) {
                        break;
                    }
                    if Instant::now() >= deadline {
                        let _ = c.kill(); // SIGKILL the leader
                        kill_group_kill(c.id()); // and the whole group
                        let _ = c.wait();
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
            *guard = None;
            *self.running.lock().unwrap() = false;
            pid
        };

        if let Some(pid) = pid_opt {
            // Best-effort: anything still bound to the port belongs to a
            // grandchild we didn't track. Reclaim aggressively.
            if port_in_use() {
                eprintln!(
                    "[sidecar] port {SIDECAR_PORT} still bound after killing PID {pid}; reclaiming"
                );
                reclaim_stale_port(SIDECAR_PORT);
            }
        }
    }
}

impl Drop for SidecarManager {
    /// Last-line defence against orphaning uvicorn. Tauri usually fires
    /// CloseRequested first and we shut down cleanly there, but if the
    /// shell exits via panic, signal, or a code path that bypasses the
    /// window-event handler, Drop still runs and stops the child.
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Ensure the onedir sidecar is extracted from the bundled archive into a
/// stable per-user cache dir, returning the path to its executable.
///
/// The sidecar ships as a single `sidecar.tar.gz` Tauri resource (one file
/// sidesteps Tauri's resource-glob bundler, which can't copy the onedir's
/// nested Python.framework symlink tree). We extract ONCE per version into
/// `<app_data>/sidecar/` and reuse it on every later launch — unlike a
/// PyInstaller *onefile* binary, which re-extracts its whole payload on EVERY
/// launch (~6 s). A stamp file records the archive's `(len, mtime)` so a new app
/// version (new archive) triggers a clean re-extract.
///
/// Only called from the release branch of `spawn_sidecar`; `#[allow(dead_code)]`
/// keeps it compiling (and clippy-checked) in debug builds, where it's unused.
#[allow(dead_code)]
fn ensure_sidecar_extracted(
    archive: &std::path::Path,
    app_data_dir: &std::path::Path,
) -> std::io::Result<std::path::PathBuf> {
    let dest_root = app_data_dir.join("sidecar");
    let binary = dest_root.join("sidecar");
    let stamp_path = dest_root.join(".archive-stamp");

    // Stamp = archive size + mtime. A new release ships a new archive → new
    // stamp → clean re-extract; an unchanged archive → reuse the extracted dir.
    let meta = std::fs::metadata(archive)?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let stamp = format!("{}:{}", meta.len(), mtime);

    let fresh = binary.exists()
        && std::fs::read_to_string(&stamp_path)
            .map(|s| s.trim() == stamp)
            .unwrap_or(false);
    if fresh {
        return Ok(binary);
    }

    // Stale or missing → clean re-extract. tar preserves the framework symlinks.
    let _ = std::fs::remove_dir_all(&dest_root);
    std::fs::create_dir_all(app_data_dir)?;
    let status = std::process::Command::new("/usr/bin/tar")
        .arg("-xzf")
        .arg(archive)
        .arg("-C")
        .arg(app_data_dir)
        .status()?;
    if !status.success() {
        return Err(std::io::Error::other("tar extraction of sidecar failed"));
    }
    if !binary.exists() {
        return Err(std::io::Error::other(
            "sidecar binary missing after extraction",
        ));
    }
    // Best-effort: guarantee the exec bit and write the stamp last (so a partial
    // extract never leaves a matching stamp).
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(m) = std::fs::metadata(&binary) {
            let mut perm = m.permissions();
            perm.set_mode(0o755);
            let _ = std::fs::set_permissions(&binary, perm);
        }
    }
    let _ = std::fs::write(&stamp_path, stamp);
    Ok(binary)
}

/// Spawn the sidecar process. Dev uses uvicorn; release uses the bundled binary.
///
/// `app_data_dir` and `bundle_resources_dir` are injected as env vars so the
/// Python sidecar's `config.py` can resolve workspace paths without hardcoding.
fn spawn_sidecar(
    app_data_dir: &std::path::Path,
    bundle_resources_dir: &std::path::Path,
) -> std::io::Result<std::process::Child> {
    use std::os::unix::process::CommandExt;
    let parent_pid = std::process::id().to_string();

    // Convert paths to strings once; fail early if they're non-UTF-8.
    let app_data_str = app_data_dir
        .to_str()
        .ok_or_else(|| std::io::Error::other("app_data_dir is not valid UTF-8"))?;
    let bundle_resources_str = bundle_resources_dir
        .to_str()
        .ok_or_else(|| std::io::Error::other("bundle_resources_dir is not valid UTF-8"))?;

    #[cfg(debug_assertions)]
    {
        // Dev: invoke the venv's uvicorn binary directly so the Child handle
        // points at uvicorn itself — killing it via shutdown() actually stops
        // the server instead of orphaning it (bash wrapper would be killed but
        // uvicorn would keep running).
        //
        // On Apple Silicon we route through `/usr/bin/arch -arm64` to force the
        // universal2 python.org interpreter into arm64 mode. Without this the
        // OS can launch python as x86_64 and the dlopen of arm64-only native
        // wheels (pydantic_core, etc.) fails with an architecture mismatch.
        // On x86_64 hosts uvicorn is spawned directly.
        let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("CARGO_MANIFEST_DIR has no parent");
        // Dev defaults to the demo database (data/codenest.demo.db) so day-to-day
        // work never touches the real data. Opt into the real DB with
        // `CODENEST_ENV=prod pnpm tauri:dev`; config.py resolves the path.
        let env = std::env::var("CODENEST_ENV").unwrap_or_else(|_| "demo".to_string());
        let uvicorn = project_root.join(".venv/bin/uvicorn");
        if !uvicorn.exists() {
            return Err(std::io::Error::other(format!(
                "dev venv missing: {} not found — run `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt` from the repo root",
                uvicorn.display()
            )));
        }
        let mut cmd = if cfg!(target_arch = "aarch64") {
            let mut c = std::process::Command::new("/usr/bin/arch");
            c.arg("-arm64").arg(&uvicorn);
            c
        } else {
            std::process::Command::new(&uvicorn)
        };
        cmd.args(["main:app", "--port", "8002"])
            .current_dir(project_root)
            .env("CODENEST_ENV", env)
            .env("CODENEST_PARENT_PID", &parent_pid)
            .env("CODENEST_APP_DATA_DIR", app_data_str)
            .env("CODENEST_BUNDLE_RESOURCES", bundle_resources_str);
        unsafe {
            // setsid puts the child in its own process group so signals
            // delivered via kill(-pid) reach uvicorn *and* any worker it
            // forks. Without this, killing the leader can leave a worker
            // orphaned and still bound to :8002.
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        cmd.spawn()
    }

    #[cfg(not(debug_assertions))]
    {
        // Release: the sidecar ships as a single PyInstaller *onedir* archive at
        // Contents/Resources/sidecar.tar.gz. We extract it ONCE per version into
        // <APP_DATA_DIR>/sidecar/ and spawn from there. onedir loads its
        // libraries directly from that folder, so once extracted, cold start is
        // <1 s — unlike a PyInstaller *onefile* binary, which re-extracts its
        // whole payload on EVERY launch (~6 s). That per-launch extraction,
        // combined with the old 5 s startup timeout, was the direct cause of the
        // ~20 s first launch.
        //
        // current_exe() = <App>.app/Contents/MacOS/<bin>.
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .ok_or_else(|| std::io::Error::other("cannot resolve executable directory"))?;

        let app_data_path = std::path::Path::new(app_data_str);
        // bundle_resources_dir is Contents/Resources/org-agents; its parent is
        // Contents/Resources, where the sidecar archive is bundled.
        let archive = std::path::Path::new(bundle_resources_str)
            .parent()
            .map(|res_dir| res_dir.join("sidecar.tar.gz"));

        let binary = match archive {
            Some(ref a) if a.exists() => match ensure_sidecar_extracted(a, app_data_path) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!(
                        "[sidecar] archive extraction failed: {e}; falling back to MacOS/sidecar"
                    );
                    exe_dir.join("sidecar")
                }
            },
            // Legacy fallback: a single-file binary at Contents/MacOS/sidecar.
            _ => exe_dir.join("sidecar"),
        };

        let mut cmd = std::process::Command::new(binary);
        // Release always serves the real production database.
        cmd.env("CODENEST_ENV", "prod")
            .env("CODENEST_PARENT_PID", &parent_pid)
            .env("CODENEST_APP_DATA_DIR", app_data_str)
            .env("CODENEST_BUNDLE_RESOURCES", bundle_resources_str);
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        cmd.spawn()
    }
}

/// SIGTERM every process in the given child's process group.
///
/// `kill(-pid, SIGTERM)` targets the whole group — the leader plus any
/// children/grandchildren uvicorn spawned. Safe to call even if the group
/// is already gone.
fn kill_group_term(pid: u32) {
    unsafe {
        let signed = pid as i32;
        libc::kill(-signed, libc::SIGTERM);
    }
}

fn kill_group_kill(pid: u32) {
    unsafe {
        let signed = pid as i32;
        libc::kill(-signed, libc::SIGKILL);
    }
}

/// If something else is bound to `port`, find its owner via `lsof -ti` and
/// terminate it (SIGTERM first, SIGKILL after a grace). This is the
/// pre-flight cleanup that lets the next launch always succeed even after
/// a hard parent crash leaked uvicorn.
fn reclaim_stale_port(port: u16) {
    if !port_in_use() {
        return;
    }
    let output = match std::process::Command::new("/usr/sbin/lsof")
        .args(["-ti", &format!("tcp:{port}"), "-sTCP:LISTEN"])
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            eprintln!("[sidecar] reclaim: lsof failed: {e}");
            return;
        }
    };
    let pids: Vec<i32> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<i32>().ok())
        .collect();
    if pids.is_empty() {
        return;
    }
    eprintln!("[sidecar] reclaim: found stale PIDs on :{port} → {pids:?}");
    for pid in &pids {
        unsafe {
            libc::kill(*pid, libc::SIGTERM);
        }
    }
    let deadline = Instant::now() + STALE_KILL_GRACE;
    while Instant::now() < deadline {
        if !port_in_use() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    for pid in &pids {
        unsafe {
            libc::kill(*pid, libc::SIGKILL);
        }
    }
    // Best-effort final check; failure here is logged but non-fatal.
    if port_in_use() {
        eprintln!(
            "[sidecar] reclaim: port :{port} still bound after SIGKILL — the next bind will likely fail"
        );
    }
}

/// One line attributing the startup wait, for C1.
///
/// Three spans, because they fail for different reasons and are fixed in
/// different places:
///
/// * `pre` — this thread's own work before the spawn: stale-port reclamation
///   and, in a packaged build, extracting the sidecar archive.
/// * `boot` — spawn until the port accepts a connection. uvicorn binds only
///   after lifespan startup completes, so this is the child actually coming up:
///   interpreter start, imports, migrations. On a fresh install this is where
///   first-execution verification of a newly extracted, unnotarised binary
///   would land.
/// * `ready` — first connection until `/health` answers 2xx.
///
/// `?` means the mark was never reached, which is itself the finding.
fn format_startup_marks(
    thread_start: Instant,
    spawned: Instant,
    first_connect: Option<Instant>,
    healthy: Instant,
) -> String {
    let ms = |d: Duration| d.as_millis();
    let boot = first_connect.map(|t| ms(t - spawned));
    let ready = first_connect.map(|t| ms(healthy - t));
    let show = |v: Option<u128>| v.map_or_else(|| "?".to_string(), |n| format!("{n}ms"));
    format!(
        "pre={}ms boot={} ready={} total={}ms",
        ms(spawned - thread_start),
        show(boot),
        show(ready),
        ms(healthy - thread_start)
    )
}

/// Return true iff the sidecar answers HTTP GET /health with a 2xx status.
///
/// This is the readiness probe. A bare open socket is not enough: uvicorn
/// opens the listening socket only after lifespan startup (`init_db`)
/// completes, so requiring a 200 means "ready" implies the DB schema is
/// applied and the REST API will answer — the exact contract the onboarding
/// gate depends on.
fn health_ok(client: &reqwest::blocking::Client) -> bool {
    client
        .get(format!("http://127.0.0.1:{SIDECAR_PORT}/health"))
        .send()
        .map(|resp| resp.status().is_success())
        .unwrap_or(false)
}

/// Return true if anything is bound to and accepting connections on the
/// sidecar port. Used for orphan-port reclamation, where we want to detect ANY
/// listener squatting :8002 (not just a healthy sidecar) before we rebind.
fn port_in_use() -> bool {
    use std::net::TcpStream;
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{SIDECAR_PORT}").parse().unwrap(),
        Duration::from_millis(50),
    )
    .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The marks exist to be read by a human comparing a fresh install against a
    /// warm one, so the split has to survive a refactor of the loop that feeds it.
    #[test]
    fn startup_marks_attribute_each_span() {
        let start = Instant::now();
        let spawned = start + Duration::from_millis(200);
        let connected = spawned + Duration::from_millis(4500);
        let healthy = connected + Duration::from_millis(300);

        assert_eq!(
            format_startup_marks(start, spawned, Some(connected), healthy),
            "pre=200ms boot=4500ms ready=300ms total=5000ms"
        );
    }

    /// A sidecar that answered `/health` before any poll observed an open port
    /// (a very fast boot) must still report, with the unreached mark visible
    /// rather than silently folded into another span.
    #[test]
    fn startup_marks_show_an_unreached_mark() {
        let start = Instant::now();
        let spawned = start + Duration::from_millis(50);
        let healthy = spawned + Duration::from_millis(120);

        assert_eq!(
            format_startup_marks(start, spawned, None, healthy),
            "pre=50ms boot=? ready=? total=170ms"
        );
    }
}
