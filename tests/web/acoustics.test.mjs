import { test } from 'node:test';
import assert from 'node:assert/strict';
import { airCutoff, wetLevel, ROOMS, impulse, underRoof, OCCLUDED } from '../../web/js/acoustics.js';
import { distanceGain } from '../../web/js/surround.js';
import { Settings } from '../../web/js/settings.js';

test('acoustics: air closes the highs with distance', () => {
  assert.equal(airCutoff(0), 20000);
  assert.ok(airCutoff(100) < 7000 && airCutoff(100) > 5000);
  assert.ok(airCutoff(300) < airCutoff(100));
  assert.equal(airCutoff(1e6), 1500, 'never below 1.5 kHz');
  assert.ok(OCCLUDED.cutoff < airCutoff(300) && OCCLUDED.gain < 1);
});

test('acoustics: far sounds are more echo than sound', () => {
  const ratio = (d) => wetLevel(d, distanceGain) / distanceGain(d);
  assert.ok(ratio(100) > ratio(10) && ratio(10) > ratio(1));
});

test('acoustics: impulse responses decay, differ left and right, and repeat', () => {
  for (const room of Object.values(ROOMS)) {
    const [l, r] = impulse(48000, room, 3);
    assert.equal(l.length, Math.ceil((room.pre + room.t60) * 48000));
    const rms = (d, a, b) => Math.sqrt(d.slice(a, b).reduce((s, x) => s + x * x, 0) / (b - a));
    const n = l.length;
    const early = rms(l, Math.floor(room.pre * 48000), Math.floor(room.pre * 48000) + 4800);
    const late = rms(l, n - 4800, n);
    assert.ok(late < early / 50, `decays: ${early} → ${late}`);
    for (let i = 0; i < Math.floor(room.pre * 48000); i++) assert.equal(l[i], 0, 'silent before it starts');
    assert.notDeepEqual(l.slice(5000, 5100), r.slice(5000, 5100));
    assert.deepEqual(impulse(48000, room, 3)[0].slice(0, 3000), l.slice(0, 3000), 'seeded');
  }
  assert.ok(ROOMS.indoor.t60 < ROOMS.outdoor.t60);
});

test('acoustics: under a roof', () => {
  const roofs = [{ min: { x: 0, y: 3, z: 0 }, max: { x: 10, y: 3.3, z: 10 } }];
  assert.equal(underRoof(roofs, 5, 1.6, 5), true);
  assert.equal(underRoof(roofs, 15, 1.6, 5), false);
  assert.equal(underRoof(roofs, 5, 4.9, 5), false, 'standing on the roof');
  assert.equal(underRoof([], 5, 1.6, 5), false);
});

test('acoustics: :set spatial / reverb', () => {
  const s = new Settings(null);
  assert.equal(s.get('spatial'), true);
  assert.equal(s.get('reverb'), 100);
  assert.equal(s.command('nospatial reverb=40').error, null);
  assert.deepEqual(s.changedArgs(), ['nospatial', 'reverb=40']);
  assert.match(s.command('reverb=300').error, /^E474/);
});
