use std::process::Command;

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileTextResult {
    pub contents: String,
    pub truncated: bool,
    pub size_bytes: u64,
}

fn require_home_scope(path: &str) -> Result<(), String> {
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
