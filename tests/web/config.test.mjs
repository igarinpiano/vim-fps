import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { tokenize, escapeWord, parseRc, applyRc, buildRc, customCommand, isRcName, CUSTOM_DEFAULTS } from '../../web/js/rc.js';
import { Profile, PROFILE_KEY } from '../../web/js/profile.js';
import { Settings } from '../../web/js/settings.js';
import { parseSkin, safeSkinPath, safeCssValue, skinName, inferSkin, readBundle, skinLayer, readZip, writeZip, crc32 } from '../../web/js/skin.js';

function mem(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
}

test('rc: words, escapes and comments', () => {
  assert.deepEqual(tokenize('set adssens=30  forward=j'), ['set', 'adssens=30', 'forward=j']);
  assert.deepEqual(tokenize('set name=a\\ b "a comment'), ['set', 'name=a b']);
  assert.deepEqual(tokenize('" only a comment'), []);
  assert.deepEqual(tokenize('host password=x"y'), ['host', 'password=x"y']);
  assert.deepEqual(tokenize('host password=\\"q'), ['host', 'password="q']);
  for (const w of ['a b', 'back\\slash', '"quoted', 'tab\there', '合言葉 です']) assert.deepEqual(tokenize(`set ${escapeWord(w)}`), ['set', w]);
});

test('rc: lines, line numbers, leading colons, unknown commands', () => {
  const cmds = parseRc('\uFEFF" header\n\n:set sens=8\r\n  skin  my-skin\ncustom bots=3\nhost bots=5 tunnel\nfoo bar\n');
  assert.deepEqual(
    cmds.map((c) => [c.line, c.cmd, c.args]),
    [
      [3, 'set', ['sens=8']],
      [4, 'skin', ['my-skin']],
      [5, 'custom', ['bots=3']],
      [6, 'host', ['bots=5', 'tunnel']],
      [7, 'foo', ['bar']],
    ],
  );
  const seen = [];
  const errors = applyRc(cmds, {
    set: (a) => (seen.push(['set', a]), null),
    skin: (a) => (seen.push(['skin', a]), null),
    custom: () => 'E474: nope',
    host: (raw) => (seen.push(['host', raw]), null),
  });
  assert.deepEqual(errors, ['5: E474: nope', '7: E492: Not an editor command: foo bar']);
  assert.deepEqual(seen, [
    ['set', ['sens=8']],
    ['skin', ['my-skin']],
    ['host', 'host bots=5 tunnel'],
  ]);
});

test('rc: file names taken as a .vimfpsrc', () => {
  for (const n of ['.vimfpsrc', '_vimfpsrc', 'vimfpsrc', 'VIMFPSRC.txt', 'dir/.vimfpsrc', 'my.vim']) assert.ok(isRcName(n), n);
  for (const n of ['skin.json', 'vimfpsrc.zip', 'ground.png', 'xvimfpsrc']) assert.ok(!isRcName(n), n);
});

test('rc: custom match values are checked; nothing changes on an error', () => {
  const c = { ...CUSTOM_DEFAULTS };
  assert.equal(customCommand(['bots=8', 'rule=last', 'time=7'], c), null);
  assert.equal(c.bots, 8);
  assert.equal(c.rule, 'last');
  assert.equal(c.time, 7);
  // Up to a hundred bots in the browser (a host takes more).
  assert.equal(customCommand(['bots=100'], c), null);
  assert.equal(c.bots, 100);
  assert.match(customCommand(['bots=101'], c), /^E474/);
  assert.match(customCommand(['skill=4', 'ring=maybe'], c), /^E474/);
  assert.equal(c.skill, 3, 'not half-applied');
  assert.match(customCommand(['colour=red'], c), /^E518/);
  assert.match(customCommand(['seed=1.5'], c), /^E474/);
});

test('rc: :mkvimrc output reads back into the same state', () => {
  const a = new Settings(null);
  a.command('adssens=30 nocompass accel=inf forward=j');
  a.command(['name=a b']);
  a.command('eq=bass,pk3k:+3:1.4,pre-2');
  const custom = { ...CUSTOM_DEFAULTS, bots: 9, rule: 'last' };
  const text = buildRc({ set: a.changedArgs(), skin: 'my skin', custom, host: ['host bots=5 tunnel'] });
  assert.match(text, /^set all&$/m);
  assert.match(text, /^host bots=5 tunnel$/m);

  const b = new Settings(null);
  b.command('sens=99'); // reset by `set all&`
  const c2 = { ...CUSTOM_DEFAULTS };
  let skin = null;
  const host = [];
  const errors = applyRc(parseRc(text), {
    set: (args) => b.command(args).error,
    skin: (args) => ((skin = args[0]), null),
    custom: (args) => customCommand(args, c2),
    host: (raw) => (host.push(raw), null),
  });
  assert.deepEqual(errors, []);
  for (const k of ['adssens', 'compass', 'accel', 'forward', 'name', 'sensitivity', 'eq']) assert.equal(b.get(k), a.get(k), k);
  assert.equal(b.get('name'), 'a b');
  assert.equal(skin, 'my skin');
  assert.deepEqual(c2, custom);
  assert.deepEqual(host, ['host bots=5 tunnel']);
  // No skin: `skin off`.
  assert.match(buildRc({ set: [], skin: null, custom: {}, host: [] }), /^skin off$/m);
});

test('profile: one key; the two old keys move in', () => {
  const store = mem({ 'vimfps.settings.v1': JSON.stringify({ sensitivity: 20 }), 'vimfps.custom.v1': JSON.stringify({ bots: 7 }) });
  const p = new Profile(store);
  assert.deepEqual(p.get('set'), { sensitivity: 20 });
  assert.deepEqual(p.get('custom'), { bots: 7 });
  assert.ok(store.m.has(PROFILE_KEY));
  assert.ok(!store.m.has('vimfps.settings.v1') && !store.m.has('vimfps.custom.v1'));
  const s = new Settings(p.section('set'));
  assert.equal(s.get('sensitivity'), 20);
  s.command('adssens=40');
  const again = new Profile(store);
  assert.equal(new Settings(again.section('set')).get('adssens'), 40);
  assert.deepEqual(again.get('custom'), { bots: 7 });
  again.put('skin', 'x');
  assert.equal(new Profile(store).get('skin'), 'x');
  again.put('skin', null);
  assert.equal(new Profile(store).get('skin'), undefined);
  // No storage at all.
  const none = new Profile(null);
  none.put('skin', 'y');
  assert.equal(none.get('skin'), 'y');
});

test('skin: skin.json is checked item by item', () => {
  const m = parseSkin({
    name: ' My Skin ',
    textures: { ground: 'textures/grass.png', wall: { file: 'brick.jpg', size: 3 }, roof: '../x.png', nope: 'a.png', rock: { file: 'r.png', size: 9999 } },
    sounds: { startup: 'sounds/boot.wav', error2: 'http://x/y.wav', bang: 'b.wav' },
    ui: { window: '#123456', crosshair: 'rgb(0, 255, 0)', bg: 'url(http://x/y.png)', text: 'red; }', nope: '#fff', font: '"Comic Sans MS", sans-serif' },
  });
  assert.equal(m.name, 'My-Skin');
  assert.deepEqual(m.textures, { ground: { file: 'textures/grass.png', size: null }, wall: { file: 'brick.jpg', size: 3 }, rock: { file: 'r.png', size: null } });
  assert.deepEqual(m.sounds, { startup: 'sounds/boot.wav' });
  assert.deepEqual(m.ui, { window: '#123456', crosshair: 'rgb(0, 255, 0)', font: '"Comic Sans MS", sans-serif' });
  assert.equal(m.warnings.length, 7);
  assert.equal(parseSkin(null, 'fb').name, 'fb');
  assert.equal(skinName('off'), 'my-skin');
});

test('skin: paths and CSS values', () => {
  for (const p of ['a.png', 'textures/a-b_c.jpg', 'x/y/z.wav']) assert.ok(safeSkinPath(p), p);
  for (const p of ['', '../a.png', 'a/../b', '.hidden', 'a/.b', '/abs.png', 'a b.png', 'http://x/y.png', 'a\\b.png', 'C:/x.png', 'a//b']) assert.ok(!safeSkinPath(p), p);
  assert.equal(safeCssValue(' #fff '), '#fff');
  assert.equal(safeCssValue('linear-gradient(red, blue)'), 'linear-gradient(red, blue)');
  for (const v of ['url(x)', 'URL (x)', 'a;b', '}', '<x>', '@import "x"', 'a\\62', 42, '']) assert.equal(safeCssValue(v), null, String(v));
});

test('skin: a folder without skin.json is read from file names', () => {
  const m = inferSkin(['ground.png', 'pics/wall-brick.jpg', 'sounds/startup.wav', 'error2.ogg', 'readme.txt', 'ground-2.png'], 'folder');
  assert.deepEqual(m, { name: 'folder', textures: { ground: 'ground.png', wall: 'pics/wall-brick.jpg' }, sounds: { startup: 'sounds/startup.wav', error2: 'error2.ogg' } });
  assert.equal(inferSkin(['a.txt'], 'x'), null);
});

const blob = (s, type = '') => new Blob([s], { type });

test('skin: a bundle (zip / folder) gives the skin and the .vimfpsrc', async () => {
  const files = new Map([
    ['top/.vimfpsrc', blob('set sens=8\n')],
    ['top/skin/skin.json', blob(JSON.stringify({ name: 'neon', textures: { ground: 'g.png', sky: 'missing.jpg' }, sounds: { error: 'e.wav' }, ui: { window: '#000' } }))],
    ['top/skin/g.png', blob('PNG')],
    ['top/skin/e.wav', blob('WAV')],
    ['top/skin/unused.png', blob('x')],
    ['__MACOSX/top/._g.png', blob('junk')],
  ]);
  const b = await readBundle(files, 'fallback');
  assert.equal(b.rc, 'set sens=8\n');
  assert.equal(b.skin.name, 'neon');
  assert.deepEqual(Object.keys(b.skin.files).sort(), ['e.wav', 'g.png']);
  assert.deepEqual(b.skin.manifest, { name: 'neon', textures: { ground: 'g.png' }, sounds: { error: 'e.wav' }, ui: { window: '#000' } });
  assert.deepEqual(b.skin.warnings, ['missing.jpg: ファイルがありません']);
  // Its layer resolves paths to the stored blobs.
  const layer = skinLayer(b.skin.manifest, (p) => b.skin.files[p] || null);
  assert.equal(layer.textures.ground.src, b.skin.files['g.png']);
  assert.equal(layer.sounds.error, b.skin.files['e.wav']);
  // Broken skin.json: an error, not a silent skip.
  await assert.rejects(readBundle(new Map([['skin.json', blob('{nope')]]), 'x'), /JSON/);
  // Nothing in it.
  assert.deepEqual(await readBundle(new Map([['a.txt', blob('x')]]), 'x'), { skin: null, rc: null });
});

test('zip: what writeZip writes, readZip reads (and deflated entries)', async () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const png = new Uint8Array([137, 80, 78, 71, 0, 1, 2, 255]);
  const z = writeZip([
    { path: '.vimfpsrc', data: 'set sens=8\n' },
    { path: 'skin/skin.json', data: '{"name":"a"}' },
    { path: 'skin/textures/ground.png', data: png },
  ]);
  const files = await readZip(await z.arrayBuffer());
  assert.deepEqual([...files.keys()], ['.vimfpsrc', 'skin/skin.json', 'skin/textures/ground.png']);
  assert.equal(await files.get('.vimfpsrc').text(), 'set sens=8\n');
  assert.deepEqual(new Uint8Array(await files.get('skin/textures/ground.png').arrayBuffer()), png);
  assert.equal(files.get('skin/textures/ground.png').type, 'image/png');

  // A deflated entry, as most zip tools write: patch one by hand.
  const text = 'hello hello hello hello';
  const raw = new TextEncoder().encode(text);
  const comp = deflateRawSync(raw);
  const name = new TextEncoder().encode('a.txt');
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(8, 8);
  lh.writeUInt32LE(crc32(raw), 14);
  lh.writeUInt32LE(comp.length, 18);
  lh.writeUInt32LE(raw.length, 22);
  lh.writeUInt16LE(name.length, 26);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(8, 10);
  ch.writeUInt32LE(crc32(raw), 16);
  ch.writeUInt32LE(comp.length, 20);
  ch.writeUInt32LE(raw.length, 24);
  ch.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + name.length, 12);
  end.writeUInt32LE(30 + name.length + comp.length, 16);
  const zip = Buffer.concat([lh, name, comp, ch, name, end]);
  const got = await readZip(zip);
  assert.equal(await got.get('a.txt').text(), text);
  await assert.rejects(readZip(new TextEncoder().encode('not a zip at all, sorry')), /zip/);
});
