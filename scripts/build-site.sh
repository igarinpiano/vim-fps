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
import hashlib, json, os, re
root = "dist/site"

# Cache busting: GitHub Pages lets browsers keep files for 10 minutes, and a
# page mixing old and new modules breaks. Every URL between our own files
# gets ?v=<hash of the whole client>, so a new build is a new set of URLs.
h = hashlib.sha256()
for d, _, names in sorted(os.walk(root)):
    for n in sorted(names):
        with open(os.path.join(d, n), "rb") as f:
            h.update(n.encode() + f.read())
tag = h.hexdigest()[:10]
ref = re.compile(r"""((?:from\s+|import\(\s*|new URL\(\s*)['"])(\.{1,2}/[^'"?]+\.(?:js|wasm))(['"])""")
for d, _, names in os.walk(os.path.join(root, "js")):
    for n in names:
        if n.endswith(".js"):
            p = os.path.join(d, n)
            src = open(p, encoding="utf-8").read()
            open(p, "w", encoding="utf-8").write(ref.sub(lambda m: f"{m[1]}{m[2]}?v={tag}{m[3]}", src))
idx = os.path.join(root, "index.html")
html = open(idx, encoding="utf-8").read()
html = html.replace('src="js/main.js"', f'src="js/main.js?v={tag}"').replace('href="style.css"', f'href="style.css?v={tag}"')
open(idx, "w", encoding="utf-8").write(html)
print(f"cache-busting tag: {tag}")
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

# The installers, served next to the client:
#   curl -fsSL https://igarinpiano.github.io/vim-fps/install.sh | sh
#   irm https://igarinpiano.github.io/vim-fps/install.ps1 | iex
cp scripts/install.sh scripts/install.ps1 dist/site/
