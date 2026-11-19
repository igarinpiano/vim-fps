// Speakers: where each channel's speaker stands and how much of a sound
// goes to each (`:set speakers=`). Pure module: no Web Audio, testable with
// node --test.
//
// headphones: the browser's HRTF (binaural, 2 channels), as before.
// stereo / quad / 5.1 / 7.1: our own panning, one channel per speaker:
// each sound goes to the two speakers on either side of it (pairwise
// amplitude panning, constant power), on the level (height is not used).

/// Angles in degrees, clockwise from straight ahead (90 = right). The order
/// is the channel order the browser hands the sound card (Web Audio's own
/// for quad and 5.1, WAVE_FORMAT_EXTENSIBLE's for 7.1). `lfe`: the
/// subwoofer channel (sent nothing directly; receivers route bass to it).
export const LAYOUTS = {
  stereo: [
    { name: 'L', label: '左 (フロント)', az: -30 },
    { name: 'R', label: '右 (フロント)', az: 30 },
  ],
  quad: [
    { name: 'L', label: '左フロント', az: -45 },
    { name: 'R', label: '右フロント', az: 45 },
    { name: 'SL', label: '左リア', az: -135 },
    { name: 'SR', label: '右リア', az: 135 },
  ],
  '5.1': [
    { name: 'L', label: '左フロント', az: -30 },
    { name: 'R', label: '右フロント', az: 30 },
    { name: 'C', label: 'センター', az: 0 },
    { name: 'LFE', label: 'サブウーファー (LFE)', lfe: true },
    { name: 'SL', label: '左サラウンド', az: -110 },
    { name: 'SR', label: '右サラウンド', az: 110 },
  ],
  '7.1': [
    { name: 'L', label: '左フロント', az: -30 },
    { name: 'R', label: '右フロント', az: 30 },
    { name: 'C', label: 'センター', az: 0 },
    { name: 'LFE', label: 'サブウーファー (LFE)', lfe: true },
    { name: 'BL', label: '左バック', az: -150 },
    { name: 'BR', label: '右バック', az: 150 },
    { name: 'SL', label: '左サイド', az: -90 },
    { name: 'SR', label: '右サイド', az: 90 },
  ],
};

export const SPEAKER_MODES = ['headphones', 'stereo', 'quad', '5.1', '7.1', 'auto'];

/// The mode to use for `setting` when the output has `maxChannels`
/// channels: { mode, note } (note: why it is not what was asked, or '').
export function resolveMode(setting, maxChannels) {
  const max = maxChannels || 2;
  if (setting === 'auto') {
    const mode = max >= 8 ? '7.1' : max >= 6 ? '5.1' : max >= 4 ? 'quad' : 'headphones';
    return { mode, note: '' };
  }
  if (setting === 'headphones' || !LAYOUTS[setting]) return { mode: 'headphones', note: '' };
  const need = LAYOUTS[setting].length;
  if (need <= max) return { mode: setting, note: '' };
  // Fewer channels than asked: the largest layout that fits.
  const fit = ['7.1', '5.1', 'quad', 'stereo'].find((m) => LAYOUTS[m].length <= max) || 'stereo';
  return { mode: fit, note: `出力が ${max} チャンネルしかないので ${fit} にしました (${setting} には ${need} チャンネル必要)` };
}

const rad = (d) => (d * Math.PI) / 180;

/// Angle (degrees, clockwise from ahead) of a point dx, dz away from a
/// listener facing `yaw` (three.js: yaw 0 looks along -z).
export function azimuth(dx, dz, yaw) {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  return (Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz) * 180) / Math.PI;
}

/// Gains for each channel of `layout` for a sound at `az` degrees.
/// Constant power (the squares add up to 1). `spread` 0..1 blends toward
/// every speaker alike (for sounds right on top of the listener).
export function panGains(layout, az, spread = 0) {
  const n = layout.length;
  const g = new Array(n).fill(0);
  const sp = layout.map((s, i) => ({ ...s, i })).filter((s) => !s.lfe);
  if (sp.length === 2) {
    // Stereo: constant-power pan by how far right the sound is (behind
    // folds to the front, as on two speakers it must).
    const x = Math.max(-1, Math.min(1, Math.sin(rad(az)) / Math.sin(rad(sp[1].az))));
    const t = ((x + 1) / 2) * (Math.PI / 2);
    g[sp[0].i] = Math.cos(t);
    g[sp[1].i] = Math.sin(t);
  } else {
    // The two neighbours around the circle; their gains from the 2D VBAP
    // equations (the sound's direction as a sum of the two speakers').
    const ring = [...sp].sort((a, b) => a.az - b.az);
    const a = ((((az + 180) % 360) + 360) % 360) - 180;
    let k = ring.findIndex((s, j) => {
      const next = ring[(j + 1) % ring.length];
      const span = (next.az - s.az + 360) % 360 || 360;
      return (a - s.az + 360) % 360 <= span;
    });
    if (k < 0) k = ring.length - 1;
    const s1 = ring[k];
    const s2 = ring[(k + 1) % ring.length];
    const [px, pz] = [Math.sin(rad(a)), Math.cos(rad(a))];
    const [ax, az1] = [Math.sin(rad(s1.az)), Math.cos(rad(s1.az))];
    const [bx, bz] = [Math.sin(rad(s2.az)), Math.cos(rad(s2.az))];
    const det = ax * bz - bx * az1;
    let g1 = (px * bz - bx * pz) / det;
    let g2 = (ax * pz - px * az1) / det;
    g1 = Math.max(0, g1);
    g2 = Math.max(0, g2);
    const norm = Math.hypot(g1, g2) || 1;
    g[s1.i] = g1 / norm;
    g[s2.i] = g2 / norm;
  }
  if (spread > 0) {
    const even = 1 / Math.sqrt(sp.length);
    let sum = 0;
    for (const s of sp) {
      g[s.i] = (1 - spread) * g[s.i] + spread * even;
      sum += g[s.i] * g[s.i];
    }
    const norm = Math.sqrt(sum) || 1;
    for (const s of sp) g[s.i] /= norm;
  }
  return g;
}

/// Loudness by distance: the PannerNode's "inverse" model with the
/// numbers the headphones mode uses (refDistance 4, rolloff 1.2, max 300).
export const DISTANCE = { ref: 4, rolloff: 1.2, max: 300 };
export function distanceGain(d) {
  const { ref, rolloff, max } = DISTANCE;
  const x = Math.min(Math.max(d, ref), max);
  return ref / (ref + rolloff * (x - ref));
}

/// How much a sound this close spreads over all speakers (1 on top of the
/// listener, 0 from 1.5 m away).
export function spreadAt(d) {
  return Math.max(0, Math.min(1, 1 - d / 1.5));
}
