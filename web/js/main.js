// vim-fps browser client: title menu, connection, input, prediction, HUD.

import { Settings, OPTIONS, SMOOTH_GROUP } from './settings.js';
import { Vim, Aim, MODES } from './vim.js';
import { WsConnection, LocalConnection, parseServerUrl, PROTOCOL } from './net.js';
import { World, wantVelocity, eyeHeight, GUNS, ACCEL, RUN_SPEED, SNEAK_SPEED, wrapAngle, bearing } from './world.js';
import { TouchPad } from './touch.js';
import { Sound } from './audio.js';
import { VERSION } from './version.js';

const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;

const storage = (() => {
  try {
    const s = window.localStorage;
    s.getItem('x');
    return s;
  } catch {
    return null;
  }
})();
const settings = new Settings(storage);
const sound = new Sound(settings);
const aim = new Aim(settings);
let renderer = null;
let serverInfo = null;

// ---------------------------------------------------------------- state

const game = {
  conn: null,
  practice: false,
  myId: null,
  map: null,
  world: null,
  roster: new Map(),
  snaps: [],
  grenades: [],
  me: null,
  left: 0,
  intermission: null,
  pos: { x: 0, y: 0, z: 0 },
  vel: { x: 0, z: 0 },
  yaw: 0,
  pitch: 0,
  alive: false,
  held: { fwd: false, back: false, left: false, right: false },
  timed: null,
  shiftDown: false,
  sneak: false,
  fire: false,
  ads: false,
  zoom: 0,
  fov: 80,
  adsK: 0,
  turnLeft: 0,
  lastSend: 0,
  lastInput: '',
  pings: new Map(),
  pingSeq: 0,
  ping: null,
  steps: new Map(),
  specs: null,
  // Recent gunfire of others: {x, z, t, id}; spotted (*): id -> until.
  shots: [],
  spotted: new Map(),
  seen: new Map(),
  myStep: 0,
  bob: 0,
  kick: 0,
  leaving: false,
  // Watching (spectator, or out of a no-respawn round): whom we follow
  // (player id), or a free camera {x, y, z, yaw, pitch}.
  watching: false,
  follow: null,
  free: null,
  bsodPending: false,
  range: false,
  respawnMode: true,
};

function resetGame() {
  Object.assign(game, {
    conn: null,
    practice: false,
    myId: null,
    map: null,
    world: null,
    snaps: [],
    grenades: [],
    me: null,
    alive: false,
    timed: null,
    fire: false,
    ads: false,
    zoom: 0,
    turnLeft: 0,
    intermission: null,
    lastInput: '',
    watching: false,
    follow: null,
    free: null,
    bsodPending: false,
    range: false,
    respawnMode: true,
  });
  game.roster = new Map();
  game.steps = new Map();
  game.held = { fwd: false, back: false, left: false, right: false, up: false, down: false };
}

// ---------------------------------------------------------------- helpers

const textCache = new WeakMap();
function setText(el, text) {
  if (textCache.get(el) !== text) {
    textCache.set(el, text);
    el.textContent = text;
  }
}

function show(id, on = true) {
  $(id).classList.toggle('hidden', !on);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function balloon(head, body = '', cls = '') {
  const b = document.createElement('div');
  b.className = `balloon ${cls}`;
  b.innerHTML = `<div class="h">${esc(head)}</div>${body ? `<div>${esc(body)}</div>` : ''}`;
  const box = $('balloons');
  box.appendChild(b);
  while (box.children.length > 5) box.firstChild.remove();
  const life = cls === 'err' ? 6000 : 3500;
  setTimeout(() => {
    if (settings.get('uianim')) {
      b.classList.add('out');
      setTimeout(() => b.remove(), 400);
    } else b.remove();
  }, life);
}

function chatLine(html, cls = '') {
  const log = $('chatlog');
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.innerHTML = html;
  log.appendChild(d);
  while (log.children.length > 8) log.firstChild.remove();
  setTimeout(() => d.classList.add('old'), 12000);
}

function nameOf(id) {
  const r = game.roster.get(id);
  return r ? r.name : `#${id}`;
}

function gunName(g) {
  return (GUNS[g] || { name: g || '—' }).name;
}

function fmtTime(s) {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- windows

function showMsg(title, lines, isError = false) {
  $('msg-title').textContent = title;
  const body = $('msg-body');
  body.innerHTML = '';
  for (const l of lines) {
    const div = document.createElement('div');
    if (isError) div.className = 'err';
    div.textContent = l;
    body.appendChild(div);
  }
  show('msgwin');
  body.scrollTop = 0;
  body.scrollLeft = 0;
  msgReturn = vim.mode === 'command' ? cmdReturn : vim.mode;
  if (msgReturn === 'msg') msgReturn = game.map ? 'normal' : 'menu';
  // The title window would cover it.
  show('title', false);
  vim.setMode('msg');
}
let msgReturn = 'menu';

function closeMsg() {
  show('msgwin', false);
  const back = msgReturn || (game.map ? 'normal' : 'menu');
  if (back === 'menu') show('title');
  vim.setMode(back);
}

const HELP = [
  'vim-fps — マウス禁止。モードごとにキーの意味が変わります (同時には使えません)',
  '割り当てのないキーは何もしません。',
  '',
  'NORMAL (移動)                         VIEW (v: 構えて視点移動。歩けない)',
  '  h j k l   左 前 後 右 (前は :set forward)   h j k l   視点 (カーソルと同じ向き)',
  '  Shift     押している間スニーク          H J K L   速く回す (:set fastlook)',
  '  {n}k      n メートル歩く               {n}l      n 目盛り回す (:set step)',
  '  , .       左 / 右に 45° 旋回 ({n}, 可)   短押し    1 目盛り (0.2°)',
  '  ~         180° 振り返る                 長押し    ゆっくり→加速 (:set accelafter)',
  '  f         撃つ / 選んだアイテムを使う     v         スコープ切り替え',
  '  {n}dd     グレネード (n=1〜5 で強さ)      f / {n}dd / r / *',
  '  r         リロード                       Esc       NORMAL へ',
  '  y         足元の銃を拾う (最大 2 丁)',
  '  gt        銃を持ち替え                  INVENTORY (s)',
  '  *         照準の近くの敵をマーク (6 秒)     j / k     選ぶ (gg 先頭, G 末尾, 数字)',
  '  s         インベントリ                     Enter/Esc 閉じる → f で使う',
  '  m         マップ',
  '  i         チャット (全員に届きます)',
  '  :         コマンド                      Esc の代わりに Ctrl-[ も使えます',
  '',
  '索敵: 画面上のコンパスに、銃声 (赤 ●)・近くの足音 (橙 ●)・マークした敵 (黄 ▼) の方向が出ます。',
  '      見えている敵の頭上には ▼ が付きます。スニーク中の足音はコンパスに出ません。',
  '',
  'コマンド',
  '  :spec                武器・移動などの数値 (弾速・ダメージ・連射速度…)',
  '  :set                 変更した設定     :set all       すべての設定',
  '  :set sens=8          長押しの初速      :set accel=inf 加速の後は即最高速',
  '  :set step=0.1        1 目盛りの角度    :set accelafter=800 ゆっくりの時間を長く',
  '  :set zoomsens=0.5    構え・スコープ中をさらに細かく (ズーム率に比例した上に掛かる)',
  '  :set nosmooth        アニメーション・補間・加速をすべてオフ (瞬時に切り替わる)',
  '  :set noadsanim       ADS だけ瞬時     :set nomoveaccel 移動の加速度を無限大に',
  '  :set forward=j       j を前進に       :set invert    視点の上下反転',
  '  :set touch=on        タッチパッド     :set nocompass  コンパスを消す',
  '  :set name=名前       名前             :set {opt}&     初期値に戻す',
  '  :ls                  スコア           :bots 5        bot の数 (練習のみ)',
  '  :connect URL         サーバーに接続    :practice      練習',
  '  :fs                  フルスクリーン   :q             タイトルへ',
  '  :watch               観戦に回る       :play          観戦から試合へ',
  '  :follow 名前         その人を観戦     :range         射撃訓練場',
  '',
  'SPECTATE (観戦中)      n / N  次 / 前の選手    o  自由視点 (k/j 前後, h/l 旋回, K/J 上下, Shift で速く)',
  '  復活なしの試合で倒されると、倒した相手の視点で観戦します (:set nokillcam で自由視点)',
  '',
  '設定の一覧と説明は :options',
];

/// :spec — every number of the rules, from the server (or the practice wasm).
function specLines(sp) {
  const L = [];
  const f = (v, d = 1) => (Number.isInteger(v) ? String(v) : v.toFixed(d));
  if (sp.gravity && sp.guns.every((g) => g.muzzle_velocity)) {
    L.push(`弾: 実際に飛ぶ弾 (初速で撃ち出され、重力 ${sp.gravity} m/s² で落ちる。空気抵抗なし)`);
    L.push('    遠くの相手には「届くまでの時間ぶん先」と「落ちるぶん上」を狙います (SR のスコープの目盛り 1〜4 = 100〜400 m)');
    L.push('');
    L.push('到達時間 / 落下   100 m          200 m          300 m          400 m');
    for (const g of sp.guns) {
      const cells = [100, 200, 300, 400].map((d) => {
        if (d > g.range) return '(射程外)'.padEnd(14);
        const t = d / g.muzzle_velocity;
        return `${t.toFixed(2)}s ${Math.round(0.5 * sp.gravity * t * t * 100)}cm`.padEnd(14);
      });
      L.push(`${`${g.name} ${g.muzzle_velocity}m/s`.padEnd(17)}${cells.join(' ')}`);
    }
  } else {
    L.push('弾: ヒットスキャン (このサーバーは旧版: 撃った瞬間に着弾)');
  }
  L.push('');
  L.push(`HP ${sp.hp}   頭の当たり判定 半径 ${sp.head_radius} m   サーバー ${sp.tick_rate} Hz / 送信 ${sp.snap_rate} Hz`);
  L.push('');
  L.push('武器   ダメージ(胴/頭)  連射    装弾/予備  リロード  拡散 腰/構え/スコープ  減衰 (距離→倍率)     射程');
  for (const g of sp.guns) {
    const dmg = `${f(g.damage)}${g.pellets > 1 ? `×${g.pellets}` : ''}/${f(g.damage * g.head_mult)}${g.pellets > 1 ? `×${g.pellets}` : ''}`;
    const rof = `${g.rpm}rpm${g.auto ? ' 連' : ' 単'}`;
    const spread = `${f(g.spread_hip)}°/${f(g.spread_ads)}°/${f(g.spread_scope)}°`;
    const fall = g.min_factor >= 1 ? 'なし' : `${g.falloff_start}m→${g.falloff_end}m ×${g.min_factor}`;
    L.push(`${g.name.padEnd(5)}  ${dmg.padEnd(15)}  ${rof.padEnd(9)} ${`${g.mag}/${g.reserve_max}`.padEnd(9)}  ${`${g.reload}s`.padEnd(7)}  ${spread.padEnd(19)}  ${fall.padEnd(20)}  ${g.range}m`);
  }
  L.push('  (頭 = 胴 × 倍率。腰撃ちで歩いていると拡散 ×1.3。SG は 1 発で 9 粒。減衰は弾が飛んだ距離で決まる)');
  L.push('  (SR は構えると低倍率スコープ、v でさらに高倍率)');
  L.push('');
  L.push(`移動: 走り ${sp.run_speed} m/s · スニーク ${sp.sneak_speed} m/s · 加速度 ${sp.accel} m/s² (:set nomoveaccel で無限大) · 構え中は歩けない`);
  L.push(`回復キット: +${sp.medkit_heal} HP、${sp.medkit_time} 秒 (最大 ${sp.max_medkits} 個)`);
  L.push(`グレネード: 信管 ${sp.grenade_fuse} 秒、半径 ${sp.grenade_radius} m、最大 ${sp.grenade_damage} ダメージ (距離で減少・壁で遮断、最大 ${sp.max_grenades} 個)`);
  L.push(`  {n}dd の初速: ${sp.throw_speeds.map((v, i) => `${i + 1}dd=${v}m/s`).join(' ')}`);
  L.push(`復活: ${sp.respawn} 秒後 · 復活直後 ${sp.protect} 秒は無敵 (撃つと解除)`);
  return L;
}

async function showSpec() {
  let sp = game.specs;
  if (!sp) {
    try {
      sp = await LocalConnection.specs();
    } catch (e) {
      showMsg('エラー', [String(e.message || e)], true);
      return;
    }
  }
  showMsg(':spec — 仕様', specLines(sp));
}

function optionsHelp() {
  const lines = [];
  for (const [k, o] of Object.entries(OPTIONS)) {
    const v = settings.get(k);
    const cur = o.type === 'bool' ? (v ? k : `no${k}`) : `${k}=${v === Infinity ? 'inf' : v}`;
    const alias = o.alias ? ` (${o.alias.join(', ')})` : '';
    lines.push(`${cur.padEnd(22)} ${o.desc || ''}${alias}`);
  }
  lines.push('');
  lines.push(`${(settings.get('smooth') ? 'smooth' : 'nosmooth').padEnd(22)} ${SMOOTH_GROUP.join(' ')} をまとめて切り替え`);
  return lines;
}

function scoreboard() {
  const rows = [...game.roster.values()];
  if (!rows.length) return ['(試合に参加していません)'];
  const lines = ['  #  名前              キル  デス'];
  rows.forEach((r, i) => {
    const me = r.id === game.myId ? '%' : ' ';
    const tag = r.spectator ? '  観戦' : r.out ? '  脱落' : r.bot ? '  bot' : '';
    lines.push(`${me}${String(i + 1).padStart(2)}  ${r.name.padEnd(16)}  ${String(r.kills).padStart(4)}  ${String(r.deaths).padStart(4)}${tag}`);
  });
  return lines;
}

// ---------------------------------------------------------------- command line

let cmdReturn = 'menu';
const history = [];
let histPos = 0;

function openCommand(prefill = '') {
  cmdReturn = vim.mode === 'command' ? cmdReturn : vim.mode;
  if (cmdReturn === 'msg') {
    show('msgwin', false);
    cmdReturn = msgReturn;
  }
  vim.setMode('command');
  show('cmdwin');
  const input = $('cmdinput');
  input.value = prefill;
  histPos = history.length;
  input.focus();
}

function closeCommand() {
  show('cmdwin', false);
  $('cmdinput').blur();
  if (vim.mode === 'command') vim.setMode(cmdReturn);
}

$('cmdinput').addEventListener('keydown', (e) => {
  const input = e.target;
  if (e.isComposing) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    submitCommand();
  } else if (e.key === 'Escape' || (e.ctrlKey && e.key === '[')) {
    e.preventDefault();
    closeCommand();
  } else if (e.key === 'Backspace' && input.value === '') {
    e.preventDefault();
    closeCommand();
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    histPos = Math.max(0, Math.min(history.length, histPos + (e.key === 'ArrowUp' ? -1 : 1)));
    input.value = history[histPos] || '';
  } else if (e.key === 'Tab') {
    e.preventDefault();
    const m = input.value.match(/^(se|set)\s+(.*?)([a-z]*)$/);
    if (m) {
      const cands = settings.complete(m[3].replace(/^no/, ''));
      if (cands.length) input.value = `${m[1]} ${m[2]}${m[3].startsWith('no') ? 'no' : ''}${cands[0]}`;
      if (cands.length > 1) balloon('候補', cands.join(' '));
    }
  }
  e.stopPropagation();
});

function submitCommand() {
  const line = $('cmdinput').value.trim();
  closeCommand();
  if (line) {
    history.push(line);
    runCommand(line);
  }
}

function runCommand(line) {
  const m = line.match(/^(\S+)\s*(.*)$/);
  const cmd = m[1];
  const args = m[2] || '';
  switch (cmd) {
    case 'se':
    case 'set': {
      const r = settings.command(args);
      if (r.error) balloon(r.error, '', 'err');
      else if (r.lines.length) showMsg(':set', r.lines);
      else if (r.changed.length) balloon('設定しました', r.changed.map((k) => settings.format(k).trim()).join(' '));
      break;
    }
    case 'spec':
    case 'specs':
      showSpec();
      break;
    case 'options':
    case 'opt':
      showMsg(':options — :set で変更できます', optionsHelp());
      break;
    case 'q':
    case 'q!':
    case 'qa':
    case 'qa!':
    case 'quit':
    case 'wq':
    case 'x':
      if (game.conn) leave();
      break;
    case 'w':
      settings.save();
      balloon('"settings" written');
      break;
    case 'h':
    case 'help':
      showMsg(':help', HELP);
      break;
    case 'ls':
    case 'score':
    case 'buffers':
      showMsg(':ls — スコア', scoreboard());
      break;
    case 'c':
    case 'e':
    case 'connect':
      connect(args);
      break;
    case 'watch':
      if (game.conn) game.conn.send({ t: 'watch' });
      break;
    case 'play':
      if (game.conn) game.conn.send({ t: 'play' });
      break;
    case 'follow': {
      const r = [...game.roster.values()].find((x) => x.name === args.trim());
      if (r && game.watching) {
        game.free = null;
        game.follow = r.id;
      } else balloon(`E: ${game.watching ? '見つかりません' : '観戦中だけ使えます'}: ${args}`, '', 'err');
      break;
    }
    case 'range':
      startPractice(0, { range: true });
      break;
    case 'practice':
      startPractice(args ? parseInt(args, 10) : 5);
      break;
    case 'bots':
      if (game.practice && game.conn) game.conn.send({ t: 'bots', n: Math.max(0, Math.min(15, parseInt(args, 10) || 0)) });
      else balloon('E: :bots は練習モードだけで使えます', '', 'err');
      break;
    case 'fs':
    case 'fullscreen':
      fullscreen();
      break;
    case 've':
    case 'version':
      showMsg(':version', [`vim-fps v${VERSION} (protocol ${PROTOCOL})`, serverInfo ? `サーバー: ${serverInfo.name} v${serverInfo.version}` : 'サーバー: なし']);
      break;
    case 'name':
      runCommand(`set name=${args}`);
      break;
    default:
      balloon(`E492: Not an editor command: ${line}`, '', 'err');
  }
}

async function fullscreen() {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    // Keep Esc for the game (Chromium, secure pages only).
    if (navigator.keyboard && navigator.keyboard.lock) await navigator.keyboard.lock(['Escape']);
    else balloon('Esc でフルスクリーンが解除されます', 'Ctrl-[ を Esc の代わりに使ってください');
  } catch (e) {
    balloon('フルスクリーンにできません', String(e.message || e), 'err');
  }
}

// ---------------------------------------------------------------- chat

function openChat() {
  if (!game.conn) return;
  vim.setMode('insert');
  show('chatwin');
  const input = $('chatinput');
  input.value = '';
  input.focus();
}

function submitChat() {
  const text = $('chatinput').value.trim();
  if (text && game.conn) game.conn.send({ t: 'chat', text });
  closeChat();
}

function closeChat() {
  show('chatwin', false);
  $('chatinput').blur();
  if (vim.mode === 'insert') vim.setMode('normal');
}

$('chatinput').addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    submitChat();
  } else if (e.key === 'Escape' || (e.ctrlKey && e.key === '[')) {
    e.preventDefault();
    closeChat();
  }
  e.stopPropagation();
});

// ---------------------------------------------------------------- inventory

function invEntries() {
  const inv = game.me && game.me.inv;
  if (!inv) return [];
  const g = (i) => inv.guns[i];
  const gunRow = (i, slot) =>
    g(i)
      ? { slot, label: gunName(g(i).gun), sub: `${g(i).ammo} / ${g(i).reserve}`, ok: true }
      : { slot, label: '(空き)', sub: '銃は 2 丁まで (y で拾う)', ok: false };
  return [
    gunRow(0, 'gun0'),
    gunRow(1, 'gun1'),
    { slot: 'medkit', label: '回復キット', sub: `× ${inv.medkits}  (f で使用 +60)`, ok: inv.medkits > 0 },
    { slot: 'grenade', label: 'グレネード', sub: `× ${inv.grenades}  (f で投げる / dd)`, ok: inv.grenades > 0 },
  ];
}

let invCursor = 0;

function renderInventory() {
  const list = $('inv-list');
  const rows = invEntries();
  const sel = game.me && game.me.inv.sel;
  list.innerHTML = '';
  rows.forEach((r, i) => {
    const li = document.createElement('li');
    if (i === invCursor) li.className = 'sel';
    if (!r.ok) li.classList.add('disabled');
    li.innerHTML = `${r.slot === sel ? '▶ ' : ''}${esc(r.label)}<span class="sub">${esc(r.sub)}</span>`;
    list.appendChild(li);
  });
}

function invSelect(n, absolute) {
  const rows = invEntries();
  if (!rows.length) return;
  if (absolute) invCursor = n < 0 ? rows.length - 1 : Math.min(n, rows.length - 1);
  else invCursor = Math.max(0, Math.min(rows.length - 1, invCursor + n));
  const r = rows[invCursor];
  if (r.ok && game.conn) {
    game.conn.send({ t: 'select', slot: r.slot });
    game.me.inv.sel = r.slot;
    sound.click();
  }
  renderInventory();
}

// ---------------------------------------------------------------- map window

function drawMap() {
  const c = $('mapcanvas');
  const ctx = c.getContext('2d');
  const map = game.map;
  if (!map) return;
  const W = c.width;
  const k = W / (map.half * 2);
  const tx = (x) => (x + map.half) * k;
  ctx.fillStyle = '#6fae4a';
  ctx.fillRect(0, 0, W, W);
  const col = { wall: '#d9d0b8', roof: 'rgba(154,90,58,0.55)', rock: '#8b8d90', cover: '#b9a774', crate: '#9c7240', trunk: '#2f7a35', fence: '#555' };
  for (const s of map.solids) {
    ctx.fillStyle = col[s.kind] || '#999';
    ctx.fillRect(tx(s.min.x), tx(s.min.z), Math.max(1.5, (s.max.x - s.min.x) * k), Math.max(1.5, (s.max.z - s.min.z) * k));
  }
  const pc = { ar: '#2f6fd6', smg: '#2f6fd6', sg: '#2f6fd6', sr: '#2f6fd6', medkit: '#d83a3a', grenade: '#1d5a12', ammo: '#e0b52a' };
  for (const p of renderer ? [...lastPickups] : []) {
    ctx.fillStyle = pc[p.kind] || '#fff';
    ctx.beginPath();
    ctx.arc(tx(p.x), tx(p.z), 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  // Gunfire heard in the last seconds.
  const now = performance.now();
  for (const sh of game.shots) {
    if (now - sh.t > 3500) continue;
    ctx.strokeStyle = '#ff2020';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(tx(sh.x), tx(sh.z), 7, 0, Math.PI * 2);
    ctx.stroke();
  }
  // You: a triangle pointing where you look.
  ctx.save();
  ctx.translate(tx(game.pos.x), tx(game.pos.z));
  ctx.rotate(-game.yaw);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#000';
  ctx.beginPath();
  ctx.moveTo(0, -9);
  ctx.lineTo(6, 7);
  ctx.lineTo(-6, 7);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
let lastPickups = [];

// ---------------------------------------------------------------- title menu

const menu = { items: [], sel: 0 };

function buildMenu() {
  menu.items = [];
  if (serverInfo) {
    const mode = serverInfo.respawn === false ? ' · 復活なし' : '';
    menu.items.push({
      label: 'このサーバーに参加',
      sub: `${serverInfo.name} · v${serverInfo.version}${mode}${serverInfo.password ? ' · 合言葉あり' : ''}`,
      run: () => connect(''),
    });
    menu.items.push({ label: 'このサーバーを観戦', sub: '試合には出ずに見る (:play で途中参加)', run: () => connect('', true) });
  }
  menu.items.push({ label: '射撃訓練場', sub: 'オフライン · 10〜400 m の的 · 全武器 · 弾無限', run: () => startPractice(0, { range: true }) });
  menu.items.push({ label: '練習する', sub: 'オフライン · bot 5 体', run: () => startPractice(5) });
  menu.items.push({ label: '練習する (復活なし)', sub: 'オフライン · bot 5 体 · 最後の 1 人が勝ち', run: () => startPractice(5, { noRespawn: true }) });
  menu.items.push({ label: 'URL を指定して接続', sub: ':connect URL', run: () => openCommand('connect ') });
  menu.items.push({ label: '操作説明', sub: ':help', run: () => showMsg(':help', HELP) });
  menu.items.push({ label: '設定', sub: ':options', run: () => showMsg(':options — :set で変更できます', optionsHelp()) });
  menu.sel = Math.min(menu.sel, menu.items.length - 1);
  renderMenu();
}

function renderMenu() {
  const ol = $('menu');
  ol.innerHTML = '';
  menu.items.forEach((it, i) => {
    const li = document.createElement('li');
    if (i === menu.sel) li.className = 'sel';
    li.innerHTML = `${esc(it.label)}<span class="sub">${esc(it.sub)}</span>`;
    ol.appendChild(li);
  });
  const name = settings.get('name');
  $('title-name').innerHTML = `名前: <b>${esc(name || '(未設定 — :set name=名前)')}</b>`;
  $('title-version').textContent = `v${VERSION}`;
}

function showTitle() {
  show('title');
  show('hud', false);
  for (const id of ['inventory', 'mapwin', 'chatwin', 'bsod', 'boot', 'resultwin', 'progress']) show(id, false);
  buildMenu();
  vim.setMode('menu');
}

// ---------------------------------------------------------------- connection

function attach(conn, practice) {
  if (game.conn) game.conn.close();
  resetGame();
  lastPickups = [];
  game.conn = conn;
  game.practice = practice;
  game.leaving = false;
  conn.onmessage = onMessage;
  conn.onclose = (reason) => {
    if (game.conn !== conn) return;
    const wasLeaving = game.leaving;
    resetGame();
    showTitle();
    if (!wasLeaving) showMsg('切断', [reason], true);
  };
}

function joinMsg(password, spectate = false) {
  return { t: 'join', name: settings.get('name') || '', password: password || null, protocol: PROTOCOL, spectate };
}

function connect(input, spectate = false) {
  let target;
  try {
    target = parseServerUrl(input, window.location);
  } catch {
    balloon(`E: URL が読めません: ${input}`, '', 'err');
    return;
  }
  if (window.location.protocol === 'https:' && !target.secure) {
    balloon('https のページから ws:// には接続できません', 'ホストのページ (http://...) を直接開くか、トンネルの https URL を使ってください', 'err');
    return;
  }
  const pw = target.password ?? (window.location.hash.match(/pw=([^&]*)/) || [])[1];
  balloon('接続中…', target.ws);
  let conn;
  try {
    conn = new WsConnection(target.ws);
  } catch (e) {
    balloon('接続できません', String(e.message || e), 'err');
    return;
  }
  attach(conn, false);
  conn.onopen = () => conn.send(joinMsg(pw ? decodeURIComponent(pw) : null, spectate));
}

async function startPractice(bots, mode = {}) {
  balloon(mode.range ? '射撃訓練場を準備中…' : '練習モードを準備中…');
  try {
    const conn = await LocalConnection.create(Math.floor(Math.random() * 100000), Number.isFinite(bots) ? bots : 5, mode);
    attach(conn, true);
    conn.onopen = () => conn.send(joinMsg(null));
  } catch (e) {
    showMsg('エラー', [String(e.message || e)], true);
  }
}

function leave() {
  if (!game.conn) return;
  game.leaving = true;
  const c = game.conn;
  resetGame();
  c.close();
  if (renderer) renderer.clear();
  showTitle();
}

function ensureRenderer() {
  if (renderer) return true;
  return import('./render.js')
    .then(({ Renderer }) => {
      renderer = new Renderer($('view'), settings);
      return true;
    })
    .catch((e) => {
      showMsg('エラー', ['3D 表示 (WebGL) を開始できません', String(e.message || e)], true);
      return false;
    });
}

async function onWelcome(m) {
  game.myId = m.id;
  game.map = m.map;
  game.world = new World(m.map);
  game.specs = m.specs;
  game.range = !!m.range;
  game.respawnMode = m.respawn !== false;
  const conn = game.conn;
  const ok = await ensureRenderer();
  if (!ok) return leave();
  if (game.conn !== conn) return;
  renderer.buildMap(m.map);
  renderer.setPickups(lastPickups);
  show('title', false);
  show('hud');
  show('msgwin', false);
  vim.setMode('normal');
  if (m.spectator) startWatching(null);
  if (game.range) balloon('射撃訓練場', 'うしろの台で y: 銃を持ち替え · 的は 10〜400 m · 弾は減りません · :q で終了');
  else
    balloon(
      game.practice ? '練習モード' : `${serverInfo ? serverInfo.name : 'サーバー'} に${m.spectator ? '観戦で' : ''}参加しました`,
      `${Math.round(m.time_limit / 60)} 分 · ${m.respawn === false ? '復活なし (最後の 1 人が勝ち)' : `${m.frag_limit} キル先取`} · :help で操作説明`,
    );
  if (m.version !== VERSION) balloon('バージョンが違います', `サーバー v${m.version} / このページ v${VERSION}`, 'err');
}

function onMessage(m) {
  switch (m.t) {
    case 'welcome':
      onWelcome(m);
      break;
    case 'error':
      game.leaving = true;
      showMsg('接続できません', [m.text, '', '合言葉は URL の末尾に #pw=合言葉 を付けて開くか、:connect URL#pw=合言葉'], true);
      if (game.conn) game.conn.close();
      resetGame();
      break;
    case 'snap':
      onSnap(m);
      break;
    case 'roster':
      game.roster = new Map(m.players.map((p) => [p.id, p]));
      for (const id of [...(renderer ? renderer.players.keys() : [])]) if (!game.roster.has(id)) renderer.removePlayer(id);
      break;
    case 'pickups':
      lastPickups = m.list;
      if (renderer) renderer.setPickups(m.list);
      break;
    case 'shot': {
      const mine = m.id === game.myId;
      if (!mine) game.shots.push({ x: m.from.x, z: m.from.z, id: m.id, t: performance.now() });
      if (renderer) renderer.tracer(m.from, m.to, mine, m.vel, game.specs && game.specs.gravity);
      sound.shot(m.gun, mine ? null : m.from);
      if (mine) {
        if (renderer) renderer.muzzle();
        if (settings.get('bob')) game.kick = 0.06;
      }
      break;
    }
    case 'hit':
      if (m.attacker === game.myId && m.victim !== game.myId) {
        const hm = $('hitmarker');
        hm.classList.toggle('head', m.head);
        show('hitmarker');
        clearTimeout(hitTimer);
        hitTimer = setTimeout(() => show('hitmarker', false), 160);
        sound.hit(m.head);
        const snap = game.snaps[game.snaps.length - 1];
        const v = snap && snap.players.get(m.victim);
        if (v && renderer && settings.get('dmgnum')) renderer.damageNumber({ x: v.x, y: v.y + (m.head ? 2.0 : 1.4), z: v.z }, m.dmg, m.head);
      }
      if (m.victim === game.myId) {
        damageArc(m.from);
        sound.hurt();
      }
      break;
    case 'kill': {
      const how = m.cause === 'grenade' ? 'グレネード' : gunName(m.cause.gun);
      const self = m.killer === m.victim;
      const dist = !self && m.dist ? ` · ${m.dist >= 10 ? Math.round(m.dist) : m.dist.toFixed(1)} m` : '';
      const mine = m.killer === game.myId && !self;
      balloon(
        self ? `${nameOf(m.victim)} は自爆しました` : mine ? `キル: ${nameOf(m.victim)}` : `${nameOf(m.killer)} ▶ ${nameOf(m.victim)}`,
        `${how}${m.head ? ' · ヘッドショット' : ''}${dist}`,
        'kill',
      );
      if (m.victim === game.myId) {
        game.alive = false;
        showBsod(self ? null : nameOf(m.killer), `${how}${m.head ? ' · ヘッドショット' : ''}${dist}`);
        if (vim.mode === 'view' || vim.mode === 'inventory' || vim.mode === 'map') vim.setMode('normal');
        if (!game.respawnMode) {
          // Out of the round: after the stop screen, watch through the
          // killer's eyes (or a free camera with :set nokillcam).
          game.bsodPending = true;
          const killer = self ? null : m.killer;
          setTimeout(() => {
            game.bsodPending = false;
            if (!game.conn || game.alive) return;
            hideDeath();
            startWatching(settings.get('killcam') ? killer : 'free');
          }, 1600);
        }
      }
      if (game.watching && m.victim === game.follow) {
        // Whom we watched fell: follow the one who got them.
        setTimeout(() => {
          if (game.watching && game.follow === m.victim) game.follow = m.killer !== m.victim ? m.killer : null;
        }, 1200);
      }
      break;
    }
    case 'explode':
      if (renderer) renderer.explosion(m.pos);
      sound.explosion(m.pos);
      break;
    case 'chat':
      chatLine(`<b>${esc(m.name)}</b>: ${esc(m.text)}`);
      sound.click();
      break;
    case 'sys':
      chatLine(esc(m.text), 'sys');
      break;
    case 'item':
      balloon(m.text);
      sound.ding();
      break;
    case 'respawn':
      game.pos = { x: m.pos.x, y: m.pos.y, z: m.pos.z };
      game.vel = { x: 0, z: 0 };
      game.yaw = m.yaw;
      game.pitch = 0;
      game.alive = true;
      game.timed = null;
      game.turnLeft = 0;
      hideDeath();
      if (game.watching) stopWatching();
      break;
    case 'match_end':
      showResult(m);
      break;
    case 'match_start':
      show('resultwin', false);
      balloon('新しい試合が始まりました');
      break;
    case 'pong': {
      const t = game.pings.get(m.id);
      if (t) {
        game.ping = performance.now() - t;
        game.pings.delete(m.id);
      }
      break;
    }
    default:
      break;
  }
}

let hitTimer = null;

// ---------------------------------------------------------------- death screen

/// The stop screen shown when you are killed. It "reboots" (boot screen)
/// for the last BOOT_TIME seconds before the respawn.
const BOOT_TIME = 0.8;
let bsodState = { killer: null, how: '' };

function bsodCode(name) {
  // Four hex words from the killer's name, for the "technical information".
  const bytes = [...new TextEncoder().encode(name || 'SELF')].slice(0, 4);
  while (bytes.length < 4) bytes.push(0);
  return bytes.map((b) => `0x${b.toString(16).toUpperCase().padStart(8, '0')}`).join(', ');
}

function showBsod(killer, how) {
  bsodState = { killer, how, at: performance.now() };
  renderBsod(null);
  show('boot', false);
  show('bsod');
}

function renderBsod(left) {
  const { killer, how } = bsodState;
  const id = (killer ? `KILLED_BY_${killer}` : 'SELF_DESTRUCT').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const count = left == null ? '' : ` ${Math.max(0, Math.ceil(left - BOOT_TIME))}`;
  const lines = [
    '<span class="hl"> vim-fps </span>',
    '',
    'プレイヤーが倒されたため、問題が起きないようにシステムを停止しました。',
    '',
    esc(id),
    '',
    killer ? `倒した相手: ${esc(killer)}` : '原因: 自分のグレネード',
    `詳細: ${esc(how)}`,
    '',
    'このエラーが続く場合は、遮蔽物に隠れるか、先に撃ってください。',
    '',
    `自動的に再起動します…${count}`,
    '',
    '技術情報:',
    '',
    `*** STOP: 0x000000DE (${bsodCode(killer)})`,
    '***  E492: Not an editor command: alive',
  ];
  $('bsod-text').innerHTML = lines.join('\n');
}

function updateDeath(serverLeft) {
  // Until the first snapshot after the kill arrives, the last one still says
  // "alive, 0 s": count from the moment of death instead.
  const total = (game.specs && game.specs.respawn) || 3;
  const local = total - (performance.now() - (bsodState.at || 0)) / 1000;
  const left = serverLeft > 0 ? serverLeft : Math.max(0, local);
  if (left > BOOT_TIME) {
    // Once rebooting, stay there until the respawn.
    if (!$('boot').classList.contains('hidden')) return;
    renderBsod(left);
  } else if ($('boot').classList.contains('hidden')) {
    show('bsod', false);
    show('boot');
  }
}

function hideDeath() {
  show('bsod', false);
  show('boot', false);
}

function damageArc(from) {
  const dx = from.x - game.pos.x;
  const dz = from.z - game.pos.z;
  // Angle of the attacker relative to where you look (0 = ahead).
  const ang = wrapAngle(Math.atan2(-dx, -dz) - game.yaw);
  const arc = document.createElement('div');
  arc.className = 'arc';
  arc.style.transform = `rotate(${-ang}rad)`;
  $('dmgdir').appendChild(arc);
  setTimeout(() => arc.remove(), 700);
}

function showResult(m) {
  const t = $('result-table');
  t.innerHTML = '<tr><th>#</th><th>名前</th><th>キル</th><th>デス</th></tr>';
  m.ranking.forEach((r, i) => {
    const tr = document.createElement('tr');
    if (r.id === game.myId) tr.className = 'me';
    tr.innerHTML = `<td>${i + 1}</td><td>${esc(r.name)}${r.bot ? ' (bot)' : ''}</td><td>${r.kills}</td><td>${r.deaths}</td>`;
    t.appendChild(tr);
  });
  show('resultwin');
  hideDeath();
}

function onSnap(m) {
  if (m.watching && !game.watching && !game.bsodPending) startWatching(null);
  if (!m.watching && game.watching && m.me) stopWatching();
  game.me = m.me;
  game.left = m.left;
  game.intermission = m.intermission;
  game.grenades = m.grenades;
  const now = performance.now();
  const players = new Map(m.players.map((p) => [p.id, p]));
  game.snaps.push({ t: now, players });
  if (game.snaps.length > 12) game.snaps.shift();
  const mine = players.get(game.myId);
  if (mine) {
    if (mine.alive && !game.alive && game.me && game.me.respawn === 0) {
      game.alive = true;
      game.pos = { x: mine.x, y: mine.y, z: mine.z };
      hideDeath();
    }
    if (mine.alive && game.alive) {
      // Reconcile the predicted position with the server's.
      const ex = mine.x - game.pos.x;
      const ez = mine.z - game.pos.z;
      const err = Math.hypot(ex, ez);
      if (err > 2.0) {
        game.pos.x = mine.x;
        game.pos.z = mine.z;
      } else {
        game.pos.x += ex * 0.15;
        game.pos.z += ez * 0.15;
      }
      if (game.world) game.pos.y = game.world.height(game.pos.x, game.pos.z);
    }
  }
  // Footsteps of others (positional).
  for (const p of m.players) {
    if (p.id === game.myId || !p.alive || !p.mv) continue;
    const acc = (game.steps.get(p.id) || 0) + (p.sneak ? SNEAK_SPEED : RUN_SPEED) / 20;
    if (acc > 2.2) {
      sound.footstep({ x: p.x, y: p.y, z: p.z }, p.sneak);
      game.steps.set(p.id, 0);
    } else game.steps.set(p.id, acc);
  }
  if (renderer) renderer.setGrenades(m.grenades);
  if (vim.mode === 'inventory') renderInventory();
}

// ---------------------------------------------------------------- input → actions

/// Look speed and step while aiming: in proportion to the zoom (so one step
/// moves the same distance on screen), times :set zoomsens. A scoped SR
/// (14° of view) turns about 0.18× as fast as the hip, 0.04° per step.
function zoomFactor() {
  if (!game.ads) return 1;
  const ratio = Math.min(1, targetFov() / settings.get('fov'));
  return ratio * settings.get('zoomsens');
}

function applyLook(d) {
  game.yaw = wrapAngle(game.yaw + d.yaw * DEG);
  game.pitch = Math.max(-1.45, Math.min(1.45, game.pitch + d.pitch * DEG));
}

const vim = new Vim(settings, {
  mode(mode, prev) {
    setText($('mode'), MODES[mode] || mode.toUpperCase());
    $('start').dataset.mode = MODES[mode] || '';
    $('crosshair').dataset.mode = mode === 'view' ? 'view' : mode === 'normal' ? 'normal' : 'other';
    show('inventory', mode === 'inventory');
    show('mapwin', mode === 'map');
    if (mode === 'view') {
      game.ads = true;
      game.zoom = 1;
      game.timed = null;
    } else if (prev === 'view') {
      game.ads = false;
      game.zoom = 0;
      aim.clear();
      game.sneak = game.shiftDown;
    }
    if (mode === 'inventory') {
      const rows = invEntries();
      const i = rows.findIndex((r) => game.me && r.slot === game.me.inv.sel);
      invCursor = Math.max(0, i);
      renderInventory();
    }
    if (mode === 'map') drawMap();
    if (mode !== 'normal' && mode !== 'view') {
      game.fire = false;
      game.timed = null;
    }
  },
  showcmd(s) {
    setText($('tb-showcmd'), settings.get('showcmd') ? s : '');
  },
  move(dir, down) {
    game.held[dir] = down;
    if (down) game.timed = null;
  },
  moveTimed(dir, n) {
    const speed = game.sneak ? SNEAK_SPEED : RUN_SPEED;
    game.timed = { dir, left: n / speed };
  },
  sneak(on) {
    game.shiftDown = on;
    if (vim.mode !== 'view') game.sneak = on;
  },
  fire(down) {
    game.fire = down;
    if (down && game.conn) game.conn.send({ t: 'trigger' });
  },
  throw(power) {
    if (game.conn) game.conn.send({ t: 'throw', power });
  },
  reload() {
    if (game.conn) game.conn.send({ t: 'reload' });
  },
  pickup() {
    if (game.conn) game.conn.send({ t: 'pickup' });
  },
  swapGun() {
    const inv = game.me && game.me.inv;
    if (!inv || inv.guns.length < 2) return;
    const slot = inv.sel === 'gun0' ? 'gun1' : 'gun0';
    inv.sel = slot;
    game.conn.send({ t: 'select', slot });
  },
  follow(n) {
    followNext(n);
  },
  freecam() {
    if (game.free) {
      game.free = null;
      followNext(1);
    } else startFree();
  },
  turn(deg) {
    game.turnLeft += deg * DEG;
    if (!settings.get('turnanim')) {
      game.yaw = wrapAngle(game.yaw + game.turnLeft);
      game.turnLeft = 0;
    }
  },
  look(dir, down, fast) {
    if (down) applyLook(aim.press(dir, fast, zoomFactor()));
    else aim.release(dir);
  },
  lookStep(dir, n, fast) {
    applyLook(aim.stepDelta(dir, n, fast, zoomFactor()));
  },
  spot() {
    // The enemy closest to the crosshair (within 6°) that you can see.
    if (!game.world) return;
    const eye = { x: game.pos.x, y: game.pos.y + eyeHeight(game.sneak), z: game.pos.z };
    const snap = game.snaps[game.snaps.length - 1];
    if (!snap) return;
    let best = null;
    for (const [id, p] of snap.players) {
      if (id === game.myId || !p.alive) continue;
      const head = { x: p.x, y: p.y + (p.sneak ? 1.2 : 1.6), z: p.z };
      const dx = head.x - eye.x;
      const dy = head.y - eye.y;
      const dz = head.z - eye.z;
      const dist = Math.hypot(dx, dy, dz);
      const yawErr = Math.abs(bearing(dx, dz, game.yaw));
      const pitchErr = Math.abs(Math.atan2(dy, Math.hypot(dx, dz)) - game.pitch);
      const err = Math.hypot(yawErr, pitchErr);
      if (err > 6 * DEG || dist > 250) continue;
      if (!game.world.lineOfSight(eye, head)) continue;
      if (!best || err < best.err) best = { id, err };
    }
    if (best) {
      game.spotted.set(best.id, performance.now() + 6000);
      balloon(`${nameOf(best.id)} をマークしました`, '6 秒間、壁越しでも ▼ が見えます');
      sound.click();
    } else balloon('E486: Pattern not found', '照準の近くに見えている敵がいません');
  },
  zoom() {
    game.zoom = game.zoom === 2 ? 1 : 2;
  },
  invSelect,
  insert: openChat,
  command: () => openCommand(''),
  closeMsg,
  msgScroll(kind, n) {
    const body = $('msg-body');
    const line = parseFloat(getComputedStyle(body).lineHeight) || 20;
    const page = Math.max(line, body.clientHeight - line);
    if (kind === 'line') body.scrollTop += n * line;
    else if (kind === 'half') body.scrollTop += n * Math.round(page / 2);
    else if (kind === 'page') body.scrollTop += n * page;
    else if (kind === 'top') body.scrollTop = 0;
    else if (kind === 'bottom') body.scrollTop = body.scrollHeight;
    else if (kind === 'side') body.scrollLeft += n * 8 * (line / 1.5);
  },
  menuMove(n) {
    menu.sel = Math.max(0, Math.min(menu.items.length - 1, menu.sel + n));
    renderMenu();
  },
  menuPick(i) {
    if (i !== null && i !== undefined) menu.sel = Math.max(0, Math.min(menu.items.length - 1, i));
    renderMenu();
    const it = menu.items[menu.sel];
    if (it) it.run();
  },
});

let imeTimer = null;
window.addEventListener('keydown', (e) => {
  sound.wake();
  if (vim.mode === 'insert' || vim.mode === 'command') return;
  if (e.isComposing || e.key === 'Process' || e.keyCode === 229) {
    show('imewarn');
    clearTimeout(imeTimer);
    imeTimer = setTimeout(() => show('imewarn', false), 3000);
    e.preventDefault();
    return;
  }
  if (e.metaKey || e.altKey || /^F\d+$/.test(e.key)) return;
  const used = vim.key({ type: 'down', key: e.key, code: e.code, shift: e.shiftKey, ctrl: e.ctrlKey, repeat: e.repeat });
  if (used || !e.ctrlKey) e.preventDefault();
});

window.addEventListener('keyup', (e) => {
  vim.key({ type: 'up', key: e.key, code: e.code, shift: e.shiftKey, ctrl: e.ctrlKey });
});

window.addEventListener('blur', () => {
  // Losing focus: nothing stays held.
  vim.releaseAll();
  game.shiftDown = false;
  if (vim.mode !== 'view') game.sneak = false;
});

let mouseNote = 0;
for (const ev of ['mousedown', 'wheel', 'contextmenu']) {
  window.addEventListener(
    ev,
    (e) => {
      if (vim.mode === 'insert' || vim.mode === 'command') return;
      if (e.target && e.target.closest && e.target.closest('#touchpad')) return;
      e.preventDefault();
      if (touch.active) return;
      const now = performance.now();
      if (now - mouseNote > 5000) {
        mouseNote = now;
        balloon('マウスは使えません', 'キーボードだけで操作します (:help)');
      }
    },
    { passive: false },
  );
}

settings.onChange((k, v) => {
  if (k === 'uianim') document.body.classList.toggle('uianim', v);
  if (k === 'showfps') show('fps', v);
  if (k === 'name' && vim.mode === 'menu') renderMenu();
});
document.body.classList.toggle('uianim', settings.get('uianim'));
show('fps', settings.get('showfps'));

// ---------------------------------------------------------------- frame loop

function moveAxes() {
  const h = game.held;
  let mx = (h.right ? 1 : 0) - (h.left ? 1 : 0);
  let mz = (h.fwd ? 1 : 0) - (h.back ? 1 : 0);
  if (game.timed) {
    const d = game.timed.dir;
    if (d === 'fwd') mz = 1;
    else if (d === 'back') mz = -1;
    else if (d === 'left') mx = -1;
    else mx = 1;
  }
  const active = vim.mode === 'normal' && game.alive && game.intermission == null;
  return active ? { mx, mz } : { mx: 0, mz: 0 };
}

function sendInput(now) {
  if (!game.conn || !game.map) return;
  const { mx, mz } = moveAxes();
  const msg = {
    t: 'input',
    mx,
    mz,
    sneak: game.sneak,
    yaw: Math.round(game.yaw * 1000) / 1000,
    pitch: Math.round(game.pitch * 1000) / 1000,
    ads: game.ads,
    zoom: game.zoom,
    fire: game.fire && (vim.mode === 'normal' || vim.mode === 'view'),
    instant: !settings.get('moveaccel'),
  };
  const json = JSON.stringify(msg);
  if (json !== game.lastInput || now - game.lastSend > 100) {
    if (json !== game.lastInput || now - game.lastSend > 250) {
      game.conn.send(msg);
      game.lastInput = json;
      game.lastSend = now;
    }
  }
}

function interpolated(now) {
  const snaps = game.snaps;
  if (!snaps.length) return new Map();
  if (!settings.get('interp') || snaps.length < 2) return snaps[snaps.length - 1].players;
  const t = now - 100;
  let a = snaps[0];
  let b = snaps[snaps.length - 1];
  for (let i = snaps.length - 1; i > 0; i--) {
    if (snaps[i - 1].t <= t) {
      a = snaps[i - 1];
      b = snaps[i];
      break;
    }
  }
  const k = b.t > a.t ? Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t))) : 1;
  const out = new Map();
  for (const [id, pb] of b.players) {
    const pa = a.players.get(id);
    if (!pa || !pa.alive || !pb.alive) {
      out.set(id, pb);
      continue;
    }
    out.set(id, {
      ...pb,
      x: pa.x + (pb.x - pa.x) * k,
      y: pa.y + (pb.y - pa.y) * k,
      z: pa.z + (pb.z - pa.z) * k,
      yaw: pa.yaw + wrapAngle(pb.yaw - pa.yaw) * k,
    });
  }
  return out;
}

function targetFov() {
  const base = settings.get('fov');
  if (!game.ads) return base;
  const inv = game.me && game.me.inv;
  const gi = inv ? (inv.sel === 'gun1' ? 1 : 0) : 0;
  const gun = inv && inv.guns[gi] ? GUNS[inv.guns[gi].gun] : GUNS.ar;
  return game.zoom === 2 ? gun.scope : gun.ads;
}

function heldGun() {
  const inv = game.me && game.me.inv;
  if (!inv || !inv.guns.length) return null;
  const i = inv.sel === 'gun1' && inv.guns[1] ? 1 : 0;
  return inv.guns[i];
}

let last = performance.now();
let fpsAcc = 0;
let fpsN = 0;
let pingTimer = 0;

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (game.conn && game.map && renderer && game.watching) {
    watchFrame(now, dt);
  } else if (game.conn && game.map && renderer) {
    // Look (VIEW) and quick turns.
    if (vim.mode === 'view') applyLook(aim.update(dt, zoomFactor()));
    if (game.turnLeft) {
      const step = settings.get('turnanim') ? Math.min(Math.abs(game.turnLeft), 12 * dt) * Math.sign(game.turnLeft) : game.turnLeft;
      game.yaw = wrapAngle(game.yaw + step);
      game.turnLeft -= step;
      if (Math.abs(game.turnLeft) < 1e-4) game.turnLeft = 0;
    }
    // Timed walk ({n}hjkl).
    if (game.timed) {
      game.timed.left -= dt;
      if (game.timed.left <= 0) game.timed = null;
    }
    // Own movement, predicted with the server's rules.
    const { mx, mz } = moveAxes();
    const want = game.ads ? { x: 0, z: 0 } : wantVelocity(mx, mz, game.yaw, game.sneak);
    if (!settings.get('moveaccel')) game.vel = { x: want.x, z: want.z };
    else {
      const dx = want.x - game.vel.x;
      const dz = want.z - game.vel.z;
      const l = Math.hypot(dx, dz);
      const max = ACCEL * dt;
      game.vel = l <= max ? { x: want.x, z: want.z } : { x: game.vel.x + (dx / l) * max, z: game.vel.z + (dz / l) * max };
    }
    if (game.alive && game.intermission == null) {
      const before = { ...game.pos };
      game.pos = game.world.slide(game.pos, game.vel.x * dt, game.vel.z * dt);
      const moved = Math.hypot(game.pos.x - before.x, game.pos.z - before.z);
      if (moved > 0) {
        game.myStep += moved;
        if (game.myStep > 2.4) {
          game.myStep = 0;
          sound.footstep(null, true);
        }
        game.bob += moved * 2.2;
      }
    }
    sendInput(now);

    // Field of view and the gun in your hands.
    const tf = targetFov();
    if (settings.get('adsanim')) {
      const k = Math.min(1, dt * 14);
      game.fov += (tf - game.fov) * k;
      game.adsK += ((game.ads ? 1 : 0) - game.adsK) * k;
    } else {
      game.fov = tf;
      game.adsK = game.ads ? 1 : 0;
    }
    const gun = heldGun();
    const sel = game.me && game.me.inv.sel;
    renderer.setHeld(sel === 'medkit' || sel === 'grenade' ? sel : gun ? gun.gun : null);
    // The SR looks through its scope at both stages (low / high power).
    const scoped = game.ads && gun && gun.gun === 'sr' && game.adsK > 0.5;
    show('scope', scoped);
    if (scoped) updateHoldover();
    const style = game.ads && game.adsK > 0.6 && !scoped ? renderer.adsStyle() : null;
    $('crosshair').dataset.mode = style ? `ads-${style}` : vim.mode === 'view' ? 'view' : vim.mode === 'normal' ? 'normal' : 'other';
    const bobOn = settings.get('bob');
    if (bobOn) game.kick = Math.max(0, game.kick - dt * 0.6);
    else game.kick = 0;
    const bobY = bobOn && !game.ads ? Math.sin(game.bob) * 0.012 : 0;

    // Others.
    const view = interpolated(now);
    for (const [id, p] of view) {
      if (id === game.myId) continue;
      renderer.setPlayer(id, p, nameOf(id), markOf(id, p, now));
    }
    renderer.updateEffects(dt);
    const eye = eyeHeight(game.sneak);
    const cam = {
      x: game.pos.x,
      y: game.pos.y + eye + (bobOn && !game.ads ? Math.abs(Math.sin(game.bob)) * 0.04 : 0),
      z: game.pos.z,
      yaw: game.yaw,
      pitch: game.pitch,
      fov: game.fov,
    };
    renderer.render(cam, { ads: game.adsK, hide: scoped || !game.alive, bob: bobY, kick: game.kick });
    sound.listener(cam.x, cam.y, cam.z, game.yaw);
    if (vim.mode === 'map') drawMap();
  }
  if (game.conn && game.map && renderer) {

    pingTimer += dt;
    if (pingTimer > 2 && !game.practice) {
      pingTimer = 0;
      game.pingSeq += 1;
      game.pings.set(game.pingSeq, now);
      game.conn.send({ t: 'ping', id: game.pingSeq });
    }
    updateHud(dt);
    updateCompass(now);
  }
  if (settings.get('showfps')) {
    fpsAcc += dt;
    fpsN += 1;
    if (fpsAcc > 0.5) {
      setText($('fps'), `${Math.round(fpsN / fpsAcc)} fps`);
      fpsAcc = 0;
      fpsN = 0;
    }
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- watching

function alivePlayers() {
  const snap = game.snaps[game.snaps.length - 1];
  if (!snap) return [];
  return [...snap.players.values()].filter((p) => p.alive && p.id !== game.myId).sort((a, b) => a.id - b.id);
}

/// Start watching: follow `who` (a player id), 'free' for a free camera,
/// or null for whoever is around.
function startWatching(who) {
  game.watching = true;
  game.ads = false;
  game.zoom = 0;
  game.fire = false;
  game.held = { fwd: false, back: false, left: false, right: false, up: false, down: false };
  if (who === 'free') {
    game.follow = null;
    startFree();
  } else {
    game.free = null;
    game.follow = who;
    if (who == null) followNext(1);
  }
  if (['normal', 'view', 'inventory', 'map'].includes(vim.mode)) vim.setMode('spectate');
}

function stopWatching() {
  game.watching = false;
  game.follow = null;
  game.free = null;
  show('watchbar', false);
  if (vim.mode === 'spectate' || vim.mode === 'map') vim.setMode('normal');
}

function followNext(n) {
  const list = alivePlayers();
  game.free = null;
  if (!list.length) {
    game.follow = null;
    return;
  }
  const i = list.findIndex((p) => p.id === game.follow);
  const k = i < 0 ? (n > 0 ? 0 : list.length - 1) : (((i + n) % list.length) + list.length) % list.length;
  game.follow = list[k].id;
}

function startFree() {
  game.follow = null;
  game.autoFree = false;
  // From where the camera is now, a little higher.
  game.free = { x: game.pos.x, y: game.pos.y + 8, z: game.pos.z, yaw: game.yaw, pitch: -0.35 };
}

/// One frame while watching: the camera is the followed player's eyes, or
/// the free camera.
function watchFrame(now, dt) {
  const view = interpolated(now);
  let target = game.follow != null ? view.get(game.follow) : null;
  if (game.autoFree && alivePlayers().length) {
    // Somebody to watch appeared: leave the stand-in overview.
    game.autoFree = false;
    game.free = null;
  }
  if (!game.free && (!target || !target.alive)) {
    followNext(1);
    target = game.follow != null ? view.get(game.follow) : null;
    if (!target) {
      // Nobody to follow yet: an overview until someone appears.
      startFree();
      game.autoFree = true;
    }
  }
  for (const [id, p] of view) {
    if (id === game.myId) continue;
    renderer.setPlayer(id, p, nameOf(id), markOf(id, p, now));
  }
  let cam;
  let vm = { ads: 0, hide: true, bob: 0, kick: 0 };
  let scoped = false;
  if (game.free || !target) {
    const f = game.free;
    if (game.turnLeft) {
      const step = settings.get('turnanim') ? Math.min(Math.abs(game.turnLeft), 12 * dt) * Math.sign(game.turnLeft) : game.turnLeft;
      f.yaw = wrapAngle(f.yaw + step);
      game.turnLeft -= step;
      if (Math.abs(game.turnLeft) < 1e-4) game.turnLeft = 0;
    }
    const h = game.held;
    const speed = (game.shiftDown ? 45 : 15) * dt;
    const fz = (h.fwd ? 1 : 0) - (h.back ? 1 : 0);
    const fx = (h.right ? 1 : 0) - (h.left ? 1 : 0);
    // While free, h/l turn (no sideways walk) so you can look around.
    f.yaw = wrapAngle(f.yaw - fx * 1.6 * dt * (game.shiftDown ? 2 : 1));
    f.x += -Math.sin(f.yaw) * fz * speed;
    f.z += -Math.cos(f.yaw) * fz * speed;
    f.y = Math.max(game.world.height(f.x, f.z) + 1.5, f.y + ((h.up ? 1 : 0) - (h.down ? 1 : 0)) * speed);
    const half = game.map.half;
    f.x = Math.max(-half, Math.min(half, f.x));
    f.z = Math.max(-half, Math.min(half, f.z));
    cam = { x: f.x, y: f.y, z: f.z, yaw: f.yaw, pitch: f.pitch, fov: settings.get('fov') };
    renderer.setHeld(null);
  } else {
    renderer.hidePlayer(target.id);
    const gun = target.gun && GUNS[target.gun];
    scoped = target.ads && target.gun === 'sr';
    cam = {
      x: target.x,
      y: target.y + eyeHeight(target.sneak),
      z: target.z,
      yaw: target.yaw,
      pitch: target.pitch,
      fov: target.ads && gun ? gun.ads : settings.get('fov'),
    };
    renderer.setHeld(target.gun || null);
    vm = { ads: target.ads ? 1 : 0, hide: scoped, bob: 0, kick: 0 };
  }
  show('scope', scoped);
  $('crosshair').dataset.mode = game.free ? 'other' : target && target.ads ? 'view' : 'normal';
  // The compass, markers and sound follow the camera.
  game.pos = { x: cam.x, y: cam.y - 1.6, z: cam.z };
  game.yaw = cam.yaw;
  game.pitch = cam.pitch;
  game.fov = cam.fov;
  renderer.updateEffects(dt);
  renderer.render(cam, vm);
  sound.listener(cam.x, cam.y, cam.z, cam.yaw);
  if (vim.mode === 'map') drawMap();
}

function updateWatchHud() {
  const view = game.snaps.length ? game.snaps[game.snaps.length - 1].players : new Map();
  const t = game.follow != null ? view.get(game.follow) : null;
  const r = game.roster.get(game.myId);
  const voluntary = r && r.spectator;
  let line;
  if (game.free || !t) line = '自由視点 — k/j 前後 · h/l 旋回 · K/J 上下 · Shift で速く · n で選手を追う';
  else line = `${nameOf(t.id)} を観戦中 — n / N 切り替え · o 自由視点`;
  const tail = voluntary ? ' · :play で参加' : !game.respawnMode ? ' · 次のラウンドまで観戦' : '';
  setText($('watchbar'), line + tail);
  setText($('tb-weapon'), t && t.gun ? gunName(t.gun) : '観戦中');
  setText($('tb-items'), t ? nameOf(t.id) : '—');
  const hp = t && t.hp != null ? Math.max(0, t.hp) : 0;
  $('hp-fill').style.width = `${hp}%`;
  $('hp-fill').classList.toggle('low', hp <= 30);
  setText($('hp-text'), t ? String(hp) : '—');
  setText($('tb-kd'), r ? `${r.kills} / ${r.deaths}` : '');
  setText($('tb-ping'), game.practice ? '練習' : game.ping != null ? `${Math.round(game.ping)} ms` : '');
  setText($('clock'), game.intermission != null ? `次 ${fmtTime(game.intermission)}` : fmtTime(game.left));
  if (game.intermission != null) setText($('result-next'), `${Math.ceil(game.intermission)} 秒後に次の試合`);
  show('progress', false);
  const rows = [...game.roster.values()].filter((x) => !x.spectator);
  const alive = rows.filter((x) => !x.out).length;
  setText($('rank'), game.respawnMode ? `観戦中 · ${rows.length} 人` : `残り ${alive} 人 / ${rows.length} 人`);
}

/// Bullet-drop marks on the SR reticle: where to put a target 100–400 m away
/// (the bullet falls ½·g·t² below the line of sight, t = distance / speed).
let holdoverKey = '';
function updateHoldover() {
  const el = $('holdover');
  const canvasH = $('view').clientHeight;
  const sr = game.specs && game.specs.guns.find((g) => g.id === 'sr');
  const speed = sr ? sr.muzzle_velocity : 850;
  const g = (game.specs && game.specs.gravity) || 9.81;
  const key = `${Math.round(game.fov * 10)}:${canvasH}:${speed}`;
  if (key === holdoverKey) return;
  holdoverKey = key;
  const half = Math.tan((game.fov * DEG) / 2);
  let html = '';
  let last = 0;
  for (const d of [100, 200, 300, 400]) {
    const t = d / speed;
    const drop = 0.5 * g * t * t;
    const px = (drop / d / half) * (canvasH / 2);
    // Only marks that can be told apart from the centre and each other
    // (at low power the drop is a few pixels: aim at the centre).
    if (px > canvasH * 0.33 || px < 6 || px - last < 10) continue;
    last = px;
    html += `<i style="top:${px.toFixed(1)}px"><b>${d / 100}</b></i>`;
  }
  el.innerHTML = html;
}

/// Marker over an enemy: 'spotted' (marked with *), 'seen' (in view), or null.
function markOf(id, p, now) {
  if (!p.alive) return null;
  const until = game.spotted.get(id);
  if (until && until > now) return 'spotted';
  if (until) game.spotted.delete(id);
  if (!settings.get('markers') || !game.world) return null;
  const dx = p.x - game.pos.x;
  const dz = p.z - game.pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist > 150 || Math.abs(bearing(dx, dz, game.yaw)) > (game.fov * DEG) * 0.75) return null;
  // Line of sight, checked a few times a second per enemy.
  const c = game.seen.get(id);
  if (c && now - c.t < 150) return c.v ? 'seen' : null;
  const eye = { x: game.pos.x, y: game.pos.y + eyeHeight(game.sneak), z: game.pos.z };
  const v = game.world.lineOfSight(eye, { x: p.x, y: p.y + (p.sneak ? 1.2 : 1.6), z: p.z });
  game.seen.set(id, { t: now, v });
  return v ? 'seen' : null;
}

let compassAt = 0;
/// The compass strip: headings, gunfire (red), footsteps (orange), marked (yellow).
function updateCompass(now) {
  const el = $('compass');
  const on = settings.get('compass') && !!game.map;
  el.classList.toggle('hidden', !on);
  if (!on || now - compassAt < 33) return;
  compassAt = now;
  const span = 100 * DEG; // half width in radians
  const pct = (a) => 50 - (a / span) * 50;
  let html = '';
  const heading = ((((-game.yaw / DEG) % 360) + 360) % 360);
  for (let d = 0; d < 360; d += 15) {
    const a = wrapAngle(-(d - heading) * DEG);
    if (Math.abs(a) > span) continue;
    const name = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[d];
    html += `<i class="tick${name ? ' big' : ''}" style="left:${pct(a)}%">${name || (d % 45 === 0 ? d : '')}</i>`;
  }
  game.shots = game.shots.filter((s) => now - s.t < 3500);
  const dot = (dx, dz, cls, label = '') => {
    const a = bearing(dx, dz, game.yaw);
    const edge = Math.abs(a) > span;
    const left = edge ? (a > 0 ? 0 : 100) : pct(a);
    html += `<b class="${cls}${edge ? ' edge' : ''}" style="left:${left}%">${label}</b>`;
  };
  for (const sh of game.shots) dot(sh.x - game.pos.x, sh.z - game.pos.z, 'shot');
  const snap = game.snaps[game.snaps.length - 1];
  if (snap) {
    for (const [id, p] of snap.players) {
      if (id === game.myId || !p.alive) continue;
      const dx = p.x - game.pos.x;
      const dz = p.z - game.pos.z;
      if (game.spotted.has(id)) dot(dx, dz, 'spot', '▼');
      else if (p.mv && !p.sneak && Math.hypot(dx, dz) < 35) dot(dx, dz, 'step');
    }
  }
  el.innerHTML = `<div class="strip">${html}</div><span class="hdg">${Math.round(heading)}°</span>`;
}

function updateHud() {
  const me = game.me;
  show('watchbar', game.watching);
  if (game.watching || !me) {
    updateWatchHud();
    return;
  }
  const gun = heldGun();
  const sel = me.inv.sel;
  let weapon = '素手';
  if (sel === 'medkit') weapon = `回復キット × ${me.inv.medkits}`;
  else if (sel === 'grenade') weapon = `グレネード × ${me.inv.grenades}`;
  else if (gun) weapon = `${gunName(gun.gun)}  ${gun.ammo} / ${gun.reserve}`;
  setText($('tb-weapon'), weapon);
  setText($('tb-items'), `+${me.inv.medkits}  G${me.inv.grenades}${game.sneak ? '  スニーク' : ''}`);
  const hp = Math.max(0, me.hp);
  $('hp-fill').style.width = `${hp}%`;
  $('hp-fill').classList.toggle('low', hp <= 30);
  setText($('hp-text'), String(hp));
  const r = game.roster.get(game.myId);
  setText($('tb-kd'), r ? `${r.kills} / ${r.deaths}` : '');
  setText($('tb-ping'), game.practice ? '練習' : game.ping != null ? `${Math.round(game.ping)} ms` : '');
  setText($('clock'), game.range ? '∞' : game.intermission != null ? `次 ${fmtTime(game.intermission)}` : fmtTime(game.left));
  if (game.intermission != null) setText($('result-next'), `${Math.ceil(game.intermission)} 秒後に次の試合`);

  // Reload / heal progress.
  const prog = me.reload >= 0 ? ['リロード', me.reload] : me.heal >= 0 ? ['回復中', me.heal] : null;
  show('progress', !!prog && game.alive);
  if (prog) {
    setText($('progress-title'), prog[0]);
    $('progress-fill').style.width = `${Math.round(prog[1] * 100)}%`;
  }
  if (!game.alive && game.respawnMode) updateDeath(me.respawn);

  // Rank (top right).
  if (game.range) {
    setText($('rank'), '射撃訓練場 · :q で終了');
    return;
  }
  const rows = [...game.roster.values()].filter((r) => !r.spectator);
  const idx = rows.findIndex((x) => x.id === game.myId);
  const top = rows[0];
  setText($('rank'), idx >= 0 ? `${idx + 1} 位 / ${rows.length} 人${top ? ` · 1 位 ${top.name} ${top.kills}` : ''}` : '');
}

// ---------------------------------------------------------------- boot

const touch = new TouchPad($('touchpad'), settings, (ev) => {
  sound.wake();
  // While typing, the pad's Esc still cancels (phone keyboards have none).
  if (vim.mode === 'insert' || vim.mode === 'command') {
    if (ev.type === 'down' && ev.key === 'Escape') {
      if (vim.mode === 'insert') closeChat();
      else closeCommand();
    }
    return;
  }
  vim.key(ev);
});

// Buttons in the chat and command windows (touch screens: no Esc/Enter keys).
for (const [btn, fn] of [
  ['chat-send', () => submitChat()],
  ['chat-cancel', () => closeChat()],
  ['cmd-run', () => submitCommand()],
  ['cmd-cancel', () => closeCommand()],
]) {
  const el = $(btn);
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  });
  el.addEventListener('click', (e) => e.preventDefault());
}

// Phone keyboards send "Go"/"Send" as a form submission, not always as an
// Enter keydown.
$('cmdform').addEventListener('submit', (e) => {
  e.preventDefault();
  if (vim.mode === 'command') submitCommand();
});
$('chatform').addEventListener('submit', (e) => {
  e.preventDefault();
  if (vim.mode === 'insert') submitChat();
});

// The × of each window works as Esc there.
const CLOSERS = {
  cmdwin: () => closeCommand(),
  chatwin: () => closeChat(),
  msgwin: () => closeMsg(),
  inventory: () => vim.setMode('normal'),
  mapwin: () => vim.setMode('normal'),
};
for (const [id, fn] of Object.entries(CLOSERS)) {
  const x = document.querySelector(`#${id} .titlebar .x`);
  if (!x) continue;
  x.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  });
}

// ?debug: expose the state for automated browser tests (nothing else changes).
if (new URLSearchParams(location.search).has('debug')) window.vimfps = { game, settings, onMessage: (m) => onMessage(m) };

async function boot() {
  showTitle();
  try {
    // Static hosting (GitHub Pages, file://) has no host to join.
    if (location.protocol === 'file:' || location.hostname.endsWith('github.io')) throw new Error('static');
    const res = await fetch('server-info.json', { cache: 'no-store' });
    if (res.ok) {
      const info = await res.json();
      if (info && info.protocol) serverInfo = info;
    }
  } catch {
    // Not served by a host (GitHub Pages, file://): practice / :connect.
  }
  buildMenu();
  requestAnimationFrame(frame);
}

boot();
