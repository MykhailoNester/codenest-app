//! Live self-test probe for the onboarding hook-verification step.
//!
//! Process spawning belongs in the Rust shell per the architectural boundary
//! rules — the sidecar must never exec subprocesses (see `commands/git.rs`'s
//! module docstring). This module runs the SAME `curl` invocation a pasted
//! Claude Code hook would run, against a sidecar-minted, single-use token
//! endpoint, so a real inbound POST from a shell-spawned `curl` is observed
//! end to end — not just that the webview can reach the sidecar. A `fetch()`
//! from the frontend would prove only the latter, and would pass even with
//! `curl` missing from PATH, which is exactly the failure this probe exists
//! to catch.
//!
//! Two deliberate divergences from the real hook command, both required for
//! the probe to be able to report anything back to the UI:
//! 1. The trailing `>/dev/null 2>&1 || true` is dropped — those clauses exist
//!    only to discard the result and force exit 0 so a hook never blocks
//!    Claude Code; keeping them here would defeat the whole probe.
//! 2. `-S` is added next to `-s` — `-s` alone silences curl's error text,
//!    which would leave `stderr` empty in exactly the failure case the user
//!    needs explained; `-sS` keeps the progress meter off but restores it.
//!    `-o /dev/null -w '%{http_code}'` keeps stdout to just the status code.
//!
//! Every other aspect — binary, method, header, body-on-stdin, timeout, URL —
//! is identical to what Claude Code will run.

use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Instant;

/// Body piped to curl's stdin. Shaped like a minimal Claude Code hook payload
/// so the round-trip exercises the same `--data-binary @-` path the real hook
/// uses, even though the self-test ingest endpoint ignores the body entirely.
const PROBE_BODY: &str = r#"{"hook_event_name":"CodenestSelfTest"}"#;

const MIN_MAX_TIME_SECONDS: u64 = 1;
const MAX_MAX_TIME_SECONDS: u64 = 30;
const DEFAULT_MAX_TIME_SECONDS: u64 = 5;

/// `stderr` is surfaced to the user for diagnosis, not logged in bulk — cap it
/// so a pathological curl build can't hand back an unbounded string.
const STDERR_TRUNCATE_CHARS: usize = 500;

#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HookProbeArgs {
    pub url: String,
    pub max_time_seconds: Option<u64>,
}

#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HookProbeResult {
    pub http_status: Option<u16>,
    pub exit_code: Option<i32>,
    pub curl_missing: bool,
    pub duration_ms: u64,
    pub stderr: String,
}

/// Reject anything that is not a loopback URL pointing at the sidecar's own
/// self-test endpoint. This is the only thing standing between a Tauri
/// command and an arbitrary-URL `curl` primitive, so it must fail closed.
fn validate_probe_url(url: &str) -> Result<(), String> {
    if url.len() > 512 {
        return Err(format!("probe url is too long ({} bytes)", url.len()));
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("probe url contains whitespace or control characters".to_string());
    }
    if !(url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:")) {
        return Err(format!("refusing non-loopback probe url: {url}"));
    }
    if !url.contains("/api/v1/workspace/hooks/self-test/") {
        return Err("probe url must target the sidecar self-test endpoint".to_string());
    }
    Ok(())
}

/// The exact curl argv (unquoted values, no shell) — see the module docstring
/// for the two divergences from the real hook command.
fn probe_args(url: &str, max_time: u64) -> Vec<String> {
    vec![
        "-s".into(),
        "-S".into(),
        "--max-time".into(),
        max_time.to_string(),
        "-X".into(),
        "POST".into(),
        "-H".into(),
        "Content-Type: application/json".into(),
        "--data-binary".into(),
        "@-".into(),
        "-o".into(),
        "/dev/null".into(),
        "-w".into(),
        "%{http_code}".into(),
        url.to_string(),
    ]
}

/// `curl -w %{http_code}` writes `000` when no HTTP response was received at
/// all (DNS failure, connection refused, timeout). Map that — and any
/// unparsable or empty stdout — to `None` so the caller's "unreachable"
/// branch fires instead of reporting HTTP status 0.
fn parse_http_status(stdout: &str) -> Option<u16> {
    match stdout.trim().parse::<u16>() {
        Ok(0) | Err(_) => None,
        Ok(status) => Some(status),
    }
}

/// Build the "something went wrong before we got a real curl exit status"
/// probe result — shared by the spawn-failure and wait-failure branches
/// below. `Err(String)` out of this command is reserved for a rejected probe
/// URL (see `validate_probe_url`); neither a spawn failure that isn't "curl
/// is missing" nor a failure waiting on the child is that, so both resolve
/// to `Ok(HookProbeResult)` here — with `http_status: None`, matching the
/// shape `curl -w %{http_code}` itself produces on `000` — so the frontend's
/// `classifyLiveProbe` reports "unreachable" with the real cause in
/// `stderr`, instead of the generic, unrelated "check
/// CODENEST_SIDECAR_URL" message a command `Err` renders as.
fn probe_io_failure(started: Instant, message: String) -> HookProbeResult {
    HookProbeResult {
        http_status: None,
        exit_code: None,
        curl_missing: false,
        duration_ms: started.elapsed().as_millis() as u64,
        stderr: message,
    }
}

fn run_probe_blocking(url: String, max_time: u64) -> Result<HookProbeResult, String> {
    let started = Instant::now();

    let child = Command::new("curl")
        .args(probe_args(&url, max_time))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let mut child = match child {
        Ok(child) => child,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(HookProbeResult {
                http_status: None,
                exit_code: None,
                curl_missing: true,
                duration_ms: started.elapsed().as_millis() as u64,
                stderr: String::new(),
            });
        }
        Err(e) => {
            return Ok(probe_io_failure(started, format!("failed to spawn curl: {e}")));
        }
    };

    if let Some(mut stdin) = child.stdin.take() {
        // Best-effort: curl's own `--max-time` bounds the wait regardless of
        // whether this write succeeds. A broken pipe here just means curl
        // exited (e.g. connection refused) before it read stdin.
        let _ = stdin.write_all(PROBE_BODY.as_bytes());
    }

    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(e) => {
            return Ok(probe_io_failure(started, format!("curl did not complete: {e}")));
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if stderr.len() > STDERR_TRUNCATE_CHARS {
        stderr.truncate(STDERR_TRUNCATE_CHARS);
    }

    Ok(HookProbeResult {
        http_status: parse_http_status(&stdout),
        exit_code: output.status.code(),
        curl_missing: false,
        duration_ms: started.elapsed().as_millis() as u64,
        stderr,
    })
}

/// Run the same `curl` a pasted Claude Code hook would run, against the
/// sidecar-minted self-test URL, and report what actually happened.
#[tauri::command]
pub async fn run_hook_probe(args: HookProbeArgs) -> Result<HookProbeResult, String> {
    validate_probe_url(&args.url)?;
    let max_time = args
        .max_time_seconds
        .unwrap_or(DEFAULT_MAX_TIME_SECONDS)
        .clamp(MIN_MAX_TIME_SECONDS, MAX_MAX_TIME_SECONDS);
    let url = args.url;

    // A sync `#[tauri::command]` would block the main thread for up to
    // `max_time` seconds (precedent: `commands/screenshot.rs`'s
    // `capture_screenshot_blocking`).
    tauri::async_runtime::spawn_blocking(move || run_probe_blocking(url, max_time))
        .await
        .map_err(|e| format!("probe task panicked: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_probe_url_accepts_loopback() {
        assert!(
            validate_probe_url("http://127.0.0.1:8002/api/v1/workspace/hooks/self-test/abc123")
                .is_ok()
        );
        assert!(
            validate_probe_url("http://localhost:8002/api/v1/workspace/hooks/self-test/abc123")
                .is_ok()
        );
    }

    #[test]
    fn validate_probe_url_rejects_remote_host() {
        let result =
            validate_probe_url("http://evil.example.com/api/v1/workspace/hooks/self-test/abc123");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("non-loopback"));
    }

    #[test]
    fn validate_probe_url_rejects_non_selftest_path() {
        let result = validate_probe_url("http://127.0.0.1:8002/api/v1/hooks/session-start");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("self-test"));
    }

    #[test]
    fn validate_probe_url_rejects_whitespace_and_control_chars() {
        assert!(validate_probe_url(
            "http://127.0.0.1:8002/api/v1/workspace/hooks/self-test/abc 123"
        )
        .is_err());
        assert!(validate_probe_url(
            "http://127.0.0.1:8002/api/v1/workspace/hooks/self-test/abc\n123"
        )
        .is_err());
    }

    #[test]
    fn probe_args_mirror_the_hook_flags() {
        let args = probe_args("http://127.0.0.1:8002/x", 5);
        let expected: Vec<String> = vec![
            "-s",
            "-S",
            "--max-time",
            "5",
            "-X",
            "POST",
            "-H",
            "Content-Type: application/json",
            "--data-binary",
            "@-",
            "-o",
            "/dev/null",
            "-w",
            "%{http_code}",
            "http://127.0.0.1:8002/x",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        assert_eq!(args, expected);
    }

    #[test]
    fn parse_http_status_maps_zero_and_garbage_to_none() {
        assert_eq!(parse_http_status("200"), Some(200));
        assert_eq!(parse_http_status("000"), None);
        assert_eq!(parse_http_status(""), None);
        assert_eq!(parse_http_status("abc"), None);
    }

    // Contract E: `Err(String)` out of `run_hook_probe` is reserved for a
    // rejected probe URL. A spawn failure that isn't "curl is missing", and
    // a failure waiting on the child, both go through `probe_io_failure`
    // instead of `Err`, so they still resolve to `classifyLiveProbe`'s
    // "unreachable" verdict on the frontend rather than the unrelated,
    // hardcoded probe-rejected message.
    #[test]
    fn probe_io_failure_reports_unreachable_not_curl_missing() {
        let result = probe_io_failure(Instant::now(), "curl did not complete: boom".into());
        assert_eq!(result.http_status, None);
        assert_eq!(result.exit_code, None);
        assert!(!result.curl_missing);
        assert_eq!(result.stderr, "curl did not complete: boom");
    }
}
