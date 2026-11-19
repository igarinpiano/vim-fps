// .vimfpsrc: everything you set, in one text file, written like Vim's
// vimrc. One command per line; `"` starts a comment; a leading `:` is
// allowed. The browser reads `set`, `skin` and `custom`; `vimfps host` reads
// `host` (and the browser keeps those lines so :mkvimrc writes them back).
//
//   set adssens=30 forward=j
//   skin my-skin
//   custom bots=8 skill=4 rule=last
//   host bots=5 time-limit=15 tunnel password=合言葉
//
// Pure module: no DOM, testable with node --test. The same syntax is read
// by the CLI (crates/vimfps/src/rc.rs).

export const RC_NAME = '.vimfpsrc';
export const DOC_URL = 'https://igarinpiano.github.io/vim-fps/docs/config.html';

/// File names taken for a .vimfpsrc when dropped: .vimfpsrc, _vimfpsrc (as
/// Vim's _vimrc on Windows), vimfpsrc (browsers may drop the dot when
/// saving), with or without .txt; or any *.vim.
export function isRcName(name) {
  const base = String(name || '').split(/[\\/]/).pop().toLowerCase();
  return /^[._]?vimfpsrc(\.txt)?$/.test(base) || base.endsWith('.vim');
}

/// Splits a line into words. `\` takes the next character literally (so
/// `name=a\ b` is one word); `"` at the start of a word starts a comment.
export function tokenize(line) {
  const out = [];
  let cur = '';
  let has = false;
  const s = String(line);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (c === '"' && !has) {
      break;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

/// A word written so that tokenize() reads it back unchanged.
export function escapeWord(w) {
  const s = String(w).replace(/[\\\s]/g, (c) => `\\${c}`);
  return s.startsWith('"') ? `\\${s}` : s;
}

/// Text → [{ line, cmd, args, raw }] (blank and comment lines left out).
export function parseRc(text) {
  const out = [];
  String(text || '')
    .replace(/^﻿/, '')
    .split(/\r\n|\r|\n/)
    .forEach((rawLine, i) => {
      let line = rawLine.trim();
      while (line.startsWith(':')) line = line.slice(1).trimStart();
      const words = tokenize(line);
      if (!words.length) return;
      out.push({ line: i + 1, cmd: words[0], args: words.slice(1), raw: line });
    });
  return out;
}

/// Runs parsed lines through handlers: { set(args), skin(args),
/// custom(args), host(raw) }, each returning an error message or null.
/// Returns the errors, as "3: E518: ..." (line numbers).
export function applyRc(cmds, handlers) {
  const errors = [];
  for (const c of cmds) {
    let err = null;
    switch (c.cmd) {
      case 'se':
      case 'set':
        err = handlers.set(c.args);
        break;
      case 'skin':
        err = handlers.skin(c.args);
        break;
      case 'custom':
        err = handlers.custom(c.args);
        break;
      case 'host':
        err = handlers.host(c.raw);
        break;
      default:
        err = `E492: Not an editor command: ${c.raw}`;
    }
    if (err) errors.push(`${c.line}: ${err}`);
  }
  return errors;
}

// ---------------------------------------------------------------- custom match

/// The custom match (the form on the title screen), and what each value
/// may be: [min, max] for numbers, a list for words.
/// Most bots in the browser (it runs and draws the match itself; a host
/// takes up to 500). Kept equal to MAX_BOTS_BROWSER in crates/vimfps-core.
export const MAX_BOTS_BROWSER = 100;

export const CUSTOM_DEFAULTS = { bots: 5, skill: 3, rule: 'ffa', time: 10, frags: 25, ring: 'on', tanks: 'on', seed: 0 };
export const CUSTOM_SPEC = {
  bots: [0, MAX_BOTS_BROWSER],
  skill: [1, 5],
  rule: ['ffa', 'last'],
  time: [1, 60],
  frags: [0, 100],
  ring: ['on', 'off'],
  tanks: ['on', 'off'],
  seed: [0, 99999],
};

/// `custom bots=8 rule=last` into `custom` (changed in place). Returns an
/// error message or null; nothing changes on an error.
export function customCommand(args, custom) {
  const next = {};
  for (const a of args) {
    const m = a.match(/^([a-z]+)=(.*)$/);
    if (!m || !CUSTOM_SPEC[m[1]]) return `E518: Unknown custom option: ${a} (${Object.keys(CUSTOM_SPEC).join(' / ')})`;
    const spec = CUSTOM_SPEC[m[1]];
    if (typeof spec[0] === 'number') {
      const n = Number(m[2]);
      if (m[2] === '' || !Number.isInteger(n) || n < spec[0] || n > spec[1]) return `E474: Invalid argument: ${a} (${spec[0]}〜${spec[1]})`;
      next[m[1]] = n;
    } else {
      if (!spec.includes(m[2])) return `E474: Invalid argument: ${a} (${spec.join(' / ')})`;
      next[m[1]] = m[2];
    }
  }
  Object.assign(custom, next);
  return null;
}

// ---------------------------------------------------------------- writing

/// The whole state as a .vimfpsrc (what :mkvimrc writes). state:
/// { set: ['adssens=30', ...], skin: 'name' | null, custom: {...},
///   host: ['host bots=5', ...], skinDir: bool (a skin/ folder goes with it) }
export function buildRc(state) {
  const L = [];
  L.push('" vim-fps の設定ファイル (.vimfpsrc)');
  L.push('" ブラウザー: :source で読み込み、:mkvimrc で書き出し。vimfps host は ~/.vimfpsrc の host の行を読みます。');
  L.push(`" 書き方: ${DOC_URL}`);
  L.push('');
  L.push('" ---- 設定 (:set)。初期値に戻してから、変えたものだけを書いています');
  L.push('set all&');
  for (const a of state.set || []) L.push(`set ${escapeWord(a)}`);
  L.push('');
  L.push('" ---- スキン (このブラウザーに入れたスキンの名前。off で使わない)');
  L.push(`skin ${state.skin ? escapeWord(state.skin) : 'off'}`);
  L.push('');
  L.push('" ---- カスタムマッチ (タイトル画面のフォームの値)');
  const c = { ...CUSTOM_DEFAULTS, ...(state.custom || {}) };
  L.push(`custom ${Object.keys(CUSTOM_DEFAULTS).map((k) => `${k}=${c[k]}`).join(' ')}`);
  L.push('');
  L.push('" ---- ホスト (vimfps host が読みます。ブラウザーでは使いません)');
  if (state.host && state.host.length) for (const h of state.host) L.push(h);
  else L.push('" host bots=5 bot-skill=3 time-limit=10 frag-limit=25');
  if (state.skinDir) L.push('" host skin=./skin    " この zip を展開して vimfps host --config で使うとき、全員にこのスキンを配る');
  L.push('');
  return L.join('\n');
}
