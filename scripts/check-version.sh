#!/usr/bin/env bash
# The web client states its version in web/js/version.js; it must equal the
# workspace version in Cargo.toml (the CLI embeds the client).
set -euo pipefail
cd "$(dirname "$0")/.."
cargo_v="$(sed -n '/^\[workspace.package\]/,/^\[/{s/^version *= *"\(.*\)"/\1/p}' Cargo.toml | head -1)"
web_v="$(sed -n "s/^export const VERSION = '\(.*\)';/\1/p" web/js/version.js)"
echo "Cargo.toml: $cargo_v / web/js/version.js: $web_v"
if [ -z "$cargo_v" ] || [ "$cargo_v" != "$web_v" ]; then
  echo "::error::web/js/version.js ($web_v) must match the workspace version ($cargo_v)"
  exit 1
fi

# The protocol number: crates/vimfps-core (server, wasm) and web/js/net.js.
core_p="$(sed -n 's/^pub const PROTOCOL: u32 = \([0-9]*\);/\1/p' crates/vimfps-core/src/protocol.rs)"
web_p="$(sed -n 's/^export const PROTOCOL = \([0-9]*\);/\1/p' web/js/net.js)"
echo "protocol: core $core_p / web/js/net.js $web_p"
if [ -z "$core_p" ] || [ "$core_p" != "$web_p" ]; then
  echo "::error::web/js/net.js PROTOCOL ($web_p) must match crates/vimfps-core ($core_p)"
  exit 1
fi
