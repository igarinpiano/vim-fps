// Equalizer: `:set eq=...` (and `:eq`). A curve is a list of filters,
// written on one line so that it fits in :set and .vimfpsrc:
//
//   set eq=bass                       a preset
//   set eq=ls100:+6,pk3k:+3:1.4       low shelf 100 Hz +6 dB, peak 3 kHz +3 dB (Q 1.4)
//   set eq=bass,hs8k:+2,pre-3         presets and filters mixed, preamp -3 dB
//
// A filter: [type]FREQ[:GAIN[:Q]]. type: pk (peak, the default), ls / hs
// (low / high shelf), lp / hp (low / high pass: no gain). FREQ in Hz, `k`
// for kHz. `pre±N`: gain before the filters (dB).
//
// Equalizer APO / AutoEq files (ParametricEQ.txt: `Preamp: -6 dB`,
// `Filter 1: ON PK Fc 105 Hz Gain 5.5 dB Q 0.70`) are turned into this form
// (apoToEq).
//
// The filters are RBJ cookbook biquads (the ones Equalizer APO uses), so a
// curve sounds the same here as there; shelves honour Q (Web Audio's own
// shelves would not). Pure module: no Web Audio, testable with node --test.

export const EQ_PRESETS = {
  off: { curve: '', desc: 'EQ なし (そのままの音)' },
  bass: { curve: 'ls100:+6', desc: '低音を強く (100 Hz 以下 +6 dB)' },
  bassboost: { curve: 'pre-3,ls80:+10:0.6,pk200:+2:0.8', desc: '低音をもっと強く (爆発・砲声に迫力)' },
  treble: { curve: 'hs6k:+5', desc: '高音を強く' },
  loudness: { curve: 'ls90:+6,pk1k:-2:0.7,hs8k:+4', desc: '低音と高音を強く (ドンシャリ)' },
  steps: { curve: 'hp60,ls150:-4,pk2.5k:+5:1.1,hs7k:+2', desc: '足音を聞き取りやすく (低音を抑えて 2〜4 kHz を強く)' },
  voice: { curve: 'ls120:-3,pk2k:+3:0.9', desc: '中音域を前に (声・効果音がはっきり)' },
  night: { curve: 'pre-6,ls100:-6,hs8k:-3', desc: '小さめで低音を抑える (夜間)' },
};

const TYPES = ['pk', 'ls', 'hs', 'lp', 'hp'];
export const EQ_TYPE_NAMES = { pk: 'ピーク', ls: 'ローシェルフ', hs: 'ハイシェルフ', lp: 'ローパス', hp: 'ハイパス' };
export const MAX_BANDS = 20;
export const LIMITS = { freq: [10, 22000], gain: [-30, 30], q: [0.05, 30], pre: [-30, 30] };

function num(s) {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  return Number(s);
}

/// "100" / "2.5k" / "8K" → Hz (NaN when it is not a number).
function freqOf(s) {
  const m = String(s).match(/^(.*?)(k|khz|hz)?$/i);
  const n = num(m[1]);
  return m[2] && m[2].toLowerCase().startsWith('k') ? n * 1000 : n;
}

/// "+6" / "-3.5" / "6db" → dB.
function dbOf(s) {
  return num(String(s).replace(/db$/i, ''));
}

/// The value of `eq` → { pre, bands: [{ type, freq, gain, q }] }. Throws an
/// Error with a message (Japanese, for the player) when it cannot be read.
export function parseEq(value) {
  const out = { pre: 0, bands: [] };
  const s = String(value == null ? '' : value).replace(/\s+/g, '');
  if (!s) return out;
  const seen = new Set();
  const add = (tok) => {
    const lower = tok.toLowerCase();
    if (EQ_PRESETS[lower]) {
      if (seen.has(lower)) return;
      seen.add(lower);
      for (const t of EQ_PRESETS[lower].curve.split(',').filter(Boolean)) add(t);
      return;
    }
    const pm = lower.match(/^pre(.*)$/);
    if (pm) {
      const g = dbOf(pm[1]);
      if (Number.isNaN(g)) throw new Error(`プリアンプの値が読めません: ${tok}`);
      out.pre += g;
      return;
    }
    const m = lower.match(/^([a-z]{2})?([0-9.]+(?:k|khz|hz)?)(?::([^:]*))?(?::([^:]*))?$/);
    if (!m) throw new Error(`読めません: ${tok} (例: ls100:+6、pk3k:+3:1.4、プリセット名)`);
    const type = m[1] || 'pk';
    if (!TYPES.includes(type)) throw new Error(`フィルターの種類が分かりません: ${m[1]} (${TYPES.join(' / ')})`);
    const freq = freqOf(m[2]);
    const pass = type === 'lp' || type === 'hp';
    const gain = m[3] == null || m[3] === '' ? 0 : dbOf(m[3]);
    const q = m[4] == null || m[4] === '' ? (type === 'pk' ? 1 : 0.707) : num(m[4]);
    if (Number.isNaN(freq) || freq < LIMITS.freq[0] || freq > LIMITS.freq[1]) throw new Error(`周波数は ${LIMITS.freq[0]}〜${LIMITS.freq[1]} Hz: ${tok}`);
    if (Number.isNaN(gain) || gain < LIMITS.gain[0] || gain > LIMITS.gain[1]) throw new Error(`ゲインは ${LIMITS.gain[0]}〜+${LIMITS.gain[1]} dB: ${tok}`);
    if (pass && gain !== 0) throw new Error(`${type} (${EQ_TYPE_NAMES[type]}) にゲインはありません: ${tok} (例: ${type}${m[2]} や ${type}${m[2]}::0.7)`);
    if (!pass && m[3] == null) throw new Error(`ゲイン (dB) がありません: ${tok} (例: ${type === 'pk' ? '' : type}${m[2]}:+6)`);
    if (Number.isNaN(q) || q < LIMITS.q[0] || q > LIMITS.q[1]) throw new Error(`Q は ${LIMITS.q[0]}〜${LIMITS.q[1]}: ${tok}`);
    out.bands.push({ type, freq, gain, q });
  };
  for (const tok of s.split(',')) {
    if (tok) add(tok);
  }
  if (out.bands.length > MAX_BANDS) throw new Error(`フィルターは ${MAX_BANDS} 個まで (${out.bands.length} 個あります)`);
  if (out.pre < LIMITS.pre[0] || out.pre > LIMITS.pre[1]) throw new Error(`プリアンプは ${LIMITS.pre[0]}〜+${LIMITS.pre[1]} dB`);
  return out;
}

/// For :set: an error message, or null when the value is a curve.
export function eqError(value) {
  try {
    parseEq(value);
    return null;
  } catch (e) {
    return e.message;
  }
}

/// No filters and no preamp: the sound goes straight out.
export function isFlat(eq) {
  return !eq.bands.length && eq.pre === 0;
}

const r2 = (n) => String(Math.round(n * 100) / 100);
const sign = (n) => (n >= 0 ? `+${r2(n)}` : r2(n));
function fmtFreq(f) {
  return f >= 1000 && Math.round(f) % 100 === 0 ? `${r2(f / 1000)}k` : r2(f);
}

/// { pre, bands } → the `eq` value (what parseEq reads back).
export function formatEq(eq) {
  const parts = [];
  if (eq.pre) parts.push(`pre${sign(eq.pre)}`);
  for (const b of eq.bands) {
    const pass = b.type === 'lp' || b.type === 'hp';
    const defQ = b.type === 'pk' ? 1 : 0.707;
    const t = b.type;
    const q = Math.abs(b.q - defQ) > 1e-9 ? `:${r2(b.q)}` : '';
    parts.push(pass ? `${t}${fmtFreq(b.freq)}${q ? `:${q}` : ''}` : `${t}${fmtFreq(b.freq)}:${sign(b.gain)}${q}`);
  }
  return parts.join(',') || 'off';
}

/// Equalizer APO / AutoEq text → { value: the `eq` value, warnings }.
/// Throws when there is no filter or preamp in it.
export function apoToEq(text) {
  const eq = { pre: 0, bands: [] };
  const warnings = [];
  const MAP = { PK: 'pk', PEQ: 'pk', MODAL: 'pk', LS: 'ls', LSC: 'ls', LSQ: 'ls', HS: 'hs', HSC: 'hs', HSQ: 'hs', LP: 'lp', LPQ: 'lp', HP: 'hp', HPQ: 'hp' };
  let found = false;
  String(text || '')
    .split(/\r\n|\r|\n/)
    .forEach((raw, i) => {
      const line = raw.replace(/#.*$/, '').trim();
      if (!line) return;
      const pre = line.match(/^Preamp\s*:\s*([+-]?[\d.]+)\s*dB/i);
      if (pre) {
        eq.pre += Number(pre[1]);
        found = true;
        return;
      }
      const f = line.match(/^Filter\s*\d*\s*:\s*(ON|OFF)\s+([A-Z]+)(?:\s+\d+\s*dB)?\s+(.*)$/i);
      if (!f) return;
      found = true;
      if (f[1].toUpperCase() === 'OFF') return;
      const type = MAP[f[2].toUpperCase()];
      if (!type) {
        warnings.push(`${i + 1} 行目: ${f[2]} フィルターは使えないので飛ばしました`);
        return;
      }
      const fc = f[3].match(/Fc\s+([\d.]+)\s*(k?)Hz/i);
      const gain = f[3].match(/Gain\s+([+-]?[\d.]+)\s*dB/i);
      const q = f[3].match(/Q\s+([\d.]+)/i);
      if (!fc) {
        warnings.push(`${i + 1} 行目: 周波数 (Fc) が無いので飛ばしました`);
        return;
      }
      const band = {
        type,
        freq: Number(fc[1]) * (fc[2] ? 1000 : 1),
        gain: type === 'lp' || type === 'hp' ? 0 : gain ? Number(gain[1]) : 0,
        q: q ? Number(q[1]) : type === 'pk' ? 1 : 0.707,
      };
      if (!q && (type === 'ls' || type === 'hs') && /\d+\s*dB/i.test(raw.split(/Fc/i)[0])) warnings.push(`${i + 1} 行目: 傾き指定のシェルフは Q 0.707 で近似しました`);
      eq.bands.push(band);
    });
  if (!found) throw new Error('Equalizer APO / AutoEq の形式 (Preamp: … / Filter 1: ON PK Fc … Hz Gain … dB Q …) の行がありません');
  const value = formatEq(eq);
  const err = eqError(value);
  if (err) throw new Error(err);
  return { value, warnings };
}

/// Does this text look like an Equalizer APO / AutoEq file?
export function looksLikeApo(text) {
  return /^\s*(Preamp\s*:\s*[+-]?[\d.]+\s*dB|Filter\s*\d*\s*:\s*(ON|OFF)\s)/im.test(String(text || ''));
}

// ---------------------------------------------------------------- filters

/// One filter → biquad coefficients { b: [b0, b1, b2], a: [1, a1, a2] }
/// for the sample rate `fs` (RBJ Audio EQ Cookbook).
export function biquad(band, fs) {
  const f = Math.min(band.freq, fs * 0.49);
  const w = (2 * Math.PI * f) / fs;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * band.q);
  const A = 10 ** (band.gain / 40);
  let b;
  let a;
  switch (band.type) {
    case 'ls': {
      const s = 2 * Math.sqrt(A) * alpha;
      b = [A * (A + 1 - (A - 1) * cos + s), 2 * A * (A - 1 - (A + 1) * cos), A * (A + 1 - (A - 1) * cos - s)];
      a = [A + 1 + (A - 1) * cos + s, -2 * (A - 1 + (A + 1) * cos), A + 1 + (A - 1) * cos - s];
      break;
    }
    case 'hs': {
      const s = 2 * Math.sqrt(A) * alpha;
      b = [A * (A + 1 + (A - 1) * cos + s), -2 * A * (A - 1 + (A + 1) * cos), A * (A + 1 + (A - 1) * cos - s)];
      a = [A + 1 - (A - 1) * cos + s, 2 * (A - 1 - (A + 1) * cos), A + 1 - (A - 1) * cos - s];
      break;
    }
    case 'lp':
      b = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
      a = [1 + alpha, -2 * cos, 1 - alpha];
      break;
    case 'hp':
      b = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
      a = [1 + alpha, -2 * cos, 1 - alpha];
      break;
    default:
      b = [1 + alpha * A, -2 * cos, 1 - alpha * A];
      a = [1 + alpha / A, -2 * cos, 1 - alpha / A];
  }
  return { b: b.map((x) => x / a[0]), a: [1, a[1] / a[0], a[2] / a[0]] };
}

/// The whole curve's gain (dB) at `freq` Hz.
export function responseDb(eq, freq, fs = 48000) {
  const w = (2 * Math.PI * freq) / fs;
  // z^-1 = e^{-jw}
  const c1 = Math.cos(w);
  const s1 = -Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = -Math.sin(2 * w);
  let db = eq.pre;
  for (const band of eq.bands) {
    const { b, a } = biquad(band, fs);
    const nr = b[0] + b[1] * c1 + b[2] * c2;
    const ni = b[1] * s1 + b[2] * s2;
    const dr = a[0] + a[1] * c1 + a[2] * c2;
    const di = a[1] * s1 + a[2] * s2;
    db += 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }
  return db;
}

/// The curve as text (for :eq): rows of dB, columns of frequency (log,
/// 20 Hz to 20 kHz).
export function eqGraph(eq, { width = 60, fs = 48000 } = {}) {
  const freqs = [];
  for (let i = 0; i < width; i++) freqs.push(20 * 1000 ** (i / (width - 1)));
  const db = freqs.map((f) => responseDb(eq, f, fs));
  // Rows: from the highest point to the lowest (at least ±6 dB, at most
  // ±18 dB: past that the curve is drawn at the edge).
  const top = Math.min(18, Math.max(6, ...db));
  const bottom = Math.max(-18, Math.min(-6, ...db));
  const step = top - bottom <= 16 ? 2 : 3;
  const hi = Math.ceil(top / step) * step;
  const lo = Math.floor(bottom / step) * step;
  // Each column: `*` on the row nearest the curve, `#` between it and
  // 0 dB, `-` along 0 dB.
  const rowOf = (d) => Math.round(Math.max(lo, Math.min(hi, d)) / step) * step;
  const curve = db.map(rowOf);
  const lines = [];
  for (let level = hi; level >= lo; level -= step) {
    let row = '';
    for (let i = 0; i < width; i++) {
      const c = curve[i];
      if (c === level) row += '*';
      else if ((level > 0 && level < c) || (level < 0 && level > c)) row += '#';
      else row += level === 0 ? '-' : ' ';
    }
    lines.push(`${(level > 0 ? `+${level}` : String(level)).padStart(4)} dB |${row}|`);
  }
  // Frequency marks under the columns.
  const marks = [
    [20, '20'],
    [100, '100'],
    [1000, '1k'],
    [10000, '10k'],
    [20000, '20k'],
  ];
  const axis = Array(width + 2).fill(' ');
  for (const [f, label] of marks) {
    const col = Math.round((Math.log(f / 20) / Math.log(1000)) * (width - 1)) + 1;
    const start = Math.min(width + 2 - label.length, Math.max(0, col - Math.floor(label.length / 2)));
    for (let j = 0; j < label.length; j++) axis[start + j] = label[j];
  }
  lines.push(`        ${axis.join('')} Hz`);
  return lines;
}
