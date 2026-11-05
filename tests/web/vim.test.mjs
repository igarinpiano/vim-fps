import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vim, Aim } from '../../web/js/vim.js';
import { Settings } from '../../web/js/settings.js';

function setup(opts = '') {
  const s = new Settings(null);
  if (opts) s.command(opts);
  const log = [];
  const rec = (name) => (...a) => log.push([name, ...a]);
  const act = new Proxy({}, { get: (_, name) => rec(name) });
  let t = 0;
  const vim = new Vim(s, act, () => t);
  vim.mode = 'normal';
  const down = (key, extra = {}) => vim.key({ type: 'down', key, code: 'Key' + key.toUpperCase(), ...extra });
  const up = (key) => vim.key({ type: 'up', key, code: 'Key' + key.toUpperCase() });
  return { vim, log, down, up, s, tick: (ms) => (t += ms) };
}

const only = (log, name) => log.filter((l) => l[0] === name);

test('hjkl walk while held; forward key is configurable', () => {
  const { log, down, up } = setup();
  down('k');
  up('k');
  down('j');
  assert.deepEqual(only(log, 'move'), [['move', 'fwd', true], ['move', 'fwd', false], ['move', 'back', true]]);
  const b = setup('forward=j');
  b.down('j');
  assert.deepEqual(only(b.log, 'move'), [['move', 'fwd', true]]);
});

test('count walks n metres; Shift-key release still stops walking', () => {
  const { log, down, vim } = setup();
  down('5');
  down('k');
  assert.deepEqual(only(log, 'moveTimed'), [['moveTimed', 'fwd', 5]]);
  vim.key({ type: 'down', key: 'K', code: 'KeyK', shift: true });
  vim.key({ type: 'up', key: 'k', code: 'KeyK' });
  assert.deepEqual(only(log, 'move').at(-1), ['move', 'fwd', false]);
});

test('dd, {count}dd, gt, {n}, . ~ *', () => {
  const { log, down } = setup('turnangle=30');
  down('d');
  down('d');
  down('5');
  down('d');
  down('d');
  down('9');
  down('d');
  down('d');
  assert.deepEqual(only(log, 'throw'), [['throw', 3], ['throw', 5], ['throw', 5]]);
  down('g');
  down('t');
  assert.equal(only(log, 'swapGun').length, 1);
  down('2');
  down(',');
  down('.');
  down('~');
  down('*');
  assert.deepEqual(only(log, 'turn'), [['turn', 60], ['turn', -30], ['turn', 180]]);
  assert.equal(only(log, 'spot').length, 1);
});

test('keys without a mapping do nothing (no chat)', () => {
  const { log, down, vim } = setup();
  for (const k of ['a', 'A', 'b', 'q', 'z', 'x', 'Tab', ' ', 'Enter', 'o', 'p', 'u']) down(k);
  assert.equal(only(log, 'insert').length, 0);
  assert.equal(vim.mode, 'normal');
  down('i');
  assert.equal(only(log, 'insert').length, 1);
});

test('pending keys time out', () => {
  const { log, down, tick } = setup('timeoutlen=500');
  down('d');
  tick(800);
  down('d');
  assert.equal(only(log, 'throw').length, 0);
});

test('VIEW: look instead of walk, dd still throws, Esc returns', () => {
  const { log, down, vim } = setup();
  down('v');
  assert.equal(vim.mode, 'view');
  down('k');
  down('3');
  down('h');
  down('d');
  down('d');
  down('v');
  assert.deepEqual(only(log, 'look')[0], ['look', 'up', true, false]);
  assert.deepEqual(only(log, 'lookStep'), [['lookStep', 'left', 3, false]]);
  assert.equal(only(log, 'move').length, 0);
  assert.equal(only(log, 'throw').length, 1);
  assert.equal(only(log, 'zoom').length, 1);
  down('Escape');
  assert.equal(vim.mode, 'normal');
  // Leaving VIEW releases the held look key.
  assert.deepEqual(only(log, 'look').at(-1), ['look', 'up', false]);
});

test('invert flips vertical look', () => {
  const { log, down } = setup('invert');
  down('v');
  down('k');
  assert.deepEqual(only(log, 'look')[0], ['look', 'down', true, false]);
});

test('inventory: j/k, gg, G, close; Ctrl-[ is Esc', () => {
  const { log, down, vim } = setup();
  down('s');
  assert.equal(vim.mode, 'inventory');
  down('j');
  down('2');
  down('k');
  down('g');
  down('g');
  down('G');
  assert.deepEqual(only(log, 'invSelect'), [
    ['invSelect', 1, false],
    ['invSelect', -2, false],
    ['invSelect', 0, true],
    ['invSelect', -1, true],
  ]);
  vim.key({ type: 'down', key: '[', code: 'BracketLeft', ctrl: true });
  assert.equal(vim.mode, 'normal');
});

test('aim: a tap steps, holding accelerates up to maxspeed, accel=inf is instant', () => {
  const s = new Settings(null);
  s.command('step=2 aimdelay=100 accelafter=0 sens=100 accel=1000 maxspeed=300');
  const aim = new Aim(s);
  assert.deepEqual(aim.press('left', false), { yaw: 2, pitch: 0 });
  assert.equal(aim.update(0.05).yaw, 0);
  const a = aim.update(0.1).yaw; // 0.05 s past the delay
  assert.ok(a > 0 && a < 300 * 0.05);
  let last = 0;
  for (let i = 0; i < 100; i++) last = aim.update(0.01).yaw;
  assert.ok(Math.abs(last - 3) < 1e-6, `capped at maxspeed: ${last}`);
  s.command('accel=inf');
  const b = new Aim(s);
  b.press('up', false);
  const d = b.update(0.2).pitch;
  assert.ok(Math.abs(d - 30) < 1e-6, `instant max speed: ${d}`);
});

test('aim: long press stays slow (fine) before accelafter', () => {
  const s = new Settings(null);
  s.command('step=0.2 aimdelay=100 accelafter=400 sens=10 accel=200 maxspeed=200');
  const aim = new Aim(s);
  aim.press('right', false);
  let total = 0;
  for (let i = 0; i < 50; i++) total += aim.update(0.01).yaw; // 0.5 s held
  // 0.4 s of turning at 10 deg/s, no acceleration yet.
  assert.ok(Math.abs(total + 4) < 0.01, `turned ${total}`);
  for (let i = 0; i < 100; i++) total += aim.update(0.01).yaw;
  assert.ok(total < -10, 'speeds up later');
});

test('message window: j/k, counts, Ctrl-d/u/f/b, gg/G, h/l, close', () => {
  const { log, down, vim } = setup();
  vim.mode = 'msg';
  down('j');
  down('3');
  down('k');
  vim.key({ type: 'down', key: 'd', code: 'KeyD', ctrl: true });
  vim.key({ type: 'down', key: 'u', code: 'KeyU', ctrl: true });
  vim.key({ type: 'down', key: 'f', code: 'KeyF', ctrl: true });
  vim.key({ type: 'down', key: 'b', code: 'KeyB', ctrl: true });
  down('g');
  down('g');
  down('G');
  down('l');
  down('h');
  assert.deepEqual(only(log, 'msgScroll'), [
    ['msgScroll', 'line', 1],
    ['msgScroll', 'line', -3],
    ['msgScroll', 'half', 1],
    ['msgScroll', 'half', -1],
    ['msgScroll', 'page', 1],
    ['msgScroll', 'page', -1],
    ['msgScroll', 'top', 1],
    ['msgScroll', 'bottom', 1],
    ['msgScroll', 'side', 1],
    ['msgScroll', 'side', -1],
  ]);
  assert.equal(only(log, 'closeMsg').length, 0);
  down('q');
  assert.equal(only(log, 'closeMsg').length, 1);
});

test('spectate: n/N follow, o free camera, hjkl/K/J move, map returns to spectate', () => {
  const { log, down, up, vim } = setup();
  vim.mode = 'spectate';
  down('n');
  down('3');
  down('N');
  down('o');
  down('k');
  up('k');
  vim.key({ type: 'down', key: 'K', code: 'KeyK', shift: true });
  down('f');
  down('d');
  down('d');
  assert.deepEqual(only(log, 'follow'), [['follow', 1], ['follow', -3]]);
  assert.equal(only(log, 'freecam').length, 1);
  assert.deepEqual(only(log, 'move').slice(0, 3), [['move', 'fwd', true], ['move', 'fwd', false], ['move', 'up', true]]);
  assert.equal(only(log, 'fire').length + only(log, 'throw').length, 0, 'no shooting while watching');
  down('m');
  assert.equal(vim.mode, 'map');
  down('Escape');
  assert.equal(vim.mode, 'spectate');
});

test('custom match form: j/k rows, h/l and H/L values, Enter, Esc', () => {
  const { log, down, vim } = setup();
  vim.mode = 'form';
  down('j');
  down('2');
  down('k');
  down('l');
  down('h');
  vim.key({ type: 'down', key: 'L', code: 'KeyL', shift: true });
  down('3');
  down('l');
  down('Enter');
  down('Escape');
  assert.deepEqual(only(log, 'formMove'), [['formMove', 1], ['formMove', -2]]);
  assert.deepEqual(only(log, 'formChange'), [['formChange', 1], ['formChange', -1], ['formChange', 5], ['formChange', 3]]);
  assert.equal(only(log, 'formSubmit').length, 1);
  assert.equal(only(log, 'formCancel').length, 1);
});

test('spectate: O switches to the sky view', () => {
  const { log, vim } = setup();
  vim.mode = 'spectate';
  vim.key({ type: 'down', key: 'O', code: 'KeyO', shift: true });
  assert.equal(only(log, 'skycam').length, 1);
});
