use std::process::Command;

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileTextResult {
    pub contents: String,
    pub truncated: bool,
    pub size_bytes: u64,
}

pub(crate) fn require_home_scope(path: &str) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    if !path.starts_with(&home) {
        return Err(format!("path is outside $HOME; refusing: {path}"));
    }
    let denied = [
        "Library/Keychains",
        "Library/Preferences/com.apple.security",
        ".ssh",
        ".gnupg",
        ".aws/credentials",
    ];
    for segment in denied {
        if path.contains(segment) {
            return Err(format!(
                "path is in a sensitive directory; refusing: {path}"
            ));
        }
    }
    Ok(())
}

/// Web/mail URLs are handed to the OS handler as-is; anything else is treated
/// as a filesystem path and must pass `require_home_scope`.
fn is_external_url(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")
}

#[tauri::command]
pub fn open_path(path: String, app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !is_external_url(&path) {
        require_home_scope(&path)?;
    }
    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Hand a web or mail URL to the OS default handler — the user's browser.
///
/// Separate from [`open_path`] because the opener plugin draws the same
/// distinction, and conflating them is fragile: `open_path` is the
/// filesystem-shaped entry point (its free-function form stats the argument and
/// fails outright when it does not exist), while `open_url` is the one that
/// exists for this. A markdown link in an agent reply has nothing to do with the
/// filesystem, so it goes through the URL door.
///
/// A schemeless target is treated as `https://`. A markdown link written as
/// `[wttr.in/Lviv](wttr.in/Lviv)` is a web link by intent, and sending it to a
/// path opener could only ever fail.
///
/// Anything that is not http/https/mailto after that is refused rather than
/// guessed at: this input comes from model output, and `file://` or a custom
/// scheme reaching the OS handler is not something a rendered reply should be
/// able to do.
#[tauri::command]
pub fn open_external_url(url: String, app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let target = normalize_external_url(&url)?;
    app.opener()
        .open_url(&target, None::<&str>)
        .map_err(|e| e.to_string())
}

fn normalize_external_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("empty url".to_string());
    }
    if is_external_url(trimmed) {
        return Ok(trimmed.to_string());
    }
    // No scheme at all → assume https. A scheme we do not allow is refused.
    if trimmed.contains("://") || trimmed.split_once(':').is_some_and(|(s, _)| !s.contains('/')) {
        return Err(format!("refusing to open non-web url: {trimmed}"));
    }
    Ok(format!("https://{trimmed}"))
}

#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    require_home_scope(&path)?;
    Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn open_in_editor(path: String, editor: String, app: tauri::AppHandle) -> Result<(), String> {
    require_home_scope(&path)?;
    match editor.as_str() {
        "cursor" => spawn_editor("cursor", &path),
        "vscode" => spawn_editor("code", &path),
        "zed" => spawn_editor("zed", &path),
        "system" => {
            use tauri_plugin_opener::OpenerExt;
            app.opener()
                .open_path(&path, None::<&str>)
                .map_err(|e| e.to_string())
        }
        other => Err(format!("unsupported editor: {other}")),
    }
}

fn spawn_editor(binary: &str, path: &str) -> Result<(), String> {
    Command::new(binary).arg(path).spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("{binary} not found on PATH")
        } else {
            format!("{binary} failed to launch: {e}")
        }
    })?;
    Ok(())
}

#[tauri::command]
pub fn read_file_text(path: String, max_bytes: u64) -> Result<ReadFileTextResult, String> {
    require_home_scope(&path)?;

    const BINARY_EXTS: &[&str] = &[
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".zip", ".tar", ".gz", ".dmg", ".app",
        ".dylib", ".so", ".a", ".o", ".bin", ".exe",
    ];
    let path_lower = path.to_lowercase();
    for ext in BINARY_EXTS {
        if path_lower.ends_with(ext) {
            return Err("binary file type; open in external viewer".to_string());
        }
    }

    use std::io::Read;
    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    let size_bytes = metadata.len();

    if size_bytes == 0 {
        return Ok(ReadFileTextResult {
            contents: String::new(),
            truncated: false,
            size_bytes: 0,
        });
    }

    let read_len = (max_bytes as usize).min(size_bytes as usize);
    let mut buf = vec![0u8; read_len];
    let n = file.read(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(n);

    let truncated = size_bytes > max_bytes;
    let contents = String::from_utf8_lossy(&buf).into_owned();

    Ok(ReadFileTextResult {
        contents,
        truncated,
        size_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_require_home_scope_allows_home_path() {
        let home = std::env::var("HOME").unwrap();
        let path = format!("{home}/Documents/test.md");
        assert!(require_home_scope(&path).is_ok());
    }

    #[test]
    fn test_require_home_scope_rejects_etc() {
        let result = require_home_scope("/etc/passwd");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("outside $HOME"));
    }

    #[test]
    fn test_require_home_scope_rejects_ssh() {
        let home = std::env::var("HOME").unwrap();
        let path = format!("{home}/.ssh/id_rsa");
        let result = require_home_scope(&path);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("sensitive directory"));
    }

    #[test]
    fn test_read_file_text_truncates_at_max_bytes() {
        use std::io::Write;
        let home = std::env::var("HOME").unwrap();
        let path = std::path::PathBuf::from(&home)
            .join(format!(".codenest_test_{}.md", std::process::id()));
        {
            let mut f = std::fs::File::create(&path).unwrap();
            f.write_all(b"0123456789").unwrap();
        }
        let result = read_file_text(path.to_str().unwrap().to_string(), 5).unwrap();
        let _ = std::fs::remove_file(&path);
        assert!(result.truncated);
        assert_eq!(result.contents.len(), 5);
        assert_eq!(result.size_bytes, 10);
    }

    #[test]
    fn test_open_path_url_classification() {
        assert!(is_external_url("https://example.com"));
        assert!(is_external_url("http://localhost:3000/x"));
        assert!(is_external_url("HTTPS://Example.com"));
        assert!(is_external_url("mailto:user@example.com"));
        assert!(!is_external_url("/Users/foo/bar.md"));
        assert!(!is_external_url("relative/path"));
        assert!(!is_external_url("file:///Users/foo/bar.md"));
    }

    #[test]
    fn test_read_file_text_refuses_binary_extension() {
        let home = std::env::var("HOME").unwrap();
        let path = format!("{home}/fake_image.png");
        let result = read_file_text(path, 1_048_576);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("binary file type"));
    }
}

#[cfg(test)]
mod url_tests {
    use super::normalize_external_url;

    #[test]
    fn web_and_mail_urls_pass_through_unchanged() {
        for url in [
            "https://wttr.in/Lviv",
            "http://localhost:3000/x",
            "mailto:someone@example.com",
        ] {
            assert_eq!(normalize_external_url(url).unwrap(), url);
        }
    }

    #[test]
    fn a_schemeless_link_is_assumed_to_be_https() {
        // `[wttr.in/Lviv](wttr.in/Lviv)` is a web link by intent; a path opener
        // could only ever fail on it.
        assert_eq!(
            normalize_external_url("wttr.in/Lviv").unwrap(),
            "https://wttr.in/Lviv"
        );
    }

    #[test]
    fn surrounding_whitespace_is_trimmed() {
        assert_eq!(
            normalize_external_url("  https://example.com  ").unwrap(),
            "https://example.com"
        );
    }

    #[test]
    fn other_schemes_are_refused_rather_than_guessed_at() {
        // This input is model output. A `file://` or custom scheme reaching the
        // OS handler is not something a rendered reply should be able to do.
        for url in ["file:///etc/passwd", "javascript:alert(1)", "ftp://x/y"] {
            assert!(
                normalize_external_url(url).is_err(),
                "{url} must be refused"
            );
        }
    }

    #[test]
    fn an_empty_url_is_an_error_not_a_bare_https() {
        assert!(normalize_external_url("   ").is_err());
    }
}
