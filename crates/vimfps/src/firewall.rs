//! macOS application firewall: before the host listens, checks whether
//! other machines can reach it, and offers (y/N) to allow it.
//!
//! - The state is read from `socketfilterfw`, which answers these three
//!   questions without administrator rights: `--getglobalstate`,
//!   `--getappblocked <this executable>` and `--listapps`.
//! - A program with no rule is answered "permitted" by `--getappblocked`, yet
//!   nothing reaches it until the user allows it in the system's dialog:
//!   that is the third state, [`State::Asked`].
//! - Nothing is changed without asking: only on "y" are the two commands run,
//!   through `sudo` (which asks for the password itself). Without a terminal
//!   nothing is asked; the way to allow it is only shown.
//! - The firewall is never worked around (for example by relaying through a
//!   signed program): it is the user's to set.

pub const SOCKETFILTERFW: &str = "/usr/libexec/ApplicationFirewall/socketfilterfw";

/// What the firewall does with incoming connections to this program.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    /// They reach it (or the firewall is off).
    Open,
    /// They are turned away.
    Blocked,
    /// No rule yet: they wait for the user to allow them in a dialog.
    Asked,
}

/// Reads the three answers of `socketfilterfw` about `program` (its real
/// path). None when an answer cannot be read.
pub fn judge(global: &str, blocked: &str, list: &str, program: &str) -> Option<State> {
    let global = global.to_lowercase();
    let i = global.find("state =")?;
    let n: String = global[i + 7..]
        .trim_start()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    match n.parse::<u32>().ok()? {
        0 => return Some(State::Open),
        1 => {}
        2 => return Some(State::Blocked),
        _ => return None,
    }
    if blocked.to_lowercase().contains("is blocked") {
        return Some(State::Blocked);
    }
    // `--listapps`: "1 :  /path/to/program" and then, on the next line,
    // "(Allow incoming connections)" or "(Block incoming connections)".
    let lines: Vec<&str> = list.lines().collect();
    for (i, l) in lines.iter().enumerate() {
        let entry = match l.split_once(':') {
            Some((n, p))
                if !n.trim().is_empty() && n.trim().chars().all(|c| c.is_ascii_digit()) =>
            {
                p.trim()
            }
            _ => l.trim(),
        };
        if entry == program {
            let rule = lines[i + 1..]
                .iter()
                .map(|l| l.trim())
                .find(|l| !l.is_empty());
            return Some(match rule {
                Some(r) if r.trim_start_matches('(').starts_with("Allow") => State::Open,
                _ => State::Blocked,
            });
        }
    }
    Some(State::Asked)
}

/// The firewall's state for this executable, and its real path. None off
/// macOS, without `socketfilterfw`, or when its answers cannot be read.
pub fn incoming() -> Option<(State, String)> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    // (Behind a symbolic link, the rule is the real file's.)
    let program = std::env::current_exe()
        .and_then(|p| p.canonicalize())
        .ok()?
        .to_str()?
        .to_string();
    let ask = |args: &[&str]| -> Option<String> {
        let o = std::process::Command::new(SOCKETFILTERFW)
            .args(args)
            .output()
            .ok()?;
        o.status
            .success()
            .then(|| String::from_utf8_lossy(&o.stdout).into_owned())
    };
    let global = ask(&["--getglobalstate"])?;
    let blocked = ask(&["--getappblocked", &program])?;
    let list = ask(&["--listapps"])?;
    Some((judge(&global, &blocked, &list, &program)?, program))
}

/// The two commands that allow `program` (add a rule, or turn it to allow).
pub fn commands(program: &str) -> [Vec<String>; 2] {
    let c = |flag: &str| vec![SOCKETFILTERFW.to_string(), flag.into(), program.into()];
    [c("--add"), c("--unblockapp")]
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

fn how_to(program: &str) {
    eprintln!(
        "許可するには「システム設定 → ネットワーク → ファイアウォール → オプション…」で vimfps を「外部からの接続を許可」にするか、次のコマンドを実行してください:"
    );
    for c in commands(program) {
        eprintln!("  sudo {}", shell_line(&c));
    }
}

/// Unless the firewall lets connections in, says so and, at a terminal,
/// asks whether to allow them (default no). Returns the state afterwards.
/// Hosting goes on whatever the answer.
pub fn settle(state: State, program: &str) -> State {
    use std::io::{IsTerminal, Write};
    match state {
        State::Open => return state,
        State::Blocked => {
            eprintln!(
                "macOS のファイアウォールが vimfps への接続を遮断しています。ほかの端末からは接続できません。"
            )
        }
        State::Asked => eprintln!(
            "macOS のファイアウォールに vimfps の規則がありません。ほかの端末からの接続は、表示されるダイアログで許可するまで届きません。"
        ),
    }
    if !(std::io::stdin().is_terminal() && std::io::stderr().is_terminal()) {
        how_to(program);
        return state;
    }
    eprint!(
        "今すぐ許可しますか? vimfps のファイアウォールの規則を変更します。管理者のパスワードが必要です (sudo) [y/N] "
    );
    let _ = std::io::stderr().flush();
    let mut answer = String::new();
    let yes = std::io::stdin().read_line(&mut answer).is_ok()
        && matches!(answer.trim().to_lowercase().as_str(), "y" | "yes");
    if !yes {
        how_to(program);
        return state;
    }
    // sudo asks for the password itself; this program never sees it.
    for c in commands(program) {
        let ok = std::process::Command::new("sudo")
            .args(&c)
            .status()
            .is_ok_and(|s| s.success());
        if !ok {
            break;
        }
    }
    let now = incoming().map_or(state, |(s, _)| s);
    if now == State::Open {
        eprintln!("許可しました。");
    } else {
        eprintln!("許可できませんでした。");
        how_to(program);
    }
    now
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: &str = "/Users/a/.local/bin/vimfps";
    const ON: &str = "Firewall is enabled. (State = 1)";
    const PERMITTED: &str = "The application /Users/a/.local/bin/vimfps is permitted";

    fn list(entries: &[(&str, bool)]) -> String {
        let mut s = format!("ALF: total number of apps = {} \n\n", entries.len());
        for (i, (p, allow)) in entries.iter().enumerate() {
            s += &format!(
                "{} :  {p} \n \t ({} incoming connections) \n\n",
                i + 1,
                if *allow { "Allow" } else { "Block" }
            );
        }
        s
    }

    #[test]
    fn the_firewalls_answers_are_read() {
        let none = list(&[]);
        // Off, or everything turned away.
        assert_eq!(
            judge("Firewall is disabled. (State = 0)", "", "", ME),
            Some(State::Open)
        );
        assert_eq!(
            judge(
                "Firewall is blocking all non-essential incoming connections. (State = 2)",
                PERMITTED,
                &none,
                ME
            ),
            Some(State::Blocked)
        );
        // A rule of its own.
        assert_eq!(
            judge(ON, "The application is blocked", &none, ME),
            Some(State::Blocked)
        );
        assert_eq!(
            judge(
                ON,
                PERMITTED,
                &list(&[("/Applications/X.app", true), (ME, true)]),
                ME
            ),
            Some(State::Open)
        );
        assert_eq!(
            judge(ON, PERMITTED, &list(&[(ME, false)]), ME),
            Some(State::Blocked)
        );
        // No rule: "permitted", yet it waits for the dialog.
        assert_eq!(judge(ON, PERMITTED, &none, ME), Some(State::Asked));
        // Only the exact path counts, not one it begins.
        let other = format!("{ME}-old");
        assert_eq!(
            judge(ON, PERMITTED, &list(&[(&other, true)]), ME),
            Some(State::Asked)
        );
        assert_eq!(
            judge(ON, PERMITTED, &list(&[(ME, false), (&other, true)]), ME),
            Some(State::Blocked)
        );
        // Unreadable answers: no judgement.
        assert_eq!(judge("??", PERMITTED, &none, ME), None);
        assert_eq!(
            judge("Firewall is enabled. (State = 7)", PERMITTED, &none, ME),
            None
        );
    }

    #[test]
    fn commands_are_shown_as_typed() {
        let [add, unblock] = commands("/Users/a b/vimfps");
        assert_eq!(
            shell_line(&add),
            "/usr/libexec/ApplicationFirewall/socketfilterfw --add '/Users/a b/vimfps'"
        );
        assert_eq!(
            shell_line(&unblock),
            "/usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp '/Users/a b/vimfps'"
        );
    }
}
