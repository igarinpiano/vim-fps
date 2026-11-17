//! HTTP + WebSocket host. Serves the embedded web client at `/`, the game at
//! `/ws`, the host's skin (`--skin DIR`) at `/skin/`, and runs one `Room` in
//! a task at 60 Hz.

use axum::Router;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};
use vimfps_core::{ClientId, ClientMsg, Config, Room, ServerMsg, Target, sim::TICK_RATE};

#[derive(clap::Args, Clone)]
pub struct HostArgs {
    /// 待ち受けポート
    #[arg(short, long, default_value_t = 7777)]
    pub port: u16,
    /// 待ち受けアドレス (LAN に公開しないなら 127.0.0.1)
    #[arg(long, default_value = "0.0.0.0")]
    pub bind: IpAddr,
    /// Cloudflare Quick Tunnel でインターネットに公開する (cloudflared が必要)
    #[arg(long)]
    pub tunnel: bool,
    /// 合言葉 (招待 URL の #pw=... に入る)
    #[arg(long)]
    pub password: Option<String>,
    /// bot の数 (0〜15)
    #[arg(long, default_value_t = 0)]
    pub bots: u32,
    /// bot の強さ: 1 とても弱い / 2 弱い / 3 普通 / 4 強い (偏差撃ち) / 5 とても強い
    #[arg(long, default_value_t = 3, value_parser = clap::value_parser!(u8).range(1..=5))]
    pub bot_skill: u8,
    /// 最大人数 (bot を除く)
    #[arg(long, default_value_t = 12)]
    pub max_players: usize,
    /// 1 試合の長さ (分)
    #[arg(long, default_value_t = 10.0)]
    pub time_limit: f32,
    /// このキル数で試合終了
    #[arg(long, default_value_t = 25)]
    pub frag_limit: u32,
    /// マップのシード (省略時はランダム)
    #[arg(long)]
    pub seed: Option<u64>,
    /// サーバー名
    #[arg(long, default_value = "vim-fps")]
    pub name: String,
    /// 復活なし: 最後の 1 人が勝つラウンド制。倒された人は倒した相手の視点で観戦
    #[arg(long)]
    pub no_respawn: bool,
    /// リングなし (既定: 段階的に縮む円の外にいるとダメージ)
    #[arg(long)]
    pub no_ring: bool,
    /// 戦車なし (既定: マップに 3 両)
    #[arg(long)]
    pub no_tanks: bool,
    /// 起動時に新しいバージョンを確認しない
    #[arg(long)]
    pub no_update_check: bool,
    /// macOS: 起動時にファイアウォールが接続を通すか確認しない
    #[arg(long, env = "VIMFPS_NO_NETWORK_CHECK")]
    pub no_network_check: bool,
    /// 配信する Web クライアント: 公開版の URL (起動時と 10 分ごとに最新を取得)
    /// か、`embedded` (この CLI に埋め込まれた版)
    #[arg(long, env = "VIMFPS_WEB", default_value = crate::webclient::DEFAULT_WEB)]
    pub web: String,
    /// 参加者全員に配るスキン: skin.json のあるフォルダー (テクスチャ・効果音・UI の色)
    #[arg(long, value_name = "DIR")]
    pub skin: Option<std::path::PathBuf>,
    /// 設定ファイル (既定: ~/.vimfpsrc)。host の行をオプションとして読む
    #[arg(long, value_name = "PATH")]
    pub config: Option<std::path::PathBuf>,
    /// 設定ファイルを読まない
    #[arg(long)]
    pub no_config: bool,
}

impl Default for HostArgs {
    fn default() -> Self {
        HostArgs {
            port: 7777,
            bind: IpAddr::from([0, 0, 0, 0]),
            tunnel: false,
            password: None,
            bots: 0,
            bot_skill: 3,
            max_players: 12,
            time_limit: 10.0,
            frag_limit: 25,
            seed: None,
            name: "vim-fps".into(),
            no_respawn: false,
            no_ring: false,
            no_tanks: false,
            no_update_check: false,
            no_network_check: false,
            web: crate::webclient::DEFAULT_WEB.into(),
            skin: None,
            config: None,
            no_config: false,
        }
    }
}

enum Event {
    Join {
        name: String,
        password: Option<String>,
        protocol: u32,
        spectate: bool,
        tx: mpsc::Sender<Arc<str>>,
        reply: oneshot::Sender<Result<ClientId, String>>,
    },
    Msg(ClientId, ClientMsg),
    Leave(ClientId),
}

#[derive(Clone)]
struct AppState {
    events: mpsc::Sender<Event>,
    info: Arc<serde_json::Value>,
    tunnel: bool,
    web: crate::webclient::Shared,
    /// `--skin DIR`, resolved (files are read from disk on each request, so
    /// edits show on the next reload).
    skin: Option<Arc<std::path::PathBuf>>,
}

/// The skin folder: resolved, with a readable skin.json. Returns (folder,
/// the skin's name).
fn open_skin(dir: &std::path::Path) -> Result<(std::path::PathBuf, String), String> {
    let root = std::fs::canonicalize(dir)
        .map_err(|e| format!("スキンのフォルダーがありません: {} ({e})", dir.display()))?;
    let manifest = root.join("skin.json");
    let text = std::fs::read_to_string(&manifest).map_err(|e| {
        format!(
            "{} を読めません ({e})。スキンのフォルダーには skin.json が要ります",
            manifest.display()
        )
    })?;
    let json: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("{} が JSON として正しくありません: {e}", manifest.display()))?;
    let name = json
        .get("name")
        .and_then(|n| n.as_str())
        .filter(|n| !n.trim().is_empty())
        .map(|n| n.trim().chars().take(40).collect())
        .unwrap_or_else(|| {
            root.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "host".into())
        });
    Ok((root, name))
}

pub fn run(args: HostArgs) -> i32 {
    // Before the socket is opened: a firewall that turns players away tells
    // neither side, so see to it before anyone waits.
    if !args.no_network_check
        && !args.bind.is_loopback()
        && let Some((state, program)) = crate::firewall::incoming()
    {
        crate::firewall::settle(state, &program);
    }
    let rt = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("error: {e}");
            return 1;
        }
    };
    rt.block_on(host(args))
}

async fn host(args: HostArgs) -> i32 {
    let seed = args.seed.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(1)
            % 100_000
    });
    let cfg = Config {
        seed,
        time_limit: (args.time_limit * 60.0).max(30.0),
        frag_limit: args.frag_limit.max(1),
        max_players: args.max_players.max(1),
        password: args.password.clone().filter(|p| !p.is_empty()),
        practice: false,
        bots: args.bots,
        respawn: !args.no_respawn,
        range: false,
        bot_skill: args.bot_skill,
        ring: !args.no_ring,
        tanks: !args.no_tanks,
    };
    let skin = match args.skin.as_deref().map(open_skin).transpose() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: {e}");
            return 1;
        }
    };
    let addr = SocketAddr::new(args.bind, args.port);
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("error: {addr} で待ち受けできません: {e}");
            return 1;
        }
    };

    let (ev_tx, ev_rx) = mpsc::channel::<Event>(1024);
    let info = serde_json::json!({
        "name": args.name,
        "version": vimfps_core::VERSION,
        "protocol": vimfps_core::PROTOCOL,
        "password": cfg.password.is_some(),
        "respawn": cfg.respawn,
        "bots": cfg.bots,
        "bot_skill": cfg.bot_skill,
        "ring": cfg.ring,
        "tanks": cfg.tanks,
        "skin": skin.as_ref().map(|(_, name)| name.clone()),
    });
    let source = args.web.clone();
    let files = tokio::task::spawn_blocking(move || crate::webclient::initial(&source))
        .await
        .unwrap_or_else(|_| crate::webclient::Files::embedded());
    let web_label = files.label.clone();
    let web: crate::webclient::Shared = Arc::new(std::sync::RwLock::new(Arc::new(files)));
    crate::webclient::spawn_refresh(args.web.clone(), web.clone());
    let state = AppState {
        web,
        events: ev_tx,
        info: Arc::new(info),
        tunnel: args.tunnel,
        skin: skin.as_ref().map(|(root, _)| Arc::new(root.clone())),
    };
    tokio::spawn(game_loop(cfg.clone(), ev_rx));

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/server-info.json", get(server_info))
        .route("/skin/{*path}", get(skin_file))
        .fallback(static_file)
        .with_state(state);

    println!("vim-fps v{} — マップ seed {seed}", vimfps_core::VERSION);
    let pw_frag = cfg
        .password
        .as_ref()
        .map(|p| format!("#pw={}", url_encode(p)))
        .unwrap_or_default();
    println!("  このPC:   http://localhost:{}/{pw_frag}", args.port);
    if args.bind.is_unspecified()
        && let Some(ip) = lan_ip()
    {
        println!("  LAN:      http://{ip}:{}/{pw_frag}", args.port);
    }
    let _tunnel = if args.tunnel {
        crate::tunnel::start(args.port, pw_frag.clone()).await
    } else {
        None
    };
    if !args.no_update_check && std::env::var_os("VIMFPS_NO_UPDATE_CHECK").is_none() {
        tokio::task::spawn_blocking(crate::update::notify_if_newer);
    }
    println!("  Web クライアント: {web_label}");
    if let Some((root, name)) = &skin {
        println!("  スキン:   {name} ({})", root.display());
    }
    println!("Ctrl+C で終了します");

    let server = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    });
    if let Err(e) = server.await {
        eprintln!("error: {e}");
        return 1;
    }
    println!("終了しました");
    0
}

/// The address other machines on the LAN reach this one at (no packet is
/// sent: connecting a UDP socket only picks the outgoing interface).
fn lan_ip() -> Option<IpAddr> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:80").ok()?;
    let ip = s.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
}

pub fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

async fn server_info(State(st): State<AppState>) -> Response {
    (
        [(header::CACHE_CONTROL, "no-store")],
        [(header::CONTENT_TYPE, "application/json")],
        st.info.to_string(),
    )
        .into_response()
}

/// Largest file served from the skin folder.
const MAX_SKIN_FILE: u64 = 32 * 1024 * 1024;

/// A file of the host's skin. Only plain relative paths, nothing hidden, and
/// nothing outside the folder (symbolic links included).
async fn skin_file(
    State(st): State<AppState>,
    axum::extract::Path(path): axum::extract::Path<String>,
) -> Response {
    let not_found = || (StatusCode::NOT_FOUND, "not found").into_response();
    let Some(root) = st.skin.as_ref() else {
        return not_found();
    };
    if !crate::webclient::safe_path(&path) || path.split('/').any(|seg| seg.starts_with('.')) {
        return not_found();
    }
    let root = root.clone();
    let file = path.clone();
    let read = tokio::task::spawn_blocking(move || -> Option<Vec<u8>> {
        let real = std::fs::canonicalize(root.join(&file)).ok()?;
        let meta = std::fs::metadata(&real).ok()?;
        (real.starts_with(root.as_path()) && meta.is_file() && meta.len() <= MAX_SKIN_FILE)
            .then(|| std::fs::read(&real).ok())
            .flatten()
    })
    .await;
    let Ok(Some(data)) = read else {
        return not_found();
    };
    let mime = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .to_string();
    (
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, "no-cache".into()),
        ],
        data,
    )
        .into_response()
}

async fn static_file(State(st): State<AppState>, uri: Uri) -> Response {
    let mut path = uri.path().trim_start_matches('/').to_string();
    if path.is_empty() || path.ends_with('/') {
        path.push_str("index.html");
    }
    let files = st.web.read().map(|f| f.clone()).ok();
    match files.and_then(|f| f.get(&path)) {
        Some(data) => {
            let mime = if path.ends_with(".wasm") {
                "application/wasm".to_string()
            } else {
                mime_guess::from_path(&path)
                    .first_or_octet_stream()
                    .to_string()
            };
            (
                [
                    (header::CONTENT_TYPE, mime),
                    (header::CACHE_CONTROL, "no-cache".into()),
                ],
                data,
            )
                .into_response()
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    // Behind the tunnel every connection comes from localhost; the real
    // address is in CF-Connecting-IP. Only trusted in tunnel mode and only
    // from loopback (on the LAN anyone could send the header).
    let ip = if st.tunnel && peer.ip().is_loopback() {
        headers
            .get("cf-connecting-ip")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<IpAddr>().ok())
            .unwrap_or(peer.ip())
    } else {
        peer.ip()
    };
    ws.max_message_size(8 * 1024)
        .max_frame_size(8 * 1024)
        .on_upgrade(move |socket| client(socket, st, ip))
}

async fn client(mut socket: WebSocket, st: AppState, ip: IpAddr) {
    // First message: join, within 10 seconds.
    let first = tokio::time::timeout(Duration::from_secs(10), socket.recv()).await;
    let Ok(Some(Ok(Message::Text(text)))) = first else {
        return;
    };
    let Ok(ClientMsg::Join {
        name,
        password,
        protocol,
        spectate,
    }) = serde_json::from_str::<ClientMsg>(&text)
    else {
        return;
    };
    let (tx, mut rx) = mpsc::channel::<Arc<str>>(512);
    let (reply_tx, reply_rx) = oneshot::channel();
    if st
        .events
        .send(Event::Join {
            name: name.clone(),
            password,
            protocol,
            spectate,
            tx,
            reply: reply_tx,
        })
        .await
        .is_err()
    {
        return;
    }
    let id = match reply_rx.await {
        Ok(Ok(id)) => id,
        Ok(Err(text)) => {
            let msg =
                serde_json::to_string(&ServerMsg::Error { text: text.clone() }).unwrap_or_default();
            let _ = socket.send(Message::Text(msg.into())).await;
            println!("[拒否] {ip}: {text}");
            return;
        }
        Err(_) => return,
    };
    println!(
        "[{}] #{id} {name} ({ip})",
        if spectate { "観戦" } else { "参加" }
    );

    // Token bucket: 120 messages per second, bursts of 240.
    let mut tokens = 240.0f32;
    let mut last = Instant::now();
    loop {
        tokio::select! {
            incoming = socket.recv() => {
                let Some(Ok(msg)) = incoming else { break };
                let text = match msg {
                    Message::Text(t) => t,
                    Message::Close(_) => break,
                    _ => continue,
                };
                let now = Instant::now();
                tokens = (tokens + now.duration_since(last).as_secs_f32() * 120.0).min(240.0);
                last = now;
                if tokens < 1.0 {
                    continue;
                }
                tokens -= 1.0;
                match serde_json::from_str::<ClientMsg>(&text) {
                    Ok(m) => {
                        if st.events.send(Event::Msg(id, m)).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => continue,
                }
            }
            out = rx.recv() => {
                let Some(out) = out else { break };
                if socket.send(Message::Text(out.as_ref().into())).await.is_err() {
                    break;
                }
            }
        }
    }
    let _ = st.events.send(Event::Leave(id)).await;
    println!("[退出] #{id} {name}");
}

async fn game_loop(cfg: Config, mut events: mpsc::Receiver<Event>) {
    let mut room = Room::new(cfg);
    let mut clients: HashMap<ClientId, mpsc::Sender<Arc<str>>> = HashMap::new();
    let mut interval = tokio::time::interval(Duration::from_secs_f32(1.0 / TICK_RATE));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last = Instant::now();
    loop {
        tokio::select! {
            ev = events.recv() => {
                let Some(ev) = ev else { break };
                match ev {
                    Event::Join { name, password, protocol, spectate, tx, reply } => {
                        let r = room.join(&name, password.as_deref(), protocol, spectate);
                        if let Ok(id) = r {
                            clients.insert(id, tx);
                        }
                        let _ = reply.send(r);
                    }
                    Event::Msg(id, m) => {
                        if !matches!(m, ClientMsg::Join { .. } | ClientMsg::Bots { .. }) {
                            room.handle(id, m);
                        }
                    }
                    Event::Leave(id) => {
                        clients.remove(&id);
                        room.leave(id);
                    }
                }
            }
            _ = interval.tick() => {
                let now = Instant::now();
                let dt = now.duration_since(last).as_secs_f32();
                last = now;
                room.tick(dt);
                let mut slow = Vec::new();
                for (to, msg) in room.drain() {
                    let Ok(json) = serde_json::to_string(&msg) else { continue };
                    let json: Arc<str> = json.into();
                    match to {
                        Target::All => {
                            for (id, tx) in &clients {
                                if tx.try_send(json.clone()).is_err() {
                                    slow.push(*id);
                                }
                            }
                        }
                        Target::One(id) => {
                            if let Some(tx) = clients.get(&id)
                                && tx.try_send(json).is_err() {
                                    slow.push(id);
                                }
                        }
                    }
                }
                // A client that cannot keep up is dropped (its socket task
                // ends when the sender goes away).
                for id in slow {
                    if clients.remove(&id).is_some() {
                        room.leave(id);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes() {
        assert_eq!(url_encode("a b&c"), "a%20b%26c");
    }

    #[test]
    fn skin_folder() {
        let dir = std::env::temp_dir().join(format!("vimfps-skin-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(open_skin(&dir).is_err(), "no skin.json");
        std::fs::write(dir.join("skin.json"), "{nope").unwrap();
        assert!(open_skin(&dir).is_err(), "bad JSON");
        std::fs::write(dir.join("skin.json"), r#"{"name": " neon "}"#).unwrap();
        let (root, name) = open_skin(&dir).unwrap();
        assert_eq!(name, "neon");
        assert!(root.is_absolute());
        std::fs::write(dir.join("skin.json"), "{}").unwrap();
        let (_, name) = open_skin(&dir).unwrap();
        assert!(name.starts_with("vimfps-skin-"));
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(open_skin(&dir).is_err(), "no folder");
    }
}
