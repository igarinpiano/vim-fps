import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAYOUTS, resolveMode, azimuth, panGains, distanceGain, spreadAt } from '../../web/js/surround.js';
import { Settings } from '../../web/js/settings.js';

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≈ ${b}`);
const power = (g) => g.reduce((s, x) => s + x * x, 0);
const idx = (layout, name) => LAYOUTS[layout].findIndex((s) => s.name === name);

test('surround: azimuth is clockwise from where you face', () => {
  // yaw 0 faces -z; +x is to the right.
  near(azimuth(0, -1, 0), 0);
  near(azimuth(1, 0, 0), 90);
  near(azimuth(-1, 0, 0), -90);
  near(Math.abs(azimuth(0, 1, 0)), 180);
  // Turned left a quarter (facing -x): what was ahead (-z) is now right.
  near(azimuth(0, -1, Math.PI / 2), 90);
});

test('surround: a sound on a speaker comes from that speaker alone', () => {
  for (const [mode, layout] of Object.entries(LAYOUTS)) {
    if (mode === 'stereo') continue;
    for (const [i, sp] of layout.entries()) {
      if (sp.lfe) continue;
      const g = panGains(layout, sp.az);
      near(g[i], 1, 1e-9);
      near(power(g), 1, 1e-9);
    }
  }
});

test('surround: between two speakers, only those two, at constant power', () => {
  for (const mode of ['quad', '5.1', '7.1']) {
    for (let az = -180; az < 180; az += 7) {
      const g = panGains(LAYOUTS[mode], az);
      near(power(g), 1, 1e-9);
      assert.ok(g.filter((x) => x > 1e-9).length <= 2, `${mode} ${az}: ${g}`);
      const lfe = LAYOUTS[mode].findIndex((s) => s.lfe);
      if (lfe >= 0) assert.equal(g[lfe], 0, 'nothing straight to the LFE');
    }
  }
  // 5.1: right behind is shared by the two surrounds; 20° right by C and R.
  const back = panGains(LAYOUTS['5.1'], 180);
  near(back[idx('5.1', 'SL')], back[idx('5.1', 'SR')], 1e-9);
  const g = panGains(LAYOUTS['5.1'], 20);
  assert.ok(g[idx('5.1', 'R')] > g[idx('5.1', 'C')] && g[idx('5.1', 'C')] > 0);
  // 7.1: a sound at 120° sits between the right side (90) and back (150).
  const g7 = panGains(LAYOUTS['7.1'], 120);
  near(g7[idx('7.1', 'SR')], g7[idx('7.1', 'BR')], 1e-9);
});

test('surround: stereo pans by left / right and folds behind to the front', () => {
  const L = LAYOUTS.stereo;
  near(panGains(L, 0)[0], Math.SQRT1_2);
  near(panGains(L, 90)[1], 1);
  near(panGains(L, -90)[0], 1);
  assert.deepEqual(panGains(L, 150).map((x) => x.toFixed(6)), panGains(L, 30).map((x) => x.toFixed(6)));
});

test('surround: right on top of you, a sound spreads over every speaker', () => {
  const g = panGains(LAYOUTS['5.1'], 90, 1);
  near(power(g), 1, 1e-9);
  const lfe = idx('5.1', 'LFE');
  for (const [i, x] of g.entries()) if (i !== lfe) near(x, 1 / Math.sqrt(5), 1e-9);
  near(spreadAt(0), 1);
  near(spreadAt(3), 0);
});

test('surround: distance like the PannerNode (inverse, ref 4, rolloff 1.2)', () => {
  near(distanceGain(1), 1);
  near(distanceGain(4), 1);
  near(distanceGain(14), 4 / (4 + 1.2 * 10));
  near(distanceGain(1000), distanceGain(300));
});

test('surround: modes from the setting and the channels there are', () => {
  assert.deepEqual(resolveMode('headphones', 8), { mode: 'headphones', note: '' });
  assert.equal(resolveMode('auto', 8).mode, '7.1');
  assert.equal(resolveMode('auto', 6).mode, '5.1');
  assert.equal(resolveMode('auto', 4).mode, 'quad');
  assert.equal(resolveMode('auto', 2).mode, 'headphones');
  assert.equal(resolveMode('auto', 0).mode, 'headphones');
  assert.deepEqual(resolveMode('5.1', 6), { mode: '5.1', note: '' });
  const r = resolveMode('7.1', 6);
  assert.equal(r.mode, '5.1');
  assert.match(r.note, /6 チャンネル/);
  assert.equal(resolveMode('5.1', 2).mode, 'stereo');
});

test('surround: :set speakers', () => {
  const s = new Settings(null);
  assert.equal(s.get('speakers'), 'headphones');
  assert.equal(s.command('speakers=5.1').error, null);
  assert.equal(s.get('speakers'), '5.1');
  assert.equal(s.command('spk=7.1').error, null);
  assert.match(s.command('speakers=9.1').error, /^E474/);
  assert.deepEqual(s.changedArgs(), ['speakers=7.1']);
});
