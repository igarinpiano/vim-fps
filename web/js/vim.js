// The Vim-like key machine. Turns key events into game actions, one mode at
// a time — nothing is usable from two modes at once.
//
//   NORMAL     hjkl walk (Shift held = sneak), {n}hjkl walk n metres,
//              f fire/use, {n}dd grenade, r reload, y pick up, gt swap gun,
//              << >> ~ turn, v VIEW, s inventory, m map, i/I chat, : command
//   VIEW       hjkl look (Shift = fast), {n}hjkl n steps, f fire, {n}dd
//              throw, r reload, v scope, Esc back
//   INVENTORY  j/k select, gg/G, {n}, Enter/Esc/s close
//   MAP        Esc/m/q close
//
// Pure: the caller passes key events in and gets callbacks out.

export const MODES = {
  normal: 'NORMAL',
  view: 'VIEW',
  inventory: 'INVENTORY',
  map: 'MAP',
  insert: 'INSERT',
  command: 'COMMAND',
  menu: 'MENU',
  msg: 'MESSAGE',
};

const MOVE_KEYS = ['h', 'j', 'k', 'l'];

export class Vim {
  /// settings: { get(name) }, act: object of callbacks (all optional).
  constructor(settings, act, now = () => Date.now()) {
    this.s = settings;
    this.act = act;
    this.now = now;
    this.mode = 'menu';
    this.count = '';
    this.pending = '';
    this.pendingAt = 0;
    // physical key code -> {kind:'move'|'look'|'fire', dir}
    this.held = new Map();
  }

  call(name, ...args) {
    const fn = this.act[name];
    if (fn) return fn(...args);
    return undefined;
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.releaseAll();
    this.count = '';
    this.pending = '';
    const prev = this.mode;
    this.mode = mode;
    this.call('mode', mode, prev);
    this.showcmd();
  }

  releaseAll() {
    for (const [code, h] of this.held) {
      if (h.kind === 'move') this.call('move', h.dir, false);
      else if (h.kind === 'look') this.call('look', h.dir, false);
      else if (h.kind === 'fire') this.call('fire', false);
      this.held.delete(code);
    }
  }

  showcmd() {
    this.call('showcmd', this.count + this.pending);
  }

  moveDir(k) {
    const fwd = this.s.get('forward') === 'j' ? 'j' : 'k';
    if (k === 'h') return 'left';
    if (k === 'l') return 'right';
    return k === fwd ? 'fwd' : 'back';
  }

  lookDir(k) {
    if (k === 'h') return 'left';
    if (k === 'l') return 'right';
    const up = k === 'k';
    return up !== !!this.s.get('invert') ? 'up' : 'down';
  }

  takeCount(def = null) {
    const n = this.count ? parseInt(this.count, 10) : def;
    this.count = '';
    return n;
  }

  /// ev: { type: 'down'|'up', key, code, shift, ctrl, repeat }.
  /// Returns true when the key was used (the caller then prevents default).
  key(ev) {
    let key = ev.key;
    if (ev.ctrl && (key === '[' || ev.code === 'BracketLeft')) key = 'Escape';
    if (ev.type === 'up') return this.keyUp(ev, key);
    if (key === 'Shift') {
      this.call('sneak', true);
      return true;
    }
    if (ev.repeat) {
      // Held keys are tracked by down/up; OS key repeat is ignored except
      // for list navigation.
      return this.mode === 'inventory' || this.mode === 'menu' ? this.keyDown(ev, key) : true;
    }
    if (ev.ctrl && key !== 'Escape') return false;
    return this.keyDown(ev, key);
  }

  keyUp(ev, key) {
    if (key === 'Shift') {
      this.call('sneak', false);
      return true;
    }
    const h = this.held.get(ev.code);
    if (!h) return false;
    this.held.delete(ev.code);
    if (h.kind === 'move') this.call('move', h.dir, false);
    else if (h.kind === 'look') this.call('look', h.dir, false);
    else if (h.kind === 'fire') this.call('fire', false);
    return true;
  }

  keyDown(ev, key) {
    // Pending two-key commands expire after timeoutlen.
    if (this.pending && this.now() - this.pendingAt > this.s.get('timeoutlen')) {
      this.pending = '';
      this.count = '';
    }
    switch (this.mode) {
      case 'normal':
        return this.normal(ev, key);
      case 'view':
        return this.view(ev, key);
      case 'inventory':
        return this.inventory(ev, key);
      case 'map':
        if (key === 'Escape' || key === 'm' || key === 'q' || key === 'Enter') this.setMode('normal');
        return true;
      case 'menu':
        return this.menu(ev, key);
      case 'msg':
        if (['Escape', 'Enter', 'q', ' '].includes(key)) this.call('closeMsg');
        else if (key === ':') this.call('command');
        return true;
      default:
        return false; // insert / command: the text box handles keys
    }
  }

  digit(key) {
    if (/^[1-9]$/.test(key) || (key === '0' && this.count)) {
      if (this.count.length < 3) this.count += key;
      this.showcmd();
      return true;
    }
    return false;
  }

  pend(key) {
    this.pending = key;
    this.pendingAt = this.now();
    this.showcmd();
  }

  clear() {
    this.count = '';
    this.pending = '';
    this.showcmd();
  }

  /// Two-key commands shared by NORMAL and VIEW. Returns true if handled.
  twoKey(key, allowed) {
    if (!this.pending) return false;
    const p = this.pending;
    this.pending = '';
    if (p === 'd' && key === 'd') {
      this.call('throw', Math.max(1, Math.min(5, this.takeCount(3))));
    } else if (p === 'g' && (key === 't' || key === 'T') && allowed.includes('g')) {
      this.takeCount();
      this.call('swapGun');
    } else if (p === '<' && key === '<' && allowed.includes('<')) {
      this.call('turn', this.s.get('turnangle') * this.takeCount(1));
    } else if (p === '>' && key === '>' && allowed.includes('>')) {
      this.call('turn', -this.s.get('turnangle') * this.takeCount(1));
    } else {
      this.count = '';
    }
    this.showcmd();
    return true;
  }

  normal(ev, key) {
    if (key === 'Escape') {
      this.clear();
      return true;
    }
    if (this.twoKey(key, ['g', '<', '>'])) return true;
    if (this.digit(key)) return true;
    const lower = key.length === 1 ? key.toLowerCase() : key;
    if (MOVE_KEYS.includes(lower)) {
      const dir = this.moveDir(lower);
      const n = this.takeCount();
      if (n) this.call('moveTimed', dir, n);
      else {
        this.held.set(ev.code, { kind: 'move', dir });
        this.call('move', dir, true);
      }
      this.showcmd();
      return true;
    }
    switch (key) {
      case 'f':
        this.count = '';
        this.held.set(ev.code, { kind: 'fire' });
        this.call('fire', true);
        break;
      case 'd':
      case 'g':
      case '<':
      case '>':
        this.pend(key);
        return true;
      case '~':
        this.count = '';
        this.call('turn', 180);
        break;
      case 'r':
        this.count = '';
        this.call('reload');
        break;
      case 'y':
        this.count = '';
        this.call('pickup');
        break;
      case 'v':
        this.setMode('view');
        break;
      case 's':
        this.setMode('inventory');
        break;
      case 'm':
        this.setMode('map');
        break;
      case 'i':
      case 'I':
      case 'a':
      case 'A':
        this.call('insert');
        break;
      case ':':
        this.call('command');
        break;
      default:
        this.count = '';
    }
    this.showcmd();
    return true;
  }

  view(ev, key) {
    if (key === 'Escape') {
      if (this.count || this.pending) this.clear();
      else this.setMode('normal');
      return true;
    }
    if (this.twoKey(key, [])) return true;
    if (this.digit(key)) return true;
    const lower = key.length === 1 ? key.toLowerCase() : key;
    if (MOVE_KEYS.includes(lower)) {
      const dir = this.lookDir(lower);
      const fast = key !== lower || !!ev.shift;
      const n = this.takeCount();
      if (n) this.call('lookStep', dir, n, fast);
      else {
        this.held.set(ev.code, { kind: 'look', dir });
        this.call('look', dir, true, fast);
      }
      this.showcmd();
      return true;
    }
    switch (key) {
      case 'f':
        this.count = '';
        this.held.set(ev.code, { kind: 'fire' });
        this.call('fire', true);
        break;
      case 'd':
        this.pend('d');
        return true;
      case 'r':
        this.count = '';
        this.call('reload');
        break;
      case 'v':
        this.count = '';
        this.call('zoom');
        break;
      case 's':
        this.setMode('inventory');
        break;
      case ':':
        this.call('command');
        break;
      default:
        this.count = '';
    }
    this.showcmd();
    return true;
  }

  inventory(ev, key) {
    if (this.pending === 'g') {
      this.pending = '';
      if (key === 'g') this.call('invSelect', 0, true);
      this.clear();
      return true;
    }
    if (this.digit(key)) return true;
    switch (key) {
      case 'j':
      case 'J':
      case 'ArrowDown':
        this.call('invSelect', this.takeCount(1), false);
        break;
      case 'k':
      case 'K':
      case 'ArrowUp':
        this.call('invSelect', -this.takeCount(1), false);
        break;
      case 'g':
        this.pend('g');
        return true;
      case 'G': {
        const n = this.takeCount();
        this.call('invSelect', n ? n - 1 : -1, true);
        break;
      }
      case 'Enter':
      case 'Escape':
      case 's':
      case 'q':
      case 'l':
        if (this.count && key === 'Enter') this.call('invSelect', this.takeCount() - 1, true);
        this.setMode('normal');
        return true;
      case ':':
        this.call('command');
        break;
      default:
        break;
    }
    this.showcmd();
    return true;
  }

  menu(ev, key) {
    if (this.digit(key)) return true;
    switch (key) {
      case 'j':
      case 'ArrowDown':
        this.call('menuMove', this.takeCount(1));
        break;
      case 'k':
      case 'ArrowUp':
        this.call('menuMove', -this.takeCount(1));
        break;
      case 'Enter':
      case 'l':
        if (this.count) this.call('menuPick', this.takeCount() - 1);
        else this.call('menuPick', null);
        break;
      case ':':
        this.call('command');
        break;
      default:
        this.count = '';
    }
    this.showcmd();
    return true;
  }
}

/// Look speed from held keys: an immediate step on press, then (after
/// aimdelay) continuous turning that accelerates up to maxspeed.
export class Aim {
  constructor(settings) {
    this.s = settings;
    this.held = new Map(); // dir -> {t, fast}
  }

  sign(dir) {
    // yaw: +left; pitch: +up
    return {
      left: [1, 0],
      right: [-1, 0],
      up: [0, 1],
      down: [0, -1],
    }[dir];
  }

  /// Degrees to apply right away.
  press(dir, fast, zoom = 1) {
    this.held.set(dir, { t: 0, fast });
    return this.stepDelta(dir, 1, fast, zoom);
  }

  stepDelta(dir, n, fast, zoom = 1) {
    const [sy, sp] = this.sign(dir);
    const deg = this.s.get('step') * n * (fast ? this.s.get('fastlook') : 1) * zoom;
    return { yaw: sy * deg, pitch: sp * deg };
  }

  release(dir) {
    this.held.delete(dir);
  }

  clear() {
    this.held.clear();
  }

  /// Degrees to turn this frame.
  update(dt, zoom = 1) {
    let yaw = 0;
    let pitch = 0;
    const delay = this.s.get('aimdelay') / 1000;
    for (const [dir, h] of this.held) {
      const before = h.t;
      h.t += dt;
      if (h.t <= delay) continue;
      const active = h.t - Math.max(before, delay);
      const accel = this.s.get('accel');
      const t = h.t - delay;
      const v =
        accel === Infinity ? this.s.get('maxspeed') : Math.min(this.s.get('maxspeed'), this.s.get('sensitivity') + accel * t);
      const deg = v * active * (h.fast ? this.s.get('fastlook') : 1) * zoom;
      const [sy, sp] = this.sign(dir);
      yaw += sy * deg;
      pitch += sp * deg;
    }
    return { yaw, pitch };
  }
}
