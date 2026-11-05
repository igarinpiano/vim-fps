//! macOS: before hosting, checks that other machines on the LAN can reach
//! this one. Two things can stop them:
//!
//! - the application firewall blocking incoming connections to vimfps (an
//!   ad hoc signed binary is not allowed automatically), and
//! - local network privacy (macOS 15 and later): the terminal app vimfps runs
//!   in (iTerm, VS Code, ...; Terminal.app itself is exempt) may not be
//!   allowed to reach the local network.
//!
//! When either is found, the commands that allow it are shown and, after a
//! y/N, run with sudo.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::net::Ipv4Addr;

pub const SOCKETFILTERFW: &str = "/usr/libexec/ApplicationFirewall/socketfilterfw";
/// Exceptions to local network privacy (macOS 15.5 and later, TN3179).
pub const LN_DOMAIN: &str = "com.apple.network.local-network";
pub const LN_KEYS: [&str; 2] = [
    "AllowedWiFiLocalNetworkAddresses",
    "AllowedEthernetLocalNetworkAddresses",
];

/// `socketfilterfw --getglobalstate`: "Firewall is enabled. (State = 1)".
pub fn firewall_enabled(out: &str) -> bool {
    let o = out.to_lowercase();
    if let Some(i) = o.find("state =") {
        let n: String = o[i + 7..]
            .trim_start()
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        if let Ok(n) = n.parse::<u32>() {
            return n >= 1;
        }
    }
    o.contains("enabled") && !o.contains("disabled")
}

/// `socketfilterfw --getblockall`: "Block all ENABLED!" / "... DISABLED!".
pub fn block_all(out: &str) -> bool {
    let o = out.to_lowercase();
    o.contains("enabled") && !o.contains("disabled")
}

/// `socketfilterfw --getappblocked PATH`: Some(true) = allowed,
/// Some(false) = blocked or not listed, None = unknown output.
pub fn app_permitted(out: &str) -> Option<bool> {
    let o = out.to_lowercase();
    if o.contains("permitted") || o.contains("allowed") {
        Some(true)
    } else if o.contains("blocked") || o.contains("not part of") {
        Some(false)
    } else {
        None
    }
}

/// `route -n get default` → (gateway, interface).
pub fn route_default(out: &str) -> Option<(Ipv4Addr, String)> {
    let field = |name: &str| {
        out.lines().find_map(|l| {
            let (k, v) = l.split_once(':')?;
            (k.trim() == name).then(|| v.trim().to_string())
        })
    };
    let gw = field("gateway")?.parse().ok()?;
    Some((gw, field("interface")?))
}

/// `ipconfig getoption IF subnet_mask`: "255.255.255.0" (or "0xffffff00").
pub fn parse_mask(out: &str) -> Option<Ipv4Addr> {
    let s = out.trim();
    if let Some(h) = s.strip_prefix("0x") {
        return u32::from_str_radix(h, 16).ok().map(Ipv4Addr::from);
    }
    let m: Ipv4Addr = s.parse().ok()?;
    // A real netmask: ones, then zeros.
    let bits = u32::from(m);
    (bits.leading_ones() + bits.trailing_zeros() == 32).then_some(m)
}

/// "192.168.1.0/24" for 192.168.1.23 & 255.255.255.0.
pub fn cidr(ip: Ipv4Addr, mask: Ipv4Addr) -> String {
    let m = u32::from(mask);
    format!("{}/{}", Ipv4Addr::from(u32::from(ip) & m), m.count_ones())
}

/// The argv as one would type it in a shell.
pub fn shell_line(argv: &[String]) -> String {
    argv.iter()
        .map(|a| {
            if !a.is_empty()
                && a.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_./:=@%+,".contains(c))
            {
                a.clone()
            } else {
                format!("'{}'", a.replace('\'', r"'\''"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(target_os = "macos")]
pub use mac::check;

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use crate::flow::Flow;
    use std::net::{IpAddr, UdpSocket};
    use std::path::Path;
    use std::process::Command;
    use std::time::Duration;

    enum Kind {
        /// Add and unblock this executable in the firewall.
        App(String),
        /// Turn off "Block all incoming connections".
        BlockAll,
        /// Allow this subnet despite local network privacy.
        Lan { cidr: String, gw: Ipv4Addr },
    }

    struct Fix {
        kind: Kind,
        /// What was found (shown before asking).
        why: String,
        /// Shown in the flow.
        label: String,
        /// Run with `sudo`.
        cmds: Vec<Vec<String>>,
    }

    fn out(cmd: &str, args: &[&str]) -> Option<String> {
        let o = Command::new(cmd).args(args).output().ok()?;
        o.status
            .success()
            .then(|| String::from_utf8_lossy(&o.stdout).into_owned())
    }

    fn argv(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn firewall(exe: &Path, fixes: &mut Vec<Fix>) {
        let Some(state) = out(SOCKETFILTERFW, &["--getglobalstate"]) else {
            return;
        };
        if !firewall_enabled(&state) {
            return;
        }
        if out(SOCKETFILTERFW, &["--getblockall"]).is_some_and(|o| block_all(&o)) {
            fixes.push(Fix {
                kind: Kind::BlockAll,
                why: "ファイアウォールが「外部からの接続をすべてブロック」になっています".into(),
                label: "Turning off \"Block all incoming connections\"".into(),
                cmds: vec![argv(&[SOCKETFILTERFW, "--setblockall", "off"])],
            });
        }
        let Some(e) = exe.to_str() else { return };
        let listed = out(SOCKETFILTERFW, &["--getappblocked", e]);
        if listed.as_deref().and_then(app_permitted) == Some(false) {
            fixes.push(Fix {
                kind: Kind::App(e.to_string()),
                why: "ファイアウォールが vimfps への接続を許可していません".into(),
                label: "Allowing vimfps through the firewall".into(),
                cmds: vec![
                    argv(&[SOCKETFILTERFW, "--add", e]),
                    argv(&[SOCKETFILTERFW, "--unblockapp", e]),
                ],
            });
        }
    }

    /// The default gateway (when it is on a private LAN) and this subnet.
    fn lan() -> Option<(Ipv4Addr, String)> {
        let (gw, iface) = route_default(&out("/sbin/route", &["-n", "get", "default"])?)?;
        if !gw.is_private() {
            return None;
        }
        let IpAddr::V4(ip) = crate::server::lan_ip()? else {
            return None;
        };
        let mask = parse_mask(&out(
            "/usr/sbin/ipconfig",
            &["getoption", &iface, "subnet_mask"],
        )?)?;
        Some((gw, cidr(ip, mask)))
    }

    /// Whether local network privacy stops packets to the gateway: the
    /// send fails with "No route to host" (or EPERM) instead of leaving.
    fn lan_blocked(gw: Ipv4Addr) -> bool {
        let Ok(s) = UdpSocket::bind("0.0.0.0:0") else {
            return false;
        };
        for _ in 0..2 {
            match s.send_to(&[0], (gw, 9)) {
                Err(e) => return matches!(e.raw_os_error(), Some(65) | Some(1)),
                Ok(_) => std::thread::sleep(Duration::from_millis(80)),
            }
        }
        false
    }

    fn terminal_name() -> String {
        match std::env::var("TERM_PROGRAM").as_deref() {
            Ok("Apple_Terminal") => "ターミナル".into(),
            Ok("iTerm.app") => "iTerm".into(),
            Ok("vscode") => "Visual Studio Code".into(),
            Ok(t) if !t.is_empty() => t.to_string(),
            _ => "使っているターミナルのアプリ".into(),
        }
    }

    fn sudo(cmd: &[String]) -> Result<(), String> {
        let o = Command::new("sudo")
            .arg("-n")
            .args(cmd)
            .output()
            .map_err(|e| format!("sudo: {e}"))?;
        if o.status.success() {
            Ok(())
        } else {
            let err = String::from_utf8_lossy(&o.stderr);
            Err(err.lines().next().unwrap_or("error").trim().to_string())
        }
    }

    fn apply(f: &Fix) -> Result<Option<&'static str>, String> {
        match &f.kind {
            Kind::Lan { cidr, .. } => {
                // `-array-add` appends; skip keys that already have it.
                let mut added = false;
                for (key, cmd) in LN_KEYS.iter().zip(&f.cmds) {
                    let have = Command::new("sudo")
                        .args(["-n", "defaults", "read", LN_DOMAIN, key])
                        .output()
                        .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains(cidr.as_str()));
                    if !have {
                        sudo(cmd)?;
                        added = true;
                    }
                }
                Ok((!added).then_some("already allowed"))
            }
            Kind::App(e) => {
                for c in &f.cmds {
                    sudo(c)?;
                }
                let now = out(SOCKETFILTERFW, &["--getappblocked", e]);
                match now.as_deref().and_then(app_permitted) {
                    Some(false) => Err("still blocked".into()),
                    _ => Ok(None),
                }
            }
            Kind::BlockAll => {
                for c in &f.cmds {
                    sudo(c)?;
                }
                Ok(None)
            }
        }
    }

    pub fn check() {
        use std::io::IsTerminal;
        let mut fixes = Vec::new();
        if let Ok(exe) = std::env::current_exe().and_then(|p| p.canonicalize()) {
            firewall(&exe, &mut fixes);
        }
        let lan = lan();
        let term = terminal_name();
        if let Some((gw, cidr)) = &lan
            && lan_blocked(*gw)
        {
            fixes.push(Fix {
                kind: Kind::Lan {
                    cidr: cidr.clone(),
                    gw: *gw,
                },
                why: format!(
                    "macOS のローカルネットワークの制限で、{term} からローカルネットワーク ({cidr}) に届きません"
                ),
                label: format!("Allowing the local network {cidr}"),
                cmds: LN_KEYS
                    .iter()
                    .map(|k| argv(&["defaults", "write", LN_DOMAIN, k, "-array-add", cidr]))
                    .collect(),
            });
        }
        if fixes.is_empty() {
            return;
        }

        println!("ほかの端末からこのサーバーに接続できない可能性があります:");
        for f in &fixes {
            println!("  - {}", f.why);
        }
        println!("次のコマンドで許可できます (管理者のパスワードを聞かれます):");
        for f in &fixes {
            for c in &f.cmds {
                println!("  sudo {}", shell_line(c));
            }
        }
        if fixes.iter().any(|f| matches!(f.kind, Kind::Lan { .. })) {
            println!(
                "  (ローカルネットワークは「システム設定 > プライバシーとセキュリティ > ローカルネットワーク」で {term} をオンにしても許可できます。この場合は {term} を開き直してください)"
            );
        }
        if !std::io::stdin().is_terminal() {
            println!("上のコマンドを実行してから、もう一度起動してください。このまま起動します。");
            println!();
            return;
        }
        if !crate::update::confirm("今すぐ実行しますか? [y/N] ") {
            println!(
                "実行しませんでした。このまま起動します (`--no-network-check` でこの確認を省けます)"
            );
            println!();
            return;
        }
        // Ask for the password once, before the steps draw their lines.
        if !Command::new("sudo")
            .arg("-v")
            .status()
            .is_ok_and(|s| s.success())
        {
            println!("sudo できなかったので、実行しませんでした。このまま起動します");
            println!();
            return;
        }
        println!();
        let mut flow = Flow::new();
        let mut lan_still_blocked = false;
        for f in &fixes {
            let _ = flow.step(&f.label, || apply(f));
            if let Kind::Lan { gw, .. } = f.kind {
                lan_still_blocked = lan_blocked(gw);
            }
        }
        flow.finish("Ready to host!");
        if lan_still_blocked {
            println!(
                "ローカルネットワークの制限がまだ残っています。{term} を開き直すか、「システム設定 > プライバシーとセキュリティ > ローカルネットワーク」で {term} をオンにしてください。"
            );
        }
        println!();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn firewall_outputs() {
        assert!(firewall_enabled("Firewall is enabled. (State = 1)"));
        assert!(firewall_enabled("Firewall is enabled. (State = 2)"));
        assert!(!firewall_enabled("Firewall is disabled. (State = 0)"));
        assert!(block_all("Block all ENABLED!"));
        assert!(block_all("Firewall has block all state set to enabled."));
        assert!(!block_all("Block all DISABLED!"));
        assert_eq!(
            app_permitted("The application /Users/a/.local/bin/vimfps is permitted"),
            Some(true)
        );
        assert_eq!(app_permitted("The application is blocked"), Some(false));
        assert_eq!(
            app_permitted("The application is not part of the firewall"),
            Some(false)
        );
        assert_eq!(app_permitted("??"), None);
    }

    #[test]
    fn route_and_subnet() {
        let r = "   route to: default\ndestination: default\n       mask: default\n    gateway: 192.168.1.1\n  interface: en0\n      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING>\n";
        assert_eq!(
            route_default(r),
            Some((Ipv4Addr::new(192, 168, 1, 1), "en0".into()))
        );
        assert_eq!(route_default("gateway: fe80::1\ninterface: en0"), None);
        let m = parse_mask("255.255.255.0\n").unwrap();
        assert_eq!(cidr(Ipv4Addr::new(192, 168, 1, 23), m), "192.168.1.0/24");
        let m = parse_mask("0xfffff000").unwrap();
        assert_eq!(cidr(Ipv4Addr::new(10, 0, 18, 5), m), "10.0.16.0/20");
        assert_eq!(parse_mask("255.0.255.0"), None);
    }

    #[test]
    fn shell_lines() {
        let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            shell_line(&v(&[
                "defaults",
                "write",
                LN_DOMAIN,
                LN_KEYS[0],
                "-array-add",
                "192.168.1.0/24"
            ])),
            "defaults write com.apple.network.local-network AllowedWiFiLocalNetworkAddresses -array-add 192.168.1.0/24"
        );
        assert_eq!(
            shell_line(&v(&[SOCKETFILTERFW, "--add", "/Users/a b/vimfps"])),
            "/usr/libexec/ApplicationFirewall/socketfilterfw --add '/Users/a b/vimfps'"
        );
    }
}
