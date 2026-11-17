#!/usr/bin/env python3
"""Turns a page of docs/ (Markdown) into a standalone HTML page for the site.

    python3 scripts/md2html.py docs/config.md dist/site/docs/config.html

Covers what the docs use: headings (with GitHub-style anchors), paragraphs,
lists, fenced code, tables, rules, `code`, **bold**, [links](url). No
dependencies, so the Pages workflow needs nothing installed.
"""
import html
import re
import sys

STYLE = """
:root { --title-a: #0a5ee8; --title-b: #3d95ff; --title-c: #0645c8; --window: #ece9d8; --edge: #0b45b8;
  --text: #111; --muted: #555; --code: #fff; --rule: #b9b3a0; --link: #0645c8; --bg: #3a6ea5; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --window: #23252b; --edge: #2f5fbf; --text: #e6e6e6; --muted: #a0a0a0;
    --code: #15171b; --rule: #44474f; --link: #8ab4ff; --bg: #12243a; }
}
* { box-sizing: border-box; }
html { background: var(--bg); }
body { margin: 0; padding: 24px 16px 48px; font: 15px/1.7 system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif; color: var(--text); }
.window { max-width: 920px; margin: 0 auto; background: var(--window); border: 3px solid var(--edge); border-top-width: 0;
  border-radius: 8px 8px 2px 2px; box-shadow: 2px 3px 12px rgba(0,0,0,.45); }
.titlebar { display: flex; justify-content: space-between; align-items: center; gap: 12px; min-height: 30px; padding: 2px 10px;
  color: #fff; font-weight: 700; font-size: 14px; text-shadow: 1px 1px 0 #0a2a7a; border-radius: 7px 7px 0 0;
  background: linear-gradient(180deg, var(--title-b) 0%, var(--title-a) 12%, var(--title-a) 70%, var(--title-c) 100%); }
.titlebar a { color: #fff; font-weight: 400; font-size: 13px; }
main { padding: 8px 28px 28px; }
@media (max-width: 640px) { main { padding: 4px 14px 20px; } body { padding: 12px 8px 32px; } }
h1 { font-size: 26px; margin: 18px 0 12px; }
h2 { font-size: 21px; margin: 34px 0 10px; padding-bottom: 4px; border-bottom: 2px solid var(--rule); }
h3 { font-size: 17px; margin: 26px 0 8px; }
a { color: var(--link); }
code { font: 13px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, "Noto Sans Mono", monospace; background: var(--code);
  border: 1px solid var(--rule); border-radius: 3px; padding: 0 4px; }
pre { background: var(--code); border: 1px solid var(--rule); border-radius: 4px; padding: 10px 12px; overflow-x: auto; }
pre code { border: 0; padding: 0; background: none; }
.table { overflow-x: auto; margin: 12px 0; }
table { border-collapse: collapse; min-width: 60%; font-size: 14px; }
th, td { border: 1px solid var(--rule); padding: 4px 10px; text-align: left; vertical-align: top; }
th { background: color-mix(in srgb, var(--rule) 35%, transparent); }
hr { border: 0; border-top: 1px solid var(--rule); margin: 28px 0; }
ul { padding-left: 1.4em; }
"""


def slug(text):
    """GitHub's heading anchors: lower case, punctuation out, spaces to -."""
    text = re.sub(r"[`*]", "", text).lower()
    return re.sub(r"[^\w\- ]", "", text).replace(" ", "-")


def inline(s):
    out = []
    for i, part in enumerate(re.split(r"(`[^`]*`)", s)):
        if i % 2:
            out.append(f"<code>{html.escape(part[1:-1])}</code>")
            continue
        t = html.escape(part, quote=False)
        t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
        t = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", lambda m: f'<a href="{html.escape(m[2])}">{m[1]}</a>', t)
        out.append(t)
    return "".join(out)


def cells(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def convert(md):
    lines = md.splitlines()
    out = []
    title = None
    i = 0
    para = []

    def flush():
        if para:
            out.append(f"<p>{inline(' '.join(para))}</p>")
            para.clear()

    while i < len(lines):
        line = lines[i]
        if line.startswith("```"):
            flush()
            lang = line[3:].strip()
            body = []
            i += 1
            while i < len(lines) and not lines[i].startswith("```"):
                body.append(lines[i])
                i += 1
            cls = f' class="language-{html.escape(lang)}"' if lang else ""
            out.append(f"<pre><code{cls}>{html.escape(chr(10).join(body))}</code></pre>")
            i += 1
            continue
        m = re.match(r"^(#{1,4})\s+(.*)$", line)
        if m:
            flush()
            n, text = len(m[1]), m[2].strip()
            if n == 1 and title is None:
                title = re.sub(r"[`*]", "", text)
            out.append(f'<h{n} id="{html.escape(slug(text))}">{inline(text)}</h{n}>')
            i += 1
            continue
        if line.strip() == "---":
            flush()
            out.append("<hr>")
            i += 1
            continue
        if line.startswith("|") and i + 1 < len(lines) and re.match(r"^\|[\s:|-]+\|\s*$", lines[i + 1]):
            flush()
            head = cells(line)
            rows = []
            i += 2
            while i < len(lines) and lines[i].startswith("|"):
                rows.append(cells(lines[i]))
                i += 1
            t = ["<div class=\"table\"><table><thead><tr>", *(f"<th>{inline(c)}</th>" for c in head), "</tr></thead><tbody>"]
            for r in rows:
                t.append("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>")
            t.append("</tbody></table></div>")
            out.append("".join(t))
            continue
        if re.match(r"^\s*[-*]\s+", line):
            flush()
            items = []
            while i < len(lines) and re.match(r"^\s*[-*]\s+", lines[i]):
                item = re.sub(r"^\s*[-*]\s+", "", lines[i])
                i += 1
                # Continuation lines (indented, not a new item).
                while i < len(lines) and lines[i].startswith("  ") and not re.match(r"^\s*[-*]\s+", lines[i]) and lines[i].strip():
                    item += " " + lines[i].strip()
                    i += 1
                items.append(f"<li>{inline(item)}</li>")
            out.append("<ul>" + "".join(items) + "</ul>")
            continue
        if not line.strip():
            flush()
            i += 1
            continue
        para.append(line.strip())
        i += 1
    flush()
    return title or "vim-fps", "\n".join(out)


def page(title, body):
    return f"""<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)} — vim-fps</title>
<style>{STYLE}</style>
</head>
<body>
<div class="window">
<div class="titlebar"><span>{html.escape(title)} — vim-fps</span><a href="../">ゲームを開く</a></div>
<main>
{body}
</main>
</div>
</body>
</html>
"""


def main():
    if len(sys.argv) != 3:
        sys.exit("usage: md2html.py IN.md OUT.html")
    with open(sys.argv[1], encoding="utf-8") as f:
        title, body = convert(f.read())
    with open(sys.argv[2], "w", encoding="utf-8") as f:
        f.write(page(title, body))


if __name__ == "__main__":
    main()
