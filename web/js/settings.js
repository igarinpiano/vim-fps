// :set options. Vim syntax: `:set sens=120`, `:set noinvert`, `:set invert!`,
// `:set sens?`, `:set sens&`, `:set all&`, `:set sens+=10`, `:set nosmooth`.
// Pure module (storage is passed in) so it can be tested with node --test.

export const OPTIONS = {
  name: { type: 'string', def: '', desc: 'プレイヤー名 (次の接続から)' },
  forward: { type: 'enum', values: ['k', 'j'], def: 'k', desc: '前進キー (もう一方が後退)' },
  sensitivity: { type: 'number', def: 12, min: 0.5, max: 1440, alias: ['sens'], desc: '長押しの初速 (度/秒)。この速さで微調整' },
  accelafter: { type: 'number', def: 450, min: 0, max: 5000, alias: ['aa'], desc: '長押しがこの時間 (ミリ秒) を超えたら加速を始める' },
  accel: { type: 'number', def: 200, min: 0, max: Infinity, alias: ['acc'], desc: '視点移動の加速度 (度/秒²、inf で即最高速、0 で一定)' },
  maxspeed: { type: 'number', def: 220, min: 1, max: 2880, alias: ['maxs'], desc: '視点移動の最高速 (度/秒)' },
  step: { type: 'number', def: 0.2, min: 0.01, max: 90, desc: '短押し・回数指定 1 回で回る角度 (度)' },
  aimdelay: { type: 'number', def: 160, min: 0, max: 2000, desc: '押しっぱなしが連続移動になるまで (ミリ秒)' },
  fastlook: { type: 'number', def: 4, min: 1, max: 40, desc: 'Shift+hjkl (VIEW) の速度倍率' },
  zoomsens: { type: 'number', def: 0.4, min: 0.05, max: 4, desc: 'スコープ中の視点速度の倍率' },
  invert: { type: 'bool', def: false, desc: '視点の上下を反転' },
  turnangle: { type: 'number', def: 45, min: 1, max: 180, alias: ['ta'], desc: ', と . で回る角度 (度)' },
  fov: { type: 'number', def: 80, min: 40, max: 120, desc: '視野角 (度)' },
  timeoutlen: { type: 'number', def: 1000, min: 50, max: 10000, alias: ['tm'], desc: 'dd や gt の 2 打目を待つ時間 (ミリ秒)' },
  volume: { type: 'number', def: 70, min: 0, max: 100, alias: ['vol'], desc: '音量 (0-100)' },
  showcmd: { type: 'bool', def: true, alias: ['sc'], desc: '入力途中のキーを表示' },
  showfps: { type: 'bool', def: false, desc: 'FPS を表示' },
  compass: { type: 'bool', def: true, desc: '索敵コンパス (銃声・足音・発見した敵の方向)' },
  markers: { type: 'bool', def: true, desc: '見えている敵の頭上に ▼ を表示' },
  touch: { type: 'enum', values: ['auto', 'on', 'off'], def: 'auto', desc: 'タッチ操作パッド (auto: タッチ端末で表示)' },
  // ---- smoothing: `:set nosmooth` turns all of these off ----
  adsanim: { type: 'bool', def: true, smooth: true, desc: 'ADS・スコープの切り替えを滑らかに (off: 瞬時)' },
  moveaccel: { type: 'bool', def: true, smooth: true, desc: '移動の加速・減速 (off: 加速度無限大)' },
  turnanim: { type: 'bool', def: true, smooth: true, desc: ', . ~ の旋回を滑らかに (off: 瞬時)' },
  interp: { type: 'bool', def: true, smooth: true, desc: '他プレイヤーの位置を補間 (off: 受信した位置そのまま)' },
  bob: { type: 'bool', def: true, smooth: true, desc: '歩行の揺れ・射撃の反動の表示' },
  uianim: { type: 'bool', def: true, smooth: true, desc: '画面のアニメーション (通知のフェード、爆発など)' },
};

/// Pseudo-option: all smoothing options at once.
export const SMOOTH_GROUP = Object.keys(OPTIONS).filter((k) => OPTIONS[k].smooth);

const STORAGE_KEY = 'vimfps.settings.v1';

export function resolveName(name) {
  if (name === 'smooth') return 'smooth';
  if (OPTIONS[name]) return name;
  for (const [k, o] of Object.entries(OPTIONS)) {
    if (o.alias && o.alias.includes(name)) return k;
  }
  return null;
}

export class Settings {
  constructor(storage) {
    this.storage = storage || null;
    this.values = {};
    for (const [k, o] of Object.entries(OPTIONS)) this.values[k] = o.def;
    this.listeners = [];
    this.load();
  }

  get(k) {
    if (k === 'smooth') return SMOOTH_GROUP.every((g) => this.values[g]);
    return this.values[k];
  }

  onChange(fn) {
    this.listeners.push(fn);
  }

  set(k, v) {
    this.values[k] = v;
    for (const fn of this.listeners) fn(k, v);
  }

  load() {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      for (const [k, v] of Object.entries(saved)) {
        if (!OPTIONS[k]) continue;
        const o = OPTIONS[k];
        if (o.type === 'number' && (typeof v === 'number' || v === 'inf')) this.values[k] = v === 'inf' ? Infinity : v;
        else if (o.type === 'bool' && typeof v === 'boolean') this.values[k] = v;
        else if (o.type === 'enum' && o.values.includes(v)) this.values[k] = v;
        else if (o.type === 'string' && typeof v === 'string') this.values[k] = v;
      }
    } catch {
      // Unreadable storage: keep the defaults.
    }
  }

  save() {
    if (!this.storage) return;
    const out = {};
    for (const [k, o] of Object.entries(OPTIONS)) {
      const v = this.values[k];
      if (v !== o.def) out[k] = v === Infinity ? 'inf' : v;
    }
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(out));
    } catch {
      // Private mode etc.: settings last for this page only.
    }
  }

  format(k) {
    if (k === 'smooth') return this.get('smooth') ? '  smooth' : 'nosmooth';
    const o = OPTIONS[k];
    const v = this.values[k];
    if (o.type === 'bool') return (v ? '  ' : 'no') + k;
    if (v === Infinity) return `  ${k}=inf`;
    return `  ${k}=${v}`;
  }

  /// Runs the arguments of `:set`. Returns { lines, error, changed }.
  command(args) {
    const lines = [];
    const changed = [];
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      // Like Vim: the options that differ from their defaults.
      for (const [k, o] of Object.entries(OPTIONS)) {
        if (this.values[k] !== o.def) lines.push(this.format(k));
      }
      if (lines.length === 0) lines.push('(すべて初期値です)');
      return { lines, error: null, changed };
    }
    for (const tok of tokens) {
      const err = this.one(tok, lines, changed);
      if (err) return { lines, error: err, changed };
    }
    if (changed.length) this.save();
    return { lines, error: null, changed };
  }

  one(tok, lines, changed) {
    if (tok === 'all') {
      for (const k of Object.keys(OPTIONS)) lines.push(this.format(k));
      lines.push(this.format('smooth'));
      return null;
    }
    if (tok === 'all&') {
      for (const [k, o] of Object.entries(OPTIONS)) {
        if (this.values[k] !== o.def) {
          this.set(k, o.def);
          changed.push(k);
        }
      }
      return null;
    }
    const m = tok.match(/^([a-z]+)(\?|&|!|\+=|-=|\^=|=|:)?(.*)$/);
    if (!m) return `E518: Unknown option: ${tok}`;
    let [, rawName, op, val] = m;
    let neg = false;
    let inv = false;
    let name = resolveName(rawName);
    if (!name && rawName.startsWith('no')) {
      name = resolveName(rawName.slice(2));
      neg = true;
    } else if (!name && rawName.startsWith('inv')) {
      name = resolveName(rawName.slice(3));
      inv = true;
    }
    if (!name) return `E518: Unknown option: ${rawName}`;

    if (name === 'smooth') {
      let v;
      if (op === '?') {
        lines.push(this.format('smooth'));
        return null;
      } else if (op === '&') v = true;
      else if (op === '!' || inv) v = !this.get('smooth');
      else if (!op) v = !neg;
      else return `E474: Invalid argument: ${tok}`;
      for (const g of SMOOTH_GROUP) {
        if (this.values[g] !== v) {
          this.set(g, v);
          changed.push(g);
        }
      }
      return null;
    }

    const o = OPTIONS[name];
    if (op === '?') {
      lines.push(this.format(name));
      return null;
    }
    if (op === '&') {
      if (this.values[name] !== o.def) {
        this.set(name, o.def);
        changed.push(name);
      }
      return null;
    }
    if (o.type === 'bool') {
      let v;
      if (op === '!' || inv) v = !this.values[name];
      else if (!op) v = !neg;
      else return `E474: Invalid argument: ${tok}`;
      if (this.values[name] !== v) {
        this.set(name, v);
        changed.push(name);
      }
      return null;
    }
    if (neg || inv || op === '!') return `E474: Invalid argument: ${tok}`;
    if (!op) {
      // `:set sens` shows the value, as in Vim.
      lines.push(this.format(name));
      return null;
    }
    let v;
    if (o.type === 'number') {
      const n = val === 'inf' ? Infinity : Number(val);
      if (val === '' || Number.isNaN(n)) return `E521: Number required after =: ${tok}`;
      const cur = this.values[name];
      if (op === '+=') v = cur + n;
      else if (op === '-=') v = cur - n;
      else if (op === '^=') v = cur * n;
      else v = n;
      if (v < o.min || v > o.max) return `E474: Invalid argument: ${tok} (${o.min}〜${o.max === Infinity ? 'inf' : o.max})`;
    } else if (o.type === 'enum') {
      if (!['=', ':'].includes(op) || !o.values.includes(val)) return `E474: Invalid argument: ${tok} (${o.values.join(' / ')})`;
      v = val;
    } else {
      if (!['=', ':'].includes(op)) return `E474: Invalid argument: ${tok}`;
      v = val.slice(0, 16);
    }
    if (this.values[name] !== v) {
      this.set(name, v);
      changed.push(name);
    }
    return null;
  }

  /// Completion candidates for a partial option name.
  complete(prefix) {
    const names = [...Object.keys(OPTIONS), 'smooth', 'all'];
    return names.filter((n) => n.startsWith(prefix));
  }
}
