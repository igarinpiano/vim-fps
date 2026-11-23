import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEXTURE_SLOTS, slotOf, parsePack, parseSize } from '../../web/js/textures.js';
import { SCENES, keysOf } from '../../web/js/touch.js';
import { Vim } from '../../web/js/vim.js';
import { Settings } from '../../web/js/settings.js';

test('textures: a file name says where the image goes', () => {
  assert.equal(slotOf('ground.png'), 'ground');
  assert.equal(slotOf('Wall-brick_02.JPG'), 'wall');
  assert.equal(slotOf('C:\\pics\\sky_sunset.webp'), 'sky');
  assert.equal(slotOf('assets/tank.v2.png'), 'tank');
  assert.equal(slotOf('grounded.png'), null);
  assert.equal(slotOf('ground.txt'), null);
  assert.equal(slotOf('photo.png'), null);
  for (const slot of Object.keys(TEXTURE_SLOTS)) assert.equal(slotOf(`${slot}.png`), slot);
});

test('textures: pack.json keeps known slots and plain file names only', () => {
  const pack = parsePack({
    ground: 'grass.png',
    wall: { file: 'brick.jpg', size: 3 },
    roof: { file: 'r.png', size: -1 },
    rock: '../secret.png',
    crate: 'http://example.com/x.png',
    nothing: 'x.png',
    sky: 42,
  });
  assert.deepEqual(pack, [
    { slot: 'ground', file: 'grass.png', size: null },
    { slot: 'wall', file: 'brick.jpg', size: 3 },
    { slot: 'roof', file: 'r.png', size: null },
  ]);
  assert.deepEqual(parsePack(null), []);
  assert.deepEqual(parsePack({}), []);
});

test('textures: tile size', () => {
  assert.equal(parseSize('12'), 12);
  assert.equal(parseSize('0.5'), 0.5);
  assert.equal(parseSize('0'), null);
  assert.equal(parseSize('9999'), null);
  assert.equal(parseSize('abc'), null);
});

// What each mode does with a key: every key a scene shows must do something
// in the mode(s) it is shown for.
const SCENE_MODES = {
  combat: ['normal', 'view'],
  boarding: ['normal', 'view'],
  tank: ['normal', 'view'],
  wait: ['normal'],
  // j / k scroll the table (main.js takes them first); in the modes they
  // are the moving keys.
  results: ['normal', 'spectate'],
  menu: ['menu'],
  msg: ['msg'],
  form: ['form'],
  inventory: ['inventory'],
  map: ['map'],
  typing: [],
  watch: ['spectate'],
  fly: ['spectate'],
};

test('touch: every scene is a grid of known keys', () => {
  assert.deepEqual(Object.keys(SCENES).sort(), Object.keys(SCENE_MODES).sort());
  for (const [name, scene] of Object.entries(SCENES)) {
    const keys = [...scene.left, ...scene.right].flat().filter(Boolean);
    assert.ok(keys.length > 0, name);
    assert.equal(new Set(keys).size, keys.length, `${name}: a key twice`);
    for (const h of Object.keys(scene.hint || {})) assert.ok(keys.includes(h), `${name}: hint for a key that is not there: ${h}`);
    for (const key of keys) {
      for (const k of keysOf(key)) assert.ok(k.key.length === 1 || ['Escape', 'Enter', 'Shift'].includes(k.key), `${name}: ${key}`);
    }
  }
});

test('touch: the keys of a scene act in (one of) its modes', () => {
  const acts = (mode, key) => {
    const calls = [];
    const act = new Proxy({}, { get: (_, fn) => (...a) => calls.push([fn, ...a]) });
    const vim = new Vim(new Settings(null), act, () => 0);
    vim.mode = mode;
    for (const k of keysOf(key)) {
      vim.key({ type: 'down', key: k.key, code: `Touch-${k.key}`, shift: k.key !== k.key.toLowerCase(), ctrl: !!k.ctrl, repeat: false });
    }
    return calls.some((c) => c[0] !== 'showcmd') || vim.mode !== mode || vim.count + vim.pending !== '';
  };
  for (const [name, modes] of Object.entries(SCENE_MODES)) {
    const scene = SCENES[name];
    const keys = [...scene.left, ...scene.right].flat().filter(Boolean);
    for (const key of keys) {
      // Shift is a toggle; ⏎ on the fighting pad is kept as it always was.
      if (!modes.length || key === 'Shift' || (key === 'Enter' && modes.includes('normal'))) continue;
      assert.ok(
        modes.some((mode) => acts(mode, key)),
        `${name}: ${key} does nothing`,
      );
    }
  }
});

test('touch: the fighting pad is the one it always was', () => {
  assert.deepEqual(SCENES.combat.left, [
    [null, 'k', null],
    ['h', 'j', 'l'],
  ]);
  assert.deepEqual(SCENES.combat.right, [
    ['Escape', 'v', 'f'],
    ['dd', 'r', 'y'],
    [',', '.', '~'],
    ['s', 'm', '*'],
    ['Shift', 'i', ':'],
    ['Enter', 'gt', '1'],
  ]);
});
