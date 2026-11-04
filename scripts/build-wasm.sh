#!/usr/bin/env bash
# Builds the browser practice mode (crates/vimfps-wasm) into web/pkg/.
# Run before building the CLI: the CLI embeds web/ (with this file) and
# GitHub Pages publishes it.
set -euo pipefail
cd "$(dirname "$0")/.."
if command -v rustup > /dev/null; then
  rustup target add wasm32-unknown-unknown > /dev/null 2>&1 || true
fi
cargo build -p vimfps-wasm --target wasm32-unknown-unknown --release --locked
mkdir -p web/pkg
cp target/wasm32-unknown-unknown/release/vimfps_wasm.wasm web/pkg/vimfps.wasm
echo "web/pkg/vimfps.wasm: $(wc -c < web/pkg/vimfps.wasm) bytes"
