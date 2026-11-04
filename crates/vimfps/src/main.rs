//! vimfps — CLI host of vim-fps.
//!
//!   vimfps host [--port 7777] [--tunnel] [--bots N] [--password PW]
//!   vimfps update [--check] [--yes]

mod server;
mod tunnel;
mod update;
mod webclient;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "vimfps",
    version,
    about = "vim-fps: Vimのキーで遊ぶ、マウス禁止のブラウザFPS — マルチプレイのホスト",
    long_about = None
)]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// サーバーを立てる (LAN、--tunnel で Cloudflare Quick Tunnel も)
    Host(server::HostArgs),
    /// 最新版に更新する (GitHub Releases から)
    Update(update::UpdateArgs),
}

fn main() {
    let cli = Cli::parse();
    let code = match cli.cmd {
        Some(Cmd::Update(a)) => update::run(&a),
        Some(Cmd::Host(a)) => server::run(a),
        // No subcommand (e.g. double-clicked): host with the defaults.
        None => server::run(server::HostArgs::default()),
    };
    std::process::exit(code);
}
