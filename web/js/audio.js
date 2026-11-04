// Synthesized sounds (no audio files). Positional with a PannerNode.

export class Sound {
  constructor(settings) {
    this.s = settings;
    this.ctx = null;
    this.noise = null;
  }

  /// Browsers allow audio only after a user gesture; call on a key press.
  wake() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  listener(x, y, z, yaw) {
    if (!this.ctx) return;
    this.master.gain.value = this.s.get('volume') / 100;
    const l = this.ctx.listener;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    if (l.positionX) {
      l.positionX.value = x;
      l.positionY.value = y;
      l.positionZ.value = z;
      l.forwardX.value = fx;
      l.forwardY.value = 0;
      l.forwardZ.value = fz;
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    } else if (l.setPosition) {
      l.setPosition(x, y, z);
      l.setOrientation(fx, 0, fz, 0, 1, 0);
    }
  }

  out(pos) {
    if (!pos) return this.master;
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 4;
    p.rolloffFactor = 1.2;
    p.maxDistance = 300;
    if (p.positionX) {
      p.positionX.value = pos.x;
      p.positionY.value = pos.y;
      p.positionZ.value = pos.z;
    } else p.setPosition(pos.x, pos.y, pos.z);
    p.connect(this.master);
    return p;
  }

  burst({ pos, dur = 0.12, freq = 1200, q = 0.7, gain = 0.6, type = 'lowpass' }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.out(pos));
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  tone({ pos, freq = 800, dur = 0.06, gain = 0.25, type = 'square', to = null }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.out(pos));
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  shot(gun, pos) {
    const p = { ar: [1800, 0.12, 0.7], smg: [2200, 0.08, 0.55], sg: [900, 0.25, 0.9], sr: [700, 0.45, 1.0] }[gun] || [1500, 0.1, 0.6];
    this.burst({ pos, freq: p[0], dur: p[1], gain: p[2] });
    this.tone({ pos, freq: 140, to: 50, dur: p[1], gain: p[2] * 0.5, type: 'sine' });
  }

  footstep(pos, quiet) {
    this.burst({ pos, freq: 300, dur: 0.07, gain: quiet ? 0.08 : 0.35, q: 1.2 });
  }

  explosion(pos) {
    this.burst({ pos, freq: 400, dur: 0.9, gain: 1.2 });
    this.tone({ pos, freq: 90, to: 30, dur: 0.8, gain: 0.8, type: 'sine' });
  }

  hit(head) {
    this.tone({ freq: head ? 1800 : 1200, dur: 0.05, gain: 0.2 });
  }

  hurt() {
    this.tone({ freq: 220, to: 120, dur: 0.15, gain: 0.3, type: 'sawtooth' });
  }

  click() {
    this.tone({ freq: 2400, dur: 0.02, gain: 0.08 });
  }

  ding() {
    // A short two-note chime for notifications.
    this.tone({ freq: 880, dur: 0.12, gain: 0.12, type: 'sine' });
    setTimeout(() => this.tone({ freq: 1320, dur: 0.18, gain: 0.1, type: 'sine' }), 90);
  }
}
