//! Which web client the host serves. By default the latest one published on
//! GitHub Pages is downloaded at start-up (and checked again every few
//! minutes), so players always get the newest HTML/JS even with an older
//! CLI. The copy embedded in the binary is the fallback: offline, a
//! different protocol, or `--web embedded`.

use rust_embed::RustEmbed;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;

pub const DEFAULT_WEB: &str = "https://igarinpiano.github.io/vim-fps/";
const MAX_FILE: u64 = 32 * 1024 * 1024;
const MAX_FILES: usize = 200;

#[derive(RustEmbed)]
#[folder = "../../web/"]
struct Embedded;

pub struct Files {
    files: HashMap<String, Vec<u8>>,
    embedded: bool,
    /// "GitHub Pages v1.1.0" / "埋め込み v1.1.0"
    pub label: String,
}

impl Files {
    pub fn embedded() -> Files {
        Files {
            files: HashMap::new(),
            embedded: true,
            label: format!("埋め込み v{}", vimfps_core::VERSION),
        }
    }

    pub fn get(&self, path: &str) -> Option<Vec<u8>> {
        if self.embedded {
            Embedded::get(path).map(|f| f.data.into_owned())
        } else {
            self.files.get(path).cloned()
        }
    }
}

pub type Shared = Arc<RwLock<Arc<Files>>>;

#[derive(Deserialize)]
struct Manifest {
    version: String,
    protocol: u32,
    files: Vec<String>,
}

/// Only plain relative paths ("js/main.js"): nothing that could climb out.
pub fn safe_path(p: &str) -> bool {
    !p.is_empty()
        && p.len() < 200
        && !p.starts_with('/')
        && !p.split('/').any(|s| s.is_empty() || s == "." || s == "..")
        && p.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-/".contains(c))
}

fn join(base: &str, path: &str) -> String {
    if base.ends_with('/') {
        format!("{base}{path}")
    } else {
        format!("{base}/{path}")
    }
}

/// Downloads the client listed in `<base>/manifest.json`.
pub fn fetch(base: &str) -> Result<Files, String> {
    let agent = crate::update::agent(20);
    let get = |url: &str| -> Result<Vec<u8>, String> {
        agent
            .get(url)
            .header("User-Agent", concat!("vimfps/", env!("CARGO_PKG_VERSION")))
            .header("Cache-Control", "no-cache")
            .call()
            .map_err(|e| format!("{url}: {e}"))?
            .body_mut()
            .with_config()
            .limit(MAX_FILE)
            .read_to_vec()
            .map_err(|e| format!("{url}: {e}"))
    };
    let manifest: Manifest = serde_json::from_slice(&get(&join(base, "manifest.json"))?)
        .map_err(|e| format!("manifest.json を読めません: {e}"))?;
    if manifest.protocol != vimfps_core::PROTOCOL {
        return Err(format!(
            "公開版 v{} はプロトコル {} (この CLI は {})。`vimfps update` で CLI を更新してください",
            manifest.version,
            manifest.protocol,
            vimfps_core::PROTOCOL
        ));
    }
    if manifest.files.len() > MAX_FILES || !manifest.files.iter().any(|f| f == "index.html") {
        return Err("manifest.json の内容が正しくありません".into());
    }
    let mut files = HashMap::new();
    for f in &manifest.files {
        if !safe_path(f) {
            return Err(format!("manifest.json に不正なパスがあります: {f}"));
        }
        files.insert(f.clone(), get(&join(base, f))?);
    }
    Ok(Files {
        files,
        embedded: false,
        label: format!("{} v{}", base.trim_end_matches('/'), manifest.version),
    })
}

/// The client to start with: `source` is a URL, or "embedded".
pub fn initial(source: &str) -> Files {
    if source == "embedded" {
        return Files::embedded();
    }
    match fetch(source) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("  Web クライアント: 最新版を取得できません ({e})。埋め込み版を使います");
            Files::embedded()
        }
    }
}

/// Re-downloads every few minutes; swaps in a newer client when it appears.
pub fn spawn_refresh(source: String, shared: Shared) {
    if source == "embedded" {
        return;
    }
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(600));
        tick.tick().await;
        loop {
            tick.tick().await;
            let src = source.clone();
            if let Ok(Ok(files)) = tokio::task::spawn_blocking(move || fetch(&src)).await {
                let old = shared.read().map(|f| f.label.clone()).unwrap_or_default();
                if old != files.label {
                    println!("  Web クライアントを更新しました: {}", files.label);
                }
                if let Ok(mut w) = shared.write() {
                    *w = Arc::new(files);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_client_present() {
        let f = Files::embedded();
        assert!(f.get("index.html").is_some());
        assert!(f.get("js/main.js").is_some());
    }

    #[test]
    fn paths() {
        assert!(safe_path("js/main.js"));
        assert!(safe_path("pkg/vimfps.wasm"));
        assert!(!safe_path("../etc/passwd"));
        assert!(!safe_path("/abs"));
        assert!(!safe_path("a//b"));
        assert!(!safe_path("a b"));
        assert_eq!(join("https://x/y/", "a"), "https://x/y/a");
        assert_eq!(join("https://x/y", "a"), "https://x/y/a");
    }
}
