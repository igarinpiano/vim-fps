//! The host's admin: who may run the matches, and the commands they use.
//!
//! An admin does not play. They watch everything (ranking, health, ping,
//! everyone's view) and start and end the matches, from the admin page
//! (`/admin.html#key=...`, over a WebSocket that must open with a key) or
//! from the terminal `vimfps host` runs in. Players have no way to start,
//! end or change a match.

use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use vimfps_core::protocol::{AdminMsg, AdminState, MatchSettings, Phase};
use vimfps_core::{ClientId, Room};

/// One person allowed in as admin.
#[derive(Clone, Debug, PartialEq)]
pub struct Admin {
    pub name: String,
    pub key: String,
    /// Made up at start-up (not given with --admin).
    pub generated: bool,
}

/// Shortest key accepted from --admin (a made-up one is 24 characters).
pub const MIN_KEY: usize = 8;

/// `--admin` values: "名前:鍵" or just "鍵". Empty: one key is made up.
pub fn parse_admins(specs: &[String]) -> Result<Vec<Admin>, String> {
    let mut out: Vec<Admin> = Vec::new();
    for spec in specs.iter().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let (name, key) = match spec.split_once(':') {
            Some((n, k)) => (n.trim().to_string(), k.trim().to_string()),
            None => (String::new(), spec.to_string()),
        };
        if key.chars().count() < MIN_KEY {
            return Err(format!(
                "管理者の鍵は {MIN_KEY} 文字以上にしてください (--admin 名前:鍵)"
            ));
        }
        if key.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err("管理者の鍵に空白は使えません".into());
        }
        if out.iter().any(|a| a.key == key) {
            return Err("同じ鍵が 2 回指定されています".into());
        }
        let name = if name.is_empty() {
            format!("管理者{}", out.len() + 1)
        } else {
            name.chars().take(16).collect()
        };
        out.push(Admin {
            name,
            key,
            generated: false,
        });
    }
    if out.is_empty() {
        out.push(Admin {
            name: "ホスト".into(),
            key: new_key(),
            generated: true,
        });
    }
    Ok(out)
}

/// A random key: 24 characters from an alphabet without look-alikes
/// (about 130 bits). The randomness comes from the OS through the seeds
/// of std's hash maps.
pub fn new_key() -> String {
    const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut out = String::with_capacity(24);
    let mut n = 0u64;
    while out.len() < 24 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(n);
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        );
        let mut v = h.finish();
        n += 1;
        for _ in 0..4 {
            out.push(ALPHABET[(v % ALPHABET.len() as u64) as usize] as char);
            v /= ALPHABET.len() as u64;
        }
    }
    out.truncate(24);
    out
}

/// Compares in time that does not depend on where the strings differ.
fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Wrong keys allowed from one address before it is shut out.
const MAX_FAILS: u32 = 5;
const LOCKOUT: Duration = Duration::from_secs(60);

/// The admins, and the addresses that guessed wrong too often.
pub struct Gate {
    admins: Vec<Admin>,
    fails: Mutex<HashMap<IpAddr, (u32, Instant)>>,
}

impl Gate {
    pub fn new(admins: Vec<Admin>) -> Gate {
        Gate {
            admins,
            fails: Mutex::new(HashMap::new()),
        }
    }

    pub fn admins(&self) -> &[Admin] {
        &self.admins
    }

    /// The admin this key belongs to. Err: why not.
    pub fn check(&self, ip: IpAddr, key: &str) -> Result<String, String> {
        let now = Instant::now();
        let mut fails = self.fails.lock().unwrap_or_else(|e| e.into_inner());
        fails.retain(|_, (_, at)| now.duration_since(*at) < LOCKOUT);
        if fails.get(&ip).is_some_and(|(n, _)| *n >= MAX_FAILS) {
            return Err("鍵の間違いが続いたため、1 分間は入れません".into());
        }
        // Every key is compared, so the time does not tell which matched.
        let found = self
            .admins
            .iter()
            .fold(None, |hit, a| if same(&a.key, key) { Some(a) } else { hit });
        match found {
            Some(a) => {
                fails.remove(&ip);
                Ok(a.name.clone())
            }
            None => {
                let e = fails.entry(ip).or_insert((0, now));
                e.0 += 1;
                e.1 = now;
                Err("管理者の鍵が違います".into())
            }
        }
    }
}

// ---------------------------------------------------------------- commands

/// What a command asks of the host besides the room (the host owns the
/// connections).
pub enum Effect {
    None,
    /// Disconnect this player.
    Kick(ClientId),
}

/// Carries out an admin's message on the room.
pub fn apply(room: &mut Room, who: &str, msg: AdminMsg) -> (Result<String, String>, Effect) {
    let r = match msg {
        AdminMsg::Hello { .. } => Err("もう入っています".into()),
        // Run by the host (it needs the connections).
        AdminMsg::Command { .. } => Err("コマンドはホストが実行します".into()),
        AdminMsg::Start { countdown } => room.admin_start(countdown),
        AdminMsg::Cancel => room.admin_cancel(),
        AdminMsg::End => room.admin_end(),
        AdminMsg::Lobby => room.admin_lobby(),
        AdminMsg::Settings { settings } => room.admin_settings(settings),
        AdminMsg::Auto { on } => Ok(room.set_auto(on)),
        AdminMsg::Spectate { id } => room.admin_spectate(id),
        AdminMsg::Bots { n } => room.admin_bots(n),
        AdminMsg::BotLevel { id, level } => room.admin_bot_level(id, level),
        AdminMsg::Say { text } => room.announce(who, &text),
        AdminMsg::Kick { id } => {
            return match room.name_of(id).map(str::to_string) {
                None => (Err("その人はいません".into()), Effect::None),
                Some(_) if room.is_bot(id) => (
                    Err("bot は退出させられません (bot の数で調整してください)".into()),
                    Effect::None,
                ),
                Some(name) => (Ok(format!("{name} を退出させました")), Effect::Kick(id)),
            };
        }
    };
    (r, Effect::None)
}

pub const HELP: &str = "\
管理コマンド (この端末で入力して Enter):
  status              状態と参加者の一覧 (HP・キル・デス・ping)   短く: s
  start [秒]          試合を開始 (既定 5 秒の秒読み。0 ですぐ)
  cancel              開始の秒読みを取り消す
  end                 試合を終了 (結果を出して待機中へ)
  lobby               すぐ待機中に戻す (結果なし)
  auto on|off         結果のあと、次の試合を自動で始めるか
  set 項目=値 ...     次の試合の設定: time=分 frags=キル数 bots=数 skill=1〜5
                      respawn=on|off ring=on|off tanks=on|off
  bots 数             bot の数をすぐ変える (0〜15)
  level 名前|番号 1〜5   bot 1 体の強さをすぐ変える (auto で全体の設定に戻す)
  kick 名前|番号      退出させる
  watch 名前|番号     観戦に回す
  say テキスト        全員にメッセージ
  admins              管理ページの URL (鍵つき)
  help                この説明";

/// A line typed into the host's terminal. `Ok(None)`: nothing to say.
pub fn parse_line(room: &Room, line: &str) -> Result<Option<AdminMsg>, String> {
    let line = line.trim();
    let (cmd, rest) = line.split_once(char::is_whitespace).unwrap_or((line, ""));
    let rest = rest.trim();
    let who = |rest: &str| -> Result<ClientId, String> {
        if rest.is_empty() {
            return Err("名前か番号を指定してください (status で一覧)".into());
        }
        room.find(rest)
            .ok_or_else(|| format!("{rest} という人はいません (status で一覧)"))
    };
    let msg = match cmd {
        "" => return Ok(None),
        "start" | "go" => AdminMsg::Start {
            countdown: if rest.is_empty() {
                5.0
            } else {
                rest.parse::<f32>()
                    .map_err(|_| format!("秒数が読めません: {rest}"))?
            },
        },
        "cancel" => AdminMsg::Cancel,
        "end" | "stop" => AdminMsg::End,
        "lobby" => AdminMsg::Lobby,
        "auto" => AdminMsg::Auto {
            on: switch(rest).ok_or("auto on か auto off で指定してください")?,
        },
        "set" => AdminMsg::Settings {
            settings: parse_settings(room.next_settings(), rest)?,
        },
        "bots" => AdminMsg::Bots {
            n: rest
                .parse()
                .map_err(|_| format!("bot の数が読めません: {rest}"))?,
        },
        "level" | "skill" => {
            let (name, lv) = rest
                .rsplit_once(char::is_whitespace)
                .ok_or("level 名前 1〜5 (auto で全体の設定) で指定してください")?;
            let level = if lv == "auto" {
                None
            } else {
                Some(
                    lv.parse::<u8>()
                        .ok()
                        .filter(|l| (1..=5).contains(l))
                        .ok_or("強さは 1〜5 か auto で指定してください")?,
                )
            };
            AdminMsg::BotLevel {
                id: who(name.trim())?,
                level,
            }
        }
        "kick" => AdminMsg::Kick { id: who(rest)? },
        "watch" | "spectate" => AdminMsg::Spectate { id: who(rest)? },
        "say" => AdminMsg::Say {
            text: rest.to_string(),
        },
        _ => return Err(format!("知らないコマンドです: {cmd} (help で一覧)")),
    };
    Ok(Some(msg))
}

fn switch(v: &str) -> Option<bool> {
    match v.to_ascii_lowercase().as_str() {
        "on" | "yes" | "true" | "1" => Some(true),
        "off" | "no" | "false" | "0" => Some(false),
        _ => None,
    }
}

/// `time=10 frags=25 ...` on top of `base`.
pub fn parse_settings(mut s: MatchSettings, text: &str) -> Result<MatchSettings, String> {
    if text.trim().is_empty() {
        return Err(
            "set time=分 frags=キル数 bots=数 skill=1〜5 respawn=on|off ring=on|off tanks=on|off"
                .into(),
        );
    }
    for word in text.split_whitespace() {
        let (k, v) = word
            .split_once('=')
            .ok_or_else(|| format!("{word}: 項目=値 で書いてください"))?;
        let num = || format!("{k}={v}: 数で書いてください");
        let flag = || format!("{k}={v}: on か off で書いてください");
        match k {
            "time" | "time-limit" => s.time_limit = v.parse().map_err(|_| num())?,
            "frags" | "frag-limit" | "kills" => s.frag_limit = v.parse().map_err(|_| num())?,
            "bots" => s.bots = v.parse().map_err(|_| num())?,
            "skill" | "bot-skill" => s.bot_skill = v.parse().map_err(|_| num())?,
            "respawn" => s.respawn = switch(v).ok_or_else(flag)?,
            "ring" => s.ring = switch(v).ok_or_else(flag)?,
            "tanks" => s.tanks = switch(v).ok_or_else(flag)?,
            _ => return Err(format!("{k}: そういう項目はありません")),
        }
    }
    Ok(s)
}

fn clock(secs: f32) -> String {
    let s = secs.max(0.0) as u32;
    format!("{}:{:02}", s / 60, s % 60)
}

pub fn phase_text(st: &AdminState) -> String {
    match st.phase {
        Phase::Lobby => "待機中 (start で開始)".into(),
        Phase::Countdown => format!("開始まで {} 秒", st.countdown.unwrap_or(0.0)),
        Phase::Live => format!("試合中 · 残り {}", clock(st.left)),
        Phase::Results => format!(
            "結果表示中 · {} 秒後に{}",
            st.intermission.unwrap_or(0.0),
            if st.auto {
                "次の試合"
            } else {
                "待機中へ"
            }
        ),
    }
}

fn rules(s: &MatchSettings) -> String {
    format!(
        "{} 分 · {} · bot {} 体 (強さ {}) · リング{} · 戦車{}",
        s.time_limit,
        if s.respawn {
            format!("{} キル先取", s.frag_limit)
        } else {
            "復活なし".into()
        },
        s.bots,
        s.bot_skill,
        if s.ring { "あり" } else { "なし" },
        if s.tanks { "あり" } else { "なし" },
    )
}

/// What `status` prints.
pub fn status(st: &AdminState) -> String {
    let mut out = String::new();
    out.push_str(&format!("状態: {}\n", phase_text(st)));
    out.push_str(&format!("この試合: {}\n", rules(&st.settings)));
    if st.next != st.settings {
        out.push_str(&format!("次の試合: {}\n", rules(&st.next)));
    }
    out.push_str(&format!(
        "結果のあと: {}\n",
        if st.auto {
            "自動で次の試合"
        } else {
            "待機中 (start で開始)"
        }
    ));
    let playing: Vec<_> = st.players.iter().filter(|p| !p.spectator).collect();
    if playing.is_empty() {
        out.push_str("参加者はまだいません\n");
    } else {
        out.push_str("  番号  名前              HP  キル  デス   ping\n");
        for p in &playing {
            let hp = if p.alive {
                format!("{:>3}", p.hp as i32)
            } else if p.out {
                "OUT".into()
            } else {
                "  -".into()
            };
            let ping = match p.ping {
                Some(ms) => format!("{:>4} ms", ms.round() as i32),
                None if p.bot => format!("  bot {}", p.level.unwrap_or(3)),
                None => "      -".into(),
            };
            out.push_str(&format!(
                "  #{:<4} {} {}  {:>4}  {:>4}  {}\n",
                p.id,
                pad(&p.name, 16),
                hp,
                p.kills,
                p.deaths,
                ping
            ));
        }
    }
    let watching: Vec<&str> = st
        .players
        .iter()
        .filter(|p| p.spectator)
        .map(|p| p.name.as_str())
        .collect();
    if !watching.is_empty() {
        out.push_str(&format!("観戦: {}\n", watching.join(", ")));
    }
    out.trim_end().to_string()
}

/// Pads to a width in terminal columns (CJK characters are two wide).
fn pad(s: &str, width: usize) -> String {
    let mut w = 0;
    let mut out = String::new();
    for c in s.chars() {
        let cw = if (c as u32) >= 0x1100 { 2 } else { 1 };
        if w + cw > width {
            break;
        }
        w += cw;
        out.push(c);
    }
    out.extend(std::iter::repeat_n(' ', width - w));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;
    use vimfps_core::Config;

    #[test]
    fn admins_from_options() {
        let a = parse_admins(&[]).unwrap();
        assert_eq!(a.len(), 1);
        assert!(a[0].generated);
        assert_eq!(a[0].key.len(), 24);
        let a = parse_admins(&["igarin:longenough".into(), "secretkey9".into()]).unwrap();
        assert_eq!(a[0].name, "igarin");
        assert_eq!(a[0].key, "longenough");
        assert_eq!(a[1].name, "管理者2");
        assert!(!a[1].generated);
        assert!(parse_admins(&["a:short".into()]).is_err());
        assert!(parse_admins(&["x:samesame1".into(), "y:samesame1".into()]).is_err());
        assert_ne!(new_key(), new_key());
    }

    #[test]
    fn wrong_keys_lock_out() {
        let gate = Gate::new(parse_admins(&["igarin:rightkey1".into()]).unwrap());
        let ip = IpAddr::from(Ipv4Addr::new(10, 0, 0, 2));
        let other = IpAddr::from(Ipv4Addr::new(10, 0, 0, 3));
        assert_eq!(gate.check(ip, "rightkey1").unwrap(), "igarin");
        for _ in 0..MAX_FAILS {
            assert!(gate.check(ip, "wrongkey").is_err());
        }
        // Even the right key is refused for a while.
        assert!(gate.check(ip, "rightkey1").is_err());
        assert!(gate.check(other, "rightkey1").is_ok());
    }

    #[test]
    fn terminal_commands() {
        let mut room = Room::new(Config {
            seed: 3,
            managed: true,
            ..Default::default()
        });
        let id = room
            .join("alice", None, vimfps_core::PROTOCOL, false)
            .unwrap();
        assert_eq!(
            parse_line(&room, "start").unwrap(),
            Some(AdminMsg::Start { countdown: 5.0 })
        );
        assert_eq!(
            parse_line(&room, "start 0").unwrap(),
            Some(AdminMsg::Start { countdown: 0.0 })
        );
        assert_eq!(
            parse_line(&room, "kick alice").unwrap(),
            Some(AdminMsg::Kick { id })
        );
        assert_eq!(
            parse_line(&room, &format!("watch #{id}")).unwrap(),
            Some(AdminMsg::Spectate { id })
        );
        assert!(parse_line(&room, "kick nobody").is_err());
        assert!(parse_line(&room, "dance").is_err());
        let Some(AdminMsg::Settings { settings }) =
            parse_line(&room, "set time=3 bots=4 respawn=off").unwrap()
        else {
            panic!()
        };
        assert_eq!(settings.time_limit, 3.0);
        assert_eq!(settings.bots, 4);
        assert!(!settings.respawn);
        assert!(parse_line(&room, "set time=abc").is_err());
        assert_eq!(
            parse_line(&room, "bots 3").unwrap(),
            Some(AdminMsg::Bots { n: 3 })
        );
        let (r, _) = apply(&mut room, "igarin", AdminMsg::Bots { n: 2 });
        assert!(r.is_ok());
        let bot = room.find("bot-2").unwrap();
        assert_eq!(
            parse_line(&room, "level bot-2 5").unwrap(),
            Some(AdminMsg::BotLevel {
                id: bot,
                level: Some(5)
            })
        );
        let (r, _) = apply(
            &mut room,
            "igarin",
            AdminMsg::BotLevel {
                id: bot,
                level: Some(5),
            },
        );
        assert!(r.is_ok(), "{r:?}");
        let st = room.admin_state();
        let b = st.players.iter().find(|p| p.id == bot).unwrap();
        assert_eq!((b.level, b.own_level), (Some(5), true));
        assert!(parse_line(&room, "level alice 3").is_ok());
        let (r, _) = apply(&mut room, "x", AdminMsg::BotLevel { id, level: Some(3) });
        assert!(r.is_err(), "alice is not a bot");
        assert!(parse_line(&room, "level bot-2 9").is_err());
        let (r, _) = apply(&mut room, "igarin", AdminMsg::Start { countdown: 0.0 });
        assert!(r.is_ok());
        let st = room.admin_state();
        assert_eq!(st.phase, Phase::Live);
        assert!(status(&st).contains("alice"));
    }

    #[test]
    fn pads_wide_characters() {
        assert_eq!(pad("ab", 4), "ab  ");
        assert_eq!(pad("あい", 6), "あい  ");
        assert_eq!(pad("あいう", 5), "あい ");
    }
}
