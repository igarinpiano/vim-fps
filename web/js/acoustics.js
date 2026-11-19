// Spatial audio beyond direction (`:set spatial`, `:set reverb`): what the
// air, walls and rooms do to a sound on its way to you. Pure module: no
// Web Audio, testable with node --test.
//
// - Air: far sounds lose their highs (a low-pass that closes with distance).
// - Walls: a wall or hill between you and a sound muffles it (low-pass) and
//   makes it quieter; more of it reaches you as echo.
// - Rooms: under a roof the echo is short and close; outside it is long,
//   thin and late (a far-off slap from the land around).

/// Low-pass cutoff (Hz) for air over `d` metres: open at hand, about 6 kHz
/// at 100 m, 2.6 kHz at 300 m.
export function airCutoff(d) {
  return Math.max(1500, Math.min(20000, 22000 / (1 + Math.max(0, d) / 40)));
}

/// A wall in the way: cutoff (Hz) and how much of the sound gets through.
export const OCCLUDED = { cutoff: 1100, gain: 0.5, wet: 1.6 };

/// How much of a sound `d` metres away goes into the echo (before the
/// `reverb` setting): falls slower than the sound itself, so far sounds are
/// more echo than sound, as they are.
export function wetLevel(d, distanceGain) {
  return 0.5 * Math.sqrt(distanceGain(d));
}

/// The two rooms: how long the echo takes to die away (seconds, -60 dB),
/// how late it starts, how dark it gets, how loud it is, and early
/// reflections [delay s, level] off the nearest walls.
export const ROOMS = {
  indoor: { t60: 0.8, pre: 0.004, bright: 0.55, dark: 0.92, level: 0.9, early: [[0.011, 0.5], [0.017, -0.4], [0.023, 0.35], [0.031, -0.3], [0.043, 0.22]] },
  outdoor: { t60: 1.4, pre: 0.045, bright: 0.75, dark: 0.96, level: 0.09, early: [[0.06, 0.25], [0.11, 0.15], [0.19, 0.08]] },
};

/// A small seeded random source (the same echo each time).
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 31 - 1;
  };
}

/// An impulse response for `room` at `fs` Hz: [left, right] (Float32Array),
/// decaying noise that darkens as it dies, the two sides different so the
/// echo surrounds you.
export function impulse(fs, room, seed = 1) {
  const len = Math.ceil((room.pre + room.t60) * fs);
  const out = [];
  for (let ch = 0; ch < 2; ch++) {
    const rand = rng(seed * 7919 + ch * 104729);
    const d = new Float32Array(len);
    const start = Math.floor(room.pre * fs);
    let y = 0;
    for (let i = start; i < len; i++) {
      const t = (i - start) / fs;
      const env = 10 ** ((-3 * t) / room.t60);
      // One-pole low-pass that closes over the tail.
      const a = room.bright + (room.dark - room.bright) * Math.min(1, t / room.t60);
      y = a * y + (1 - a) * rand();
      d[i] = y * env;
    }
    for (const [delay, level] of room.early) {
      const i = Math.floor((room.pre + delay * (ch ? 1.07 : 1)) * fs);
      if (i < len) d[i] += level * (ch ? -1 : 1) * 0.6;
    }
    out.push(d);
  }
  return out;
}

/// What stops sound: walls, roofs, rocks, cover and crates. Not tree trunks
/// or fences (sound goes round and through them).
export const SOUND_BLOCKERS = ['wall', 'roof', 'rock', 'cover', 'crate'];

/// Is a point under a roof? `roofs`: solids ({ min, max }) of kind roof.
export function underRoof(roofs, x, y, z) {
  return roofs.some((r) => x > r.min.x && x < r.max.x && z > r.min.z && z < r.max.z && r.min.y > y);
}
