// Your own textures on the world. The shape of the field never changes:
// images only replace the flat colours of its surfaces.
//
// Where an image comes from, in this order:
//   1. this browser (`:texture <slot>` picks a file; kept in IndexedDB),
//   2. the skins (skin.js): yours, the host's, the one served with the game
//      (web/assets/skin.json; before skins, web/assets/textures/pack.json).
//
// Pure where it can be (file names, the pack's format) so it is testable
// with node --test; the store takes `indexedDB` as an argument.

/// What can be textured, and the size (metres) one copy of the image covers
/// by default. `sky` is a panorama (equirectangular), not tiled.
export const TEXTURE_SLOTS = {
  ground: { label: '地面', size: 8 },
  wall: { label: '建物の壁', size: 4 },
  roof: { label: '屋根', size: 4 },
  rock: { label: '岩', size: 3 },
  cover: { label: '低い壁 (遮蔽物)', size: 3 },
  crate: { label: '木箱', size: 2 },
  trunk: { label: '木の幹', size: 1 },
  fence: { label: '外周のフェンス', size: 4 },
  leaves: { label: '木の葉', size: 2 },
  tank: { label: '戦車', size: 2 },
  sky: { label: '空 (横長のパノラマ画像)', size: 0 },
};

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;
/// Images larger than this are refused (they would not fit a phone's GPU).
export const MAX_TEXTURE_BYTES = 24 * 1024 * 1024;

/// Which slot a file is for, from its name: "ground.png", "Wall-02.JPG",
/// "sky_sunset.webp" → ground, wall, sky. null when it names none.
export function slotOf(filename) {
  const base = String(filename || '')
    .split(/[\\/]/)
    .pop()
    .toLowerCase();
  if (!IMAGE_EXT.test(base)) return null;
  const stem = base.replace(IMAGE_EXT, '');
  for (const slot of Object.keys(TEXTURE_SLOTS)) {
    if (stem === slot || stem.startsWith(`${slot}-`) || stem.startsWith(`${slot}_`) || stem.startsWith(`${slot}.`)) return slot;
  }
  return null;
}

/// Reads pack.json: { "ground": "grass.png", "wall": { "file": "w.jpg",
/// "size": 3 } } → [{ slot, file, size }]. Unknown slots and unsafe file
/// names (anything but a plain name in the same folder) are left out.
export function parsePack(json) {
  const out = [];
  if (!json || typeof json !== 'object') return out;
  for (const [slot, v] of Object.entries(json)) {
    if (!TEXTURE_SLOTS[slot]) continue;
    const file = typeof v === 'string' ? v : v && typeof v.file === 'string' ? v.file : null;
    if (!file || !/^[A-Za-z0-9._-]+$/.test(file) || file.startsWith('.')) continue;
    const size = v && typeof v === 'object' && Number.isFinite(v.size) && v.size > 0 ? v.size : null;
    out.push({ slot, file, size });
  }
  return out;
}

/// A tile size typed by the user: metres, 0.1 to 500. null when not one.
export function parseSize(text) {
  const n = Number(text);
  return Number.isFinite(n) && n >= 0.1 && n <= 500 ? n : null;
}

const DB_NAME = 'vimfps';
const STORE = 'textures';
/// Version 2 added `skins` (skin.js) next to `textures`.
const DB_VERSION = 2;
const DB_STORES = ['textures', 'skins'];
const opened = new WeakMap();

/// The game's IndexedDB database (one per idb factory, opened once).
export function openDb(idb) {
  if (!idb) return Promise.reject(new Error('このブラウザーでは保存できません (IndexedDB なし)'));
  if (!opened.has(idb)) {
    opened.set(
      idb,
      new Promise((resolve, reject) => {
        const req = idb.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          for (const name of DB_STORES) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
          opened.delete(idb);
          reject(req.error || new Error('IndexedDB を開けません'));
        };
      }),
    );
  }
  return opened.get(idb);
}

/// Textures kept in this browser: slot -> { blob, size, name }.
export class TextureStore {
  constructor(idb) {
    this.idb = idb || null;
  }

  open() {
    return openDb(this.idb);
  }

  async run(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  /// Every stored texture: [[slot, { blob, size, name }]].
  async all() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const out = [];
      const tx = db.transaction(STORE, 'readonly');
      const cur = tx.objectStore(STORE).openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return;
        if (TEXTURE_SLOTS[c.key] && c.value && c.value.blob) out.push([c.key, c.value]);
        c.continue();
      };
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
    });
  }

  put(slot, rec) {
    return this.run('readwrite', (s) => s.put(rec, slot));
  }

  remove(slot) {
    return this.run('readwrite', (s) => s.delete(slot));
  }

  clear() {
    return this.run('readwrite', (s) => s.clear());
  }
}

/// An <img> decoded from a Blob or a URL.
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = typeof src === 'string' ? src : URL.createObjectURL(src);
    img.onload = () => {
      if (typeof src !== 'string') URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      if (typeof src !== 'string') URL.revokeObjectURL(url);
      reject(new Error('画像として読めません'));
    };
    if (typeof src === 'string') img.crossOrigin = 'anonymous';
    img.src = url;
  });
}

/// The pack served with the game: [{ slot, url, size }] (empty without one).
export async function fetchPack(base) {
  try {
    const res = await fetch(new URL('pack.json', base), { cache: 'no-cache' });
    if (!res.ok) return [];
    const type = res.headers.get('content-type') || '';
    if (type.startsWith('text/html')) return [];
    return parsePack(await res.json()).map((e) => ({ slot: e.slot, size: e.size, url: new URL(e.file, base).href }));
  } catch {
    return [];
  }
}
