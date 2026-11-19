// Sounds. Gunfire, steps and the like are synthesized (no audio files),
// positional: through the browser's HRTF on headphones, or panned over the
// speakers for stereo / quad / 5.1 / 7.1 (`:set speakers`, surround.js). A few moments play a sound file instead:
// spawning, being killed, taking damage and the end of a match (see
// EVENT_SOUNDS).

import { parseEq, isFlat, biquad } from './eq.js';
import { LAYOUTS, resolveMode, azimuth, panGains, distanceGain, spreadAt, DISTANCE } from './surround.js';

/// How loud the subwoofer gets the bass of each sound (5.1 / 7.1).
const LFE_LEVEL = 0.35;

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
    this.graph = [];
    this.voices = [];
    this.lx = 0;
    this.ly = 0;
    this.lz = 0;
    this.yaw = 0;
    this.rebuild();
    this.s.onChange((k) => {
      if (k === 'eq' || k === 'speakers') this.rebuild();
    });
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.loadSamples();
  }

  /// How many channels the sound card takes (2 when the browser does not
  /// say).
  maxChannels() {
    return (this.ctx && this.ctx.destination.maxChannelCount) || 2;
  }

  /// Builds the output from `:set speakers` and `:set eq`:
  ///
  ///   headphones: sounds → HRTF panner ─┐
  ///               flat sounds ──────────┴→ master → (EQ) → 2 channels
  ///   speakers:   sounds → a gain per speaker ─→ bus (one input per
  ///               channel) → master → (EQ) → N channels, as they are
  ///               flat sounds → front (L / R) ─┘
  ///
  /// Sounds already playing on the old graph go quiet.
  rebuild() {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const n of this.graph) n.disconnect();
    this.graph = [];
    this.voices = [];
    const { mode, note } = resolveMode(this.s.get('speakers'), this.maxChannels());
    this.mode = mode;
    this.modeNote = note;
    this.layout = mode === 'headphones' ? null : LAYOUTS[mode];
    const n = this.layout ? this.layout.length : 2;
    const discrete = !!this.layout;
    const fit = (node, count = n, disc = discrete) => {
      node.channelCount = count;
      node.channelCountMode = 'explicit';
      node.channelInterpretation = disc ? 'discrete' : 'speakers';
      return node;
    };
    try {
      fit(ctx.destination);
    } catch {
      // The card refuses that many channels: stay on what it had.
    }
    const keep = (node) => (this.graph.push(node), node);
    this.master = keep(fit(ctx.createGain()));
    this.master.gain.value = this.s.get('volume') / 100;
    if (this.layout) {
      this.bus = keep(ctx.createChannelMerger(n));
      this.bus.connect(this.master);
      // Flat sounds (event sounds, your own hits): left and right front.
      this.front = keep(fit(ctx.createGain(), 2, false));
      const split = keep(ctx.createChannelSplitter(2));
      this.front.connect(split);
      split.connect(this.bus, 0, this.layout.findIndex((sp) => sp.name === 'L'));
      split.connect(this.bus, 1, this.layout.findIndex((sp) => sp.name === 'R'));
      // The subwoofer: the bass of everything, a little down.
      const lfe = this.layout.findIndex((sp) => sp.lfe);
      this.lfe = null;
      if (lfe >= 0) {
        this.lfe = keep(fit(ctx.createBiquadFilter(), 1, true));
        this.lfe.type = 'lowpass';
        this.lfe.frequency.value = 120;
        this.lfe.connect(this.bus, 0, lfe);
        const fromFront = keep(fit(ctx.createGain(), 1, false));
        fromFront.gain.value = LFE_LEVEL;
        this.front.connect(fromFront).connect(this.lfe);
      }
    } else {
      this.bus = null;
      this.lfe = null;
      this.front = this.master;
    }
    this.buildEq(n, fit, keep);
  }

  /// master → preamp → filters → limiter → the card, or master → the card
  /// when `:set eq` is flat.
  buildEq(n, fit, keep) {
    const ctx = this.ctx;
    let eq;
    try {
      eq = parseEq(this.s.get('eq') === 'off' ? '' : this.s.get('eq'));
    } catch {
      eq = { pre: 0, bands: [] };
    }
    this.eqNodes = [];
    if (isFlat(eq)) {
      this.master.connect(ctx.destination);
      return;
    }
    const fs = ctx.sampleRate;
    const pre = fit(ctx.createGain());
    pre.gain.value = 10 ** (eq.pre / 20);
    const chain = [pre];
    for (const band of eq.bands) {
      const { b, a } = biquad(band, fs);
      let node;
      if (ctx.createIIRFilter) node = ctx.createIIRFilter(b, a);
      else {
        // No IIRFilterNode (old browsers): Web Audio's own biquads (their
        // shelves ignore Q).
        node = ctx.createBiquadFilter();
        node.type = { pk: 'peaking', ls: 'lowshelf', hs: 'highshelf', lp: 'lowpass', hp: 'highpass' }[band.type];
        node.frequency.value = Math.min(band.freq, fs * 0.49);
        node.gain.value = band.gain;
        node.Q.value = band.type === 'lp' || band.type === 'hp' ? 20 * Math.log10(band.q) : band.q;
      }
      chain.push(fit(node));
    }
    // Boosts can go over full scale: a limiter keeps them from clipping. A
    // compressor takes at most 2 channels, so past that one per channel.
    const limiter = () => {
      const lim = ctx.createDynamicsCompressor();
      lim.threshold.value = -1;
      lim.knee.value = 0;
      lim.ratio.value = 20;
      lim.attack.value = 0.002;
      lim.release.value = 0.15;
      return lim;
    };
    const one = limiter();
    // The compressor adds makeup gain, (1 / its gain at full scale)^0.6
    // (Web Audio spec): taken back off so quiet sounds pass unchanged.
    const atFull = one.threshold.value * (1 - 1 / one.ratio.value);
    const post = fit(ctx.createGain());
    post.gain.value = 10 ** ((0.6 * atFull) / 20);
    for (let i = 0; i + 1 < chain.length; i++) chain[i].connect(chain[i + 1]);
    const last = chain[chain.length - 1];
    if (n <= 2) {
      last.connect(one).connect(post);
      chain.push(one);
    } else {
      const split = ctx.createChannelSplitter(n);
      const merge = ctx.createChannelMerger(n);
      last.connect(split);
      for (let i = 0; i < n; i++) {
        const lim = i === 0 ? one : limiter();
        lim.channelCount = 1;
        lim.channelCountMode = 'explicit';
        split.connect(lim, i).connect(merge, 0, i);
        chain.push(lim);
      }
      merge.connect(post);
      chain.push(split, merge);
    }
    chain.push(post);
    this.master.connect(pre);
    post.connect(ctx.destination);
    for (const node of chain) keep(node);
    this.eqNodes = chain;
  }

  /// What `:speakers` shows: { mode, setting, note, max, layout }.
  outputInfo() {
    return { mode: this.mode, setting: this.s.get('speakers'), note: this.modeNote || '', max: this.maxChannels(), layout: this.layout };
  }

  /// `:speakers test`: noise on each speaker in turn (headphones: from the
  /// left, right, front and behind). `onEach(label)` as each one starts.
  /// Returns how long it all takes (seconds).
  speakerTest(onEach) {
    if (!this.ctx) return 0;
    const STEP = 1.1;
    const t0 = this.ctx.currentTime + 0.1;
    const steps = this.layout
      ? this.layout.map((sp, i) => ({ label: `${sp.name} ${sp.label}`, ch: i, lfe: sp.lfe }))
      : [
          { label: '左', az: -90 },
          { label: '右', az: 90 },
          { label: '前', az: 0 },
          { label: '後ろ', az: 180 },
        ];
    steps.forEach((st, k) => {
      const t = t0 + k * STEP;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const f = this.ctx.createBiquadFilter();
      f.type = st.lfe ? 'lowpass' : 'bandpass';
      f.frequency.value = st.lfe ? 70 : 1200;
      f.Q.value = st.lfe ? 0.7 : 0.4;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(st.lfe ? 0.9 : 0.5, t + 0.05);
      g.gain.setValueAtTime(st.lfe ? 0.9 : 0.5, t + STEP - 0.25);
      g.gain.linearRampToValueAtTime(0, t + STEP - 0.15);
      src.connect(f).connect(g);
      if (this.layout) {
        g.channelCount = 1;
        g.channelCountMode = 'explicit';
        g.connect(this.bus, 0, st.ch);
      } else {
        const r = 4;
        const a = (st.az * Math.PI) / 180;
        // Straight from where the listener faces.
        const fx = -Math.sin(this.yaw);
        const fz = -Math.cos(this.yaw);
        const rx = Math.cos(this.yaw);
        const rz = -Math.sin(this.yaw);
        const pos = { x: this.lx + r * (Math.cos(a) * fx + Math.sin(a) * rx), y: this.ly, z: this.lz + r * (Math.cos(a) * fz + Math.sin(a) * rz) };
        g.connect(this.out(pos, STEP));
      }
      src.start(t);
      src.stop(t + STEP);
      setTimeout(() => onEach && onEach(st.label, k, steps.length), Math.max(0, (t - this.ctx.currentTime) * 1000));
    });
    return 0.1 + steps.length * STEP;
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
    src.connect(g).connect(this.front);
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
    src.connect(g).connect(this.front);
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
    this.lx = x;
    this.ly = y;
    this.lz = z;
    this.yaw = yaw;
    if (this.layout) {
      // Our own panning: sounds still playing follow the listener.
      const now = this.ctx.currentTime;
      this.voices = this.voices.filter((v) => v.until > now);
      for (const v of this.voices) this.place(v, false);
      return;
    }
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

  /// Where a sound goes in: `pos` null for a flat sound (no direction).
  /// `dur`: how long it plays (seconds), for following the listener.
  out(pos, dur = 2) {
    if (!pos) return this.front;
    if (this.layout) return this.speakersOut(pos, dur);
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = DISTANCE.ref;
    p.rolloffFactor = DISTANCE.rolloff;
    p.maxDistance = DISTANCE.max;
    if (p.positionX) {
      p.positionX.value = pos.x;
      p.positionY.value = pos.y;
      p.positionZ.value = pos.z;
    } else p.setPosition(pos.x, pos.y, pos.z);
    p.connect(this.master);
    return p;
  }

  /// A positional sound on the speakers: one gain per speaker into the bus
  /// (and some of it to the subwoofer).
  speakersOut(pos, dur) {
    const ctx = this.ctx;
    const input = ctx.createGain();
    input.channelCount = 1;
    input.channelCountMode = 'explicit';
    const sends = this.layout.map((sp, i) => {
      if (sp.lfe) return null;
      const g = ctx.createGain();
      input.connect(g).connect(this.bus, 0, i);
      return g;
    });
    let lfe = null;
    if (this.lfe) {
      lfe = ctx.createGain();
      input.connect(lfe).connect(this.lfe);
    }
    const v = { pos, sends, lfe, until: ctx.currentTime + dur + 0.2 };
    this.place(v, true);
    this.voices.push(v);
    return input;
  }

  /// Sets a voice's speaker gains from where it is against the listener.
  place(v, now) {
    const dx = v.pos.x - this.lx;
    const dy = v.pos.y - this.ly;
    const dz = v.pos.z - this.lz;
    const flat = Math.hypot(dx, dz);
    const near = distanceGain(Math.hypot(flat, dy));
    const gains = panGains(this.layout, azimuth(dx, dz, this.yaw), spreadAt(flat));
    const t = this.ctx.currentTime;
    const set = (param, value) => {
      if (now) param.value = value;
      else param.setTargetAtTime(value, t, 0.03);
    };
    v.sends.forEach((g, i) => {
      if (g) set(g.gain, gains[i] * near);
    });
    if (v.lfe) set(v.lfe.gain, near * LFE_LEVEL);
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
    src.connect(f).connect(g).connect(this.out(pos, dur));
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
    o.connect(g).connect(this.out(pos, dur));
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
