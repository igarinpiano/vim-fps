#!/bin/sh
# vim-fps installer for Linux, macOS, FreeBSD, NetBSD, illumos and Android
# (Termux). Downloads the release archive for this machine from GitHub
# Releases, checks it against SHA256SUMS and puts `vimfps` on your PATH.
#
#   curl -fsSL https://igarinpiano.github.io/vim-fps/install.sh | sh
#
# Environment:
#   VIMFPS_VERSION      version to install (e.g. 1.1.1; default: latest)
#   VIMFPS_INSTALL_DIR  where to put the binary (default: ~/.local/bin, or
#                       $PREFIX/bin on Termux)
#   VIMFPS_TARGET       override the detected target triple
#   GITHUB_TOKEN        optional, raises the GitHub API rate limit
set -eu

REPO="igarinpiano/vim-fps"
BIN="vimfps"

say() { printf '%s\n' "$*"; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

have() { command -v "$1" > /dev/null 2>&1; }

fetch() { # url [output]
  if have curl; then
    if [ -n "${2:-}" ]; then curl -fsSL --retry 3 -o "$2" "$1"; else curl -fsSL --retry 3 "$1"; fi
  elif have wget; then
    if [ -n "${2:-}" ]; then wget -q -O "$2" "$1"; else wget -q -O - "$1"; fi
  else
    die "curl か wget が必要です"
  fi
}

api() { # GitHub API (authenticated when GITHUB_TOKEN is set)
  if [ -n "${GITHUB_TOKEN:-}" ] && have curl; then
    curl -fsSL --retry 3 -H "Authorization: Bearer $GITHUB_TOKEN" "$1"
  else
    fetch "$1"
  fi
}

sha256() {
  if have sha256sum; then
    sha256sum "$1" | awk '{print $1}'
  elif have shasum; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif have sha256; then
    sha256 -q "$1"
  elif have digest; then
    digest -a sha256 "$1"
  elif have openssl; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    die "SHA-256 を計算するコマンド (sha256sum / shasum / sha256 / digest / openssl) がありません"
  fi
}

detect_target() {
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$arch" in
    x86_64 | amd64) arch=x86_64 ;;
    aarch64 | arm64) arch=aarch64 ;;
    armv7* | armv8l) arch=armv7 ;;
    armv6* | arm) arch=arm ;;
    i386 | i486 | i586 | i686 | i86pc) arch=i686 ;;
    riscv64) arch=riscv64gc ;;
    ppc64le) arch=powerpc64le ;;
    s390x) arch=s390x ;;
    loongarch64) arch=loongarch64 ;;
    *) die "この CPU ($arch) 向けのビルドはありません" ;;
  esac
  case "$os" in
    Linux)
      if [ "$(uname -o 2> /dev/null || true)" = Android ] || [ -n "${TERMUX_VERSION:-}" ]; then
        case "$arch" in
          aarch64 | x86_64 | i686) echo "$arch-linux-android" ;;
          armv7 | arm) echo "armv7-linux-androideabi" ;;
          *) die "Android ($arch) 向けのビルドはありません" ;;
        esac
      else
        # Static musl builds where they exist: they run on any distribution.
        case "$arch" in
          x86_64 | aarch64 | i686) echo "$arch-unknown-linux-musl" ;;
          armv7) echo "armv7-unknown-linux-musleabihf" ;;
          arm) echo "arm-unknown-linux-musleabihf" ;;
          *) echo "$arch-unknown-linux-gnu" ;;
        esac
      fi
      ;;
    Darwin)
      case "$arch" in
        aarch64) echo "aarch64-apple-darwin" ;;
        x86_64) echo "x86_64-apple-darwin" ;;
        *) die "macOS ($arch) 向けのビルドはありません" ;;
      esac
      ;;
    FreeBSD | NetBSD)
      [ "$arch" = x86_64 ] || die "$os ($arch) 向けのビルドはありません"
      if [ "$os" = FreeBSD ]; then echo "x86_64-unknown-freebsd"; else echo "x86_64-unknown-netbsd"; fi
      ;;
    SunOS) echo "x86_64-unknown-illumos" ;;
    MINGW* | MSYS* | CYGWIN*) die "Windows では PowerShell で: irm https://raw.githubusercontent.com/igarinpiano/vim-fps/main/scripts/install.ps1 | iex" ;;
    *) die "この OS ($os) 向けのビルドはありません" ;;
  esac
}

main() {
  target="${VIMFPS_TARGET:-$(detect_target)}"
  version="${VIMFPS_VERSION:-}"
  if [ -z "$version" ]; then
    version="$(api "https://api.github.com/repos/$REPO/releases/latest" \
      | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)"
    [ -n "$version" ] || die "最新のバージョンを取得できません"
  fi
  version="${version#v}"
  name="$BIN-$version-$target"
  base="https://github.com/$REPO/releases/download/v$version"

  if [ -n "${VIMFPS_INSTALL_DIR:-}" ]; then
    dir="$VIMFPS_INSTALL_DIR"
  elif [ -n "${TERMUX_VERSION:-}" ] && [ -n "${PREFIX:-}" ]; then
    dir="$PREFIX/bin"
  else
    dir="$HOME/.local/bin"
  fi

  say "vim-fps v$version ($target) を $dir にインストールします"
  tmp="$(mktemp -d 2> /dev/null || mktemp -d -t vimfps)"
  trap 'rm -rf "$tmp"' EXIT INT TERM
  fetch "$base/$name.tar.gz" "$tmp/$name.tar.gz" || die "$base/$name.tar.gz をダウンロードできません"
  fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || die "SHA256SUMS をダウンロードできません"
  want="$(awk -v f="$name.tar.gz" '$2 == f || $2 == "*" f {print $1}' "$tmp/SHA256SUMS")"
  got="$(sha256 "$tmp/$name.tar.gz")"
  [ -n "$want" ] || die "SHA256SUMS に $name.tar.gz がありません"
  [ "$want" = "$got" ] || die "SHA-256 が一致しません (期待 $want, 実際 $got)"
  say "SHA-256 を確認しました"

  tar -xzf "$tmp/$name.tar.gz" -C "$tmp"
  mkdir -p "$dir"
  cp "$tmp/$name/$BIN" "$dir/$BIN.new"
  chmod 755 "$dir/$BIN.new"
  mv -f "$dir/$BIN.new" "$dir/$BIN"
  say "インストールしました: $dir/$BIN"
  "$dir/$BIN" --version || true

  case ":$PATH:" in
    *":$dir:"*) ;;
    *)
      say ""
      say "$dir が PATH にありません。シェルの設定ファイル (~/.bashrc / ~/.zshrc など) に次を追加してください:"
      say "  export PATH=\"$dir:\$PATH\""
      ;;
  esac
  say ""
  say "ホストを立てる: vimfps host    更新: vimfps update"
}

main "$@"
