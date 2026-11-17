// Skins: the look and sound of the game in one folder (or one zip), described
// by skin.json:
//
//   {
//     "name": "my-skin",
//     "textures": { "ground": "textures/grass.png",
//                   "wall": { "file": "textures/brick.jpg", "size": 3 } },
//     "sounds":   { "startup": "sounds/boot.wav", "error2": "sounds/hit.ogg" },
//     "ui":       { "window": "#ece9d8", "crosshair": "#00ff66" }
//   }
//
// Skins stack, each over the one before, item by item (what a skin leaves
// out comes from the layer below):
//   1. the one served with the game (web/assets/skin.json),
//   2. the host's (`vimfps host --skin DIR`, served at skin/),
//   3. yours (kept in this browser; `:skin`),
//   4. single textures set with `:texture` (textures only).
//
// Pure where it can be (the manifest, zip files) so it is testable with
// node --test; the store takes `indexedDB` as an argument.

import { TEXTURE_SLOTS, MAX_TEXTURE_BYTES, slotOf, openDb } from './textures.js';
import { EVENT_SOUNDS } from './audio.js';
import { isRcName } from './rc.js';

/// The colours (and fonts) a skin may set: CSS variables of style.css.
export const UI_VARS = {
  bg: 'デスクトップ (背景)',
  window: 'ウィンドウの地',
  'window-edge': 'ウィンドウの枠',
  'title-a': 'タイトルバー (中央)',
  'title-b': 'タイトルバー (上端)',
  'title-c': 'タイトルバー (下端)',
  text: '文字',
  muted: '薄い文字 (ヒント)',
  select: '選択中の行',
  'taskbar-a': 'タスクバー (上)',
  'taskbar-b': 'タスクバー (下)',
  'start-a': 'スタートボタン (上)',
  'start-b': 'スタートボタン (下)',
  tray: 'タスクバー右端',
  crosshair: '照準',
  font: '文字のフォント',
  mono: '等幅フォント',
};

export const MAX_SKIN_BYTES = 64 * 1024 * 1024;
export const MAX_SKIN_FILES = 300;
const SOUND_EXT = /\.(wav|mp3|ogg)$/i;

/// A file path inside a skin: plain names separated by `/`, nothing hidden
/// (no segment starting with `.`, so no `..`), no URL.
export function safeSkinPath(p) {
  return typeof p === 'string' && p.length > 0 && p.length < 200 && /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/.test(p);
}

/// A CSS value a skin may give a variable: no way out of the declaration and
/// nothing fetched (no url(), no @import).
export function safeCssValue(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > 160 || /[;{}<>\\]|url\s*\(|@import|expression\s*\(/i.test(s)) return null;
  return s;
}

/// A skin's name: what `skin <name>` in .vimfpsrc picks. Spaces become `-`.
export function skinName(v, fallback = 'my-skin') {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, '-').replace(/[\u0000-\u001f"\\/]/g, '').slice(0, 40) : '';
  return s && s !== 'off' ? s : fallback;
}

/// skin.json → { name, textures: { slot: { file, size } }, sounds: { event:
/// file }, ui: { var: value }, warnings: [] }. Unknown keys, unsafe paths
/// and values are left out (with a warning).
export function parseSkin(json, fallbackName) {
  const out = { name: skinName(json && json.name, fallbackName), textures: {}, sounds: {}, ui: {}, warnings: [] };
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    out.warnings.push('skin.json の中身がオブジェクト ({ ... }) ではありません');
    return out;
  }
  const t = json.textures && typeof json.textures === 'object' ? json.textures : {};
  for (const [slot, v] of Object.entries(t)) {
    if (!TEXTURE_SLOTS[slot]) {
      out.warnings.push(`textures.${slot}: 貼る場所が分かりません (${Object.keys(TEXTURE_SLOTS).join(' / ')})`);
      continue;
    }
    const file = typeof v === 'string' ? v : v && typeof v.file === 'string' ? v.file : null;
    if (!safeSkinPath(file)) {
      out.warnings.push(`textures.${slot}: ファイル名が使えません: ${JSON.stringify(file)}`);
      continue;
    }
    const size = v && typeof v === 'object' && Number.isFinite(v.size) && v.size >= 0.1 && v.size <= 500 ? v.size : null;
    out.textures[slot] = { file, size };
  }
  const s = json.sounds && typeof json.sounds === 'object' ? json.sounds : {};
  for (const [ev, file] of Object.entries(s)) {
    if (!EVENT_SOUNDS[ev]) {
      out.warnings.push(`sounds.${ev}: 場面が分かりません (${Object.keys(EVENT_SOUNDS).join(' / ')})`);
      continue;
    }
    if (!safeSkinPath(file)) {
      out.warnings.push(`sounds.${ev}: ファイル名が使えません: ${JSON.stringify(file)}`);
      continue;
    }
    out.sounds[ev] = file;
  }
  const ui = json.ui && typeof json.ui === 'object' ? json.ui : {};
  for (const [k, v] of Object.entries(ui)) {
    if (!UI_VARS[k]) {
      out.warnings.push(`ui.${k}: 変えられる項目ではありません (${Object.keys(UI_VARS).join(' / ')})`);
      continue;
    }
    const val = safeCssValue(v);
    if (val == null) {
      out.warnings.push(`ui.${k}: 値が使えません: ${JSON.stringify(v)}`);
      continue;
    }
    out.ui[k] = val;
  }
  return out;
}

/// A manifest made up from file names, for a folder without skin.json:
/// ground.png, wall-brick.jpg → textures; startup.wav, error2.ogg → sounds.
export function inferSkin(paths, name) {
  const json = { name, textures: {}, sounds: {} };
  for (const p of paths) {
    const base = p.split('/').pop();
    const slot = slotOf(base);
    if (slot && !json.textures[slot]) json.textures[slot] = p;
    const ev = base.replace(SOUND_EXT, '');
    if (SOUND_EXT.test(base) && EVENT_SOUNDS[ev] && !json.sounds[ev]) json.sounds[ev] = p;
  }
  return Object.keys(json.textures).length || Object.keys(json.sounds).length ? json : null;
}

/// Files of a dropped folder or zip (Map: path → Blob) → what they hold:
/// { skin: a record to store (skinRecord) | null, rc: text | null }.
/// The skin is the folder holding the shallowest skin.json (or, without
/// one, files named after slots and sounds: ground.png, startup.wav); only
/// the files it names are kept. `fallbackName`: the zip's or folder's name.
export async function readBundle(files, fallbackName) {
  const paths = [...files.keys()].filter((p) => !p.split('/').some((seg) => seg === '__MACOSX' || seg.startsWith('._')));
  const depth = (p) => p.split('/').length;
  const byDepth = (a, b) => depth(a) - depth(b) || a.localeCompare(b);
  const rcPath = paths.filter((p) => isRcName(p)).sort(byDepth)[0] || null;
  const manifestPath = paths.filter((p) => p.split('/').pop().toLowerCase() === 'skin.json').sort(byDepth)[0] || null;
  const out = { skin: null, rc: rcPath ? await files.get(rcPath).text() : null };
  if (manifestPath) {
    let json;
    try {
      json = JSON.parse(await files.get(manifestPath).text());
    } catch (e) {
      throw new Error(`${manifestPath} を JSON として読めません: ${e.message || e}`);
    }
    out.skin = skinRecord(json, manifestPath.slice(0, manifestPath.length - 'skin.json'.length), files, fallbackName);
  } else {
    const inferred = inferSkin(paths, fallbackName);
    if (inferred) out.skin = skinRecord(inferred, '', files, fallbackName);
  }
  return out;
}

/// A skin.json (parsed) and the files it sits among → a record to store:
/// { name, manifest, files: { path: Blob }, warnings }.
export function skinRecord(json, root, files, fallbackName) {
  const m = parseSkin(json, fallbackName);
  const keep = {};
  let total = 0;
  const want = [...Object.values(m.textures).map((t) => t.file), ...Object.values(m.sounds)];
  for (const p of new Set(want)) {
    const blob = files.get(root + p);
    if (!blob) {
      m.warnings.push(`${p}: ファイルがありません`);
      continue;
    }
    if (blob.size > MAX_TEXTURE_BYTES) {
      m.warnings.push(`${p}: 大きすぎます (${Math.round(blob.size / 1048576)} MB、上限 ${MAX_TEXTURE_BYTES / 1048576} MB)`);
      continue;
    }
    total += blob.size;
    keep[p] = blob;
  }
  if (total > MAX_SKIN_BYTES) throw new Error(`スキンが大きすぎます (${Math.round(total / 1048576)} MB、上限 ${MAX_SKIN_BYTES / 1048576} MB)`);
  // What is stored is the manifest as read (only what passed), so an
  // export writes back a clean skin.json.
  const manifest = { name: m.name, textures: {}, sounds: {}, ui: m.ui };
  for (const [slot, t] of Object.entries(m.textures)) if (keep[t.file]) manifest.textures[slot] = t.size ? { file: t.file, size: t.size } : t.file;
  for (const [ev, f] of Object.entries(m.sounds)) if (keep[f]) manifest.sounds[ev] = f;
  return { name: m.name, manifest, files: keep, warnings: m.warnings };
}

/// One layer of the stack: { name, textures: { slot: { src, size, name } },
/// sounds: { event: src }, ui }. `resolve(path)` gives a URL string or a
/// Blob (null: missing, left out).
export function skinLayer(manifest, resolve, fallbackName) {
  const m = parseSkin(manifest, fallbackName);
  const layer = { name: m.name, textures: {}, sounds: {}, ui: m.ui, warnings: m.warnings };
  for (const [slot, t] of Object.entries(m.textures)) {
    const src = resolve(t.file);
    if (src) layer.textures[slot] = { src, size: t.size, name: t.file.split('/').pop() };
  }
  for (const [ev, f] of Object.entries(m.sounds)) {
    const src = resolve(f);
    if (src) layer.sounds[ev] = src;
  }
  return layer;
}

// ---------------------------------------------------------------- zip

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  json: 'application/json',
};
export function mimeOf(path) {
  const m = String(path).toLowerCase().match(/\.([a-z0-9]+)$/);
  return (m && MIME[m[1]]) || 'application/octet-stream';
}

async function inflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/// A zip file (ArrayBuffer) → Map: path → Blob. Stored and deflated entries;
/// no encryption, no zip64.
export async function readZip(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip ファイルとして読めません');
  const count = dv.getUint16(eocd + 10, true);
  if (count > MAX_SKIN_FILES * 4) throw new Error(`zip のファイルが多すぎます (${count} 個)`);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map();
  let total = 0;
  const utf8 = new TextDecoder('utf-8');
  for (let n = 0; n < count; n++) {
    if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('zip ファイルが壊れています');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = utf8.decode(u8.subarray(p + 46, p + 46 + nlen)).replace(/\\/g, '/');
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error('暗号化された zip は読めません');
    if (csize === 0xffffffff || usize === 0xffffffff) throw new Error('大きすぎる zip (zip64) は読めません');
    total += usize;
    if (total > MAX_SKIN_BYTES * 2) throw new Error(`zip が大きすぎます (上限 ${(MAX_SKIN_BYTES * 2) / 1048576} MB)`);
    if (local + 30 > u8.length || dv.getUint32(local, true) !== 0x04034b50) throw new Error('zip ファイルが壊れています');
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = u8.subarray(start, start + csize);
    let bytes;
    if (method === 0) bytes = data;
    else if (method === 8) bytes = await inflateRaw(data);
    else throw new Error(`${name}: この圧縮方式 (${method}) の zip は読めません`);
    out.set(name.replace(/^\/+/, ''), new Blob([bytes], { type: mimeOf(name) }));
  }
  return out;
}

let crcTable = null;
export function crc32(u8) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/// [{ path, data: Uint8Array | string }] → a zip Blob (stored, not
/// compressed: images and sounds are compressed already).
export function writeZip(entries, date = new Date()) {
  const enc = new TextEncoder();
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.path);
    const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    const crc = crc32(data);
    const head = (size, sig) => {
      const b = new Uint8Array(size + name.length);
      const v = new DataView(b.buffer);
      v.setUint32(0, sig, true);
      return [b, v];
    };
    const [lh, l] = head(30, 0x04034b50);
    l.setUint16(4, 20, true);
    l.setUint16(6, 0x800, true); // UTF-8 names
    l.setUint16(10, time, true);
    l.setUint16(12, day, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, data.length, true);
    l.setUint32(22, data.length, true);
    l.setUint16(26, name.length, true);
    lh.set(name, 30);
    const [ch, c] = head(46, 0x02014b50);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x800, true);
    c.setUint16(12, time, true);
    c.setUint16(14, day, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    ch.set(name, 46);
    parts.push(lh, data);
    central.push(ch);
    offset += lh.length + data.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = new Uint8Array(22);
  const v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, entries.length, true);
  v.setUint16(10, entries.length, true);
  v.setUint32(12, size, true);
  v.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

// ---------------------------------------------------------------- this browser

/// Your skins, kept in this browser: name → { name, manifest, files, added }.
export class SkinStore {
  constructor(idb) {
    this.idb = idb || null;
  }

  async run(mode, fn) {
    const db = await openDb(this.idb);
    return new Promise((resolve, reject) => {
      const tx = db.transaction('skins', mode);
      const req = fn(tx.objectStore('skins'));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async list() {
    const all = (await this.run('readonly', (s) => s.getAll())) || [];
    return all.filter((r) => r && r.name && r.manifest).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name) {
    return this.run('readonly', (s) => s.get(name));
  }

  put(rec) {
    return this.run('readwrite', (s) => s.put({ ...rec, added: Date.now() }, rec.name));
  }

  remove(name) {
    return this.run('readwrite', (s) => s.delete(name));
  }
}

/// The files of a drop, with their folder paths (a dropped folder keeps its
/// structure): { files: Map path → File, folder: name of a single dropped
/// folder | null }.
export async function filesFromDrop(dt) {
  const files = new Map();
  const items = [...(dt.items || [])].map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
  if (!items.length) {
    for (const f of dt.files || []) files.set(f.name, f);
    return { files, folder: null };
  }
  const readAll = (reader) =>
    new Promise((resolve, reject) => {
      const out = [];
      const next = () =>
        reader.readEntries((batch) => {
          if (!batch.length) resolve(out);
          else {
            out.push(...batch);
            next();
          }
        }, reject);
      next();
    });
  const walk = async (entry, prefix) => {
    if (files.size > MAX_SKIN_FILES * 4) return;
    if (entry.isFile) {
      const f = await new Promise((resolve, reject) => entry.file(resolve, reject));
      files.set(prefix + entry.name, f);
    } else if (entry.isDirectory) {
      for (const child of await readAll(entry.createReader())) await walk(child, `${prefix}${entry.name}/`);
    }
  };
  for (const e of items) await walk(e, '');
  const folder = items.length === 1 && items[0].isDirectory ? items[0].name : null;
  // A single folder: paths inside it.
  if (folder) {
    const inner = new Map();
    for (const [p, f] of files) inner.set(p.slice(folder.length + 1), f);
    return { files: inner, folder };
  }
  return { files, folder: null };
}
