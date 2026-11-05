//! `vimfps uninstall`: removes the running executable (and, on Windows,
//! the folder and user PATH entry the install script made). The CLI keeps
//! no other files: the fetched web client lives in memory only.

use std::path::Path;

#[derive(clap::Args)]
pub struct UninstallArgs {
    /// 確認なしで削除する
    #[arg(short, long)]
    pub yes: bool,
}

pub fn run(args: &UninstallArgs) -> i32 {
    match uninstall(args) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("error: {e}");
            1
        }
    }
}

fn uninstall(args: &UninstallArgs) -> Result<(), String> {
    let exe = std::env::current_exe()
        .and_then(|p| p.canonicalize())
        .map_err(|e| format!("実行ファイルの場所がわかりません: {e}"))?;
    let dir = exe
        .parent()
        .ok_or("実行ファイルのフォルダがわかりません")?
        .to_path_buf();
    let (exe_s, dir_s) = (plain(&exe), plain(&dir));
    // The PATH entry and the folder go only when the folder holds nothing
    // but vimfps (the install script's own folder), never a shared one.
    let own_dir = cfg!(windows) && only_contains(&dir, &exe);
    println!("削除するもの:");
    println!("  {exe_s}");
    if own_dir {
        println!("  {dir_s} (フォルダと、ユーザーの PATH の登録)");
    }
    if !args.yes && !crate::update::confirm("vim-fps をアンインストールしますか? [y/N] ")
    {
        println!("中止しました");
        return Ok(());
    }
    println!();

    let mut flow = crate::flow::Flow::new();
    let mut notes: Vec<String> = Vec::new();

    #[cfg(windows)]
    if own_dir {
        let r = flow.step(&format!("Removing {dir_s} from PATH"), || {
            remove_from_user_path(&dir_s).map(|removed| (!removed).then_some("not on PATH"))
        });
        if r.is_err() {
            notes.push(format!(
                "「環境変数」の設定で、ユーザーの Path から {dir_s} を外してください。"
            ));
        }
    }

    // Windows cannot delete a running exe: self_replace moves it out of
    // `dir` and deletes it once this process exits. On Unix it is unlinked
    // right away.
    flow.step(&format!("Deleting {exe_s}"), || {
        let r = if cfg!(windows) {
            self_replace::self_delete_outside_path(&dir)
        } else {
            self_replace::self_delete()
        };
        r.map(|()| None).map_err(|e| {
            if e.kind() == std::io::ErrorKind::PermissionDenied {
                format!("{e} (権限がありません。管理者として実行するか、手動で削除してください)")
            } else {
                e.to_string()
            }
        })
    })?;

    if own_dir {
        // remove_dir only removes an empty folder.
        let _ = flow.step(&format!("Deleting {dir_s}"), || {
            std::fs::remove_dir(&dir)
                .map(|()| None)
                .map_err(|e| e.to_string())
        });
    }

    flow.finish("Thank you for using vim-fps!");

    if cfg!(windows) && own_dir {
        notes.push("PATH の変更は、新しく開いたターミナルから反映されます。".into());
    }
    if cfg!(unix) {
        notes.push(format!(
            "シェルの設定ファイル (~/.bashrc / ~/.zshrc など) に {dir_s} を PATH に足す行を書いた場合は、ほかに使っていなければ消してください。"
        ));
    }
    notes.push(
        "ゲームの設定 (:set など) はブラウザのサイトデータに残っています。消すにはブラウザの設定で igarinpiano.github.io (または遊んだホストのアドレス) のデータを削除してください。".into(),
    );
    println!();
    for n in notes {
        println!("{n}");
    }
    Ok(())
}

/// A path as people write it (without Windows' `\\?\` prefix).
fn plain(p: &Path) -> String {
    let s = p.display().to_string();
    s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
}

/// Whether `exe` is the only entry of `dir`.
fn only_contains(dir: &Path, exe: &Path) -> bool {
    let Ok(it) = std::fs::read_dir(dir) else {
        return false;
    };
    let names: Vec<_> = it.filter_map(|e| e.ok()).map(|e| e.file_name()).collect();
    names.len() == 1 && Some(names[0].as_os_str()) == exe.file_name()
}

/// `path` (a `;`-separated PATH) without `dir`; None when it isn't there.
/// Windows paths: compared ignoring case and a trailing `\`.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn strip_path_entry(path: &str, dir: &str) -> Option<String> {
    let norm = |s: &str| s.trim().trim_end_matches(['\\', '/']).to_lowercase();
    let want = norm(dir);
    let parts: Vec<&str> = path.split(';').filter(|p| !p.trim().is_empty()).collect();
    let kept: Vec<&str> = parts.iter().copied().filter(|p| norm(p) != want).collect();
    (kept.len() != parts.len()).then(|| kept.join(";"))
}

/// Takes `dir` off the user PATH. Ok(false) when it was not on it.
#[cfg(windows)]
fn remove_from_user_path(dir: &str) -> Result<bool, String> {
    use std::process::Command;
    let ps = |script: &str, value: Option<&str>| {
        let mut c = Command::new("powershell");
        c.args(["-NoProfile", "-NonInteractive", "-Command", script]);
        if let Some(v) = value {
            c.env("VIMFPS_NEW_PATH", v);
        }
        match c.output() {
            Ok(o) if o.status.success() => {
                Ok(String::from_utf8_lossy(&o.stdout).trim().to_string())
            }
            Ok(o) => Err(String::from_utf8_lossy(&o.stderr).trim().to_string()),
            Err(e) => Err(format!("powershell: {e}")),
        }
    };
    let current = ps("[Environment]::GetEnvironmentVariable('Path','User')", None)?;
    let Some(next) = strip_path_entry(&current, dir) else {
        return Ok(false);
    };
    ps(
        "[Environment]::SetEnvironmentVariable('Path',$env:VIMFPS_NEW_PATH,'User')",
        Some(&next),
    )?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::strip_path_entry;
    use crate::flow::flow_line;

    #[test]
    fn flow_lines() {
        assert_eq!(flow_line("Deleting x", &Ok(None)), "● Deleting x... done");
        assert_eq!(
            flow_line("Removing d from PATH", &Ok(Some("not on PATH"))),
            "● Removing d from PATH... skipped (not on PATH)"
        );
        assert_eq!(
            flow_line("Deleting x", &Err("denied".into())),
            "× Deleting x... failed: denied"
        );
    }

    #[test]
    fn path_entry() {
        let d = r"C:\Users\a\AppData\Local\Programs\vimfps";
        assert_eq!(
            strip_path_entry(
                r"C:\Windows;C:\Users\a\AppData\Local\Programs\VimFPS\;C:\bin",
                d
            )
            .as_deref(),
            Some(r"C:\Windows;C:\bin")
        );
        assert_eq!(
            strip_path_entry(&format!("{d};;C:\\x"), d).as_deref(),
            Some(r"C:\x")
        );
        assert_eq!(strip_path_entry(d, d).as_deref(), Some(""));
        assert_eq!(strip_path_entry(r"C:\Windows;C:\bin", d), None);
        // A folder that merely starts with the same name stays.
        assert_eq!(strip_path_entry(&format!("{d}2"), d), None);
    }
}
