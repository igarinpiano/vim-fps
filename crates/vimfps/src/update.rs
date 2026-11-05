//! Self-update from GitHub Releases. The release workflow uploads
//! `vimfps-<version>-<target>.tar.gz` (or `.zip` on Windows) and
//! `SHA256SUMS`; this downloads the archive for the target the running
//! binary was built for, checks its SHA-256, and replaces the executable.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::time::Duration;

pub const REPO: &str = "igarinpiano/vim-fps";
pub const TARGET: &str = env!("VIMFPS_TARGET");
const BIN: &str = if cfg!(windows) {
    "vimfps.exe"
} else {
    "vimfps"
};

#[derive(clap::Args)]
pub struct UpdateArgs {
    /// 確認だけして更新しない
    #[arg(long)]
    pub check: bool,
    /// 確認なしで更新する
    #[arg(short, long)]
    pub yes: bool,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    html_url: String,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

/// (major, minor, patch) of "v1.2.3" / "1.2.3"; pre-release suffixes ignored.
pub fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let v = v.trim().trim_start_matches('v');
    let core = v.split(['-', '+']).next()?;
    let mut it = core.split('.').map(|x| x.parse::<u64>().ok());
    Some((it.next()??, it.next()??, it.next().flatten().unwrap_or(0)))
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(l), Some(c)) => l > c,
        _ => false,
    }
}

pub fn agent(timeout: u64) -> ureq::Agent {
    use ureq::tls::{PemItem, RootCerts, TlsConfig};
    // Built-in (webpki) roots, or the PEM bundle in SSL_CERT_FILE (for
    // networks behind an inspecting proxy).
    let mut tls = TlsConfig::builder();
    if let Some(path) = std::env::var_os("SSL_CERT_FILE")
        && let Ok(pem) = std::fs::read(path)
    {
        let certs: Vec<_> = ureq::tls::parse_pem(&pem)
            .filter_map(|i| match i {
                Ok(PemItem::Certificate(c)) => Some(c),
                _ => None,
            })
            .collect();
        if !certs.is_empty() {
            tls = tls.root_certs(RootCerts::new_with_certs(&certs));
        }
    }
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(timeout)))
        .tls_config(tls.build())
        .build()
        .into()
}

fn latest_release(timeout: u64) -> Result<Release, String> {
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    agent(timeout)
        .get(&url)
        .header(
            "User-Agent",
            concat!("vimfps-updater/", env!("CARGO_PKG_VERSION")),
        )
        .header("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| format!("リリース情報を取得できません: {e}"))?
        .body_mut()
        .read_json::<Release>()
        .map_err(|e| format!("リリース情報を読めません: {e}"))
}

fn download(url: &str) -> Result<Vec<u8>, String> {
    agent(300)
        .get(url)
        .header(
            "User-Agent",
            concat!("vimfps-updater/", env!("CARGO_PKG_VERSION")),
        )
        .call()
        .map_err(|e| format!("ダウンロードできません ({url}): {e}"))?
        .body_mut()
        .with_config()
        .limit(256 * 1024 * 1024)
        .read_to_vec()
        .map_err(|e| format!("ダウンロードに失敗しました: {e}"))
}

/// Printed by `vimfps host` at start-up (quietly does nothing on failure).
pub fn notify_if_newer() {
    if let Ok(r) = latest_release(4)
        && is_newer(&r.tag_name, env!("CARGO_PKG_VERSION"))
    {
        println!(
            "  新しいバージョン {} があります。`vimfps update` で更新できます",
            r.tag_name
        );
    }
}

pub fn run(args: &UpdateArgs) -> i32 {
    match update(args) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("error: {e}");
            1
        }
    }
}

fn update(args: &UpdateArgs) -> Result<(), String> {
    let current = env!("CARGO_PKG_VERSION");
    println!("現在のバージョン: v{current} ({TARGET})");
    let rel = latest_release(15)?;
    println!("最新のバージョン: {}", rel.tag_name);
    if !is_newer(&rel.tag_name, current) {
        println!("最新です");
        return Ok(());
    }
    if args.check {
        println!(
            "更新するには `vimfps update` を実行してください ({})",
            rel.html_url
        );
        return Ok(());
    }
    let version = rel.tag_name.trim_start_matches('v');
    let stem = format!("vimfps-{version}-{TARGET}");
    let asset = rel
        .assets
        .iter()
        .find(|a| a.name == format!("{stem}.tar.gz") || a.name == format!("{stem}.zip"))
        .ok_or_else(|| {
            format!(
                "このプラットフォーム ({TARGET}) 向けのファイルがリリースにありません: {}",
                rel.html_url
            )
        })?;
    if !args.yes
        && !confirm(&format!(
            "v{current} → {} に更新しますか? [y/N] ",
            rel.tag_name
        ))
    {
        println!("中止しました");
        return Ok(());
    }
    println!("ダウンロード中: {}", asset.name);
    let archive = download(&asset.browser_download_url)?;

    let sums = rel
        .assets
        .iter()
        .find(|a| a.name == "SHA256SUMS")
        .ok_or("リリースに SHA256SUMS がありません")?;
    let sums = String::from_utf8(download(&sums.browser_download_url)?)
        .map_err(|_| "SHA256SUMS が読めません")?;
    let want = expected_sum(&sums, &asset.name).ok_or("SHA256SUMS にこのファイルがありません")?;
    let got = hex(&Sha256::digest(&archive));
    if !want.eq_ignore_ascii_case(&got) {
        return Err(format!("SHA-256 が一致しません (期待 {want}, 実際 {got})"));
    }
    println!("SHA-256 を確認しました");

    let bin = if asset.name.ends_with(".zip") {
        extract_zip(&archive)?
    } else {
        extract_tar_gz(&archive)?
    };
    let tmp = std::env::temp_dir().join(format!("vimfps-update-{}", std::process::id()));
    {
        let mut f =
            std::fs::File::create(&tmp).map_err(|e| format!("一時ファイルを作れません: {e}"))?;
        f.write_all(&bin)
            .map_err(|e| format!("一時ファイルに書けません: {e}"))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
    }
    let r = self_replace::self_replace(&tmp)
        .map_err(|e| format!("実行ファイルを置き換えられません: {e}"));
    let _ = std::fs::remove_file(&tmp);
    r?;
    println!("{} に更新しました", rel.tag_name);
    Ok(())
}

pub fn confirm(prompt: &str) -> bool {
    print!("{prompt}");
    let _ = std::io::stdout().flush();
    let mut s = String::new();
    std::io::stdin().read_line(&mut s).is_ok() && matches!(s.trim(), "y" | "Y" | "yes")
}

pub fn expected_sum(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|l| {
        let mut it = l.split_whitespace();
        let sum = it.next()?;
        let file = it.next()?.trim_start_matches('*');
        (file == name).then(|| sum.to_string())
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn extract_tar_gz(data: &[u8]) -> Result<Vec<u8>, String> {
    let gz = flate2::read::GzDecoder::new(data);
    let mut ar = tar::Archive::new(gz);
    for entry in ar.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path().map_err(|e| e.to_string())?.into_owned();
        if path.file_name().and_then(|n| n.to_str()) == Some(BIN) {
            let mut v = Vec::new();
            entry.read_to_end(&mut v).map_err(|e| e.to_string())?;
            return Ok(v);
        }
    }
    Err(format!("アーカイブに {BIN} がありません"))
}

fn extract_zip(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(data)).map_err(|e| e.to_string())?;
    for i in 0..z.len() {
        let mut f = z.by_index(i).map_err(|e| e.to_string())?;
        // Only a regular file named like the binary (any folder) is taken.
        let full = f.name().map_err(|e| e.to_string())?.into_owned();
        let name = full.rsplit(['/', '\\']).next().unwrap_or("");
        if f.is_file() && name == BIN {
            let mut v = Vec::new();
            f.read_to_end(&mut v).map_err(|e| e.to_string())?;
            return Ok(v);
        }
    }
    Err(format!("アーカイブに {BIN} がありません"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert!(is_newer("v1.0.1", "1.0.0"));
        assert!(is_newer("v2.0.0", "1.9.9"));
        assert!(!is_newer("v1.0.0", "1.0.0"));
        assert!(!is_newer("v0.9.0", "1.0.0"));
        assert!(!is_newer("garbage", "1.0.0"));
        assert_eq!(parse_version("v1.2.3-rc.1"), Some((1, 2, 3)));
    }

    #[test]
    fn sums() {
        let s = "abc123  vimfps-1.0.0-x86_64-unknown-linux-gnu.tar.gz\ndef456  vimfps-1.0.0-x86_64-pc-windows-msvc.zip\n";
        assert_eq!(
            expected_sum(s, "vimfps-1.0.0-x86_64-pc-windows-msvc.zip").as_deref(),
            Some("def456")
        );
        assert_eq!(expected_sum(s, "nope"), None);
    }

    #[test]
    fn zip_round_trip() {
        use zip::write::SimpleFileOptions;
        let body = b"MZ fake exe";
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        w.add_directory("vimfps-1.0.0-x/", SimpleFileOptions::default())
            .unwrap();
        w.start_file(
            format!("vimfps-1.0.0-x/{BIN}"),
            SimpleFileOptions::default(),
        )
        .unwrap();
        w.write_all(body).unwrap();
        w.start_file("vimfps-1.0.0-x/README.md", SimpleFileOptions::default())
            .unwrap();
        w.write_all(b"readme").unwrap();
        let data = w.finish().unwrap().into_inner();
        assert_eq!(extract_zip(&data).unwrap(), body);
        assert!(extract_zip(b"not a zip").is_err());
    }

    #[test]
    fn tar_round_trip() {
        let mut builder = tar::Builder::new(Vec::new());
        let body = b"#!/bin/sh\necho hi\n";
        let mut h = tar::Header::new_gnu();
        h.set_size(body.len() as u64);
        h.set_mode(0o755);
        h.set_cksum();
        builder
            .append_data(&mut h, format!("vimfps-1.0.0-x/{BIN}"), &body[..])
            .unwrap();
        let tar = builder.into_inner().unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(&tar).unwrap();
        let data = gz.finish().unwrap();
        assert_eq!(extract_tar_gz(&data).unwrap(), body);
    }
}
