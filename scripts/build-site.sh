#!/usr/bin/env bash
# Assembles the static site published on GitHub Pages into dist/site/,
# with manifest.json: the file list that `vimfps host` downloads to serve the
# latest client (see crates/vimfps/src/webclient.rs).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f web/pkg/vimfps.wasm ] || bash scripts/build-wasm.sh
rm -rf dist/site
mkdir -p dist/site
cp -r web/. dist/site/
touch dist/site/.nojekyll
python3 - <<'PY'
import json, os, re
root = "dist/site"
version = re.search(r"VERSION = '([^']+)'", open("web/js/version.js").read()).group(1)
protocol = int(re.search(r"PROTOCOL = (\d+)", open("web/js/net.js").read()).group(1))
files = []
for d, _, names in os.walk(root):
    for n in names:
        p = os.path.relpath(os.path.join(d, n), root).replace(os.sep, "/")
        if p.startswith(".") or p == "manifest.json":
            continue
        files.append(p)
files.sort()
json.dump({"version": version, "protocol": protocol, "files": files}, open(f"{root}/manifest.json", "w"), indent=1)
print(f"dist/site: v{version}, protocol {protocol}, {len(files)} files")
PY
