// On-screen keys for phones and tablets. Each button sends the same key
// events a keyboard would, so the modes and rules stay exactly the same
// (no aiming by dragging: still no "mouse").
//
// The keys on screen follow what is going on (a "scene"): fighting shows
// the full pad, a menu only what moves and picks, watching the camera keys,
// and so on. Pure layout data: `SCENES` below.

const HJKL = [
  [null, 'k', null],
  ['h', 'j', 'l'],
];
const UP_DOWN = [
  [null, 'k', null],
  [null, 'j', null],
];

/// A key is: one character ('f', ':', 'N' — capitals are sent with Shift),
/// 'Escape' / 'Enter' / 'Shift' (a toggle), two keys in a row ('dd', 'gt',
/// 'gg'), or Ctrl with a letter ('^d').
export const SCENES = {
  // Fighting on foot (NORMAL and VIEW).
  combat: {
    left: HJKL,
    right: [
      ['Escape', 'v', 'f'],
      ['dd', 'r', 'y'],
      [',', '.', '~'],
      ['s', 'm', '*'],
      ['Shift', 'i', ':'],
      ['Enter', 'gt', '1'],
    ],
    shiftCase: true,
  },
  // The same, next to a tank nobody is in: e (get in) where ⏎ was.
  boarding: {
    left: HJKL,
    right: [
      ['Escape', 'v', 'f'],
      ['dd', 'r', 'y'],
      [',', '.', '~'],
      ['s', 'm', '*'],
      ['Shift', 'i', ':'],
      ['e', 'gt', '1'],
    ],
    hint: { e: '乗る' },
    shiftCase: true,
  },
  // Driving a tank.
  tank: {
    left: HJKL,
    right: [
      ['Escape', 'v', 'f'],
      [',', '.', '~'],
      ['e', 'm', '*'],
      ['1', 'i', ':'],
    ],
    hint: { e: '降りる', v: '構え', f: '砲撃', k: '前進', j: '後退', h: '左旋回', l: '右旋回' },
    shiftCase: true,
  },
  // Killed, waiting for the respawn; the result screen.
  wait: {
    left: [],
    right: [['m', 'i', ':']],
    hint: { m: '地図', i: '会話' },
  },
  // The result screen with a ranking longer than its box: j / k scroll it.
  results: {
    left: UP_DOWN,
    right: [['m', 'i', ':']],
    hint: { k: '上へ', j: '下へ', m: '地図', i: '会話' },
  },
  // Title menu.
  menu: {
    left: UP_DOWN,
    right: [[':', 'Enter']],
    hint: { Enter: '決定' },
  },
  // A message window (:help, :spec ...).
  msg: {
    left: HJKL,
    right: [
      ['gg', 'G', 'Escape'],
      ['^u', '^d', ':'],
    ],
    hint: { gg: '先頭', G: '末尾', '^u': '半頁↑', '^d': '半頁↓', Escape: '閉じる' },
  },
  // The custom match form.
  form: {
    left: HJKL,
    right: [
      ['H', 'L', 'Escape'],
      [null, ':', 'Enter'],
    ],
    hint: { H: '−5', L: '+5', Enter: '開始', Escape: '戻る' },
  },
  inventory: {
    left: UP_DOWN,
    right: [
      ['gg', 'G', 'Escape'],
      [null, null, 'Enter'],
    ],
    hint: { gg: '先頭', G: '末尾', Enter: '決定' },
  },
  map: {
    left: [],
    right: [['Escape']],
    hint: { Escape: '閉じる' },
  },
  // Typing (chat, command line): the phone's own keyboard is up.
  typing: {
    left: [],
    right: [['Escape']],
    hint: { Escape: '取り消し' },
  },
  // Watching a player (their eyes, or the automatic camera).
  watch: {
    left: [['N', null, 'n']],
    right: [
      ['a', 'o', 'O'],
      ['m', 'i', ':'],
    ],
    hint: { N: '前の人', n: '次の人', a: '自動', o: '自由', O: '空から', m: '地図', i: '会話' },
  },
  // Watching with the free camera or from the sky.
  fly: {
    left: [
      ['K', 'k', 'u'],
      ['h', 'j', 'l'],
      ['J', null, 'd'],
    ],
    right: [
      ['a', 'n', 'N'],
      ['o', 'O', 'm'],
      [',', '.', 'Shift'],
      ['i', ':', null],
    ],
    hint: { K: '上', J: '下', u: '見上げ', d: '見下ろ', a: '自動', n: '次の人', N: '前の人', o: '自由', O: '空から', m: '地図', Shift: '速く' },
  },
};

const LABEL = { Escape: 'Esc', Shift: 'Shift', Enter: '⏎', '^d': '^d', '^u': '^u' };

/// The key events (key, with Ctrl / Shift) one press of a pad key sends.
export function keysOf(token) {
  if (token.length === 2 && token[0] === '^') return [{ key: token[1], ctrl: true }];
  if (token.length === 2) return [...token].map((key) => ({ key }));
  return [{ key: token }];
}

export class TouchPad {
  constructor(root, settings, send) {
    this.root = root;
    this.s = settings;
    this.send = send;
    this.active = false;
    this.shiftOn = false;
    this.scene = null;
    this.setScene('menu');
    this.update();
    settings.onChange((k) => {
      if (k === 'touch') this.update();
    });
    if (window.matchMedia) {
      const mq = window.matchMedia('(pointer: coarse)');
      if (mq.addEventListener) mq.addEventListener('change', () => this.update());
    }
    // Some phones and tablets do not report a coarse pointer: the first
    // touch counts as one.
    this.touched = false;
    window.addEventListener(
      'touchstart',
      () => {
        if (!this.touched) {
          this.touched = true;
          this.update();
        }
      },
      { passive: true },
    );
  }

  wanted() {
    const t = this.s.get('touch');
    if (t === 'on') return true;
    if (t === 'off') return false;
    return this.touched || !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  }

  update() {
    this.active = this.wanted();
    this.root.classList.toggle('hidden', !this.active);
    document.body.classList.toggle('touch', this.active);
  }

  /// Show the keys of a scene (a name in SCENES). Keys held on the old pad
  /// are let go by the key machine when the mode changes.
  setScene(name) {
    if (!SCENES[name]) name = 'combat';
    if (name === this.scene) return;
    this.scene = name;
    this.root.dataset.scene = name;
    this.build();
  }

  /// Turn the Shift toggle off (a new match starts without sneaking).
  releaseShift() {
    if (!this.shiftOn) return;
    this.shiftOn = false;
    const b = this.root.querySelector('button[data-key="Shift"]');
    if (b) b.classList.remove('on');
    this.send(this.ev('up', 'Shift'));
  }

  ev(type, key, ctrl = false) {
    const code = `Touch-${key}`;
    return { type, key, code, shift: this.shiftOn || (key.length === 1 && key !== key.toLowerCase()), ctrl, repeat: false };
  }

  build() {
    const scene = SCENES[this.scene];
    this.root.textContent = '';
    for (const side of ['left', 'right']) {
      const pad = document.createElement('div');
      pad.className = `pad ${side}`;
      const rows = scene[side] || [];
      const cols = rows.reduce((n, r) => Math.max(n, r.length), 0);
      pad.style.setProperty('--cols', String(Math.max(1, cols)));
      for (const row of rows) {
        for (let i = 0; i < cols; i++) {
          const key = row[i] ?? null;
          const b = document.createElement('button');
          b.type = 'button';
          if (!key) {
            b.className = 'blank';
            b.disabled = true;
          } else {
            const label = document.createElement('span');
            label.textContent = LABEL[key] || key;
            b.appendChild(label);
            const hint = scene.hint && scene.hint[key];
            if (hint) {
              const small = document.createElement('small');
              small.textContent = hint;
              b.appendChild(small);
              b.classList.add('hinted');
            }
            b.dataset.key = key;
            if (key === 'f') b.classList.add('fire');
            if (key === 'Shift' && this.shiftOn) b.classList.add('on');
            this.bind(b, key);
          }
          pad.appendChild(b);
        }
      }
      this.root.appendChild(pad);
    }
  }

  bind(b, key) {
    const combo = key.length === 2;
    const down = (e) => {
      e.preventDefault();
      e.stopPropagation();
      b.classList.add('down');
      if (key === 'Shift') {
        // A toggle: sneak stays on until pressed again.
        this.shiftOn = !this.shiftOn;
        b.classList.toggle('on', this.shiftOn);
        this.send(this.ev(this.shiftOn ? 'down' : 'up', 'Shift'));
        return;
      }
      if (combo) {
        // Two keys in a row (dd, gt, gg) or Ctrl with a letter (^d).
        for (const k of keysOf(key)) {
          this.send(this.ev('down', k.key, !!k.ctrl));
          this.send(this.ev('up', k.key, !!k.ctrl));
        }
        return;
      }
      // Shift on while fighting: hjkl become HJKL (fast look in VIEW).
      const shifted = SCENES[this.scene].shiftCase && this.shiftOn && /^[hjkl]$/.test(key);
      const k = shifted ? key.toUpperCase() : key;
      this.send({ ...this.ev('down', k), code: `Touch-${key}` });
    };
    const up = (e) => {
      e.preventDefault();
      e.stopPropagation();
      b.classList.remove('down');
      if (key === 'Shift' || combo) return;
      this.send({ ...this.ev('up', key), code: `Touch-${key}` });
    };
    b.addEventListener('pointerdown', down);
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('pointerleave', (e) => {
      if (b.classList.contains('down')) up(e);
    });
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}
