import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEq, formatEq, eqError, responseDb, eqGraph, apoToEq, looksLikeApo, biquad, EQ_PRESETS } from '../../web/js/eq.js';
import { Settings } from '../../web/js/settings.js';

const near = (a, b, tol = 0.05) => assert.ok(Math.abs(a - b) <= tol, `${a} ≈ ${b}`);

test('eq: filters, presets and preamp', () => {
  assert.deepEqual(parseEq(''), { pre: 0, bands: [] });
  assert.deepEqual(parseEq('ls100:+6'), { pre: 0, bands: [{ type: 'ls', freq: 100, gain: 6, q: 0.707 }] });
  assert.deepEqual(parseEq('3k:-2.5:1.4').bands, [{ type: 'pk', freq: 3000, gain: -2.5, q: 1.4 }]);
  assert.deepEqual(parseEq('hp30').bands, [{ type: 'hp', freq: 30, gain: 0, q: 0.707 }]);
  assert.deepEqual(parseEq('lp12k::2').bands, [{ type: 'lp', freq: 12000, gain: 0, q: 2 }]);
  const mixed = parseEq('bass, hs8k:+2 ,pre-3');
  assert.equal(mixed.pre, -3);
  assert.deepEqual(mixed.bands.map((b) => b.type), ['ls', 'hs']);
  for (const k of Object.keys(EQ_PRESETS)) assert.equal(eqError(k), null, k);
});

test('eq: bad values are refused with a reason', () => {
  for (const bad of ['zz100:+1', '100', 'pk100:+40', 'hp100:+3', 'foo', '5:+1', '100:+1:0', 'pre+x']) assert.ok(eqError(bad), bad);
  assert.ok(eqError(Array(21).fill('1k:+1').join(',')), 'too many filters');
});

test('eq: formatEq reads back to the same curve', () => {
  for (const v of ['ls100:+6', 'pre-3,ls80:+10:0.6,pk200:+2:0.8', 'hp60,ls150:-4,pk2.5k:+5:1.1,hs7k:+2', 'lp12k::2']) {
    assert.deepEqual(parseEq(formatEq(parseEq(v))), parseEq(v), v);
  }
  assert.equal(formatEq(parseEq('')), 'off');
});

test('eq: the response matches the filters', () => {
  const bass = parseEq('ls100:+6');
  near(responseDb(bass, 20), 6, 0.2);
  near(responseDb(bass, 100), 3, 0.1); // a shelf is half way at its frequency
  near(responseDb(bass, 5000), 0, 0.05);
  const peak = parseEq('1k:-4:2');
  near(responseDb(peak, 1000), -4, 0.01);
  near(responseDb(peak, 100), 0, 0.1);
  near(responseDb(parseEq('pre-3'), 1000), -3, 1e-9);
  near(responseDb(parseEq('hp100'), 100), -3, 0.05);
  assert.ok(responseDb(parseEq('hp100'), 20) < -20);
  // Normalised: a0 = 1.
  assert.equal(biquad({ type: 'pk', freq: 1000, gain: 3, q: 1 }, 48000).a[0], 1);
  const g = eqGraph(bass);
  assert.ok(g.length > 5 && g.at(-1).includes('1k'));
});

test('eq: Equalizer APO / AutoEq files', () => {
  const apo = [
    '# AutoEq',
    'Preamp: -6.2 dB',
    'Filter 1: ON LSC Fc 105 Hz Gain 5.5 dB Q 0.70',
    'Filter 2: ON PK Fc 2500 Hz Gain -3.1 dB Q 1.41',
    'Filter 3: ON HSC Fc 10000 Hz Gain 2.0 dB Q 0.70',
    'Filter 4: OFF PK Fc 50 Hz Gain 1 dB Q 1',
    'Filter 5: ON HP Fc 20 Hz',
    'Filter 6: ON NO Fc 60 Hz',
  ].join('\n');
  assert.ok(looksLikeApo(apo));
  assert.ok(!looksLikeApo('set eq=bass'));
  const r = apoToEq(apo);
  assert.equal(r.value, 'pre-6.2,ls105:+5.5:0.7,pk2.5k:-3.1:1.41,hs10k:+2:0.7,hp20');
  assert.equal(r.warnings.length, 1, 'NO (notch) is skipped');
  assert.throws(() => apoToEq('hello'));
});

test('eq: :set eq checks the curve and keeps long values', () => {
  const s = new Settings(null);
  assert.equal(s.get('eq'), 'off');
  assert.equal(s.command('eq=bass').error, null);
  assert.equal(s.get('eq'), 'bass');
  assert.match(s.command('eq=zz1:+1').error, /^E474/);
  assert.equal(s.get('eq'), 'bass', 'unchanged on an error');
  const long = 'pre-6.2,ls105:+5.5:0.7,pk2.5k:-3.1:1.41,hs10k:+2:0.7,hp20';
  assert.equal(s.command([`eq=${long}`]).error, null);
  assert.equal(s.get('eq'), long);
  assert.deepEqual(s.changedArgs(), [`eq=${long}`]);
  s.command('eq&');
  assert.equal(s.get('eq'), 'off');
});
