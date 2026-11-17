//! `.vimfpsrc`: the one settings file of vim-fps, written like Vim's vimrc.
//! The browser reads its `set` / `skin` / `custom` lines; the host reads the
//! `host` lines, which are the options of `vimfps host` without the `--`:
//!
//! ```vim
//! " ~/.vimfpsrc
//! set adssens=30
//! host bots=5 bot-skill=4 time-limit=15
//! host tunnel password=合言葉 skin=./my-skin
//! ```
//!
//! Found at `--config PATH`, else `~/.vimfpsrc` (or `~/_vimfpsrc`, as Vim's
//! `_vimrc` on Windows). The options it gives come before the ones on the
//! command line, so the command line wins. Same syntax as web/js/rc.js.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// `host` keys that take a value.
const VALUE_KEYS: &[&str] = &[
    "port",
    "bind",
    "password",
    "bots",
    "bot-skill",
    "max-players",
    "time-limit",
    "frag-limit",
    "seed",
    "name",
    "web",
    "skin",
];
/// `host` keys that are switches (`tunnel`, or `tunnel=on` / `tunnel=off`).
const FLAG_KEYS: &[&str] = &[
    "tunnel",
    "no-respawn",
    "no-ring",
    "no-tanks",
    "no-update-check",
    "no-network-check",
];
/// What the browser reads (the host leaves these lines alone).
const BROWSER_CMDS: &[&str] = &["set", "se", "skin", "custom"];

/// Splits a line into words: `\` takes the next character literally (so
/// `name=a\ b` is one word); `"` at the start of a word starts a comment.
pub fn tokenize(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut has = false;
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some(n) => {
                    cur.push(n);
                    has = true;
                }
                None => {
                    cur.push('\\');
                    has = true;
                }
            }
        } else if c == '"' && !has {
            break;
        } else if c.is_whitespace() {
            if has {
                out.push(std::mem::take(&mut cur));
            }
            has = false;
        } else {
            cur.push(c);
            has = true;
        }
    }
    if has {
        out.push(cur);
    }
    out
}

/// What the `host` lines of a file say.
#[derive(Debug, Default, PartialEq)]
pub struct HostLines {
    /// As command-line arguments: `--bots 5 --tunnel ...`.
    pub args: Vec<String>,
    /// "3: ..." (line numbers): lines left out.
    pub warnings: Vec<String>,
    /// How many `host` settings were taken.
    pub count: usize,
}

/// Reads the `host` lines. `base`: the file's folder (a relative `skin=`
/// path is from there).
pub fn host_lines(text: &str, base: &Path) -> HostLines {
    let mut out = HostLines::default();
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    for (i, raw) in text.lines().enumerate() {
        let n = i + 1;
        let line = raw.trim().trim_start_matches(':').trim_start();
        let words = tokenize(line);
        let Some((cmd, rest)) = words.split_first() else {
            continue;
        };
        if BROWSER_CMDS.contains(&cmd.as_str()) {
            continue;
        }
        if cmd != "host" {
            out.warnings
                .push(format!("{n}: 知らないコマンドです (飛ばします): {cmd}"));
            continue;
        }
        for word in rest {
            let (key, value) = match word.split_once('=') {
                Some((k, v)) => (k.replace('_', "-"), Some(v.to_string())),
                None => (word.replace('_', "-"), None),
            };
            let key = key.trim_start_matches("--").to_string();
            if FLAG_KEYS.contains(&key.as_str()) {
                let on = match value.as_deref().map(str::to_ascii_lowercase).as_deref() {
                    None | Some("on" | "yes" | "true" | "1") => true,
                    Some("off" | "no" | "false" | "0") => false,
                    Some(v) => {
                        out.warnings
                            .push(format!("{n}: {key}={v}: on か off で書いてください"));
                        continue;
                    }
                };
                if on {
                    out.args.push(format!("--{key}"));
                }
                out.count += 1;
            } else if VALUE_KEYS.contains(&key.as_str()) {
                let Some(mut v) = value else {
                    out.warnings
                        .push(format!("{n}: {key} には値が要ります ({key}=...)"));
                    continue;
                };
                if key == "skin" {
                    v = resolve(&v, base).to_string_lossy().into_owned();
                }
                out.args.push(format!("--{key}"));
                out.args.push(v);
                out.count += 1;
            } else {
                out.warnings.push(format!(
                    "{n}: host に {key} という項目はありません (飛ばします)"
                ));
            }
        }
    }
    out
}

/// `~/x` and paths relative to `base`.
fn resolve(p: &str, base: &Path) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\"))
        && let Some(home) = home()
    {
        return home.join(rest);
    }
    let p = p.strip_prefix("./").unwrap_or(p);
    let path = Path::new(p);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    }
}

pub fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").filter(|h| !h.is_empty()))
        .map(PathBuf::from)
}

/// Where the file is looked for when no `--config` is given.
pub fn default_paths() -> Vec<PathBuf> {
    home()
        .map(|h| vec![h.join(".vimfpsrc"), h.join("_vimfpsrc")])
        .unwrap_or_default()
}

/// The file in use: `--config PATH` (must exist), else the first default
/// that exists, else none.
pub fn find(explicit: Option<&Path>) -> Result<Option<PathBuf>, String> {
    if let Some(p) = explicit {
        return if p.is_file() {
            Ok(Some(p.to_path_buf()))
        } else {
            Err(format!("設定ファイルがありません: {}", p.display()))
        };
    }
    Ok(default_paths().into_iter().find(|p| p.is_file()))
}

pub struct Loaded {
    pub path: PathBuf,
    pub host: HostLines,
}

pub fn load(explicit: Option<&Path>) -> Result<Option<Loaded>, String> {
    let Some(path) = find(explicit)? else {
        return Ok(None);
    };
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("{} を読めません: {e}", path.display()))?;
    let base = path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let host = host_lines(&text, &base);
    Ok(Some(Loaded { path, host }))
}

/// The value of `--config` on a command line (`--config X` / `--config=X`),
/// and whether `--no-config` is there.
fn config_flag(args: &[OsString]) -> (Option<PathBuf>, bool) {
    let mut path = None;
    let mut off = false;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let Some(s) = a.to_str() else { continue };
        if s == "--" {
            break;
        } else if s == "--no-config" {
            off = true;
        } else if s == "--config" {
            path = it.next().map(PathBuf::from);
        } else if let Some(v) = s.strip_prefix("--config=") {
            path = Some(PathBuf::from(v));
        }
    }
    (path, off)
}

/// The command line with the file's `host` options put in front of the
/// user's (so the user's win): `vimfps host --bots 9` with `host bots=5
/// tunnel` in the file → `vimfps host --bots 5 --tunnel --bots 9`. With no
/// subcommand at all (double-clicked) it becomes `vimfps host ...`.
/// Prints which file was read, and its warnings.
pub fn expand_args(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
    let sub = argv.get(1).and_then(|s| s.to_str());
    if !matches!(sub, None | Some("host")) {
        return Ok(argv);
    }
    let rest = if argv.len() > 2 { &argv[2..] } else { &[][..] };
    if rest
        .iter()
        .any(|a| matches!(a.to_str(), Some("-h" | "--help")))
    {
        return Ok(argv);
    }
    let (explicit, off) = config_flag(rest);
    if off {
        return Ok(argv);
    }
    let Some(loaded) = load(explicit.as_deref())? else {
        return Ok(argv);
    };
    report(&loaded);
    let mut out: Vec<OsString> = Vec::with_capacity(argv.len() + loaded.host.args.len() + 1);
    out.push(argv[0].clone());
    out.push("host".into());
    out.extend(loaded.host.args.iter().map(OsString::from));
    out.extend(rest.iter().cloned());
    Ok(out)
}

fn report(l: &Loaded) {
    println!(
        "設定ファイル: {} (host の設定 {} 個)",
        l.path.display(),
        l.host.count
    );
    for w in &l.host.warnings {
        eprintln!("  {}:{w}", l.path.display());
    }
}

/// What `vimfps config --init` writes.
pub const TEMPLATE: &str = r#"" vim-fps の設定ファイル (.vimfpsrc)。Vim の vimrc と同じ書き方で、" から行末はコメントです。
" 書き方: https://igarinpiano.github.io/vim-fps/docs/config.html
"
" ブラウザー (:source で読み込み、:mkvimrc で書き出し) は set / skin / custom の行を、
" vimfps host は host の行を読みます。1 つのファイルに両方書けます。

" ---- ブラウザーの設定 (:set と同じ)
" set adssens=30 forward=j

" ---- ホスト (vimfps host のオプションから -- を取ったもの。コマンドラインで指定したほうが優先)
" host bots=5 bot-skill=3
" host time-limit=10 frag-limit=25
" host no-respawn no-ring no-tanks
" host tunnel password=合言葉
" host name=vim-fps\ サーバー           " 空白は \ を前に付ける
" host skin=./my-skin                    " 全員に配るスキン (skin.json のあるフォルダー。このファイルからの相対パス)
"#;

#[derive(clap::Args)]
pub struct ConfigArgs {
    /// ひな形を書き出す (既定: ~/.vimfpsrc。すでにあれば何もしない)
    #[arg(long)]
    pub init: bool,
    /// 読む設定ファイル (既定: ~/.vimfpsrc)
    #[arg(long)]
    pub config: Option<PathBuf>,
}

/// `vimfps config`: which file is read and what `vimfps host` takes from it.
pub fn run(a: &ConfigArgs) -> i32 {
    if a.init {
        let Some(path) = a
            .config
            .clone()
            .or_else(|| default_paths().into_iter().next())
        else {
            eprintln!("error: ホームフォルダーが分かりません (--config で場所を指定してください)");
            return 1;
        };
        if path.exists() {
            println!(
                "{} はもうあります (書き換えません)。エディターで開いて編集してください",
                path.display()
            );
            return 0;
        }
        return match std::fs::write(&path, TEMPLATE) {
            Ok(()) => {
                println!("{} を作りました", path.display());
                0
            }
            Err(e) => {
                eprintln!("error: {} に書けません: {e}", path.display());
                1
            }
        };
    }
    match load(a.config.as_deref()) {
        Err(e) => {
            eprintln!("error: {e}");
            1
        }
        Ok(None) => {
            let places: Vec<String> = default_paths()
                .iter()
                .map(|p| p.display().to_string())
                .collect();
            println!(
                "設定ファイルはありません (探した場所: {})",
                if places.is_empty() {
                    "なし".into()
                } else {
                    places.join(", ")
                }
            );
            println!("`vimfps config --init` でひな形を作れます");
            0
        }
        Ok(Some(l)) => {
            report(&l);
            if l.host.args.is_empty() {
                println!("vimfps host に足すオプション: なし");
            } else {
                let shown: Vec<String> = l
                    .host
                    .args
                    .iter()
                    .map(|s| {
                        if s.contains(char::is_whitespace) || s.is_empty() {
                            format!("{s:?}")
                        } else {
                            s.clone()
                        }
                    })
                    .collect();
                println!("vimfps host に足すオプション: {}", shown.join(" "));
            }
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words() {
        assert_eq!(
            tokenize("host bots=5  tunnel"),
            ["host", "bots=5", "tunnel"]
        );
        assert_eq!(
            tokenize(r#"host name=a\ b " comment"#),
            ["host", "name=a b"]
        );
        assert_eq!(
            tokenize(r#"host password=x"y"#),
            ["host", r#"password=x"y"#]
        );
        assert!(tokenize(r#"" only a comment"#).is_empty());
        assert!(tokenize("   ").is_empty());
    }

    #[test]
    fn host_lines_to_args() {
        let text = "\u{feff}\" header\nset adssens=30\n:host bots=5 bot_skill=4 tunnel\nhost no-ring=off no-tanks=on name=My\\ Server\nhost skin=./sk\ncustom bots=3\nskin x\n";
        let h = host_lines(text, Path::new("/cfg"));
        assert_eq!(
            h.args,
            [
                "--bots",
                "5",
                "--bot-skill",
                "4",
                "--tunnel",
                "--no-tanks",
                "--name",
                "My Server",
                "--skin",
                Path::new("/cfg").join("sk").to_str().unwrap(),
            ]
        );
        assert_eq!(h.count, 7);
        assert!(h.warnings.is_empty(), "{:?}", h.warnings);
    }

    #[test]
    fn bad_lines_are_reported_and_skipped() {
        let h = host_lines(
            "host bots\nhost colour=red\nhost tunnel=maybe\nfoo\nhost port=8080\n",
            Path::new("."),
        );
        assert_eq!(h.args, ["--port", "8080"]);
        assert_eq!(h.warnings.len(), 4, "{:?}", h.warnings);
        assert!(h.warnings[0].starts_with("1: "));
        assert!(h.warnings[3].starts_with("4: "));
    }

    #[test]
    fn config_flag_found() {
        let a = |v: &[&str]| v.iter().map(OsString::from).collect::<Vec<_>>();
        assert_eq!(
            config_flag(&a(&["--bots", "3", "--config", "x.rc"])),
            (Some(PathBuf::from("x.rc")), false)
        );
        assert_eq!(
            config_flag(&a(&["--config=y"])),
            (Some(PathBuf::from("y")), false)
        );
        assert_eq!(config_flag(&a(&["--no-config"])), (None, true));
    }

    #[test]
    fn file_options_come_before_the_command_line() {
        let dir = std::env::temp_dir().join(format!("vimfps-rc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let rc = dir.join("rc");
        std::fs::write(&rc, "host bots=5 tunnel\n").unwrap();
        let argv = |v: &[&str]| v.iter().map(OsString::from).collect::<Vec<_>>();
        let rcs = rc.to_str().unwrap();
        let out = expand_args(argv(&["vimfps", "host", "--config", rcs, "--bots", "9"])).unwrap();
        assert_eq!(
            out,
            argv(&[
                "vimfps", "host", "--bots", "5", "--tunnel", "--config", rcs, "--bots", "9"
            ])
        );
        // Other subcommands, --no-config, --help: untouched.
        let same = argv(&["vimfps", "update", "--config", rcs]);
        assert_eq!(expand_args(same.clone()).unwrap(), same);
        let same = argv(&["vimfps", "host", "--config", rcs, "--no-config"]);
        assert_eq!(expand_args(same.clone()).unwrap(), same);
        // A --config that is not there is an error.
        assert!(
            expand_args(argv(&[
                "vimfps",
                "host",
                "--config",
                dir.join("nope").to_str().unwrap()
            ]))
            .is_err()
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_template_has_no_active_host_line() {
        let h = host_lines(TEMPLATE, Path::new("."));
        assert!(h.args.is_empty());
        assert!(h.warnings.is_empty(), "{:?}", h.warnings);
    }
}
