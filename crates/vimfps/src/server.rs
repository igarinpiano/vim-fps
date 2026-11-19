//! HTTP + WebSocket host. Serves the embedded web client at `/`, the game at
//! `/ws`, the admin page's connection at `/admin/ws` (with a key; on its own
//! port with `--admin-port`), the host's skin (`--skin DIR`) at `/skin/`,
//! and runs one `Room` in a task at 60 Hz. Lines typed into the terminal are
//! admin commands (`help`).

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
use vimfps_core::protocol::{AdminMsg, AdminOut, Specs};
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
    /// 管理者 (試合を開始・終了できる人。参加はせず観戦と管理だけ): 名前:鍵 (8 文字以上)。
    /// 複数回指定できます。省略すると鍵を 1 つ作って表示します
    #[arg(
        long = "admin",
        value_name = "名前:鍵",
        env = "VIMFPS_ADMIN",
        value_delimiter = ','
    )]
    pub admin: Vec<String>,
    /// 管理ページを別のポートで配信する (参加者用のポートでは管理できなくなります)
    #[arg(long, value_name = "PORT")]
    pub admin_port: Option<u16>,
    /// 管理ページのポートの待ち受けアドレス (--admin-port のとき)
    #[arg(long, default_value = "127.0.0.1")]
    pub admin_bind: IpAddr,
    /// 管理ページを別の Cloudflare Quick Tunnel で公開する (--admin-port の指定がなければ PORT+1)
    #[arg(long)]
    pub admin_tunnel: bool,
    /// 管理者を待たずに試合を始め、結果のあとも自動で次の試合へ進む
    #[arg(long)]
    pub autostart: bool,
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
            admin: Vec::new(),
            admin_port: None,
            admin_bind: IpAddr::from([127, 0, 0, 1]),
            admin_tunnel: false,
            autostart: false,
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
    /// An admin page signed in (its key checked).
    AdminJoin {
        name: String,
        tx: mpsc::Sender<Arc<str>>,
        reply: oneshot::Sender<u32>,
    },
    AdminMsg(u32, AdminMsg),
    AdminLeave(u32),
    /// A line typed into the host's terminal.
    Terminal {
        line: String,
        reply: oneshot::Sender<String>,
    },
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
    gate: Arc<crate::admin::Gate>,
    /// Serves the admin page's connection (the players' port does unless
    /// --admin-port is given).
    admin: bool,
    /// The admin port's listener: `/` is the admin page.
    admin_root: bool,
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
        managed: !args.autostart,
    };
    let admins = match crate::admin::parse_admins(&args.admin) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("error: {e}");
            return 1;
        }
    };
    let admin_port = args
        .admin_port
        .or(args.admin_tunnel.then(|| args.port.wrapping_add(1)));
    if admin_port == Some(args.port) {
        eprintln!(
            "error: --admin-port は参加者用のポート ({}) と別にしてください",
            args.port
        );
        return 1;
    }
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
    let admin_listener = match admin_port {
        Some(port) => {
            let addr = SocketAddr::new(args.admin_bind, port);
            match tokio::net::TcpListener::bind(addr).await {
                Ok(l) => Some(l),
                Err(e) => {
                    eprintln!("error: 管理ページ用の {addr} で待ち受けできません: {e}");
                    return 1;
                }
            }
        }
        None => None,
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
        "managed": cfg.managed,
    });
    let source = args.web.clone();
    let files = tokio::task::spawn_blocking(move || crate::webclient::initial(&source))
        .await
        .unwrap_or_else(|_| crate::webclient::Files::embedded());
    let web_label = files.label.clone();
    let web: crate::webclient::Shared = Arc::new(std::sync::RwLock::new(Arc::new(files)));
    crate::webclient::spawn_refresh(args.web.clone(), web.clone());
    let gate = Arc::new(crate::admin::Gate::new(admins));
    let state = AppState {
        web,
        events: ev_tx.clone(),
        info: Arc::new(info),
        tunnel: args.tunnel,
        skin: skin.as_ref().map(|(root, _)| Arc::new(root.clone())),
        gate: gate.clone(),
        admin: admin_listener.is_none(),
        admin_root: false,
    };
    let server_name = args.name.clone();
    tokio::spawn(game_loop(cfg.clone(), ev_rx, server_name));

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/admin/ws", get(admin_ws_handler))
        .route("/server-info.json", get(server_info))
        .route("/skin/{*path}", get(skin_file))
        .fallback(static_file)
        .with_state(state.clone());
    let admin_app = admin_listener.as_ref().map(|_| {
        Router::new()
            .route("/admin/ws", get(admin_ws_handler))
            .route("/server-info.json", get(server_info))
            .fallback(static_file)
            .with_state(AppState {
                tunnel: args.admin_tunnel,
                admin: true,
                admin_root: true,
                ..state.clone()
            })
    });

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
    let tunnel = if args.tunnel {
        crate::tunnel::start(args.port, pw_frag.clone(), "インターネット", true).await
    } else {
        None
    };
    // Where the admin page is.
    let mut admin_bases: Vec<String> = Vec::new();
    match admin_port {
        Some(p) => {
            let host = if args.admin_bind.is_unspecified() || args.admin_bind.is_loopback() {
                "localhost".to_string()
            } else {
                args.admin_bind.to_string()
            };
            admin_bases.push(format!("http://{host}:{p}/admin.html"));
        }
        None => {
            admin_bases.push(format!("http://localhost:{}/admin.html", args.port));
            if let Some(url) = tunnel.as_ref().and_then(|(_, u)| u.clone()) {
                admin_bases.push(format!("{url}/admin.html"));
            }
        }
    }
    let admin_tunnel = match (admin_port, args.admin_tunnel) {
        (Some(p), true) => {
            let t = crate::tunnel::start(p, String::new(), "管理ページのトンネル", false).await;
            if let Some(url) = t.as_ref().and_then(|(_, u)| u.clone()) {
                admin_bases.push(format!("{url}/admin.html"));
            }
            t
        }
        _ => None,
    };
    let _tunnels = (tunnel, admin_tunnel);
    let admin_urls = admin_urls(&admin_bases, gate.admins());
    for line in admin_lines(&admin_bases, gate.admins(), false) {
        println!("{line}");
    }
    if !args.no_update_check && std::env::var_os("VIMFPS_NO_UPDATE_CHECK").is_none() {
        tokio::task::spawn_blocking(crate::update::notify_if_newer);
    }
    println!("  Web クライアント: {web_label}");
    if let Some((root, name)) = &skin {
        println!("  スキン:   {name} ({})", root.display());
    }
    if cfg.managed {
        println!(
            "試合は管理者が開始します (管理ページ、またはこの端末で start)。参加者はそれまで待機中です"
        );
    } else {
        println!("--autostart: 試合は自動で始まり、続けて次の試合へ進みます");
    }
    println!("この端末で help と入力すると管理コマンドの一覧が出ます。Ctrl+C で終了します");
    spawn_terminal(ev_tx, admin_urls);
    if let (Some(listener), Some(app)) = (admin_listener, admin_app) {
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });
    }

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

/// The admin page's addresses, with each admin's key (for `admins`).
fn admin_urls(bases: &[String], admins: &[crate::admin::Admin]) -> Vec<String> {
    admin_lines(bases, admins, true)
}

/// What is printed about the admin page. Keys given with --admin are left
/// out unless `with_keys` (the terminal may be on a stream); a made-up key
/// is always shown (there is no other way to learn it).
fn admin_lines(bases: &[String], admins: &[crate::admin::Admin], with_keys: bool) -> Vec<String> {
    let mut out = Vec::new();
    for a in admins {
        if a.generated || with_keys {
            for b in bases {
                out.push(format!(
                    "  管理:     {b}#key={} ({})",
                    url_encode(&a.key),
                    a.name
                ));
            }
        }
    }
    let named: Vec<&str> = admins
        .iter()
        .filter(|a| !a.generated && !with_keys)
        .map(|a| a.name.as_str())
        .collect();
    if !named.is_empty() {
        out.push(format!(
            "  管理:     {} の末尾に #key=鍵 を付けて開く ({}。鍵ごとの URL は admins で表示)",
            bases.first().map(String::as_str).unwrap_or(""),
            named.join(", ")
        ));
    }
    out
}

/// Lines typed into the terminal, read on a thread of their own (a read
/// that never ends must not hold up the exit).
fn spawn_terminal(events: mpsc::Sender<Event>, urls: Vec<String>) {
    let (tx, mut rx) = mpsc::channel::<String>(16);
    let _ = std::thread::Builder::new()
        .name("terminal".into())
        .spawn(move || {
            let stdin = std::io::stdin();
            let mut line = String::new();
            loop {
                line.clear();
                match stdin.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if tx.blocking_send(line.trim().to_string()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
    tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            match line.as_str() {
                "" => continue,
                "help" | "h" | "?" => println!("{}", crate::admin::HELP),
                "admins" | "keys" => {
                    for u in &urls {
                        println!("{u}");
                    }
                }
                _ => {
                    let (reply, answer) = oneshot::channel();
                    if events.send(Event::Terminal { line, reply }).await.is_err() {
                        break;
                    }
                    if let Ok(text) = answer.await {
                        println!("{text}");
                    }
                }
            }
        }
    });
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
    if st.admin_root && path.is_empty() {
        path.push_str("admin.html");
    } else if path.is_empty() || path.ends_with('/') {
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
    let ip = real_ip(&st, peer, &headers);
    ws.max_message_size(8 * 1024)
        .max_frame_size(8 * 1024)
        .on_upgrade(move |socket| client(socket, st, ip))
}

/// Behind the tunnel every connection comes from localhost; the real
/// address is in CF-Connecting-IP. Only trusted in tunnel mode and only from
/// loopback (on the LAN anyone could send the header).
fn real_ip(st: &AppState, peer: SocketAddr, headers: &HeaderMap) -> IpAddr {
    if st.tunnel && peer.ip().is_loopback() {
        headers
            .get("cf-connecting-ip")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<IpAddr>().ok())
            .unwrap_or(peer.ip())
    } else {
        peer.ip()
    }
}

async fn admin_ws_handler(
    ws: WebSocketUpgrade,
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if !st.admin {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    let ip = real_ip(&st, peer, &headers);
    ws.max_message_size(8 * 1024)
        .max_frame_size(8 * 1024)
        .on_upgrade(move |socket| admin_client(socket, st, ip))
}

/// An admin page: a key first, then commands; everything that happens
/// comes back.
async fn admin_client(mut socket: WebSocket, st: AppState, ip: IpAddr) {
    let first = tokio::time::timeout(Duration::from_secs(10), socket.recv()).await;
    let Ok(Some(Ok(Message::Text(text)))) = first else {
        return;
    };
    let Ok(AdminMsg::Hello { key }) = serde_json::from_str::<AdminMsg>(&text) else {
        return;
    };
    let name = match st.gate.check(ip, &key) {
        Ok(name) => name,
        Err(text) => {
            let msg = serde_json::to_string(&AdminOut::AdminReply {
                ok: false,
                text: text.clone(),
            })
            .unwrap_or_default();
            let _ = socket.send(Message::Text(msg.into())).await;
            println!("[管理 拒否] {ip}: {text}");
            return;
        }
    };
    let (tx, mut rx) = mpsc::channel::<Arc<str>>(1024);
    let (reply_tx, reply_rx) = oneshot::channel();
    if st
        .events
        .send(Event::AdminJoin {
            name: name.clone(),
            tx,
            reply: reply_tx,
        })
        .await
        .is_err()
    {
        return;
    }
    let Ok(aid) = reply_rx.await else { return };
    println!("[管理] {name} が管理ページに入りました ({ip})");
    let mut tokens = 20.0f32;
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
                tokens = (tokens + now.duration_since(last).as_secs_f32() * 10.0).min(20.0);
                last = now;
                if tokens < 1.0 {
                    continue;
                }
                tokens -= 1.0;
                if let Ok(m) = serde_json::from_str::<AdminMsg>(&text)
                    && st.events.send(Event::AdminMsg(aid, m)).await.is_err()
                {
                    break;
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
    let _ = st.events.send(Event::AdminLeave(aid)).await;
    println!("[管理] {name} が管理ページを閉じました");
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

struct AdminConn {
    name: String,
    tx: mpsc::Sender<Arc<str>>,
}

fn json<T: serde::Serialize>(v: &T) -> Option<Arc<str>> {
    serde_json::to_string(v).ok().map(Arc::from)
}

/// The room's state for admins, with each player's ping.
fn admin_state(room: &Room, pings: &HashMap<ClientId, f32>) -> vimfps_core::protocol::AdminState {
    let mut st = room.admin_state();
    for p in &mut st.players {
        p.ping = pings.get(&p.id).map(|ms| ms.round());
    }
    st
}

/// Disconnects a player (the admin's kick): a last word, then the socket
/// closes once its queue is sent.
fn kick(
    room: &mut Room,
    clients: &mut HashMap<ClientId, mpsc::Sender<Arc<str>>>,
    pings: &mut HashMap<ClientId, f32>,
    id: ClientId,
) {
    if let Some(tx) = clients.remove(&id)
        && let Some(msg) = json(&ServerMsg::Sys {
            text: "管理者によって退出させられました".into(),
        })
    {
        let _ = tx.try_send(msg);
    }
    pings.remove(&id);
    room.leave(id);
}

/// One admin command line (the terminal's, or `:` on the admin page).
fn run_line(
    room: &mut Room,
    clients: &mut HashMap<ClientId, mpsc::Sender<Arc<str>>>,
    pings: &mut HashMap<ClientId, f32>,
    who: &str,
    line: &str,
) -> Result<String, String> {
    if matches!(line.trim(), "status" | "s") {
        return Ok(crate::admin::status(&admin_state(room, pings)));
    }
    match crate::admin::parse_line(room, line)? {
        None => Ok(String::new()),
        Some(AdminMsg::Command { .. }) => Err("入れ子のコマンドです".into()),
        Some(msg) => {
            let (r, effect) = crate::admin::apply(room, who, msg);
            if let crate::admin::Effect::Kick(id) = effect {
                kick(room, clients, pings, id);
            }
            r
        }
    }
}

async fn game_loop(cfg: Config, mut events: mpsc::Receiver<Event>, server_name: String) {
    let mut room = Room::new(cfg);
    let mut clients: HashMap<ClientId, mpsc::Sender<Arc<str>>> = HashMap::new();
    let mut admins: HashMap<u32, AdminConn> = HashMap::new();
    let mut next_admin = 1u32;
    let mut pings: HashMap<ClientId, f32> = HashMap::new();
    let mut interval = tokio::time::interval(Duration::from_secs_f32(1.0 / TICK_RATE));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last = Instant::now();
    let mut ticks = 0u64;
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
                        if let ClientMsg::Ping { rtt: Some(ms), .. } = &m
                            && ms.is_finite()
                        {
                            pings.insert(id, ms.clamp(0.0, 9999.0));
                        }
                        // Bots are the admin's (practice mode only otherwise).
                        if !matches!(m, ClientMsg::Join { .. } | ClientMsg::Bots { .. } | ClientMsg::BotSkill { .. }) {
                            room.handle(id, m);
                        }
                    }
                    Event::Leave(id) => {
                        clients.remove(&id);
                        pings.remove(&id);
                        room.leave(id);
                    }
                    Event::AdminJoin { name, tx, reply } => {
                        let aid = next_admin;
                        next_admin += 1;
                        let welcome = AdminOut::AdminWelcome {
                            name: name.clone(),
                            server: server_name.clone(),
                            version: vimfps_core::VERSION.into(),
                            map: Box::new(room.map.clone()),
                            specs: Box::new(Specs::current()),
                        };
                        if let Some(m) = json(&welcome) {
                            let _ = tx.try_send(m);
                        }
                        admins.insert(aid, AdminConn { name, tx });
                        room.refresh();
                        let _ = reply.send(aid);
                    }
                    Event::AdminLeave(aid) => {
                        admins.remove(&aid);
                    }
                    Event::AdminMsg(aid, msg) => {
                        let Some(name) = admins.get(&aid).map(|a| a.name.clone()) else { continue };
                        let r = match msg {
                            // A `:` line from the page: the terminal's commands.
                            AdminMsg::Command { line } => run_line(&mut room, &mut clients, &mut pings, &name, &line),
                            msg => {
                                let (r, effect) = crate::admin::apply(&mut room, &name, msg);
                                if let crate::admin::Effect::Kick(id) = effect {
                                    kick(&mut room, &mut clients, &mut pings, id);
                                }
                                r
                            }
                        };
                        let (ok, text) = match r {
                            Ok(t) => (true, t),
                            Err(t) => (false, t),
                        };
                        println!("[管理] {name}: {text}");
                        if let (Some(a), Some(m)) = (admins.get(&aid), json(&AdminOut::AdminReply { ok, text })) {
                            let _ = a.tx.try_send(m);
                        }
                    }
                    Event::Terminal { line, reply } => {
                        let text = match run_line(&mut room, &mut clients, &mut pings, "ホスト", &line) {
                            Ok(t) => t,
                            Err(t) => format!("できません: {t}"),
                        };
                        let _ = reply.send(text);
                    }
                }
            }
            _ = interval.tick() => {
                let now = Instant::now();
                let dt = now.duration_since(last).as_secs_f32();
                last = now;
                room.tick(dt);
                ticks += 1;
                let mut slow = Vec::new();
                let mut gone = Vec::new();
                for (to, msg) in room.drain() {
                    let Some(json) = json(&msg) else { continue };
                    match to {
                        Target::All => {
                            for (id, tx) in &clients {
                                if tx.try_send(json.clone()).is_err() {
                                    slow.push(*id);
                                }
                            }
                            // Admins see all that happens (a full queue
                            // only loses a message).
                            for (aid, a) in &admins {
                                if let Err(mpsc::error::TrySendError::Closed(_)) = a.tx.try_send(json.clone()) {
                                    gone.push(*aid);
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
                // Admins: the whole state 20 times a second.
                if !admins.is_empty() && ticks.is_multiple_of(3)
                    && let Some(m) = json(&AdminOut::AdminState { state: Box::new(admin_state(&room, &pings)) })
                {
                    for (aid, a) in &admins {
                        if let Err(mpsc::error::TrySendError::Closed(_)) = a.tx.try_send(m.clone()) {
                            gone.push(aid.to_owned());
                        }
                    }
                }
                for aid in gone {
                    admins.remove(&aid);
                }
                // A client that cannot keep up is dropped (its socket task
                // ends when the sender goes away).
                for id in slow {
                    if clients.remove(&id).is_some() {
                        pings.remove(&id);
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
