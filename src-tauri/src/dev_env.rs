//! Dev-only environment bootstrap.
//!
//! Two pieces, both inert in a packaged build:
//!
//! 1. [`load_env_local`] reads `<repo root>/.env.local` into this process's
//!    environment before anything resolves a path. That file is gitignored, so
//!    a machine can pin its own dev profile without every clone inheriting it —
//!    a fresh checkout has no `.env.local` and keeps the `demo` default.
//! 2. [`is_work_env`] reports whether that profile is `work`: the persistent dev
//!    workboard, which lives in its own app-data root ([`DEV_APP_DATA_DIR_NAME`])
//!    so it shares neither database nor workspace with the packaged app. Wiping
//!    `com.codenest.dashboard/` to test a clean first run cannot touch it, and
//!    neither can `git clean -xdf`, because nothing of it lives in the repo.
//!
//! Release builds never consult either: `spawn_sidecar` hardcodes
//! `CODENEST_ENV=prod` there, and `is_work_env` is compiled to `false`.

/// App-data directory name for the `work` profile, a sibling of the packaged
/// app's own directory. Mirrored by `DEV_APP_DATA_DIR_NAME` in `app/config.py`
/// — the sidecar derives the database path from it.
pub const DEV_APP_DATA_DIR_NAME: &str = "com.codenest.dev";

/// Load `<repo root>/.env.local` into this process's environment.
///
/// Call once, before any path or sidecar env resolution. Missing or unreadable
/// files are not an error — the file is optional by design. A variable already
/// present in the real environment always wins, so a one-off
/// `CODENEST_ENV=demo pnpm tauri:dev` still overrides the file.
///
/// No-op in release builds.
pub fn load_env_local() {
    #[cfg(debug_assertions)]
    {
        let Some(root) = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent() else {
            return;
        };
        let path = root.join(".env.local");
        let Ok(contents) = std::fs::read_to_string(&path) else {
            return;
        };
        for (key, value) in parse_env_local(&contents) {
            if std::env::var_os(&key).is_some() {
                // Set by the shell that launched us — that is the stronger intent.
                continue;
            }
            eprintln!("[dev-env] {key}={value} (from .env.local)");
            std::env::set_var(&key, &value);
        }
    }
}

/// Is this process running the persistent dev workboard profile?
///
/// Always `false` in release builds, where the profile does not exist.
pub fn is_work_env() -> bool {
    cfg!(debug_assertions)
        && std::env::var("CODENEST_ENV")
            .map(|v| v.trim().eq_ignore_ascii_case("work"))
            .unwrap_or(false)
}

/// Parse `KEY=VALUE` lines, keeping only the `CODENEST_` namespace.
///
/// Blank lines and `#` comments are skipped, a leading `export ` is tolerated,
/// and one layer of matching quotes is stripped from the value. Everything else
/// after the first `=` is the value verbatim — there are no inline comments, so
/// a path containing `#` survives intact.
///
/// Restricting to `CODENEST_*` is the point of parsing this by hand rather than
/// sourcing the file: a stray line in a gitignored file must not be able to
/// rewrite `PATH` or `HOME` for the app and every terminal it spawns.
#[cfg(debug_assertions)]
fn parse_env_local(contents: &str) -> Vec<(String, String)> {
    contents
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (key, value) = line.strip_prefix("export ").unwrap_or(line).split_once('=')?;
            let key = key.trim();
            if !key.starts_with("CODENEST_") {
                return None;
            }
            let value = value.trim();
            let unquoted = value
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
                .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
                .unwrap_or(value);
            Some((key.to_string(), unquoted.to_string()))
        })
        .collect()
}

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::parse_env_local;

    #[test]
    fn keeps_only_the_codenest_namespace() {
        let parsed = parse_env_local("CODENEST_ENV=work\nPATH=/evil\nHOME=/evil\n");
        assert_eq!(parsed, vec![("CODENEST_ENV".into(), "work".into())]);
    }

    #[test]
    fn skips_comments_and_blank_lines() {
        let parsed = parse_env_local("# CODENEST_ENV=demo\n\n   \nCODENEST_ENV=work\n");
        assert_eq!(parsed, vec![("CODENEST_ENV".into(), "work".into())]);
    }

    #[test]
    fn tolerates_export_prefix_whitespace_and_quotes() {
        let parsed = parse_env_local("export  CODENEST_ENV = \"work\" \nCODENEST_DB_PATH='/a/b.db'");
        assert_eq!(
            parsed,
            vec![
                ("CODENEST_ENV".into(), "work".into()),
                ("CODENEST_DB_PATH".into(), "/a/b.db".into()),
            ]
        );
    }

    #[test]
    fn treats_the_whole_remainder_as_the_value() {
        // No inline-comment stripping: a `#` in a path is part of the path, and
        // a value may itself contain `=`.
        let parsed = parse_env_local("CODENEST_DB_PATH=/Users/a/My #1 Dir/db.sqlite?x=1");
        assert_eq!(
            parsed,
            vec![(
                "CODENEST_DB_PATH".into(),
                "/Users/a/My #1 Dir/db.sqlite?x=1".into()
            )]
        );
    }

    #[test]
    fn ignores_lines_without_an_assignment() {
        assert!(parse_env_local("CODENEST_ENV\njust some prose\n").is_empty());
    }
}
