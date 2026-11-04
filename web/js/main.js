// vim-fps browser client: title menu, connection, input, prediction, HUD.

import { Settings, OPTIONS, SMOOTH_GROUP } from './settings.js';
import { Vim, Aim, MODES } from './vim.js';
import { WsConnection, LocalConnection, parseServerUrl, PROTOCOL } from './net.js';
import { World, wantVelocity, eyeHeight, GUNS, ACCEL, RUN_SPEED, SNEAK_SPEED, wrapAngle } from './world.js';
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
  myStep: 0,
  bob: 0,
  kick: 0,
  leaving: false,
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
  });
  game.roster = new Map();
  game.steps = new Map();
  game.held = { fwd: false, back: false, left: false, right: false };
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
  msgReturn = vim.mode === 'command' ? cmdReturn : vim.mode;
  if (msgReturn === 'msg') msgReturn = game.map ? 'normal' : 'menu';
  vim.setMode('msg');
}
let msgReturn = 'menu';

function closeMsg() {
  show('msgwin', false);
  vim.setMode(msgReturn || (game.map ? 'normal' : 'menu'));
}

const HELP = [
  'vim-fps — マウス禁止。モードごとにキーの意味が変わります (同時には使えません)',
  '',
  'NORMAL (移動)                         VIEW (v: 構えて視点移動)',
  '  h j k l   左 前 後 右 (前は :set forward)   h j k l   視点 (カーソルと同じ向き)',
  '  Shift     押している間スニーク          H J K L   速く回す (:set fastlook)',
  '  {n}k      n メートル歩く               {n}l      n 目盛り回す (:set step)',
  '  << >>     左右に 45° 旋回 ({n}<< 可)     v         スコープ切り替え',
  '  ~         180° 振り返る                 f         撃つ',
  '  f         撃つ / 選んだアイテムを使う     {n}dd     狙って投げる',
  '  {n}dd     グレネード (n=1〜5 で強さ)      r         リロード',
  '  r         リロード                       Esc       NORMAL へ',
  '  y         足元の銃を拾う (最大 2 丁)',
  '  gt        銃を持ち替え                  INVENTORY (s)',
  '  s         インベントリ                     j / k     選ぶ (gg 先頭, G 末尾, 数字)',
  '  m         マップ                           Enter/Esc 閉じる → f で使う',
  '  i         チャット (全員に届きます)',
  '  :         コマンド                      Esc の代わりに Ctrl-[ も使えます',
  '',
  'コマンド',
  '  :set                 変更した設定     :set all       すべての設定',
  '  :set sens=120        視点の初速        :set accel=inf 加速なし (即最高速)',
  '  :set nosmooth        アニメーション・補間・加速をすべてオフ (瞬時に切り替わる)',
  '  :set noadsanim       ADS だけ瞬時     :set nomoveaccel 移動の加速度を無限大に',
  '  :set forward=j       j を前進に       :set invert    視点の上下反転',
  '  :set name=名前       名前             :set {opt}&     初期値に戻す',
  '  :ls                  スコア           :bots 5        bot の数 (練習のみ)',
  '  :connect URL         サーバーに接続    :practice      練習',
  '  :fs                  フルスクリーン   :q             タイトルへ',
  '',
  '設定の一覧と説明は :options',
];

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
    lines.push(`${me}${String(i + 1).padStart(2)}  ${r.name.padEnd(16)}  ${String(r.kills).padStart(4)}  ${String(r.deaths).padStart(4)}${r.bot ? '  bot' : ''}`);
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
    const line = input.value.trim();
    closeCommand();
    if (line) {
      history.push(line);
      runCommand(line);
    }
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

function closeChat() {
  show('chatwin', false);
  $('chatinput').blur();
  if (vim.mode === 'insert') vim.setMode('normal');
}

$('chatinput').addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    const text = e.target.value.trim();
    if (text && game.conn) game.conn.send({ t: 'chat', text });
    closeChat();
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
    menu.items.push({
      label: 'このサーバーに参加',
      sub: `${serverInfo.name} · v${serverInfo.version}${serverInfo.password ? ' · 合言葉あり' : ''}`,
      run: () => connect(''),
    });
  }
  menu.items.push({ label: '練習する', sub: 'オフライン · bot 5 体', run: () => startPractice(5) });
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
  for (const id of ['inventory', 'mapwin', 'chatwin', 'deathwin', 'resultwin', 'progress']) show(id, false);
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

function joinMsg(password) {
  return { t: 'join', name: settings.get('name') || '', password: password || null, protocol: PROTOCOL };
}

function connect(input) {
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
  conn.onopen = () => conn.send(joinMsg(pw ? decodeURIComponent(pw) : null));
}

async function startPractice(bots) {
  balloon('練習モードを準備中…');
  try {
    const conn = await LocalConnection.create(Math.floor(Math.random() * 100000), Number.isFinite(bots) ? bots : 5);
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
  balloon(game.practice ? '練習モード' : `${serverInfo ? serverInfo.name : 'サーバー'} に参加しました`, `${Math.round(m.time_limit / 60)} 分 · ${m.frag_limit} キル先取 · :help で操作説明`);
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
      if (renderer) renderer.tracer(m.from, m.to, mine);
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
      }
      if (m.victim === game.myId) {
        damageArc(m.from);
        sound.hurt();
      }
      break;
    case 'kill': {
      const how = m.cause === 'grenade' ? 'グレネード' : gunName(m.cause.gun);
      const self = m.killer === m.victim;
      balloon(self ? `${nameOf(m.victim)} は自爆しました` : `${nameOf(m.killer)} ▶ ${nameOf(m.victim)}`, `${how}${m.head ? ' · ヘッドショット' : ''}`, 'kill');
      if (m.victim === game.myId) {
        game.alive = false;
        $('death-text').textContent = self
          ? 'E492: Not an editor command: alive — 自分のグレネードで倒れました'
          : `E492: Not an editor command: alive — ${nameOf(m.killer)} に倒されました (${how}${m.head ? '、ヘッドショット' : ''})`;
        show('deathwin');
        if (vim.mode === 'view' || vim.mode === 'inventory' || vim.mode === 'map') vim.setMode('normal');
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
      show('deathwin', false);
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
  show('deathwin', false);
}

function onSnap(m) {
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
      show('deathwin', false);
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

function zoomFactor() {
  return game.zoom === 2 ? settings.get('zoomsens') : 1;
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
  zoom() {
    game.zoom = game.zoom === 2 ? 1 : 2;
  },
  invSelect,
  insert: openChat,
  command: () => openCommand(''),
  closeMsg,
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
      e.preventDefault();
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
  if (game.conn && game.map && renderer) {
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
    const scoped = game.ads && game.zoom === 2 && gun && gun.gun === 'sr';
    show('scope', scoped);
    const bobOn = settings.get('bob');
    if (bobOn) game.kick = Math.max(0, game.kick - dt * 0.6);
    else game.kick = 0;
    const bobY = bobOn && !game.ads ? Math.sin(game.bob) * 0.012 : 0;

    // Others.
    const view = interpolated(now);
    for (const [id, p] of view) {
      if (id === game.myId) continue;
      renderer.setPlayer(id, p, nameOf(id));
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

    pingTimer += dt;
    if (pingTimer > 2 && !game.practice) {
      pingTimer = 0;
      game.pingSeq += 1;
      game.pings.set(game.pingSeq, now);
      game.conn.send({ t: 'ping', id: game.pingSeq });
    }
    updateHud(dt);
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

function updateHud() {
  const me = game.me;
  if (!me) return;
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
  setText($('clock'), game.intermission != null ? `次 ${fmtTime(game.intermission)}` : fmtTime(game.left));
  if (game.intermission != null) setText($('result-next'), `${Math.ceil(game.intermission)} 秒後に次の試合`);

  // Reload / heal progress.
  const prog = me.reload >= 0 ? ['リロード', me.reload] : me.heal >= 0 ? ['回復中', me.heal] : null;
  show('progress', !!prog && game.alive);
  if (prog) {
    setText($('progress-title'), prog[0]);
    $('progress-fill').style.width = `${Math.round(prog[1] * 100)}%`;
  }
  if (!game.alive && me.respawn > 0) setText($('death-timer'), `${Math.ceil(me.respawn)} 秒後に復活します`);

  // Rank (top right).
  const rows = [...game.roster.values()];
  const idx = rows.findIndex((x) => x.id === game.myId);
  const top = rows[0];
  setText($('rank'), idx >= 0 ? `${idx + 1} 位 / ${rows.length} 人${top ? ` · 1 位 ${top.name} ${top.kills}` : ''}` : '');
}

// ---------------------------------------------------------------- boot

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
