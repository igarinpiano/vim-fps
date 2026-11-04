import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Settings, OPTIONS, SMOOTH_GROUP } from '../../web/js/settings.js';

function mem() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
}

test('number options, aliases and arithmetic', () => {
  const s = new Settings(mem());
  assert.equal(s.command('sens=120').error, null);
  assert.equal(s.get('sensitivity'), 120);
  s.command('sensitivity+=30');
  assert.equal(s.get('sensitivity'), 150);
  s.command('acc=inf');
  assert.equal(s.get('accel'), Infinity);
  assert.deepEqual(s.command('accel?').lines, ['  accel=inf']);
  assert.match(s.command('sens=abc').error, /^E521/);
  assert.match(s.command('fov=1000').error, /^E474/);
  assert.match(s.command('nope=1').error, /^E518/);
  s.command('sens&');
  assert.equal(s.get('sensitivity'), OPTIONS.sensitivity.def);
});

test('booleans: no, inv, !', () => {
  const s = new Settings(mem());
  s.command('invert');
  assert.equal(s.get('invert'), true);
  s.command('noinvert');
  assert.equal(s.get('invert'), false);
  s.command('invert!');
  assert.equal(s.get('invert'), true);
  s.command('invinvert');
  assert.equal(s.get('invert'), false);
});

test('nosmooth turns every smoothing option off and smooth back on', () => {
  const s = new Settings(mem());
  assert.ok(SMOOTH_GROUP.includes('adsanim') && SMOOTH_GROUP.includes('moveaccel'));
  s.command('nosmooth');
  for (const k of SMOOTH_GROUP) assert.equal(s.get(k), false, k);
  assert.deepEqual(s.command('smooth?').lines, ['nosmooth']);
  s.command('adsanim');
  assert.equal(s.get('smooth'), false);
  s.command('smooth');
  for (const k of SMOOTH_GROUP) assert.equal(s.get(k), true, k);
});

test('enum and persistence', () => {
  const store = mem();
  const s = new Settings(store);
  assert.match(s.command('forward=x').error, /^E474/);
  s.command('forward=j name=alice nomoveaccel accel=inf');
  const t = new Settings(store);
  assert.equal(t.get('forward'), 'j');
  assert.equal(t.get('name'), 'alice');
  assert.equal(t.get('moveaccel'), false);
  assert.equal(t.get('accel'), Infinity);
  t.command('all&');
  assert.equal(t.get('forward'), 'k');
});
