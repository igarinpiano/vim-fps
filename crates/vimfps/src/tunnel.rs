//! Cloudflare Quick Tunnel: runs `cloudflared tunnel --url ...` as a child
//! process and prints the trycloudflare.com URL it gets (with a QR code).

use qrcode::QrCode;
use qrcode::render::unicode;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

/// The URL in a line of cloudflared's log, if any.
pub fn find_url(line: &str) -> Option<&str> {
    let start = line.find("https://")?;
    let rest = &line[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '|' || c == '"')
        .unwrap_or(rest.len());
    let url = &rest[..end];
    url.ends_with(".trycloudflare.com").then_some(url)
}

/// Starts the tunnel. The child is killed when the returned value is
/// dropped (i.e. when the host exits).
pub async fn start(port: u16, fragment: String) -> Option<Child> {
    let spawned = Command::new("cloudflared")
        .args([
            "tunnel",
            "--no-autoupdate",
            "--url",
            &format!("http://127.0.0.1:{port}"),
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                eprintln!("  トンネル: cloudflared が見つかりません。インストールしてください:");
                eprintln!(
                    "    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
                );
            } else {
                eprintln!("  トンネル: cloudflared を起動できません: {e}");
            }
            eprintln!("  (LAN ではこのまま遊べます)");
            return None;
        }
    };
    println!("  トンネル: 起動中…");
    let stderr = child.stderr.take()?;
    let (url_tx, url_rx) = tokio::sync::oneshot::channel::<String>();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut url_tx = Some(url_tx);
        let mut log = Vec::new();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(url) = find_url(&line) {
                if let Some(tx) = url_tx.take() {
                    let _ = tx.send(url.to_string());
                }
            } else if url_tx.is_some() {
                log.push(line);
                if log.len() > 40 {
                    log.remove(0);
                }
            }
        }
        if url_tx.is_some() {
            eprintln!("  トンネル: cloudflared が URL を出さずに終了しました。最後のログ:");
            for l in log.iter().rev().take(8).rev() {
                eprintln!("    {l}");
            }
            eprintln!("  (~/.cloudflared/config.yml があると Quick Tunnel は起動しません)");
        }
    });
    match tokio::time::timeout(std::time::Duration::from_secs(30), url_rx).await {
        Ok(Ok(url)) => {
            let full = format!("{url}/{fragment}");
            println!("  インターネット: {full}");
            if let Ok(code) = QrCode::new(full.as_bytes()) {
                let qr = code.render::<unicode::Dense1x2>().quiet_zone(true).build();
                println!("{qr}");
            }
            println!("  (Quick Tunnel の URL は起動のたびに変わります)");
        }
        _ => eprintln!("  トンネル: URL を取得できませんでした"),
    }
    Some(child)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_url() {
        let line = "2026-11-04T07:00:00Z INF |  https://fancy-words-here.trycloudflare.com                            |";
        assert_eq!(
            find_url(line),
            Some("https://fancy-words-here.trycloudflare.com")
        );
        assert_eq!(
            find_url("INF see https://www.cloudflare.com/website-terms/"),
            None
        );
    }
}
