// Sounds. Gunfire, steps and the like are synthesized (no audio files),
// positional with a PannerNode. A few moments play a sound file instead:
// spawning, being killed, taking damage and the end of a match (see
// EVENT_SOUNDS).

/// Event sounds: files named by the skins (skin.js: "sounds" in
/// skin.json). Without a skin.json, web/assets/sounds/<event>.wav (or .mp3 /
/// .ogg). Without a file the moment passes in silence.
export const EVENT_SOUNDS = {
  startup: 'スポーン時 (起動音)',
  error: 'キルされた時 (エラー音)',
  error2: '被弾した時 (ダメージを受けるたび)',
  shutdown: '試合終了時 (システム終了音)',
};
const SOUND_EXTS = ['wav', 'mp3', 'ogg'];

export class Sound {
  constructor(settings) {
    this.s = settings;
    this.ctx = null;
    this.noise = null;
    // Event sounds: name -> AudioBuffer (decoded), 'missing', or a promise
    // while loading.
    this.samples = new Map();
    this.base = new URL('../assets/sounds/', import.meta.url);
    // event -> where its file is: a URL, a Blob, or a list of URLs to try.
    // null: the old fixed names under assets/sounds/ (until the skins load).
    this.sources = null;
    // What to play once its file has loaded (asked for before that).
    this.queued = null;
    this.playing = null;
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
    this.loadSamples();
  }

  /// Where the event sounds come from (from the skins): { event: URL |
  /// Blob | [URL, ...] }. An event left out has no sound. Reloads them.
  setSources(map) {
    this.sources = map || {};
    this.gen = (this.gen || 0) + 1;
    this.samples.clear();
    if (this.ctx) this.loadSamples();
  }

  /// Fetches and decodes one event sound; tries each candidate in turn.
  async loadSample(name) {
    const src = this.sources ? this.sources[name] : SOUND_EXTS.map((ext) => new URL(`${name}.${ext}`, this.base).href);
    if (!src) return 'missing';
    if (typeof src !== 'string' && !Array.isArray(src)) {
      try {
        return await this.ctx.decodeAudioData(await src.arrayBuffer());
      } catch {
        return 'missing';
      }
    }
    for (const url of Array.isArray(src) ? src : [src]) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        // A host that answers every path with a page is no sound.
        const type = res.headers.get('content-type') || '';
        if (type.startsWith('text/')) continue;
        const data = await res.arrayBuffer();
        return await this.ctx.decodeAudioData(data);
      } catch {
        // Not there, or not audio: the next candidate.
      }
    }
    return 'missing';
  }

  loadSamples() {
    for (const name of Object.keys(EVENT_SOUNDS)) {
      if (this.samples.has(name)) continue;
      const gen = this.gen;
      const job = this.loadSample(name).then((buf) => {
        // Sources changed while this loaded: the newer load wins.
        if (gen !== this.gen) return buf;
        this.samples.set(name, buf);
        if (this.queued && this.queued.name === name && performance.now() - this.queued.at < 1500) {
          this.queued = null;
          this.event(name);
        }
        return buf;
      });
      this.samples.set(name, job);
    }
  }

  /// For each event sound: 'file' (loaded), 'none' (no file: silent) or
  /// '?' (not loaded yet).
  sampleStatus() {
    const out = {};
    for (const name of Object.keys(EVENT_SOUNDS)) {
      const v = this.samples.get(name);
      out[name] = v === 'missing' ? 'none' : v && typeof v.then !== 'function' ? 'file' : '?';
    }
    return out;
  }

  /// Plays an event sound (startup / error / shutdown), not positional.
  /// One at a time: a new one cuts the last one off.
  event(name) {
    if (!this.ctx) return;
    const buf = this.samples.get(name);
    if (!buf || typeof buf.then === 'function') {
      // Still loading: play it when it arrives (if that is soon).
      this.queued = { name, at: performance.now() };
      return;
    }
    this.queued = null;
    this.stopEvent();
    // No file: nothing plays.
    if (buf === 'missing') return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = 0.9;
    src.connect(g).connect(this.master);
    src.start();
    this.playing = { src, g };
    src.onended = () => {
      if (this.playing && this.playing.src === src) this.playing = null;
    };
  }

  /// Taking damage: error2 from its file, over whatever else plays (it
  /// does not cut the event sounds off). Hits that come faster than a few
  /// a second share one play. Returns false when there is no file (the
  /// caller then plays its synthesized sound).
  damage() {
    if (!this.ctx) return true;
    const buf = this.samples.get('error2');
    if (!buf || buf === 'missing' || typeof buf.then === 'function') return false;
    const now = performance.now();
    if (this.lastDamage && now - this.lastDamage < 180) return true;
    this.lastDamage = now;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = 0.8;
    src.connect(g).connect(this.master);
    src.start();
    return true;
  }

  stopEvent() {
    const p = this.playing;
    if (!p) return;
    this.playing = null;
    try {
      p.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03);
      p.src.stop(this.ctx.currentTime + 0.15);
    } catch {
      // Already stopped.
    }
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

  /// A tank gun.
  cannon(pos) {
    this.burst({ pos, freq: 500, dur: 0.6, gain: 1.3 });
    this.tone({ pos, freq: 110, to: 35, dur: 0.55, gain: 0.9, type: 'sine' });
  }

  footstep(pos, quiet) {
    this.burst({ pos, freq: 300, dur: 0.07, gain: quiet ? 0.08 : 0.35, q: 1.2 });
  }

  /// A tank's engine and tracks, once per "step" while it moves.
  rumble(pos) {
    this.burst({ pos, freq: 160, dur: 0.16, gain: pos ? 0.5 : 0.12, q: 0.8 });
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

  /// Outside the ring: a low tick with each bit of damage.
  ringTick() {
    this.tone({ freq: 150, to: 90, dur: 0.12, gain: 0.22, type: 'triangle' });
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
