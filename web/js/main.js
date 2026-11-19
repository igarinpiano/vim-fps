// vim-fps browser client: title menu, connection, input, prediction, HUD.

import { Settings, OPTIONS, SMOOTH_GROUP } from './settings.js';
import { Vim, Aim, MODES } from './vim.js';
import { WsConnection, LocalConnection, parseServerUrl, PROTOCOL } from './net.js';
import { World, wantVelocity, eyeHeight, GUNS, ACCEL, RUN_SPEED, SNEAK_SPEED, wrapAngle, bearing, TANK, pushOutOfTanks } from './world.js';
import { TouchPad } from './touch.js';
import { Director } from './director.js';
import { Sound, EVENT_SOUNDS } from './audio.js';
import { TEXTURE_SLOTS, MAX_TEXTURE_BYTES, TextureStore, slotOf, parseSize, loadImage, fetchPack } from './textures.js';
import { Profile } from './profile.js';
import { parseRc, applyRc, buildRc, customCommand, tokenize, isRcName, CUSTOM_DEFAULTS, RC_NAME, DOC_URL } from './rc.js';
import { SkinStore, skinLayer, skinName, readBundle, readZip, writeZip, filesFromDrop, UI_VARS } from './skin.js';
import { VERSION } from './version.js';
import { halfWidth } from './lens.js';
import { EQ_PRESETS, EQ_TYPE_NAMES, parseEq, formatEq, eqGraph, apoToEq, looksLikeApo } from './eq.js';

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
// Everything kept between visits (one localStorage key); its text form is
// .vimfpsrc (:mkvimrc / :source).
const profile = new Profile(storage);
const settings = new Settings(profile.section('set'));
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
  // Waiting for the host's admin to start the match, and the countdown
  // once they have.
  lobby: false,
  countdown: null,
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
  // The automatic camera (director.js) is on, and its director.
  auto: false,
  director: null,
  bsodPending: false,
  range: false,
  respawnMode: true,
  // Tanks on the field (latest snapshot), the one you drive (its id) and
  // where it is drawn (smoothed between snapshots).
  tanks: [],
  myTank: null,
  tankView: null,
  // The ring: {x, z, r, nx, nz, nr, t, shrinking, dps, stage} or null.
  ring: null,
};

function resetGame() {
  Object.assign(game, {
    conn: null,
    practice: false,
    offlineName: null,
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
    lobby: false,
    countdown: null,
    lastInput: '',
    watching: false,
    follow: null,
    free: null,
    auto: false,
    director: null,
    bsodPending: false,
    range: false,
    respawnMode: true,
    sky: null,
    tanks: [],
    myTank: null,
    tankView: null,
    ring: null,
  });
  tankSteps.clear();
  for (const id of ['ringwarn', 'prompt']) show(id, false);
  showPip(null);
  game.roster = new Map();
  game.steps = new Map();
  netStats.rtts = [];
  netStats.snaps = [];
  netStats.last = null;
  game.held = { fwd: false, back: false, left: false, right: false, up: false, down: false, tiltUp: false, tiltDown: false };
}

// Distance each tank has rolled since its last engine sound (by id).
const tankSteps = new Map();

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
  // The screen it opened over (the title menu, the custom match form)
  // goes away until it closes: two windows at once would overlap.
  showBase(null);
  vim.setMode('msg');
}
let msgReturn = 'menu';

function closeMsg() {
  show('msgwin', false);
  const back = msgReturn || (game.map ? 'normal' : 'menu');
  showBase(back);
  vim.setMode(back);
  syncMode();
}

/// The window that belongs to a mode, back on screen (and only that one):
/// the title menu for MENU, the custom match form for FORM. null: neither
/// (a message or the game covers the screen). Whatever covered it (a
/// message, the command line) puts it back through here, so leaving one
/// never leaves an empty screen.
function showBase(mode) {
  show('title', mode === 'menu');
  show('customwin', mode === 'form');
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
  '  y         足元の銃を拾う (最大 2 丁)         長押しの加速はスコープ (v 2 回目) だけ。1 段階目は等速 (:set adssens)',
  '  e         戦車に乗る / 降りる (近くで)',
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
  '戦車: 近くで e で乗り込む。k / j 前進・後退、h / l 車体を旋回 (砲塔も一緒に回る)、v で砲を構えて hjkl で狙う (構え中は走れない)、',
  '      f で砲撃 (装填 3 秒、着弾で爆発)、e で降りる。銃弾はほとんど効かない (15%)。グレネードと砲弾が有効。壊されると中の人も倒れる。',
  'リング: オレンジ色の壁の外にいると体力が減ります (段階が進むほど速く)。マップ (m) に今の円 (赤) と次の円 (白) が出ます。',
  '',
  'コマンド',
  '  :spec                武器・移動などの数値 (弾速・ダメージ・連射速度…)',
  '  :set                 変更した設定     :set all       すべての設定',
  '  :set adssens=30      構えの長押し速度  :set sens=8    スコープの長押しの初速',
  '  :set accel=inf       加速の後は即最高速',
  '  :set step=0.1        1 目盛りの角度    :set accelafter=800 ゆっくりの時間を長く',
  '  :set zoomsens=0.5    構え・スコープ中をさらに細かく (ズーム率に比例した上に掛かる)',
  '  :set nosmooth        アニメーション・補間・加速をすべてオフ (瞬時に切り替わる)',
  '  :set noadsanim       ADS だけ瞬時     :set nomoveaccel 移動の加速度を無限大に',
  '  :set forward=j       j を前進に       :set invert    視点の上下反転',
  '  :set touch=on        タッチパッド     :set nocompass  コンパスを消す',
  '  :set name=名前       名前             :set {opt}&     初期値に戻す',
  '  :ls                  スコア           :bots 5        bot の数 (練習のみ)',
  '  :connect URL         サーバーに接続    :practice      練習',
  '  :join                このページのサーバーに参加 (練習中に試合が始まると自動で参加: :set noautojoin で切る)',
  '  :fs                  フルスクリーン   :q             タイトルへ',
  '  :watch               観戦に回る       :play          観戦から試合へ',
  '  :follow 名前         その人を観戦     :range         射撃訓練場',
  '  :custom              カスタムマッチ   :botskill 1〜5 bot の強さ (練習のみ)',
  '  :net                 通信統計 (ping など)  :set netstat  常に右上に表示',
  '  :set nonameplates    頭上の名前を消す :set nohpbars  頭上の体力ゲージを消す',
  '  :texture             自分の画像を地面・壁などに貼る (:texture だけで使い方と一覧)',
  '  :sounds              起動音・エラー音・終了音のファイルの状態',
  '  :speakers            サラウンド (5.1 / 7.1 など) の設定とスピーカーのテスト (:speakers test)',
  '  :set nospatial       空間オーディオ (遠くの音・壁の向こうの音がこもる、建物の響き) を切る  :set reverb=50 響きを半分に',
  '  :eq                  イコライザー (低音を強くするなど。:eq bass  :eq steps  :eq off  :eq load でファイル)',
  '  :skin                スキン (テクスチャ・効果音・UI の色をまとめたもの)',
  '  :mkvimrc             設定を .vimfpsrc に書き出す  :source  .vimfpsrc を読み込む (:help config)',
  '',
  'SPECTATE (観戦中)      a  自動カメラ (3D の中継視点。選手を自動で切り替え。もう一度押すと選手の視点)  :auto でも',
  '                       n / N  次 / 前の選手    o  自由視点 (k/j 前後, h/l 旋回, K/J 上下, u/d 見上げる・見下ろす, Shift で速く)',
  '                       O  空から (hjkl 移動, K/J 高さ, u/d 見下ろす角度, , . 回転)    m  全員が載ったマップ',
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
  if (sp.tank_hp) {
    L.push('');
    L.push(`戦車: HP ${sp.tank_hp} · 前進 ${sp.tank_speed} m/s / 後退 ${sp.tank_reverse} m/s · 旋回 ${sp.tank_turn}°/秒 · 壊されて ${sp.tank_respawn} 秒後に元の場所へ戻る`);
    L.push(`  砲弾: 初速 ${sp.shell_speed} m/s (重力で落ちる) · 装填 ${sp.shell_reload} 秒 · 爆発半径 ${sp.shell_radius} m、最大 ${sp.shell_damage} ダメージ (直撃は即死)`);
    L.push(`  装甲: 銃弾は ${Math.round(sp.tank_bullet_factor * 100)}% だけ通る · グレネードと砲弾の爆発はそのまま · 中の人は無傷 (壊されると一緒に倒れる) · 走っている戦車にひかれると即死`);
  }
  if (sp.ring_radii && sp.ring_radii.length) {
    L.push('');
    L.push(`リング: 半径 ${sp.ring_radii.join(' → ')} m と ${sp.ring_radii.length} 段階で縮む (待ち時間と縮む時間は試合時間の 8%、10〜60 秒)`);
    L.push(`  外にいる間のダメージ: 毎秒 ${sp.ring_dps.join(' → ')} (段階ごと)。戦車の中でも受ける`);
  }
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
    // Typing a command closes the message: back to what it covered (a
    // command that opens a new message covers that again).
    show('msgwin', false);
    cmdReturn = msgReturn;
    showBase(cmdReturn);
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
  syncMode();
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
      if (/^(config|rc|vimfpsrc|\.vimfpsrc|skin|skins|mkvimrc|source)$/.test(args.trim())) showMsg(':help config', CONFIG_HELP);
      else showMsg(':help', HELP);
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
    case 'net':
    case 'netstat':
      showMsg(':net — 通信統計', netLines(performance.now()));
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
        game.sky = null;
        game.follow = r.id;
        if (game.auto) director().force(r.id);
      } else balloon(`E: ${game.watching ? '見つかりません' : '観戦中だけ使えます'}: ${args}`, '', 'err');
      break;
    }
    case 'auto':
      if (game.watching) setAuto(!game.auto);
      else balloon('E: 観戦中だけ使えます: auto', '', 'err');
      break;
    case 'range':
      startPractice(0, { range: true });
      break;
    case 'practice':
      startPractice(args ? parseInt(args, 10) : 5);
      break;
    case 'join':
      if (!serverInfo) balloon('E: このページはサーバーから開かれていません', ':connect URL で接続', 'err');
      else connect('');
      break;
    case 'bots':
      if (game.practice && game.conn) game.conn.send({ t: 'bots', n: Math.max(0, Math.min(15, parseInt(args, 10) || 0)) });
      else balloon('E: :bots は練習モードだけで使えます', '', 'err');
      break;
    case 'botskill':
    case 'skill':
      if (game.practice && game.conn) game.conn.send({ t: 'bot_skill', level: Math.max(1, Math.min(5, parseInt(args, 10) || 3)) });
      else balloon('E: :botskill は練習モードだけで使えます', '', 'err');
      break;
    case 'custom':
      if (args.trim()) {
        const e = customCommand(tokenize(args), custom);
        if (e) balloon(e, '', 'err');
        else {
          saveCustom();
          balloon('カスタムマッチの設定を変えました', args.trim());
        }
      } else openCustom();
      break;
    case 'so':
    case 'source':
      sourceCommand(args.trim());
      break;
    case 'mkv':
    case 'mkvimrc':
      mkvimrc(false);
      break;
    case 'mkv!':
    case 'mkvimrc!':
      mkvimrc(true);
      break;
    case 'skin':
    case 'skins':
      skinCommand(args.trim());
      break;
    case 'host':
      showMsg(':host — vimfps host の設定', hostLines());
      break;
    case 'tex':
    case 'texture':
    case 'textures':
      textureCommand(args.trim());
      break;
    case 'sound':
    case 'sounds':
      showSounds();
      break;
    case 'eq':
      eqCommand(args.trim());
      break;
    case 'speaker':
    case 'speakers':
    case 'spk':
      speakersCommand(args.trim());
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

// ---------------------------------------------------------------- skins, textures and sounds (your own assets)
//
// The look and sound come from a stack of skins (skin.js), each over the one
// before: the one served with the game (web/assets/skin.json), the host's
// (`vimfps host --skin`), yours (`:skin`), then single textures (`:texture`).

const texStore = new TextureStore(window.indexedDB);
const skinStore = new SkinStore(window.indexedDB);
const siteBase = new URL('../assets/', import.meta.url);
// slot -> { image, size, from, name }: what is on the world now.
const texState = new Map();
// slot -> { blob, size, name }: `:texture` (kept in this browser).
const texOverrides = new Map();
// The layers: null when there is none.
const skins = { site: null, host: null, mine: null };
// Your skins when this browser cannot keep them (no IndexedDB): name -> record.
const sessionSkins = new Map();
const imageCache = new Map();
let lookGen = 0;
let uiApplied = [];
const FROM = { site: '同梱', host: 'ホスト', mine: 'スキン', browser: ':texture' };

function cachedImage(src) {
  if (!imageCache.has(src)) {
    imageCache.set(
      src,
      loadImage(src).catch((e) => {
        imageCache.delete(src);
        throw e;
      }),
    );
  }
  return imageCache.get(src);
}

/// Everything in texState onto the world (once there is a renderer).
function applyTextures() {
  if (!renderer) return;
  for (const slot of Object.keys(TEXTURE_SLOTS)) {
    const t = texState.get(slot);
    const have = renderer.textures.get(slot);
    const size = t ? t.size : null;
    if ((t ? t.image : null) === (have ? have.tex.image : null) && (!t || have.size === size)) continue;
    renderer.setTexture(slot, t ? t.image : null, size);
  }
}

/// The layers merged, item by item: { textures, sounds, ui } with `from`
/// (site / host / mine) on each.
function mergedSkin() {
  const out = { textures: {}, sounds: {}, ui: {}, from: { sounds: {}, ui: {} } };
  for (const key of ['site', 'host', 'mine']) {
    const layer = skins[key];
    if (!layer) continue;
    for (const [slot, t] of Object.entries(layer.textures)) out.textures[slot] = { ...t, from: key };
    for (const [ev, src] of Object.entries(layer.sounds)) {
      out.sounds[ev] = src;
      out.from.sounds[ev] = key;
    }
    for (const [k, v] of Object.entries(layer.ui)) {
      out.ui[k] = v;
      out.from.ui[k] = key;
    }
  }
  return out;
}

function applyUi(ui) {
  const st = document.documentElement.style;
  for (const k of uiApplied) st.removeProperty(`--${k}`);
  uiApplied = Object.keys(ui);
  for (const k of uiApplied) st.setProperty(`--${k}`, ui[k]);
}

/// Puts the stack on screen and in the speakers (after any layer changed).
async function refreshLook() {
  const gen = ++lookGen;
  const m = mergedSkin();
  applyUi(m.ui);
  sound.setSources(m.sounds);
  const next = new Map();
  for (const slot of Object.keys(TEXTURE_SLOTS)) {
    const o = texOverrides.get(slot);
    const t = o ? { src: o.blob, size: o.size, name: o.name, from: 'browser' } : m.textures[slot];
    if (!t) continue;
    try {
      next.set(slot, { image: await cachedImage(t.src), size: t.size || TEXTURE_SLOTS[slot].size, from: t.from, name: t.name || '' });
    } catch {
      console.warn(`texture ${slot}: ${t.name || t.src} could not be loaded`);
    }
  }
  if (gen !== lookGen) return;
  texState.clear();
  for (const [k, v] of next) texState.set(k, v);
  applyTextures();
}

/// The skin served with the game: assets/skin.json, or (before skins)
/// assets/textures/pack.json and assets/sounds/<event>.wav.
async function loadSiteSkin() {
  try {
    const res = await fetch(new URL('skin.json', siteBase), { cache: 'no-cache' });
    if (res.ok && !(res.headers.get('content-type') || '').startsWith('text/html')) {
      return skinLayer(await res.json(), (p) => new URL(p, siteBase).href, 'site');
    }
  } catch {
    // No skin.json: the old layout.
  }
  const layer = { name: '(同梱)', textures: {}, sounds: {}, ui: {}, warnings: [] };
  for (const e of await fetchPack(new URL('textures/', siteBase))) layer.textures[e.slot] = { src: e.url, size: e.size, name: e.url.split('/').pop() };
  for (const ev of Object.keys(EVENT_SOUNDS)) layer.sounds[ev] = ['wav', 'mp3', 'ogg'].map((x) => new URL(`sounds/${ev}.${x}`, siteBase).href);
  return layer;
}

/// The host's skin (`vimfps host --skin DIR`, served at skin/).
async function loadHostSkin() {
  if (!serverInfo || !serverInfo.skin) return null;
  const base = new URL('skin/', window.location.href);
  try {
    const res = await fetch(new URL('skin.json', base), { cache: 'no-store' });
    if (!res.ok) return null;
    return skinLayer(await res.json(), (p) => new URL(p, base).href, String(serverInfo.skin));
  } catch {
    return null;
  }
}

async function getSkinRecord(name) {
  if (sessionSkins.has(name)) return sessionSkins.get(name);
  try {
    return (await skinStore.get(name)) || null;
  } catch {
    return null;
  }
}

async function listSkinRecords() {
  let stored = [];
  try {
    stored = await skinStore.list();
  } catch {
    // No storage.
  }
  const names = new Set(stored.map((r) => r.name));
  return [...stored, ...[...sessionSkins.values()].filter((r) => !names.has(r.name))].sort((a, b) => a.name.localeCompare(b.name));
}

function recordLayer(rec) {
  return skinLayer(rec.manifest, (p) => (rec.files && rec.files[p]) || null, rec.name);
}

/// Your skin: the one named in the profile. Returns an error message
/// when it is named but not in this browser.
async function loadMySkin() {
  const name = profile.get('skin');
  if (!name) {
    skins.mine = null;
    return null;
  }
  const rec = await getSkinRecord(name);
  skins.mine = rec ? recordLayer(rec) : null;
  return rec ? null : `スキン "${name}" はこのブラウザーに入っていません (zip やフォルダーをドロップするか :skin load)`;
}

/// At start-up (after server-info.json): every layer, then :texture.
async function loadLook() {
  const [site, host] = await Promise.all([loadSiteSkin(), loadHostSkin()]);
  skins.site = site;
  skins.host = host;
  const missing = await loadMySkin();
  if (missing) console.warn(missing);
  try {
    for (const [slot, rec] of await texStore.all()) texOverrides.set(slot, rec);
  } catch {
    // No storage (private mode).
  }
  await refreshLook();
}

async function useSkin(name) {
  if (!name || name === 'off' || name === 'none') {
    profile.put('skin', null);
    skins.mine = null;
    await refreshLook();
    return balloon('スキンを外しました', skins.host ? 'ホストのスキンと同梱の素材だけになります' : '同梱の素材だけになります');
  }
  const rec = await getSkinRecord(name);
  if (!rec) return balloon(`E: スキン "${name}" はこのブラウザーにありません`, ':skin で一覧', 'err');
  profile.put('skin', rec.name);
  skins.mine = recordLayer(rec);
  await refreshLook();
  return balloon(`スキン: ${rec.name}`, skinSummary(rec.manifest));
}

function skinSummary(manifest) {
  const n = (o) => Object.keys((manifest && manifest[o]) || {}).length;
  return [`テクスチャ ${n('textures')}`, `効果音 ${n('sounds')}`, `UI ${n('ui')}`].join(' · ');
}

/// A dropped folder or zip (Map: path → Blob): its skin goes into this
/// browser and is put on; its .vimfpsrc is read (after the skin).
async function importBundle(files, fallbackName) {
  let b;
  try {
    b = await readBundle(files, skinName(fallbackName));
  } catch (e) {
    return balloon('読み込めません', String(e.message || e), 'err');
  }
  if (!b.skin && b.rc == null) {
    return balloon('スキンも .vimfpsrc も見つかりません', 'skin.json のあるフォルダー (zip)、または ground.png / startup.wav のような名前のファイルを入れてください', 'err');
  }
  if (b.skin) {
    const rec = { name: b.skin.name, manifest: b.skin.manifest, files: b.skin.files };
    let note = '';
    try {
      await skinStore.put(rec);
      sessionSkins.delete(rec.name);
    } catch {
      sessionSkins.set(rec.name, rec);
      note = ' (このブラウザーには保存できません: このページを閉じるまで)';
    }
    profile.put('skin', rec.name);
    skins.mine = recordLayer(rec);
    balloon(`スキンを入れました: ${rec.name}${note}`, [skinSummary(rec.manifest), ...b.skin.warnings].join(' · '), b.skin.warnings.length ? 'err' : '');
  }
  if (b.rc != null) sourceText(b.rc, RC_NAME);
  await refreshLook();
  return undefined;
}

/// Files picked or dropped (not a folder). `loose`: what to do with plain
/// images: 'textures' (`:texture`, by file name) or 'skin' (a new skin).
async function importFiles(files, loose) {
  if (files.length === 1 && /\.zip$/i.test(files[0].name)) {
    try {
      return importBundle(await readZip(await files[0].arrayBuffer()), files[0].name.replace(/\.zip$/i, ''));
    } catch (e) {
      return balloon('zip を読めません', String(e.message || e), 'err');
    }
  }
  if (files.length === 1 && (isRcName(files[0].name) || (files[0].type || '').startsWith('text/'))) {
    const text = await files[0].text();
    if (!isRcName(files[0].name) && looksLikeApo(text)) return importEq(text, files[0].name);
    return sourceText(text, files[0].name);
  }
  if (loose === 'skin' || files.some((f) => f.name.toLowerCase() === 'skin.json' || isRcName(f.name))) {
    return importBundle(new Map(files.map((f) => [f.name, f])), 'my-skin');
  }
  return addTexturesByName(files);
}

/// Takes image files for slots: [[slot, File]]. Kept in this browser
/// (`:texture`), over every skin.
async function addTextures(pairs) {
  const done = [];
  const failed = [];
  for (const [slot, file] of pairs) {
    try {
      if (file.size > MAX_TEXTURE_BYTES) throw new Error(`大きすぎます (${Math.round(file.size / 1048576)} MB、上限 ${MAX_TEXTURE_BYTES / 1048576} MB)`);
      await cachedImage(file);
      const size = (texState.get(slot) && texState.get(slot).size) || TEXTURE_SLOTS[slot].size;
      const rec = { blob: file, size, name: file.name || '' };
      texOverrides.set(slot, rec);
      done.push(`${slot} ← ${file.name || '画像'}`);
      try {
        await texStore.put(slot, rec);
      } catch (e) {
        failed.push(`${slot}: 保存できません (このページを閉じるまでは使えます): ${e.message || e}`);
      }
    } catch (e) {
      failed.push(`${file.name || slot}: ${e.message || e}`);
    }
  }
  await refreshLook();
  if (done.length) balloon('テクスチャを貼りました', done.join(' · '));
  if (failed.length) balloon('テクスチャを読めません', failed.join(' · '), 'err');
}

/// Files dropped or picked without naming a slot: matched by file name
/// (ground.png, wall-brick.jpg ...).
function addTexturesByName(files) {
  const pairs = [];
  const unknown = [];
  for (const f of files) {
    const slot = slotOf(f.name);
    if (slot) pairs.push([slot, f]);
    else unknown.push(f.name);
  }
  if (unknown.length) balloon('どこに貼る画像か分かりません', `${unknown.join(', ')} — ファイル名を ${Object.keys(TEXTURE_SLOTS).join(' / ')} で始めてください`, 'err');
  if (pairs.length) addTextures(pairs);
}

/// Opens the system's file chooser (the one place a pointer is needed).
function pickFiles(multiple, onFiles, accept = 'image/*') {
  const input = document.createElement('input');
  input.type = 'file';
  if (accept) input.accept = accept;
  input.multiple = multiple;
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const files = [...(input.files || [])];
    input.remove();
    if (files.length) onFiles(files);
  });
  document.body.appendChild(input);
  input.click();
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

function textureLines() {
  const L = ['自分の画像を、地形はそのままに面へ貼ります (このブラウザーに保存され、どのスキンよりも優先されます)。', ''];
  for (const [slot, o] of Object.entries(TEXTURE_SLOTS)) {
    const t = texState.get(slot);
    const state = !t ? '—' : `${FROM[t.from] || t.from}: ${t.name || '画像'} (${t.image.naturalWidth}×${t.image.naturalHeight}${o.size ? `、1 枚 ${t.size} m` : ''})`;
    L.push(`  ${slot.padEnd(7)} ${o.label.padEnd(12)} ${state}`);
  }
  L.push('');
  L.push('  :texture ground            画像ファイルを選んで地面に貼る (ground の所は上の名前)');
  L.push('  :texture load              複数のファイルをまとめて選ぶ (ファイル名の先頭で貼る場所を決める: ground.png, wall-brick.jpg …)');
  L.push('  :texture ground URL        URL の画像を貼る (その画像が他サイトからの読み込みを許可している場合)');
  L.push('  :texture ground size 12    1 枚の画像が覆う大きさ (メートル)。小さいほど細かく繰り返す');
  L.push('  :texture ground none       :texture で貼った画像を外す (スキンの画像か元の色に戻る)   :texture reset   すべて外す');
  L.push('  画像ファイルをこのページへドラッグ & ドロップしても貼れます (ファイル名で場所を決めます)。');
  L.push('');
  L.push('  テクスチャ・効果音・UI の色をまとめて配る・持ち運ぶにはスキンを使います (:skin、:help config)。');
  return L;
}

async function textureCommand(args) {
  const [a, b, c] = args.split(/\s+/);
  if (!a || a === 'list' || a === 'ls') return showMsg(':texture — テクスチャ', textureLines());
  if (a === 'load' || a === 'open') return pickFiles(true, addTexturesByName);
  if (a === 'reset' || a === 'clear') {
    texOverrides.clear();
    try {
      await texStore.clear();
    } catch {
      // Nothing stored.
    }
    await refreshLook();
    return balloon(':texture の画像をすべて外しました', 'スキンの画像か元の色に戻ります');
  }
  if (!TEXTURE_SLOTS[a]) return balloon(`E: 貼る場所が分かりません: ${a}`, Object.keys(TEXTURE_SLOTS).join(' / '), 'err');
  if (!b) return pickFiles(false, (files) => addTextures([[a, files[0]]]));
  if (b === 'none' || b === 'off' || b === '-') {
    texOverrides.delete(a);
    try {
      await texStore.remove(a);
    } catch {
      // Nothing stored.
    }
    await refreshLook();
    return balloon(`${a}: :texture の画像を外しました`);
  }
  if (b === 'size' || parseSize(b) != null) {
    const size = parseSize(b === 'size' ? c : b);
    const t = texState.get(a);
    if (size == null) return balloon('E: 大きさ (メートル) は 0.1〜500 で', '', 'err');
    if (!t) return balloon(`E: ${a} にはまだ画像がありません`, `:texture ${a} で選んでください`, 'err');
    t.size = size;
    const o = texOverrides.get(a);
    if (o) {
      o.size = size;
      try {
        await texStore.put(a, o);
      } catch {
        // Not stored: for this page only.
      }
    }
    applyTextures();
    return balloon(`${a}: 1 枚 ${size} m`, o ? '' : 'スキンの画像の大きさは、このページを閉じるまで (変え続けるならスキンの skin.json の size で)');
  }
  // A URL.
  try {
    const res = await fetch(new URL(b, window.location.href));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    await addTextures([[a, new File([blob], b.split(/[\\/?#]/).filter(Boolean).pop() || 'image', { type: blob.type })]]);
  } catch (e) {
    balloon('画像を取得できません', `${b}: ${e.message || e}`, 'err');
  }
  return undefined;
}

// Dropped on the page: a folder or zip → a skin (and its .vimfpsrc), a
// .vimfpsrc → read, images → textures by file name.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (!e.dataTransfer) return;
  try {
    const { files, folder } = await filesFromDrop(e.dataTransfer);
    if (folder) importBundle(files, folder);
    else if (files.size) importFiles([...files.values()], 'textures');
  } catch (err) {
    balloon('読み込めません', String(err.message || err), 'err');
  }
});

/// :eq — the equalizer. No argument: the curve as a graph, the presets and
/// how to write one. `:eq bass`, `:eq ls100:+6,hs8k:+2` set it (as `:set
/// eq=`); `:eq load` reads an Equalizer APO / AutoEq file.
function eqCommand(arg) {
  sound.wake();
  if (arg === 'load' || arg === 'file') {
    pickFiles(false, async (files) => importEq(await files[0].text(), files[0].name), '.txt,text/plain');
    return;
  }
  if (arg) {
    const r = settings.command([`eq=${arg.replace(/\s+/g, '')}`]);
    if (r.error) return balloon(r.error, '', 'err');
  }
  showEq();
  return undefined;
}

function showEq() {
  const v = settings.get('eq');
  let eq;
  try {
    eq = parseEq(v === 'off' ? '' : v);
  } catch {
    eq = { pre: 0, bands: [] };
  }
  const L = [`今の設定: eq=${v}`];
  if (eq.bands.length || eq.pre) {
    L.push(`  展開すると: ${formatEq(eq)}`);
    if (eq.pre) L.push(`  プリアンプ ${eq.pre > 0 ? '+' : ''}${eq.pre} dB`);
    for (const b of eq.bands) {
      const gain = b.type === 'lp' || b.type === 'hp' ? '' : `  ${b.gain > 0 ? '+' : ''}${b.gain} dB`;
      L.push(`  ${EQ_TYPE_NAMES[b.type].padEnd(7, '　')} ${String(b.freq).padStart(6)} Hz${gain}  Q ${b.q}`);
    }
  }
  L.push('');
  L.push(...eqGraph(eq));
  L.push('');
  L.push('プリセット (:eq 名前 / :set eq=名前):');
  for (const [k, p] of Object.entries(EQ_PRESETS)) L.push(`  ${k.padEnd(10)} ${p.desc}${p.curve ? `  (${p.curve})` : ''}`);
  L.push('');
  L.push('自分で書く: 種類 周波数 : ゲイン(dB) : Q を , で並べます (Q は省略可)');
  L.push('  pk = ピーク (省略時)  ls = ローシェルフ  hs = ハイシェルフ  lp / hp = ローパス / ハイパス (ゲインなし)  pre±N = プリアンプ');
  L.push('  :eq ls100:+6,pk3k:+3:1.4      100 Hz 以下を +6 dB、3 kHz を +3 dB (Q 1.4)');
  L.push('  :eq bass,hs8k:+2,pre-2        プリセットに足す');
  L.push('  :eq load                      Equalizer APO / AutoEq のファイル (ParametricEQ.txt) を読み込む (ページにドロップでも)');
  L.push('  :eq off                       EQ なし');
  L.push('');
  L.push(':mkvimrc で .vimfpsrc に set eq=… として書き出され、:source で読み込めます。音割れ防止のリミッターが掛かります。');
  showMsg(':eq — イコライザー', L);
}

/// :speakers — how the sound goes out (headphones or N speakers), the
/// channels in order, and `:speakers test` (noise on each in turn).
/// `:speakers 5.1` sets it (as `:set speakers=`).
function speakersCommand(arg) {
  sound.wake();
  if (arg === 'test') {
    const info = sound.outputInfo();
    const total = sound.speakerTest((label, k, n) => balloon(`スピーカーのテスト ${k + 1} / ${n}`, label));
    if (total) balloon(`スピーカーのテスト (${info.mode})`, `${Math.round(total)} 秒。鳴っている場所と表示が合っているか確かめてください`);
    return undefined;
  }
  if (arg) {
    const r = settings.command([`speakers=${arg}`]);
    if (r.error) return balloon(r.error, '', 'err');
    if (!r.changed.length) sound.rebuild();
  } else {
    // The OS output may have changed since (stereo → 5.1): look again.
    sound.rebuild();
  }
  // After the sound has rebuilt (its listener runs after this one).
  setTimeout(showSpeakers, 0);
  return undefined;
}

function showSpeakers() {
  const info = sound.outputInfo();
  const L = [`設定: speakers=${info.setting}  →  今の出し方: ${info.mode}`];
  if (info.note) L.push(`  ${info.note}`);
  L.push(`  このブラウザーの出力: 最大 ${info.max} チャンネル`);
  L.push('');
  if (info.layout) {
    L.push('チャンネルの順番 (この順に音声機器へ送ります):');
    info.layout.forEach((sp, i) => L.push(`  ${String(i + 1).padStart(2)}. ${sp.name.padEnd(4)} ${sp.label}${sp.lfe ? '  (全部の音の低音を少し)' : `  ${sp.az}°`}`));
    L.push('');
    L.push('  銃声・足音などは、その方向の両隣のスピーカーから鳴ります (高さは使いません)。');
    L.push('  起動音・被弾音など方向のない音は左右のフロントから鳴ります。');
  } else {
    L.push('  ヘッドホン用の立体音響 (HRTF) で、左右・前後・上下を 2 チャンネルに収めて鳴らします。');
  }
  L.push('');
  L.push('切り替え (:speakers 名前 / :set speakers=名前):');
  L.push('  headphones  ヘッドホン (2 チャンネルの立体音響。初期値)');
  L.push('  stereo      スピーカー 2 本 (左右に振り分け。立体音響の加工なし)');
  L.push('  quad        スピーカー 4 本 (前 2・後ろ 2)');
  L.push('  5.1         5.1ch (L R C LFE SL SR)');
  L.push('  7.1         7.1ch (L R C LFE BL BR SL SR)');
  L.push('  auto        出力のチャンネル数で選ぶ (8 → 7.1、6 → 5.1、4 → quad、2 → headphones)');
  L.push('');
  L.push('  :speakers test   各スピーカーから順に音を出して確かめる');
  L.push('');
  L.push(`空間オーディオ: ${settings.get('spatial') ? `オン (響き ${settings.get('reverb')}%)` : 'オフ'}  — 壁の向こうや遠くの音がこもり、建物の中と外で響きが変わります (:set nospatial / :set reverb=50)`);
  L.push('  Windows Sonic / Dolby Atmos for Headphones をオンにすると出力が 7.1 に見えることが多く、:speakers auto で OS の立体音響を使えます。');
  L.push('');
  L.push('5.1 / 7.1 で鳴らすには、OS の音声出力を 5.1 / 7.1 にしてください (Windows: サウンドの設定 → スピーカーの構成)。');
  L.push('出力が 2 チャンネルのままだと、ブラウザーは 2 チャンネルしか出せません (上の「最大」の数)。');
  showMsg(':speakers — サラウンド', L);
}

/// An Equalizer APO / AutoEq file → `:set eq=`.
function importEq(text, label) {
  let r;
  try {
    r = apoToEq(text);
  } catch (e) {
    return balloon(`${label}: EQ として読めません`, String(e.message || e), 'err');
  }
  const res = settings.command([`eq=${r.value}`]);
  if (res.error) return balloon(`${label}: EQ として読めません`, res.error, 'err');
  balloon(`EQ を読み込みました: ${label}`, [`eq=${r.value}`, ...r.warnings].join(' · '), r.warnings.length ? 'err' : '');
  return undefined;
}

/// :sounds — the event sounds, where each comes from and whether it loaded.
function showSounds() {
  sound.wake();
  const st = sound.sampleStatus();
  const m = mergedSkin();
  const word = { file: '再生できます', none: 'ファイルなし (無音)', '?': '確認中 (キーを押してからもう一度)' };
  const L = ['次の場面で、スキンの "sounds" に書いた音声ファイルを鳴らします。', ''];
  for (const [name, when] of Object.entries(EVENT_SOUNDS)) {
    const src = m.sounds[name];
    const from = src ? `${FROM[m.from.sounds[name]]}: ${typeof src === 'string' ? src.split('/').pop() : Array.isArray(src) ? `${name}.wav` : 'ファイル'}` : '—';
    L.push(`  ${name.padEnd(9)} ${when.padEnd(22)} ${word[st[name]].padEnd(14)} ${from}`);
  }
  L.push('');
  L.push('  .wav / .mp3 / .ogg を読みます。音量は :set volume=70。ファイルが無い場面では何も鳴りません (被弾だけは合成音)。');
  L.push('  自分の音にするには、スキンの skin.json に "sounds": { "startup": "sounds/boot.wav" } のように書きます (:help config)。');
  showMsg(':sounds — 効果音のファイル', L);
}

// ---------------------------------------------------------------- .vimfpsrc and :skin

/// Reads a .vimfpsrc (its text). `set`, `skin` and `custom` take effect;
/// `host` lines are kept for :mkvimrc (vimfps host reads them).
function sourceText(text, label) {
  const cmds = parseRc(text);
  const host = [];
  let skinChanged = false;
  let n = 0;
  const errors = applyRc(cmds, {
    set: (args) => {
      n++;
      return settings.command(args).error;
    },
    skin: (args) => {
      if (args.length !== 1) return 'E474: skin の後に名前を 1 つ (使わないなら skin off)';
      profile.put('skin', args[0] === 'off' || args[0] === 'none' ? null : args[0]);
      skinChanged = true;
      n++;
      return null;
    },
    custom: (args) => {
      const e = customCommand(args, custom);
      if (!e) {
        saveCustom();
        n++;
      }
      return e;
    },
    host: (raw) => {
      host.push(raw);
      return null;
    },
  });
  if (host.length) profile.put('host', host);
  if (skinChanged) {
    loadMySkin().then((missing) => {
      if (missing) balloon(missing, '', 'err');
      refreshLook();
    });
  }
  const what = `${n} 行を実行${host.length ? ` · host の行 ${host.length} 個 (vimfps host 用に保存)` : ''}`;
  if (errors.length) showMsg(`:source ${label} — エラー ${errors.length} 件`, [`${label}: ${what}`, '', ...errors]);
  else balloon(`"${label}" を読み込みました`, what);
}

/// :source — a .vimfpsrc (or a zip with one): picked, or from a URL.
async function sourceCommand(args) {
  if (!args) return pickFiles(true, (files) => importFiles(files, 'skin'), '');
  try {
    const res = await fetch(new URL(args, window.location.href), { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const name = args.split(/[\\/?#]/).filter(Boolean).pop() || RC_NAME;
    if (/\.zip$/i.test(name) || (res.headers.get('content-type') || '').includes('zip')) return importBundle(await readZip(await res.arrayBuffer()), name.replace(/\.zip$/i, ''));
    return sourceText(await res.text(), name);
  } catch (e) {
    return balloon('読み込めません', `${args}: ${e.message || e}`, 'err');
  }
}

function rcText(skinDir) {
  return buildRc({ set: settings.changedArgs(), skin: profile.get('skin') || null, custom, host: profile.get('host') || [], skinDir });
}

const EXT_OF = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/bmp': 'bmp' };

/// A skin as zip entries under `prefix`; `withTextures`: the `:texture`
/// images go in too (over the skin's).
async function skinEntries(rec, withTextures, prefix) {
  const manifest = rec ? JSON.parse(JSON.stringify(rec.manifest)) : { name: 'my-skin', textures: {}, sounds: {}, ui: {} };
  manifest.textures = manifest.textures || {};
  const files = { ...((rec && rec.files) || {}) };
  if (withTextures) {
    for (const [slot, o] of texOverrides) {
      const m = (o.name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
      const p = `textures/${slot}.${(m && m[1]) || EXT_OF[o.blob.type] || 'png'}`;
      files[p] = o.blob;
      manifest.textures[slot] = o.size ? { file: p, size: o.size } : p;
    }
  }
  const used = new Set([...Object.values(manifest.textures).map((t) => (typeof t === 'string' ? t : t.file)), ...Object.values(manifest.sounds || {})]);
  const out = [{ path: `${prefix}skin.json`, data: `${JSON.stringify(manifest, null, 2)}\n` }];
  for (const [p, blob] of Object.entries(files)) if (used.has(p)) out.push({ path: prefix + p, data: new Uint8Array(await blob.arrayBuffer()) });
  return out;
}

/// :mkvimrc — downloads .vimfpsrc. :mkvimrc! — a zip with .vimfpsrc and
/// your skin (with the :texture images): everything, to carry elsewhere.
async function mkvimrc(bang) {
  if (!bang) {
    download(new Blob([rcText(false)], { type: 'text/plain' }), RC_NAME);
    return balloon(`${RC_NAME} を書き出しました`, 'vimfps host でも使うなら ~/.vimfpsrc という名前で置きます (ブラウザーが vimfpsrc.txt などに変えていたら直してください)');
  }
  const name = profile.get('skin');
  const rec = name ? await getSkinRecord(name) : null;
  const hasSkin = !!rec || texOverrides.size > 0;
  const entries = [{ path: RC_NAME, data: rcText(hasSkin) }];
  if (hasSkin) entries.push(...(await skinEntries(rec, true, 'skin/')));
  download(writeZip(entries), 'vimfps-profile.zip');
  return balloon('vimfps-profile.zip を書き出しました', `${RC_NAME}${hasSkin ? ` とスキン (${rec ? rec.name : 'my-skin'})` : ''}。別のブラウザーでは、この zip をドロップすれば全部入ります`);
}

async function skinLines() {
  const L = ['スキン — テクスチャ・効果音・UI の色をまとめたもの。下ほど優先して重なります (書いていない項目は下の段から)。', ''];
  const row = (label, layer, extra = '') => L.push(`  ${label.padEnd(14)} ${layer ? `${layer.name}  (${skinSummary(layer)})` : '—'}${extra}`);
  row('1. 同梱', skins.site);
  row('2. ホスト', skins.host, serverInfo && serverInfo.skin && !skins.host ? '  (読み込めませんでした)' : '');
  row('3. 自分のスキン', skins.mine, profile.get('skin') && !skins.mine ? `  ("${profile.get('skin')}" はこのブラウザーにありません)` : '');
  L.push(`  ${'4. :texture'.padEnd(14)} ${texOverrides.size ? [...texOverrides.keys()].join(', ') : '—'}`);
  L.push('');
  L.push('このブラウザーに入っているスキン:');
  const recs = await listSkinRecords();
  if (!recs.length) L.push('  (なし)');
  for (const r of recs) L.push(`  ${r.name === profile.get('skin') ? '*' : ' '} ${r.name.padEnd(20)} ${skinSummary(r.manifest)}${sessionSkins.has(r.name) ? '  (保存できていません)' : ''}`);
  L.push('');
  L.push('  :skin 名前          そのスキンを使う                :skin off          使わない (ホスト・同梱の分だけ)');
  L.push('  :skin load          zip や skin.json と素材のファイルを選んで入れる (フォルダーや zip をドロップしても入ります)');
  L.push('  :skin export [名前] スキンを zip で書き出す          :skin rm 名前       このブラウザーから消す');
  L.push('  :mkvimrc!           .vimfpsrc とスキンをまとめた zip を書き出す (別のブラウザーへの引っ越しに)');
  L.push('');
  L.push(`  skin.json の書き方: :help config / ${DOC_URL}`);
  return L;
}

async function skinCommand(args) {
  const [a, b] = tokenize(args);
  if (!a || a === 'list' || a === 'ls') return showMsg(':skin — スキン', await skinLines());
  if (a === 'load' || a === 'open') return pickFiles(true, (files) => importFiles(files, 'skin'), '');
  if (a === 'export') {
    const name = b || profile.get('skin');
    const rec = name ? await getSkinRecord(name) : null;
    if (!rec) return balloon(`E: 書き出すスキンがありません${name ? `: ${name}` : ''}`, ':skin で一覧', 'err');
    download(writeZip(await skinEntries(rec, false, '')), `${rec.name}.zip`);
    return balloon(`${rec.name}.zip を書き出しました`, 'ドロップすれば入ります。vimfps host --skin で全員に配るときは展開したフォルダーを指定します');
  }
  if (a === 'rm' || a === 'delete' || a === 'del') {
    if (!b) return balloon('E: 消すスキンの名前を書いてください', ':skin rm 名前', 'err');
    sessionSkins.delete(b);
    try {
      await skinStore.remove(b);
    } catch {
      // Not stored.
    }
    if (profile.get('skin') === b) await useSkin('off');
    return balloon(`スキン "${b}" を消しました`);
  }
  return useSkin(a);
}

/// :help config — the short version of docs/config.md.
const CONFIG_HELP = [
  '設定ファイル (.vimfpsrc) とスキン — くわしくは ' + DOC_URL,
  '',
  '.vimfpsrc: 設定を 1 つのテキストファイルに。Vim の vimrc と同じ書き方 (" から行末までコメント)',
  '  set adssens=30 forward=j nocompass      :set と同じ',
  '  skin my-skin                            このブラウザーに入れたスキンを使う (skin off で使わない)',
  '  custom bots=8 skill=4 rule=last time=15 カスタムマッチのフォームの値',
  '  host bots=5 time-limit=15 tunnel        vimfps host のオプション (~/.vimfpsrc に置くと host が読みます)',
  '',
  '  :mkvimrc             今の設定を .vimfpsrc として書き出す',
  '  :mkvimrc!            .vimfpsrc とスキンをまとめた zip を書き出す (別のブラウザーへの引っ越しに)',
  '  :source              .vimfpsrc (か zip) を選んで読み込む。:source URL も可。ページへのドロップでも読めます',
  '',
  'スキン: テクスチャ・効果音・UI の色を、skin.json のある 1 つのフォルダー (zip) に',
  '  { "name": "my-skin",',
  '    "textures": { "ground": "textures/grass.png", "wall": { "file": "textures/brick.jpg", "size": 3 } },',
  '    "sounds": { "startup": "sounds/boot.wav", "error2": "sounds/hit.ogg" },',
  '    "ui": { "window": "#ece9d8", "crosshair": "#00ff66" } }',
  `  textures: ${Object.keys(TEXTURE_SLOTS).join(' ')}`,
  `  sounds:   ${Object.keys(EVENT_SOUNDS).join(' ')}`,
  `  ui:       ${Object.keys(UI_VARS).join(' ')}`,
  '',
  '  重なる順 (下ほど優先): 同梱 (web/assets/skin.json) < ホスト (vimfps host --skin DIR) < 自分のスキン (:skin) < :texture',
  '  :skin で一覧と使い方。フォルダーや zip をこのページにドロップすると入ります',
];

function hostLines() {
  const lines = profile.get('host') || [];
  return [
    'host の行は vimfps host が読む設定です (ブラウザーでは使いません)。:source で読んだ .vimfpsrc の分を覚えていて、:mkvimrc で書き戻します。',
    '',
    ...(lines.length ? lines.map((l) => `  ${l}`) : ['  (なし)']),
    '',
    '  書ける項目: port bind tunnel password bots bot-skill max-players time-limit frag-limit seed name',
    '              no-respawn no-ring no-tanks no-update-check no-network-check web skin',
    `  くわしくは ${DOC_URL}`,
  ];
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
  if (vim.mode === 'insert') vim.setMode(game.watching ? 'spectate' : 'normal');
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

const PLAYER_HUES = [0.0, 0.58, 0.12, 0.33, 0.8, 0.5, 0.05, 0.68, 0.22, 0.9];

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
  // Tanks: a square, with a line where the gun points.
  for (const t of game.tanks) {
    const mine = t.id === game.myTank;
    ctx.save();
    ctx.translate(tx(mine ? game.pos.x : t.x), tx(mine ? game.pos.z : t.z));
    ctx.rotate(-t.yaw);
    ctx.fillStyle = t.driver != null ? '#1f3d12' : '#55632f';
    ctx.strokeStyle = mine ? '#fff' : '#000';
    ctx.lineWidth = 1.5;
    ctx.fillRect(-5, -6.5, 10, 13);
    ctx.strokeRect(-5, -6.5, 10, 13);
    ctx.restore();
    const aim = mine ? game.yaw : t.aim;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(tx(t.x), tx(t.z));
    ctx.lineTo(tx(t.x) - Math.sin(aim) * 11, tx(t.z) - Math.cos(aim) * 11);
    ctx.stroke();
  }
  // The ring: now (red), and where it is going (white, dashed).
  const ring = game.ring;
  if (ring) {
    ctx.save();
    // Outside the circle, the field is dimmed.
    ctx.fillStyle = 'rgba(255, 70, 20, 0.22)';
    ctx.beginPath();
    ctx.rect(0, 0, W, W);
    ctx.arc(tx(ring.x), tx(ring.z), ring.r * k, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#ff4a1a';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(tx(ring.x), tx(ring.z), ring.r * k, 0, Math.PI * 2);
    ctx.stroke();
    if (ring.t >= 0) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.arc(tx(ring.nx), tx(ring.nz), ring.nr * k, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
  // Watching: everyone, with names (the one followed in yellow).
  if (game.watching) {
    const snap = game.snaps[game.snaps.length - 1];
    ctx.font = '12px system-ui, sans-serif';
    for (const p of snap ? snap.players.values() : []) {
      if (!p.alive) continue;
      const followed = p.id === game.follow;
      ctx.fillStyle = followed ? '#ffd400' : `hsl(${(PLAYER_HUES[p.id % PLAYER_HUES.length] * 360).toFixed(0)}, 65%, 50%)`;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = followed ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.arc(tx(p.x), tx(p.z), followed ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // Facing.
      ctx.beginPath();
      ctx.moveTo(tx(p.x), tx(p.z));
      ctx.lineTo(tx(p.x) - Math.sin(p.yaw) * 10, tx(p.z) - Math.cos(p.yaw) * 10);
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 3;
      const label = `${nameOf(p.id)}${p.hp != null ? ` ${Math.round(p.hp)}` : ''}`;
      ctx.strokeText(label, tx(p.x) + 7, tx(p.z) - 6);
      ctx.fillText(label, tx(p.x) + 7, tx(p.z) - 6);
    }
    // Your own view: where the camera is, and the wedge it looks along
    // (whichever camera it is: a player's eyes, automatic, free, the sky).
    const cx = tx(game.pos.x);
    const cz = tx(game.pos.z);
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    const halfFov = halfWidth(game.fov, aspect);
    // Looking down, the view reaches less far across the ground.
    const reach = 46 * Math.max(0.35, Math.cos(game.camPitch || 0));
    const dir = -game.yaw - Math.PI / 2;
    ctx.fillStyle = 'rgba(255, 212, 0, 0.28)';
    ctx.strokeStyle = '#ffd400';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cz);
    ctx.arc(cx, cz, reach, dir - halfFov, dir + halfFov);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffd400';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cz, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (game.sky) {
      // From the sky: the spot in the middle of the screen.
      ctx.strokeStyle = '#ffd400';
      ctx.lineWidth = 2;
      ctx.strokeRect(tx(game.sky.x) - 6, tx(game.sky.z) - 6, 12, 12);
    }
    ctx.font = '12px system-ui, sans-serif';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000';
    ctx.fillStyle = '#ffd400';
    ctx.strokeText('視点', cx + 7, cz + 14);
    ctx.fillText('視点', cx + 7, cz + 14);
    return;
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
  // Offline games on a host's page are only for warming up: the label
  // says they are not the server's match (that one the admin runs).
  const off = serverInfo ? 'ひとりで (サーバーの試合とは別)' : 'オフライン';
  if (serverInfo) {
    const mode = serverInfo.respawn === false ? ' · 復活なし' : '';
    const managed = serverInfo.managed ? ' · 試合は管理者が開始' : '';
    menu.items.push({
      label: 'このサーバーに参加',
      sub: `${serverInfo.name} · v${serverInfo.version}${mode}${serverInfo.password ? ' · 合言葉あり' : ''}${managed}`,
      run: () => connect(''),
    });
    menu.items.push({ label: 'このサーバーを観戦', sub: '試合には出ずに見る (:play で途中参加)', run: () => connect('', true) });
  }
  menu.items.push({ label: '射撃訓練場', sub: `${off} · 10〜400 m の的 · 全武器 · 弾無限`, run: () => startPractice(0, { range: true }) });
  // A match with its own rules is the admin's business on a host.
  if (!serverInfo) menu.items.push({ label: 'カスタムマッチ', sub: 'オフライン · bot の数・強さ・ルール・時間を選ぶ', run: () => openCustom() });
  menu.items.push({ label: '練習する', sub: `${off} · bot 5 体`, run: () => startPractice(5) });
  menu.items.push({ label: '練習する (復活なし)', sub: `${off} · bot 5 体 · 最後の 1 人が勝ち`, run: () => startPractice(5, { noRespawn: true }) });
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
  // A short screen scrolls the menu: keep the selected row in view.
  const sel = ol.children[menu.sel];
  if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
  const name = settings.get('name');
  $('title-name').innerHTML = `名前: <b>${esc(name || '(未設定 — :set name=名前)')}</b>`;
  $('title-version').textContent = `v${VERSION}`;
}

function showTitle() {
  show('title');
  show('hud', false);
  for (const id of ['inventory', 'mapwin', 'chatwin', 'bsod', 'boot', 'resultwin', 'progress', 'customwin', 'lobbywin']) show(id, false);
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

// ---------------------------------------------------------------- joining from practice
//
// On a host's page, practising offline while the match waits for its
// admin: the host's /match.json is checked every 1.5 s, and when the admin
// starts a match the practice ends and the page joins it (:set noautojoin:
// only a notice).

const serverWatch = { phase: null, players: 0, busy: false };
const SERVER_PHASES = { lobby: '待機中', countdown: 'まもなく開始', live: '試合中', results: '結果' };

async function pollServer() {
  if (!serverInfo || !serverInfo.managed || !game.practice || !game.map) {
    serverWatch.phase = null;
    return;
  }
  if (serverWatch.busy) return;
  serverWatch.busy = true;
  const conn = game.conn;
  try {
    const r = await fetch('match.json', { cache: 'no-store' });
    const st = await r.json();
    if (game.conn !== conn || !game.practice || !st.phase) return;
    const was = serverWatch.phase;
    serverWatch.phase = st.phase;
    serverWatch.players = st.players;
    const starting = st.phase === 'countdown' || (st.phase === 'live' && was != null && was !== 'live');
    if (starting && was !== 'countdown') {
      if (settings.get('autojoin')) {
        balloon('サーバーの試合が始まります', `練習を終えて参加します${st.countdown != null ? ` (${st.countdown} 秒後に開始)` : ''}`);
        sound.event('startup');
        connect('');
      } else balloon('サーバーの試合が始まります', ':join で参加 (:set autojoin で自動)');
    } else if (was == null) {
      balloon(
        st.phase === 'live' ? 'サーバーは試合中です' : 'サーバーの試合を待っています',
        st.phase === 'live' ? ':join で途中参加できます' : settings.get('autojoin') ? '管理者が試合を始めたら自動で参加します (:set noautojoin で切る)' : ':join で参加',
      );
    }
  } catch {
    // The host is gone or busy: try again next time.
  } finally {
    serverWatch.busy = false;
  }
}
setInterval(pollServer, 1500);

/// The task bar's ping: "練習 12 ms" offline (or the mode's name), "34 ms"
/// on a server.
function pingLabel() {
  const base = pingBase();
  if (!game.practice || !serverWatch.phase) return base;
  return `${base} · サーバー ${SERVER_PHASES[serverWatch.phase] || ''} ${serverWatch.players} 人`;
}

function pingBase() {
  const tag = game.practice ? (game.offlineName || offlineName({})).short : '';
  if (game.ping == null) return tag;
  const ms = `${game.ping < 10 ? game.ping.toFixed(1) : Math.round(game.ping)} ms`;
  return tag ? `${tag} ${ms}` : ms;
}

/// What an offline game is called: short (task bar) and long (messages).
function offlineName(mode) {
  if (mode.range) return { short: '訓練場', long: '射撃訓練場' };
  if (mode.custom) return { short: 'カスタム', long: 'カスタムマッチ' };
  return { short: '練習', long: mode.noRespawn ? '練習モード (復活なし)' : '練習モード' };
}

async function startPractice(bots, mode = {}) {
  const name = offlineName(mode);
  balloon(`${name.long}を準備中…`);
  try {
    const seed = mode.seed || Math.floor(Math.random() * 100000);
    const conn = await LocalConnection.create(seed, Number.isFinite(bots) ? bots : 5, mode);
    attach(conn, true);
    game.offlineName = name;
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
  sound.setWorld(game.world);
  game.specs = m.specs;
  game.range = !!m.range;
  game.respawnMode = m.respawn !== false;
  const conn = game.conn;
  const ok = await ensureRenderer();
  if (!ok) return leave();
  if (game.conn !== conn) return;
  renderer.buildMap(m.map);
  applyTextures();
  renderer.setPickups(lastPickups);
  show('title', false);
  show('hud');
  show('msgwin', false);
  vim.setMode('normal');
  if (m.spectator) startWatching(null);
  if (game.range) balloon('射撃訓練場', 'うしろの台で y: 銃を持ち替え · 的は 10〜400 m · 弾は減りません · :q で終了');
  else
    balloon(
      game.practice ? (game.offlineName || offlineName({})).long : `${serverInfo ? serverInfo.name : 'サーバー'} に${m.spectator ? '観戦で' : ''}参加しました`,
      `${Math.round(m.time_limit / 60)} 分 · ${m.respawn === false ? '復活なし (最後の 1 人が勝ち)' : m.frag_limit > 1e6 ? 'キル数の上限なし' : `${m.frag_limit} キル先取`} · bot の強さ ${m.bot_skill || 3}${m.ring ? ' · リングあり' : ''} · :help で操作説明`,
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
      // Through someone's eyes, their shots look and sound like your own.
      const eyes = m.id === eyesId();
      if (!mine) game.shots.push({ x: m.from.x, z: m.from.z, id: m.id, t: performance.now() });
      muzzleAt.set(m.id, performance.now());
      if (game.director) game.director.note('shot', m.id);
      if (renderer) renderer.tracer(m.from, m.to, eyes, m.vel, game.specs && game.specs.gravity);
      sound.shot(m.gun, eyes ? null : m.from);
      if (eyes) {
        if (renderer) renderer.muzzle();
        if (settings.get('bob')) game.kick = 0.06;
      }
      break;
    }
    case 'shell': {
      const mine = m.id === game.myId;
      const eyes = m.id === eyesId();
      if (!mine) game.shots.push({ x: m.from.x, z: m.from.z, id: m.id, t: performance.now() });
      if (game.director) game.director.note('shot', m.id);
      if (renderer) renderer.shell(m.from, m.to, m.vel, game.specs && game.specs.gravity);
      sound.cannon(eyes ? null : m.from);
      if (eyes && settings.get('bob')) game.kick = 0.12;
      break;
    }
    case 'hit':
      if (game.director && m.victim) game.director.note('hit', m.attacker, m.victim);
      if (m.victim && m.attacker !== m.victim) {
        // Who is fighting whom (the card shows the other side's health).
        const t = performance.now();
        foes.set(m.attacker, { id: m.victim, t });
        foes.set(m.victim, { id: m.attacker, t });
      }
      if (m.attacker === eyesId() && m.victim !== m.attacker) {
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
      if (game.watching && m.victim === eyesId() && m.attacker !== m.victim) {
        // The one you watch through was hit: the arc toward the shooter.
        damageArc(m.from);
        sound.hurt();
      }
      if (m.victim === game.myId) {
        damageArc(m.from);
        // Outside the ring (you "hit" yourself): a tick, and the arc points
        // back to the middle of the circle.
        // error2 from its file; without one, the synthesized sounds.
        if (sound.damage()) {
          // Played.
        } else if (m.attacker === m.victim && ringOutside() > 0) sound.ringTick();
        else sound.hurt();
      }
      break;
    case 'kill': {
      const ring = m.cause === 'ring';
      const how = m.cause === 'grenade' ? 'グレネード' : m.cause === 'tank' ? '戦車' : ring ? 'リングの外' : gunName(m.cause && m.cause.gun);
      const self = m.killer === m.victim;
      const dist = !self && m.dist ? ` · ${m.dist >= 10 ? Math.round(m.dist) : m.dist.toFixed(1)} m` : '';
      const mine = m.killer === game.myId && !self;
      balloon(
        ring ? `${nameOf(m.victim)} はリングの外で倒れました` : self ? `${nameOf(m.victim)} は自爆しました` : mine ? `キル: ${nameOf(m.victim)}` : `${nameOf(m.killer)} ▶ ${nameOf(m.victim)}`,
        `${how}${m.head ? ' · ヘッドショット' : ''}${dist}`,
        'kill',
      );
      if (m.victim === game.myId && !game.watching) {
        game.alive = false;
        sound.event('error');
        showBsod(self ? null : nameOf(m.killer), `${how}${m.head ? ' · ヘッドショット' : ''}${dist}`, m.cause);
        if (vim.mode === 'view' || vim.mode === 'inventory' || vim.mode === 'map') vim.setMode('normal');
        if (!game.respawnMode) {
          // Out of the round: after the stop screen, watch through the
          // killer's eyes (or a free camera with :set nokillcam).
          game.bsodPending = true;
          const killer = self ? null : m.killer;
          const conn = game.conn;
          setTimeout(() => {
            if (game.conn !== conn) return;
            game.bsodPending = false;
            if (game.alive) return;
            hideDeath();
            startWatching(settings.get('killcam') ? killer : 'free');
          }, 1600);
        }
      }
      if (game.director) game.director.note('kill', m.killer, m.victim);
      if (game.watching && !game.auto && m.victim === game.follow) {
        // Whom we watched fell: follow the one who got them.
        setTimeout(() => {
          if (game.watching && !game.auto && game.follow === m.victim) game.follow = m.killer !== m.victim ? m.killer : null;
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
      game.myTank = null;
      game.tankView = null;
      hideDeath();
      if (game.watching) stopWatching();
      resetControls(false);
      sound.event('startup');
      break;
    case 'match_end':
      showResult(m);
      sound.event('shutdown');
      break;
    case 'match_start':
      show('resultwin', false);
      showLobby(false);
      resetControls(true);
      if (m.respawn !== undefined) game.respawnMode = m.respawn !== false;
      balloon(
        '試合が始まりました',
        m.time_limit
          ? `${Math.round(m.time_limit / 60)} 分 · ${m.respawn === false ? '復活なし (最後の 1 人が勝ち)' : m.frag_limit > 1e6 ? 'キル数の上限なし' : `${m.frag_limit} キル先取`}${m.ring ? ' · リングあり' : ''}`
          : '',
      );
      break;
    case 'pong': {
      const t = game.pings.get(m.id);
      if (t) {
        game.ping = performance.now() - t;
        game.pings.delete(m.id);
        netStats.rtts.push(game.ping);
        if (netStats.rtts.length > 30) netStats.rtts.shift();
      }
      break;
    }
    default:
      break;
  }
}

let hitTimer = null;

/// Whose eyes the screen shows: yours while playing, the followed
/// player's while watching through them (not the automatic, free or sky
/// camera). null: nobody's.
function eyesId() {
  if (!game.watching) return game.myId;
  if (game.auto || game.free || game.sky) return null;
  return game.follow;
}

/// When each player last fired (the muzzle flash in the wipe).
const muzzleAt = new Map();

/// id -> {id, t}: whom each player last traded hits with, and when.
const foes = new Map();

/// The one the watched player is fighting: the automatic camera's rival,
/// or whom they traded hits with in the last 8 seconds (alive).
function opponentOf(id, view) {
  const d = game.director;
  if (game.auto && d && d.subject === id && d.rival != null && view.get(d.rival)?.alive) return d.rival;
  const f = foes.get(id);
  if (f && performance.now() - f.t < 8000 && view.get(f.id)?.alive) return f.id;
  return null;
}

// ---------------------------------------------------------------- HUD layout
//
// The boxes along the top each have a place; on a narrow screen they would
// land on one another. They are laid out in this order, so the compass and
// the key line stay at the top and the card of whom you watch goes below:
// the bars in the middle first step to the left of the box in the corner
// (narrowing if they must), and anything that would still overlap a box
// already placed goes down below it. (Semi-transparent read-outs such as
// :set netstat may overlap.)
const TOP_HUD = ['rank', 'compass', 'watchbar', 'lobbywin', 'followcard', 'fps'];
/// In the corner: the bars in the middle step aside for these.
const HUD_CORNER = new Set(['rank']);
/// Centred bars that step aside rather than go down (the key line goes
/// down: it is wide, and a narrower one wraps into more lines).
const HUD_SIDESTEP = new Set(['compass']);
let hudLaidAt = 0;

function layoutHud(force = false) {
  const now = performance.now();
  if (!force && now - hudLaidAt < 150) return;
  hudLaidAt = now;
  const placed = [];
  const hits = (r, top, p) => r.left < p.right + 4 && r.right > p.left - 4 && top < p.bottom + 4 && top + r.height > p.top - 4;
  for (const id of TOP_HUD) {
    const el = $(id);
    if (!el) continue;
    el.style.top = '';
    if (HUD_SIDESTEP.has(id)) {
      el.style.left = '';
      el.style.width = '';
    }
    if (el.classList.contains('hidden') || !el.offsetParent) continue;
    let r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const box = el.offsetParent.getBoundingClientRect();
    if (HUD_SIDESTEP.has(id)) {
      const corner = placed.find((p) => p.corner && hits(r, r.top, p));
      if (corner) {
        // Room from the left edge to the corner box.
        const room = corner.left - 8 - (box.left + 12);
        if (room >= Math.min(r.width, 150)) {
          const w = Math.min(r.width, room);
          if (w < r.width) el.style.width = `${Math.floor(w)}px`;
          const centre = Math.min(box.left + box.width / 2, corner.left - 8 - w / 2);
          el.style.left = `${Math.round(centre - box.left)}px`;
          r = el.getBoundingClientRect();
          // Never past the left edge (if it cannot narrow that far, it
          // goes down below the corner instead).
          if (r.left < box.left + 12) {
            el.style.left = `${Math.round(12 + r.width / 2)}px`;
            r = el.getBoundingClientRect();
          }
        }
      }
    }
    let top = r.top;
    for (let i = 0; i < TOP_HUD.length; i++) {
      const hit = placed.find((p) => hits(r, top, p));
      if (!hit) break;
      top = hit.bottom + 6;
    }
    if (top !== r.top) el.style.top = `${Math.round(top - box.top)}px`;
    placed.push({ left: r.left, right: r.right, top, bottom: top + r.height, corner: HUD_CORNER.has(id) });
  }
  // The chat log grows up from the bottom: it stops short of the boxes
  // above it (older lines go first).
  const log = $('chatlog');
  if (log) {
    log.style.maxHeight = '';
    const r = log.getBoundingClientRect();
    const above = placed.filter((p) => p.left < r.right && p.right > r.left).reduce((m, p) => Math.max(m, p.bottom), 0);
    if (above && r.top < above + 6) log.style.maxHeight = `${Math.max(0, Math.round(r.bottom - above - 6))}px`;
  }
}
window.addEventListener('resize', () => layoutHud(true));

/// A fresh start (a respawn, a new match): nothing carries over from the
/// life before — not VIEW (aiming), not an open inventory or map, and for a
/// new match not sneaking either (the touch pad's Shift is a toggle).
function resetControls(newMatch) {
  if (['view', 'inventory', 'map'].includes(vim.mode) && !game.watching) vim.setMode('normal');
  // Typing a command or reading a message: do not come back to VIEW.
  if (['view', 'inventory', 'map'].includes(cmdReturn)) cmdReturn = 'normal';
  if (['view', 'inventory', 'map'].includes(msgReturn)) msgReturn = 'normal';
  game.ads = false;
  game.zoom = 0;
  game.fire = false;
  game.timed = null;
  game.turnLeft = 0;
  aim.clear();
  if (newMatch) {
    touch.releaseShift();
    game.shiftDown = false;
  }
  game.sneak = game.shiftDown;
  syncMode();
}

/// Keep the key mode in step with what is on screen: watching is always
/// SPECTATE (never NORMAL or VIEW, whatever window was open when it began),
/// and playing is never SPECTATE.
function syncMode() {
  if (!game.conn || !game.map) return;
  const m = vim.mode;
  if (game.watching) {
    if (m === 'normal' || m === 'view' || m === 'inventory') vim.setMode('spectate');
  } else if (m === 'spectate') vim.setMode('normal');
}

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

function showBsod(killer, how, cause = null) {
  bsodState = { killer, how, cause, at: performance.now() };
  renderBsod(null);
  show('boot', false);
  show('bsod');
}

function renderBsod(left) {
  const { killer, how, cause } = bsodState;
  const ring = cause === 'ring';
  const id = (killer ? `KILLED_BY_${killer}` : ring ? 'OUT_OF_RING' : 'SELF_DESTRUCT').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const count = left == null ? '' : ` ${Math.max(0, Math.ceil(left - BOOT_TIME))}`;
  const lines = [
    '<span class="hl"> vim-fps </span>',
    '',
    'プレイヤーが倒されたため、問題が起きないようにシステムを停止しました。',
    '',
    esc(id),
    '',
    killer ? `倒した相手: ${esc(killer)}` : ring ? '原因: リングの外にいた' : cause === 'tank' ? '原因: 自分の砲撃' : '原因: 自分のグレネード',
    `詳細: ${esc(how)}`,
    '',
    ring ? 'このエラーが続く場合は、マップ (m) で円を確かめ、早めに中へ入ってください。' : 'このエラーが続く場合は、遮蔽物に隠れるか、先に撃ってください。',
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

/// The clock in the task bar.
function clockText() {
  if (game.lobby) return game.countdown != null ? `開始 ${Math.ceil(game.countdown)}` : '待機中';
  return game.intermission != null ? `次 ${fmtTime(game.intermission)}` : fmtTime(game.left);
}

/// Under the result table: what follows it.
function resultNext() {
  const n = Math.ceil(game.intermission);
  return serverInfo && serverInfo.managed && !game.practice ? `${n} 秒後に結果を閉じます (次の試合は管理者が開始)` : `${n} 秒後に次の試合`;
}

// ---------------------------------------------------------------- waiting room

/// Into the waiting room: nobody is on the field, so the view starts high
/// over the middle of the map (the watching keys move it).
function enterLobby() {
  show('resultwin', false);
  hideDeath();
  if (!game.watching) startWatching(null);
  game.auto = false;
  game.pos = { x: 0, y: 0, z: 0 };
  startSky();
  showLobby(true);
}

function showLobby(on) {
  show('lobbywin', on);
  if (!on) lobbyKey = '';
}

let lobbyKey = '';
function renderLobby() {
  const rows = [...game.roster.values()];
  const playing = rows.filter((r) => !r.spectator);
  const watching = rows.filter((r) => r.spectator && !r.bot);
  const humans = playing.filter((r) => !r.bot).length;
  const bots = playing.length - humans;
  const cd = game.countdown;
  const key = JSON.stringify([cd, rows.map((r) => [r.id, r.name, r.spectator, r.bot]), game.myId]);
  if (key === lobbyKey) return;
  lobbyKey = key;
  const me = game.roster.get(game.myId);
  setText($('lobby-title'), cd != null ? 'まもなく試合開始' : `待機中 — ${serverInfo ? serverInfo.name : 'サーバー'}`);
  setText(
    $('lobby-status'),
    cd != null
      ? me && me.spectator
        ? '観戦で見ます (:play で試合に参加)'
        : '試合が始まります。準備してください'
      : `管理者が試合を開始するまでお待ちください · ${humans} 人${bots ? ` + bot ${bots}` : ''}${watching.length ? ` · 観戦 ${watching.length}` : ''}`,
  );
  const count = $('lobby-count');
  show('lobby-count', cd != null);
  if (cd != null) count.textContent = String(Math.max(0, Math.ceil(cd)));
  const ul = $('lobby-list');
  ul.innerHTML = '';
  for (const r of [...playing.filter((r) => !r.bot), ...playing.filter((r) => r.bot), ...watching]) {
    const li = document.createElement('li');
    li.className = r.id === game.myId ? 'me' : r.bot ? 'bot' : r.spectator ? 'watch' : '';
    li.textContent = `${r.name}${r.bot ? ' (bot)' : r.spectator ? ' (観戦)' : ''}`;
    ul.appendChild(li);
  }
}

function onSnap(m) {
  if (m.watching && !game.watching && !game.bsodPending) startWatching(null);
  if (!m.watching && game.watching && m.me) stopWatching();
  const wasLobby = game.lobby;
  game.lobby = !!m.lobby;
  game.countdown = m.countdown ?? null;
  if (game.lobby && !wasLobby) enterLobby();
  else if (!game.lobby && wasLobby) showLobby(false);
  if (game.lobby) renderLobby();
  game.me = m.me;
  game.left = m.left;
  game.intermission = m.intermission;
  game.grenades = m.grenades;
  const now = performance.now();
  const players = new Map(m.players.map((p) => [p.id, p]));
  const tanks = new Map((m.tanks || []).map((t) => [t.id, t]));
  // Engines: a rumble for every couple of metres a tank rolls.
  for (const t of tanks.values()) {
    const was = game.tanks.find((o) => o.id === t.id);
    const acc = (tankSteps.get(t.id) || 0) + (was ? Math.hypot(t.x - was.x, t.z - was.z) : 0);
    if (acc > 2.2) {
      sound.rumble(t.driver === game.myId && !game.watching ? null : { x: t.x, y: t.y + 1, z: t.z });
      tankSteps.set(t.id, 0);
    } else tankSteps.set(t.id, acc);
  }
  game.tanks = m.tanks || [];
  game.ring = m.ring || null;
  game.snaps.push({ t: now, players, tanks });
  netStats.snaps.push(now);
  if (netStats.snaps.length > 60) netStats.snaps.shift();
  if (game.snaps.length > 12) game.snaps.shift();
  const mine = players.get(game.myId);
  game.myTank = mine && mine.alive && mine.tank != null && !m.watching ? mine.tank : null;
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
  use() {
    if (game.conn && game.alive) game.conn.send({ t: 'use' });
  },
  swapGun() {
    const inv = game.me && game.me.inv;
    if (!inv || inv.guns.length < 2) return;
    const slot = inv.sel === 'gun0' ? 'gun1' : 'gun0';
    inv.sel = slot;
    game.conn.send({ t: 'select', slot });
  },
  follow(n) {
    if (game.auto) {
      // The automatic camera stays on: tell it whom to show.
      const list = alivePlayers();
      if (!list.length) return;
      const i = list.findIndex((p) => p.id === game.follow);
      const k = i < 0 ? 0 : (((i + n) % list.length) + list.length) % list.length;
      director().force(list[k].id);
    } else followNext(n);
  },
  autocam() {
    setAuto(!game.auto);
  },
  skycam() {
    game.auto = false;
    if (game.sky) {
      game.sky = null;
      followNext(1);
    } else startSky();
  },
  formMove: (n) => customMove(n),
  formChange: (n) => customChange(n),
  formSubmit: () => customSubmit(),
  formCancel: () => customCancel(),
  freecam() {
    game.auto = false;
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
  if (k === 'speakers' && sound.ctx) {
    setTimeout(() => {
      const info = sound.outputInfo();
      if (info.note) balloon(`speakers: ${info.mode} で鳴らします`, info.note, 'err');
    }, 0);
  }
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

/// The two snapshots around "100 ms ago" and how far between them that is.
function snapPair(now) {
  const snaps = game.snaps;
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
  return { a, b, k };
}

/// Tanks as drawn: between snapshots, like the players.
function interpolatedTanks(now) {
  const snaps = game.snaps;
  if (!snaps.length) return [];
  if (!settings.get('interp') || snaps.length < 2) return [...snaps[snaps.length - 1].tanks.values()];
  const { a, b, k } = snapPair(now);
  const out = [];
  for (const tb of b.tanks.values()) {
    const ta = a.tanks.get(tb.id);
    if (!ta) {
      out.push(tb);
      continue;
    }
    out.push({
      ...tb,
      x: ta.x + (tb.x - ta.x) * k,
      y: ta.y + (tb.y - ta.y) * k,
      z: ta.z + (tb.z - ta.z) * k,
      yaw: ta.yaw + wrapAngle(tb.yaw - ta.yaw) * k,
      aim: ta.aim + wrapAngle(tb.aim - ta.aim) * k,
      pitch: ta.pitch + (tb.pitch - ta.pitch) * k,
    });
  }
  return out;
}

/// What a tank's name plate says.
function tankLabel(t) {
  return t.driver != null ? `戦車 · ${nameOf(t.driver)}` : '戦車';
}

/// The tank you drive (latest snapshot), or null.
function myTank() {
  if (game.myTank == null) return null;
  return game.tanks.find((t) => t.id === game.myTank) || null;
}

/// An empty tank close enough to get into.
function tankInReach() {
  if (!game.alive || game.myTank != null || game.watching) return null;
  return game.tanks.find((t) => t.driver == null && Math.hypot(t.x - game.pos.x, t.z - game.pos.z) < TANK.enter) || null;
}

/// How far outside the ring you are (metres; negative inside, -Infinity
/// without a ring).
function ringOutside() {
  const r = game.ring;
  if (!r) return -Infinity;
  return Math.hypot(game.pos.x - r.x, game.pos.z - r.z) - r.r;
}

function interpolated(now) {
  const snaps = game.snaps;
  if (!snaps.length) return new Map();
  if (!settings.get('interp') || snaps.length < 2) return snaps[snaps.length - 1].players;
  const { a, b, k } = snapPair(now);
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
  if (game.myTank != null) return game.zoom === 2 ? TANK.scope : TANK.ads;
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
  syncMode();
  if (game.conn && game.map && renderer && game.watching) {
    watchFrame(now, dt);
  } else if (game.conn && game.map && renderer) {
    // Look (VIEW) and quick turns.
    // Held hjkl: one steady speed at the first stage, speeding up only at
    // the second (the scope).
    if (vim.mode === 'view') applyLook(aim.update(dt, zoomFactor(), game.zoom === 2));
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
    // In a tank: the server drives it; follow it smoothly, and turn with
    // the hull (the turret rides on it).
    const tank = myTank();
    if (tank) {
      let tv = game.tankView;
      if (!tv || tv.id !== tank.id) tv = game.tankView = { id: tank.id, x: tank.x, y: tank.y, z: tank.z, yaw: tank.yaw };
      const k = settings.get('interp') ? 1 - Math.exp(-dt * 14) : 1;
      tv.x += (tank.x - tv.x) * k;
      tv.z += (tank.z - tv.z) * k;
      const turn = wrapAngle(tank.yaw - tv.yaw) * k;
      tv.yaw = wrapAngle(tv.yaw + turn);
      tv.y = game.world.height(tv.x, tv.z);
      game.yaw = wrapAngle(game.yaw + turn);
      game.pitch = Math.max(TANK.pitch[0], Math.min(TANK.pitch[1], game.pitch));
      game.pos = { x: tv.x, y: tv.y, z: tv.z };
      game.vel = { x: 0, z: 0 };
    } else game.tankView = null;
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
    if (game.alive && game.intermission == null && !tank) {
      const before = { ...game.pos };
      game.pos = pushOutOfTanks(game.world, game.world.slide(game.pos, game.vel.x * dt, game.vel.z * dt), game.tanks);
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
    const gun = tank ? null : heldGun();
    const sel = game.me && game.me.inv.sel;
    renderer.setHeld(tank ? null : sel === 'medkit' || sel === 'grenade' ? sel : gun ? gun.gun : null);
    // The SR looks through its scope at both stages (low / high power).
    const scoped = game.ads && gun && gun.gun === 'sr' && game.adsK > 0.5;
    show('scope', scoped);
    if (scoped) updateHoldover();
    const style = game.ads && game.adsK > 0.6 && !scoped && !tank ? renderer.adsStyle() : null;
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
    // Tanks: your own where you see it (no lag), turret on your aim.
    renderer.setTanks(
      interpolatedTanks(now).map((t) => (tank && t.id === tank.id ? { ...t, ...game.tankView, aim: game.yaw, pitch: game.pitch } : t)),
      game.specs && game.specs.tank_hp,
      tank ? tank.id : null,
      tankLabel,
    );
    renderer.setRing(game.ring);
    renderer.updateEffects(dt);
    const eye = tank ? TANK.eye : eyeHeight(game.sneak);
    const cam = {
      x: game.pos.x,
      y: game.pos.y + eye + (bobOn && !game.ads && !tank ? Math.abs(Math.sin(game.bob)) * 0.04 : 0),
      z: game.pos.z,
      yaw: game.yaw,
      pitch: game.pitch,
      fov: game.fov,
    };
    renderer.render(cam, { ads: game.adsK, hide: scoped || !game.alive || !!tank, bob: bobY, kick: game.kick });
    sound.listener(cam.x, cam.y, cam.z, game.yaw, cam.pitch || 0);
    if (vim.mode === 'map') drawMap();
  }
  touch.setScene(touchScene());
  if (game.conn && game.map && renderer) {
    pingTimer += dt;
    if (pingTimer > 1) {
      pingTimer = 0;
      game.pingSeq += 1;
      game.pings.set(game.pingSeq, now);
      // With the last round trip measured: the host shows it to its admin.
      game.conn.send(game.ping != null ? { t: 'ping', id: game.pingSeq, rtt: Math.round(game.ping * 10) / 10 } : { t: 'ping', id: game.pingSeq });
    }
    updateHud(dt);
    layoutHud();
    updateCompass(now);
    updateNetStats(now);
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

// ---------------------------------------------------------------- network statistics

const netStats = { rtts: [], snaps: [], last: null, rateIn: 0, rateOut: 0, msgRate: 0, at: 0 };

function fmtBytes(n) {
  if (n >= 1048576) return `${(n / 1048576).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/// Round-trip times: last, average, minimum, maximum, jitter (mean change).
function rttSummary() {
  const r = netStats.rtts;
  if (!r.length) return null;
  const avg = r.reduce((a, b) => a + b, 0) / r.length;
  let jitter = 0;
  for (let i = 1; i < r.length; i++) jitter += Math.abs(r[i] - r[i - 1]);
  jitter = r.length > 1 ? jitter / (r.length - 1) : 0;
  return { last: r[r.length - 1], avg, min: Math.min(...r), max: Math.max(...r), jitter };
}

/// Snapshots per second over the last ones, and how uneven their spacing is.
function snapSummary(now) {
  const t = netStats.snaps.filter((x) => now - x < 3000);
  if (t.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < t.length; i++) gaps.push(t[i] - t[i - 1]);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
  return { rate: 1000 / mean, mean, sd, maxGap: Math.max(...gaps), age: now - t[t.length - 1] };
}

function netLines(now) {
  const c = game.conn;
  if (!c || !c.stats) return ['(接続していません)'];
  const st = c.stats;
  const r = rttSummary();
  const sn = snapSummary(now);
  const sp = game.specs;
  const f = (v) => (v < 10 ? v.toFixed(1) : String(Math.round(v)));
  return [
    `接続     ${st.kind}${st.url ? `  ${st.url}` : ''}`,
    r ? `Ping     ${f(r.last)} ms  (平均 ${f(r.avg)} · 最小 ${f(r.min)} · 最大 ${f(r.max)} · ゆれ ${f(r.jitter)} ms)` : 'Ping     (測定中)',
    sn
      ? `受信     ${sn.rate.toFixed(1)} 回/秒 (サーバーの送信 ${sp ? sp.snap_rate : 20} Hz) · 間隔 ${f(sn.mean)} ± ${f(sn.sd)} ms · 最大の空き ${f(sn.maxGap)} ms`
      : '受信     (測定中)',
    `通信量   下り ${fmtBytes(Math.round(netStats.rateIn))}/s · 上り ${fmtBytes(Math.round(netStats.rateOut))}/s · ${netStats.msgRate.toFixed(0)} メッセージ/秒`,
    `合計     下り ${fmtBytes(st.bytesIn)} (${st.msgsIn}) · 上り ${fmtBytes(st.bytesOut)} (${st.msgsOut})`,
    sp ? `サーバー ${sp.tick_rate} Hz で計算 · ${sp.snap_rate} Hz で送信 · 補間の遅れ ${settings.get('interp') ? '100 ms' : 'なし'}` : '',
  ].filter(Boolean);
}

function updateNetStats(now) {
  const c = game.conn;
  const el = $('netstat');
  const on = settings.get('netstat') && !!c;
  el.classList.toggle('hidden', !on);
  if (!c || !c.stats) return;
  // Per-second rates.
  if (!netStats.last || now - netStats.at >= 1000) {
    if (netStats.last) {
      const secs = (now - netStats.at) / 1000;
      netStats.rateIn = (c.stats.bytesIn - netStats.last.bytesIn) / secs;
      netStats.rateOut = (c.stats.bytesOut - netStats.last.bytesOut) / secs;
      netStats.msgRate = (c.stats.msgsIn - netStats.last.msgsIn) / secs;
    }
    netStats.last = { ...c.stats };
    netStats.at = now;
    if (on) el.textContent = netLines(now).slice(1, 4).join('\n');
  }
}

// ---------------------------------------------------------------- custom match

const SKILL_NAMES = ['とても弱い', '弱い', '普通', '強い (偏差撃ち)', 'とても強い (偏差撃ち)'];
const CUSTOM_ROWS = [
  { key: 'bots', label: 'bot の数', values: [...Array(16).keys()], fmt: (v) => `${v} 体` },
  { key: 'skill', label: 'bot の強さ', values: [1, 2, 3, 4, 5], fmt: (v) => `${v} · ${SKILL_NAMES[v - 1]}` },
  { key: 'rule', label: 'ルール', values: ['ffa', 'last'], fmt: (v) => (v === 'ffa' ? '個人戦 (復活あり)' : '復活なし (最後の 1 人が勝ち)') },
  { key: 'time', label: '時間', values: [3, 5, 10, 15, 20, 30, 60], fmt: (v) => `${v} 分` },
  { key: 'frags', label: '終了キル数', values: [0, 5, 10, 15, 25, 50], fmt: (v) => (v ? `${v} キル` : 'なし (時間まで)') },
  { key: 'ring', label: 'リング', values: ['on', 'off'], fmt: (v) => (v === 'on' ? 'あり (縮む円の外はダメージ)' : 'なし') },
  { key: 'tanks', label: '戦車', values: ['on', 'off'], fmt: (v) => (v === 'on' ? 'あり (3 両)' : 'なし') },
  { key: 'seed', label: 'マップ', values: null, fmt: (v) => (v ? `シード ${v}` : 'ランダム') },
  { key: 'start', label: '▶ 開始', values: null, fmt: () => 'Enter' },
];
const custom = { ...CUSTOM_DEFAULTS, row: 0 };
{
  // Saved values that are still valid (the form only offers valid ones).
  const saved = profile.get('custom') || {};
  for (const k of Object.keys(CUSTOM_DEFAULTS)) if (saved[k] !== undefined) customCommand([`${k}=${saved[k]}`], custom);
  if (Number.isInteger(saved.row)) custom.row = saved.row;
}

function saveCustom() {
  profile.put('custom', { ...custom });
}

function openCustom() {
  show('title', false);
  show('customwin');
  vim.setMode('form');
  renderCustom();
}

function renderCustom() {
  const ol = $('custom-list');
  ol.innerHTML = '';
  CUSTOM_ROWS.forEach((r, i) => {
    const li = document.createElement('li');
    if (i === custom.row) li.className = 'sel';
    const off = r.key === 'frags' && custom.rule === 'last';
    if (off) li.classList.add('disabled');
    const v = r.key === 'start' ? '' : `◀ ${r.fmt(custom[r.key])} ▶`;
    li.innerHTML = `${esc(r.label)}<span class="sub">${esc(off ? '(復活なしでは使わない)' : v)}</span>`;
    ol.appendChild(li);
  });
}

function customMove(n) {
  custom.row = Math.max(0, Math.min(CUSTOM_ROWS.length - 1, custom.row + n));
  renderCustom();
}

function customChange(n) {
  const r = CUSTOM_ROWS[custom.row];
  if (r.key === 'start') return;
  if (r.key === 'seed') custom.seed = Math.max(0, Math.min(99999, custom.seed + n));
  else {
    const i = r.values.indexOf(custom[r.key]);
    custom[r.key] = r.values[Math.max(0, Math.min(r.values.length - 1, (i < 0 ? 0 : i) + n))];
  }
  saveCustom();
  sound.click();
  renderCustom();
}

function customSubmit() {
  show('customwin', false);
  const seed = custom.seed || Math.floor(Math.random() * 100000);
  startPractice(custom.bots, {
    custom: true,
    noRespawn: custom.rule === 'last',
    skill: custom.skill,
    time: custom.time * 60,
    frags: custom.rule === 'last' ? 0 : custom.frags,
    noRing: custom.ring === 'off',
    noTanks: custom.tanks === 'off',
    seed,
  });
}

function customCancel() {
  show('customwin', false);
  showTitle();
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
  // Watching always ends the stop screen, whichever path started it.
  game.bsodPending = false;
  hideDeath();
  game.watching = true;
  game.ads = false;
  game.zoom = 0;
  game.fire = false;
  game.held = { fwd: false, back: false, left: false, right: false, up: false, down: false, tiltUp: false, tiltDown: false };
  // Watching by choice starts with the automatic camera; out of a round,
  // with the killer's eyes (a turns the automatic camera on).
  game.auto = who == null && settings.get('autocam');
  if (game.director) game.director.reset();
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

function director() {
  if (!game.director || game.director.world !== game.world) game.director = new Director(game.world);
  return game.director;
}

/// The automatic camera on or off. On: it pulls back from the view on
/// screen. Off: the eyes of whoever it was showing.
function setAuto(on) {
  game.auto = on;
  if (!on) return;
  const d = director();
  d.reset();
  d.start({ x: game.pos.x, y: game.pos.y + 1.6, z: game.pos.z, yaw: game.yaw, pitch: game.pitch, fov: game.fov });
  if (game.follow != null && !game.free && !game.sky) d.force(game.follow);
  game.free = null;
  game.sky = null;
  game.autoFree = false;
}

/// The wipe (the followed player's own view, small, bottom right) while the
/// automatic camera is on: only where there is room for it.
function pipRect() {
  if (!settings.get('autopip') || touch.active || vim.mode === 'map') return null;
  const W = window.innerWidth;
  const H = window.innerHeight;
  if (W < 900 || H < 540) return null;
  const w = Math.round(Math.max(280, Math.min(440, W * 0.26)));
  const h = Math.round((w * 9) / 16);
  return { x: W - w - 14, y: H - h - 54, w, h };
}

let pipKey = '';
function showPip(rect, name = '') {
  const key = rect ? `${rect.x},${rect.y},${rect.w},${rect.h}` : '';
  if (rect) setText($('pip-name'), `${name} の視点`);
  if (key === pipKey) return;
  pipKey = key;
  const el = $('pip');
  show('pip', !!rect);
  // Balloons stack above the wipe instead of over it.
  document.body.style.setProperty('--pip', rect ? `${rect.h + 14}px` : '0px');
  if (!rect) return;
  el.style.left = `${rect.x}px`;
  el.style.top = `${rect.y}px`;
  el.style.width = `${rect.w}px`;
  el.style.height = `${rect.h}px`;
}

function stopWatching() {
  show('followcard', false);
  showPip(null);
  game.auto = false;
  game.watching = false;
  game.follow = null;
  game.free = null;
  game.sky = null;
  if (renderer) renderer.labelScale = 1;
  show('watchbar', false);
  if (vim.mode === 'spectate' || vim.mode === 'map') vim.setMode('normal');
}

function followNext(n) {
  const list = alivePlayers();
  game.free = null;
  game.sky = null;
  if (!list.length) {
    game.follow = null;
    return;
  }
  const i = list.findIndex((p) => p.id === game.follow);
  const k = i < 0 ? (n > 0 ? 0 : list.length - 1) : (((i + n) % list.length) + list.length) % list.length;
  game.follow = list[k].id;
}

/// Looking straight down (the sky view's start), and how far up u/d tilt
/// the sky view and the free camera (radians).
const SKY_DOWN = -Math.PI / 2 + 0.001;
const SKY_TILT_MAX = -0.25;
const FREE_PITCH = [-Math.PI / 2 + 0.01, 0.6];

/// u/d held: how far to tilt this frame.
function tiltStep(dt) {
  const h = game.held;
  return ((h.tiltUp ? 1 : 0) - (h.tiltDown ? 1 : 0)) * 0.9 * (game.shiftDown ? 2.5 : 1) * dt;
}

/// The view from the sky: straight down over the field (u/d tilt it).
function startSky() {
  const c = game.free || game.pos;
  game.follow = null;
  game.free = null;
  game.autoFree = false;
  game.sky = { x: c.x, z: c.z, h: 120, yaw: 0, pitch: SKY_DOWN };
}

function startFree() {
  game.sky = null;
  game.follow = null;
  game.autoFree = false;
  // From where the camera is now, a little higher.
  game.free = { x: game.pos.x, y: game.pos.y + 8, z: game.pos.z, yaw: game.yaw, pitch: -0.35 };
}

/// One frame while watching: the automatic camera, the followed player's
/// eyes, or the free camera.
function watchFrame(now, dt) {
  const view = interpolated(now);
  let auto = null;
  if (game.auto) {
    const alive = [...view.values()].filter((p) => p.alive && p.id !== game.myId);
    auto = director().update(now / 1000, dt, alive);
    if (auto) {
      game.free = null;
      game.sky = null;
      game.autoFree = false;
      if (auto.subject != null) game.follow = auto.subject;
    }
  }
  let target = game.follow != null ? view.get(game.follow) : null;
  if (auto) {
    // The director decides whom to show.
  } else if (game.autoFree && alivePlayers().length) {
    // Somebody to watch appeared: leave the stand-in overview.
    game.autoFree = false;
    game.free = null;
  }
  if (!auto && !game.free && !game.sky && (!target || !target.alive)) {
    followNext(1);
    target = game.follow != null ? view.get(game.follow) : null;
    if (!target) {
      // Nobody to follow yet: an overview until someone appears.
      startFree();
      game.autoFree = true;
    }
  }
  // From the sky every player is marked and named in large letters.
  renderer.labelScale = game.sky ? Math.max(1, game.sky.h / 22) : 1;
  for (const [id, p] of view) {
    if (id === game.myId) continue;
    // The automatic camera marks the one it follows (yellow ▼).
    const mark = auto ? (p.alive && id === auto.subject ? 'spotted' : null) : game.sky ? (p.alive ? 'seen' : null) : markOf(id, p, now);
    renderer.setPlayer(id, p, nameOf(id), mark);
  }
  renderer.setTanks(interpolatedTanks(now), game.specs && game.specs.tank_hp, null, tankLabel);
  renderer.setRing(game.ring);
  // A player's eyes: on foot, or from the top of the tank they drive.
  const eyesOf = (t) => {
    const gun = t.gun && GUNS[t.gun];
    const inTank = t.tank != null;
    return {
      x: t.x,
      y: t.y + (inTank ? TANK.eye : eyeHeight(t.sneak)),
      z: t.z,
      yaw: t.yaw,
      pitch: t.pitch,
      fov: !t.ads ? settings.get('fov') : inTank ? TANK.ads : gun ? gun.ads : settings.get('fov'),
    };
  };
  let cam;
  let vm = { ads: 0, hide: true, bob: 0, kick: 0 };
  let scoped = false;
  let inset = null;
  if (auto) {
    cam = auto.cam;
    renderer.setHeld(null);
    const rect = target && target.alive ? pipRect() : null;
    if (rect) {
      // The wipe: what the followed player sees, gun and all.
      const flash = performance.now() - (muzzleAt.get(target.id) || -1e9) < 50;
      const inTank = target.tank != null;
      const scope = target.ads && target.gun === 'sr';
      inset = { cam: eyesOf(target), rect, hide: target.id, vm: { held: inTank ? null : target.gun, ads: target.ads ? 1 : 0, kick: flash ? 0.04 : 0, flash, hide: inTank || scope } };
    }
    showPip(rect, target ? nameOf(target.id) : '');
  } else if (game.sky) {
    const k = game.sky;
    if (game.turnLeft) {
      k.yaw = wrapAngle(k.yaw + game.turnLeft);
      game.turnLeft = 0;
    }
    const h = game.held;
    const speed = k.h * 0.9 * (game.shiftDown ? 3 : 1) * dt;
    const up = (h.fwd ? 1 : 0) - (h.back ? 1 : 0);
    const right = (h.right ? 1 : 0) - (h.left ? 1 : 0);
    // Screen up is the camera's yaw direction.
    k.x += (-Math.sin(k.yaw) * up + Math.cos(k.yaw) * right) * speed;
    k.z += (-Math.cos(k.yaw) * up - Math.sin(k.yaw) * right) * speed;
    k.h = Math.max(20, Math.min(400, k.h * (1 + ((h.up ? 1 : 0) - (h.down ? 1 : 0)) * 1.2 * dt)));
    k.pitch = Math.max(SKY_DOWN, Math.min(SKY_TILT_MAX, k.pitch + tiltStep(dt)));
    const half = game.map.half;
    k.x = Math.max(-half, Math.min(half, k.x));
    k.z = Math.max(-half, Math.min(half, k.z));
    // The camera looks at (k.x, k.z) from k.h away: tilting (u/d) swings it
    // back along the view, so the spot stays in the middle of the screen.
    const ground = game.world.height(k.x, k.z);
    const back = k.h * Math.cos(k.pitch);
    const cx = k.x + Math.sin(k.yaw) * back;
    const cz = k.z + Math.cos(k.yaw) * back;
    const cy = Math.max(ground - k.h * Math.sin(k.pitch), game.world.height(cx, cz) + 2);
    cam = { x: cx, y: cy, z: cz, yaw: k.yaw, pitch: k.pitch, fov: settings.get('fov'), lift: cy - ground };
    renderer.setHeld(null);
  } else if (game.free || !target) {
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
    f.pitch = Math.max(FREE_PITCH[0], Math.min(FREE_PITCH[1], f.pitch + tiltStep(dt)));
    const half = game.map.half;
    f.x = Math.max(-half, Math.min(half, f.x));
    f.z = Math.max(-half, Math.min(half, f.z));
    cam = { x: f.x, y: f.y, z: f.z, yaw: f.yaw, pitch: f.pitch, fov: settings.get('fov') };
    renderer.setHeld(null);
  } else {
    renderer.hidePlayer(target.id);
    const inTank = target.tank != null;
    scoped = target.ads && target.gun === 'sr' && !inTank;
    cam = eyesOf(target);
    renderer.setHeld(inTank ? null : target.gun || null);
    // Their shots kick the gun as your own do (see 'shot').
    vm = { ads: target.ads ? 1 : 0, hide: scoped || inTank, bob: 0, kick: game.kick };
  }
  if (!auto) showPip(null);
  show('scope', scoped);
  $('crosshair').dataset.mode = auto ? 'none' : game.free ? 'other' : target && target.ads ? 'view' : 'normal';
  // The compass, markers and sound follow the camera. (Where the camera
  // is and looks is also what the map shows as your own view.)
  game.camPitch = cam.pitch;
  game.pos = { x: cam.x, y: cam.y - 1.6, z: cam.z };
  game.yaw = cam.yaw;
  game.pitch = cam.pitch;
  game.fov = cam.fov;
  game.kick = settings.get('bob') ? Math.max(0, game.kick - dt * 0.6) : 0;
  renderer.updateEffects(dt);
  renderer.render(cam, vm, inset);
  sound.listener(cam.x, cam.y, cam.z, cam.yaw, cam.pitch || 0);
  if (vim.mode === 'map') drawMap();
}

function updateWatchHud() {
  const view = game.snaps.length ? game.snaps[game.snaps.length - 1].players : new Map();
  const t = game.follow != null ? view.get(game.follow) : null;
  const r = game.roster.get(game.myId);
  const voluntary = r && r.spectator;
  let line;
  if (game.auto && t && !game.free) {
    const rival = game.director && game.director.rival != null && t.alive ? ` vs ${nameOf(game.director.rival)}` : '';
    line = `自動カメラ: ${nameOf(t.id)}${rival} — a 選手の視点 · n / N 選手を切り替え · o 自由視点 · O 空から · m マップ`;
  } else if (game.sky) line = '空からの視点 — hjkl 移動 · K/J 高さ · u/d 角度 · Shift で速く · , . 回転 · m マップ · n で選手を追う';
  else if (game.free || !t) line = '自由視点 — k/j 前後 · h/l 旋回 · K/J 上下 · u/d 見上げる・見下ろす · Shift で速く · O 空から · n で選手を追う · a 自動カメラ';
  else line = `${nameOf(t.id)} を観戦中 — a 自動カメラ · n / N 切り替え · o 自由視点 · O 空から · m マップ`;
  const tail = voluntary ? ' · :play で参加' : !game.respawnMode ? ' · 次のラウンドまで観戦' : '';
  setText($('watchbar'), line + tail);
  // The followed player's card.
  const card = $('followcard');
  show('followcard', !!t && !game.free && !game.sky);
  if (t && !game.free && !game.sky) {
    const rr = game.roster.get(t.id);
    const hpv = t.hp != null ? Math.max(0, Math.round(t.hp)) : null;
    // A fight: the other side's health too.
    const oid = t.alive ? opponentOf(t.id, view) : null;
    const o = oid != null ? view.get(oid) : null;
    const ohp = o && o.hp != null ? Math.max(0, Math.round(o.hp)) : null;
    const key = `${t.id}|${hpv}|${t.gun}|${rr ? `${rr.kills}/${rr.deaths}` : ''}|${t.ads}|${oid}|${ohp}`;
    if (card.dataset.key !== key) {
      card.dataset.key = key;
      card.innerHTML =
        `<div class="titlebar"><span>${esc(nameOf(t.id))}${o ? ` vs ${esc(nameOf(oid))}` : ''}</span></div><div class="body">` +
        `<div class="hpbar big"><div style="width:${hpv ?? 0}%" class="${hpv != null && hpv <= 30 ? 'low' : ''}"></div></div>` +
        `<div class="row"><span>HP ${hpv ?? '?'}</span><span>${esc(gunName(t.gun))}${t.ads ? ' · 構え' : ''}</span>` +
        `<span>${rr ? `${rr.kills} キル / ${rr.deaths} デス` : ''}</span></div>` +
        (o
          ? `<div class="foe"><span class="vsx">vs</span><b>${esc(nameOf(oid))}</b><span>HP ${ohp ?? '?'}</span>` +
            `<div class="hpbar big"><div style="width:${ohp ?? 0}%"></div></div></div>`
          : '') +
        `</div>`;
    }
  }
  setText($('tb-weapon'), t && t.tank != null ? '戦車' : t && t.gun ? gunName(t.gun) : '観戦中');
  setText($('tb-items'), t ? nameOf(t.id) : '—');
  const hp = t && t.hp != null ? Math.max(0, t.hp) : 0;
  $('hp-fill').style.width = `${hp}%`;
  $('hp-fill').classList.toggle('low', hp <= 30);
  setText($('hp-text'), t ? String(hp) : '—');
  setText($('tb-kd'), r ? `${r.kills} / ${r.deaths}` : '');
  setText($('tb-ping'), pingLabel());
  setText($('clock'), clockText());
  if (game.intermission != null) setText($('result-next'), resultNext());
  show('progress', false);
  const rows = [...game.roster.values()].filter((x) => !x.spectator);
  const alive = rows.filter((x) => !x.out).length;
  setText($('rank'), game.lobby ? `待機中 · ${rows.length} 人` : (game.respawnMode ? `観戦中 · ${rows.length} 人` : `残り ${alive} 人 / ${rows.length} 人`) + ringLine());
  show('ringwarn', false);
  show('prompt', false);
}

/// The ring's state, as a second line under the rank.
function ringLine() {
  const r = game.ring;
  if (!r) return '';
  const n = (game.specs && game.specs.ring_radii && game.specs.ring_radii.length) || 5;
  if (r.t < 0) return `\nリング: 最終 (半径 ${Math.round(r.r)} m)`;
  return r.shrinking ? `\nリング縮小中 ${r.stage + 1}/${n} · あと ${fmtTime(r.t)}` : `\nリング ${r.stage + 1}/${n} · 縮小まで ${fmtTime(r.t)}`;
}

/// Which on-screen keys fit what is going on (touch.js: SCENES).
function touchScene() {
  const m = vim.mode;
  if (m === 'insert' || m === 'command') return 'typing';
  if (['menu', 'msg', 'form', 'inventory', 'map'].includes(m)) return m;
  if (!game.conn || !game.map) return 'menu';
  if (m === 'spectate') return game.free || game.sky ? 'fly' : 'watch';
  if (game.intermission != null || !game.alive) return 'wait';
  if (game.myTank != null) return 'tank';
  return tankInReach() ? 'boarding' : 'combat';
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
  // Outside the ring: which way its middle is.
  if (game.ring && !game.watching && ringOutside() > 0) dot(game.ring.x - game.pos.x, game.ring.z - game.pos.z, 'ring', '◆');
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
  const tank = myTank();
  let weapon = '素手';
  if (tank) weapon = tank.reload >= 0 ? `戦車砲  装填中 ${Math.round(tank.reload * 100)}%` : '戦車砲  装填済み';
  else if (sel === 'medkit') weapon = `回復キット × ${me.inv.medkits}`;
  else if (sel === 'grenade') weapon = `グレネード × ${me.inv.grenades}`;
  else if (gun) weapon = `${gunName(gun.gun)}  ${gun.ammo} / ${gun.reserve}`;
  setText($('tb-weapon'), weapon);
  setText($('tb-items'), tank ? `戦車 HP ${Math.max(0, tank.hp)}` : `+${me.inv.medkits}  G${me.inv.grenades}${game.sneak ? '  スニーク' : ''}`);
  const hp = Math.max(0, me.hp);
  $('hp-fill').style.width = `${hp}%`;
  $('hp-fill').classList.toggle('low', hp <= 30);
  setText($('hp-text'), String(hp));
  const r = game.roster.get(game.myId);
  setText($('tb-kd'), r ? `${r.kills} / ${r.deaths}` : '');
  setText($('tb-ping'), pingLabel());
  setText($('clock'), game.range ? '∞' : clockText());
  if (game.intermission != null) setText($('result-next'), resultNext());

  // Reload / heal progress.
  const prog = tank ? (tank.reload >= 0 ? ['砲弾を装填中', tank.reload] : null) : me.reload >= 0 ? ['リロード', me.reload] : me.heal >= 0 ? ['回復中', me.heal] : null;
  show('progress', !!prog && game.alive);
  if (prog) {
    setText($('progress-title'), prog[0]);
    $('progress-fill').style.width = `${Math.round(prog[1] * 100)}%`;
  }
  if (!game.alive && game.respawnMode) updateDeath(me.respawn);

  // Outside the ring: a warning that cannot be missed.
  const out = game.alive ? ringOutside() : -1;
  show('ringwarn', out > 0);
  if (out > 0) setText($('ringwarn-text'), `リングの外にいます — 円の中へ ${Math.ceil(out)} m (毎秒 −${game.ring.dps} HP)`);
  // What e would do here.
  const reach = tankInReach();
  const hint = tank ? (vim.mode === 'view' ? '' : 'e: 戦車を降りる · v: 砲を構える') : reach ? 'e: 戦車に乗る' : '';
  show('prompt', !!hint && game.alive && game.intermission == null && (vim.mode === 'normal' || vim.mode === 'view'));
  setText($('prompt'), hint);

  // Rank (top right).
  if (game.range) {
    setText($('rank'), '射撃訓練場 · :q で終了');
    return;
  }
  const ringText = ringLine();
  const rows = [...game.roster.values()].filter((r) => !r.spectator);
  const idx = rows.findIndex((x) => x.id === game.myId);
  const top = rows[0];
  setText($('rank'), (idx >= 0 ? `${idx + 1} 位 / ${rows.length} 人${top ? ` · 1 位 ${top.name} ${top.kills}` : ''}` : '') + ringText);
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
  customwin: () => customCancel(),
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
if (new URLSearchParams(location.search).has('debug')) window.vimfps = { game, settings, profile, sourceText, importBundle, skins, onMessage: (m) => onMessage(m), startPractice, addTextures, touch: () => touch.scene, sound };

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
  // After server-info.json: it says whether the host serves a skin.
  loadLook();
  buildMenu();
  requestAnimationFrame(frame);
}

boot();
