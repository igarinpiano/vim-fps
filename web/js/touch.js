// On-screen keys for phones and tablets. Each button sends the same key
// events a keyboard would, so the modes and rules stay exactly the same
// (no aiming by dragging: still no "mouse").

const LAYOUT = {
  left: [
    [null, 'k', null],
    ['h', 'j', 'l'],
  ],
  right: [
    ['Escape', 'v', 'f'],
    ['dd', 'r', 'y'],
    [',', '.', '~'],
    ['s', 'm', '*'],
    ['Shift', 'i', ':'],
    ['Enter', 'gt', '1'],
  ],
};

const LABEL = { Escape: 'Esc', Shift: 'Shift', Enter: '⏎', dd: 'dd', gt: 'gt', ',': ',', '.': '.' };

export class TouchPad {
  constructor(root, settings, send) {
    this.root = root;
    this.s = settings;
    this.send = send;
    this.active = false;
    this.shiftOn = false;
    this.build();
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

  ev(type, key) {
    const code = `Touch-${key}`;
    return { type, key, code, shift: this.shiftOn, ctrl: false, repeat: false };
  }

  build() {
    for (const side of ['left', 'right']) {
      const pad = document.createElement('div');
      pad.className = `pad ${side}`;
      for (const row of LAYOUT[side]) {
        for (const key of row) {
          const b = document.createElement('button');
          b.type = 'button';
          if (!key) {
            b.className = 'blank';
            b.disabled = true;
          } else {
            b.textContent = LABEL[key] || key;
            b.dataset.key = key;
            if (key === 'f') b.classList.add('fire');
            this.bind(b, key);
          }
          pad.appendChild(b);
        }
      }
      this.root.appendChild(pad);
    }
  }

  bind(b, key) {
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
      if (key.length === 2 && key !== 'gt' && key !== 'dd') {
        this.send(this.ev('down', key));
        return;
      }
      if (key === 'dd' || key === 'gt') {
        for (const k of key) {
          this.send(this.ev('down', k));
          this.send(this.ev('up', k));
        }
        return;
      }
      const k = this.shiftOn && /^[hjkl]$/.test(key) ? key.toUpperCase() : key;
      this.send({ ...this.ev('down', k), code: `Touch-${key}` });
    };
    const up = (e) => {
      e.preventDefault();
      e.stopPropagation();
      b.classList.remove('down');
      if (key === 'Shift' || key === 'dd' || key === 'gt') return;
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
