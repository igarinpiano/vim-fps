// The admin page: watch everyone at once (each player's view as a little
// window on the monitor, a map, the ranking with health and ping) and run
// the matches and the bots. XP windows like the game, worked with Vim keys
// (the mouse works too):
//
//   gt / gT / {n}gt, Tab, Ctrl-w w / h j k l   go to another window
//   j / k  h / l  Enter  gg / G  {count}        inside a window
//   :  command line (the host terminal's commands, :w saves the rules)
//   i  message to everyone   ?  keys   m  views / map   Esc  back
//
// The connection opens with the admin key; the host refuses anything
// else. The key comes from the URL (#key=...), is kept for this tab only,
// and is taken out of the address bar at once (the page may be on a
// stream).

import { GUNS, TANK, World, eyeHeight, wrapAngle } from './world.js';
import { Director } from './director.js';
import { VERSION } from './version.js';

const $ = (id) => document.getElementById(id);
const KEY_STORE = 'vimfps-admin-key';
const SKILL_NAMES = ['とても弱い', '弱い', '普通', '強い', 'とても強い'];
const WINDOWS = ['monitor', 'match', 'map', 'rank', 'bots', 'rules', 'log'];

// ---------------------------------------------------------------- state

const S = {
  ws: null,
  key: null,
  name: '',
  map: null,
  specs: null,
  state: null,
  /// id -> {x, y, z, yaw, pitch} drawn (smoothed toward the latest state).
  view: new Map(),
  roster: new Map(),
  pickups: [],
  /// id -> time of the last shot fired or hit taken (red title bars).
  action: new Map(),
  /// id -> time of the last shot (muzzle flash and kick in their view).
  muzzle: new Map(),
  /// The view shown alone on the monitor, or null.
  solo: null,
  /// The player picked (monitor, map and ranking share it).
  sel: null,
  /// Monitor: 'tiles' (everyone's view) or 'map'.
  mode: 'tiles',
  showBots: false,
  /// Views on the monitor at once (0: as many as there are, sized to fit),
  /// the page shown, and seconds between pages (0: no cycling).
  perPage: 0,
  page: 0,
  cycle: 0,
  cycleAt: 0,
  /// The camera tile: 'auto' (the director, as spectators see it),
  /// 'free' (moved by hand) or 'off'. `free` is where the hand-moved camera
  /// is; `held` the keys holding it in motion; `out` the director's last
  /// pick ({subject, rival}).
  cam: { mode: 'auto', free: { x: 0, y: 60, z: 120, yaw: 0, pitch: -0.4 }, held: new Map(), director: null, out: null },
  world: null,
  /// The monitor fills the page (F).
  max: false,
  retry: null,
  refused: false,
  // Keys.
  focus: 0,
  vmode: 'normal',
  count: '',
  pending: '',
  cur: { match: 0, bots: 0, rules: 0 },
  countdown: 5,
  /// The rules being edited (null: the host's).
  draft: null,
  history: [],
  histAt: 0,
  msgClose: null,
  msgYes: null,
};

let renderer = null;
let mapImage = null;

/// How the monitor is laid out is this viewer's own (kept in this browser).
const VIEW_STORE = 'vimfps-admin-view';
const PER_PAGE = [0, 1, 2, 3, 4, 6, 9, 12, 16];
const CYCLES = [0, 5, 10, 20, 30];

function loadView() {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_STORE) || '{}');
    if (PER_PAGE.includes(v.perPage)) S.perPage = v.perPage;
    if (CYCLES.includes(v.cycle)) S.cycle = v.cycle;
    if (v.cam === 'auto' || v.cam === 'off') S.cam.mode = v.cam;
    if (typeof v.showBots === 'boolean') S.showBots = v.showBots;
  } catch {
    // No storage: the defaults.
  }
}

function saveView() {
  try {
    localStorage.setItem(VIEW_STORE, JSON.stringify({ perPage: S.perPage, cycle: S.cycle, showBots: S.showBots, cam: S.cam.mode === 'off' ? 'off' : 'auto' }));
  } catch {
    // Not kept: fine for this visit.
  }
}

function storeGet() {
  try {
    return sessionStorage.getItem(KEY_STORE);
  } catch {
    return null;
  }
}
function storeSet(v) {
  try {
    if (v) sessionStorage.setItem(KEY_STORE, v);
    else sessionStorage.removeItem(KEY_STORE);
  } catch {
    // Private window: the key is only in memory.
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmtTime(s) {
  const t = Math.max(0, Math.ceil(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function nameOf(id) {
  const p = S.state && S.state.players.find((q) => q.id === id);
  if (p) return p.name;
  const r = S.roster.get(id);
  return r ? r.name : `#${id}`;
}

function gunName(g) {
  return (GUNS[g] || { name: g || '—' }).name;
}

function pingClass(ms) {
  if (ms == null) return '';
  return ms < 60 ? 'ok' : ms < 150 ? 'mid' : 'bad';
}

function hpClass(hp) {
  return hp <= 25 ? 'low' : hp <= 50 ? 'mid' : '';
}

/// Players on the field (not spectators), ranked.
function players() {
  return S.state ? S.state.players.filter((p) => !p.spectator) : [];
}

/// The bots, in the order they came (not by score: rows stay put).
function bots() {
  return players()
    .filter((p) => p.bot)
    .sort((a, b) => a.id - b.id);
}

// ---------------------------------------------------------------- log on

function signIn(key) {
  S.key = key;
  S.refused = false;
  connect();
}

function showSignin(error) {
  $('desk').hidden = true;
  $('signin').hidden = false;
  $('signin-error').textContent = error || '';
  $('signin-key').focus();
}

$('signin-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const key = $('signin-key').value.trim();
  if (key) signIn(key);
});

function signOut() {
  storeSet(null);
  S.refused = true;
  S.key = null;
  if (S.ws) S.ws.close();
  S.map = null;
  $('signin-key').value = '';
  showSignin('ログオフしました');
}

// ---------------------------------------------------------------- connection

function connect() {
  clearTimeout(S.retry);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws;
  try {
    ws = new WebSocket(`${proto}//${location.host}/admin/ws`);
  } catch (e) {
    showSignin(`接続できません: ${e.message || e}`);
    return;
  }
  S.ws = ws;
  setLink('接続中…', false);
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', key: S.key }));
  ws.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    onMessage(m);
  };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    S.ws = null;
    if (S.refused) return;
    if (!S.map) {
      showSignin('ホストに接続できません。ホストが動いているか、このページのアドレスを確かめてください');
      return;
    }
    setLink('切断 · 再接続中…', true);
    S.retry = setTimeout(connect, 2500);
  };
}

function send(msg) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(msg));
  else note('E: ホストにつながっていません', true);
}

function setLink(text, down) {
  const el = $('link');
  el.textContent = text;
  el.classList.toggle('down', !!down);
}

function onMessage(m) {
  switch (m.t) {
    case 'admin_welcome':
      onWelcome(m);
      break;
    case 'admin_state':
      onState(m);
      break;
    case 'admin_reply':
      if (!m.ok && !S.map) {
        // The key was refused.
        S.refused = true;
        storeSet(null);
        showSignin(m.text);
        return;
      }
      if (m.text.includes('\n')) showMessage(':status', m.text);
      else if (m.text) {
        note(m.ok ? m.text : `E: ${m.text}`, !m.ok);
        log(m.text, m.ok ? 'admin' : 'err');
      }
      break;
    case 'roster':
      S.roster = new Map(m.players.map((p) => [p.id, p]));
      break;
    case 'pickups':
      S.pickups = m.list;
      if (renderer) renderer.setPickups(m.list);
      break;
    case 'shot':
      S.action.set(m.id, performance.now());
      S.muzzle.set(m.id, performance.now());
      if (S.cam.director) S.cam.director.note('shot', m.id);
      if (renderer) renderer.tracer(m.from, m.to, false, m.vel, S.specs && S.specs.gravity);
      break;
    case 'shell':
      S.action.set(m.id, performance.now());
      if (renderer) renderer.shell(m.from, m.to, m.vel, S.specs && S.specs.gravity);
      break;
    case 'explode':
      if (renderer) renderer.explosion(m.pos);
      break;
    case 'hit':
      S.action.set(m.attacker, performance.now());
      S.action.set(m.victim, performance.now());
      // As in the player's own view: a mark when they hit, red edges when
      // they are hit.
      if (S.cam.director && m.victim) S.cam.director.note('hit', m.attacker, m.victim);
      if (m.victim && m.attacker !== m.victim) {
        flashTile(m.attacker, m.head ? 'hithead' : 'hit', 160);
        flashTile(m.victim, 'hurt', 350);
      }
      break;
    case 'kill': {
      if (S.cam.director) S.cam.director.note('kill', m.killer, m.victim);
      const how = m.cause === 'grenade' ? 'グレネード' : m.cause === 'tank' ? '戦車' : m.cause === 'ring' ? 'リングの外' : gunName(m.cause && m.cause.gun);
      const dist = m.killer !== m.victim && m.dist ? ` · ${Math.round(m.dist)} m` : '';
      const text =
        m.killer === m.victim
          ? `<b>${esc(nameOf(m.victim))}</b> が倒れました (${how})`
          : `<b>${esc(nameOf(m.killer))}</b> ▶ ${esc(nameOf(m.victim))} · ${how}${m.head ? ' · ヘッドショット' : ''}${dist}`;
      log(text, 'kill', true);
      break;
    }
    case 'chat':
      log(`<b>${esc(m.name)}</b>: ${esc(m.text)}`, m.from === 0 ? 'admin' : '', true);
      break;
    case 'sys':
      log(m.text, 'sys');
      break;
    case 'match_end':
      log(`試合終了 · 1 位 ${esc(m.ranking[0] ? m.ranking[0].name : '—')}`, 'admin', true);
      break;
    default:
      break;
  }
}

async function onWelcome(m) {
  storeSet(S.key);
  S.name = m.name;
  S.specs = m.specs;
  S.maxBots = m.max_bots || 500;
  $('signin').hidden = true;
  $('desk').hidden = false;
  $('admin-name').textContent = m.name;
  document.title = `${m.server} の管理 — vim-fps`;
  setLink(m.version === VERSION ? '接続中' : `ホスト v${m.version} / ページ v${VERSION}`, false);
  if (document.activeElement === $('signin-key')) $('signin-key').blur();
  const fresh = !S.map || S.map.seed !== m.map.seed;
  S.map = m.map;
  if (fresh) {
    S.world = new World(m.map);
    S.cam.director = null;
  }
  S.server = m.server;
  if (fresh) {
    mapImage = null;
    await buildRenderer();
  }
  setFocus(S.focus);
  layoutTiles(true);
}

async function buildRenderer() {
  if (!renderer) {
    try {
      const { Renderer } = await import('./render.js');
      const settings = { get: (k) => ({ nameplates: true, hpbars: true, uianim: false })[k] };
      renderer = new Renderer($('gl'), settings);
      // The canvas covers the monitor, not the window.
      renderer.resize = () => {
        const c = $('gl');
        renderer.renderer.setSize(c.clientWidth || 1, c.clientHeight || 1, false);
      };
      new ResizeObserver(() => {
        renderer.resize();
        layoutTiles(true);
      }).observe($('screens'));
      renderer.resize();
    } catch (e) {
      note(`E: 視点の表示 (WebGL) を開始できません: ${e.message || e}`, true);
      renderer = null;
    }
  }
  if (renderer) {
    renderer.buildMap(S.map);
    renderer.setPickups(S.pickups);
  }
}

// ---------------------------------------------------------------- state

const PHASE_NAMES = { lobby: '待機中', countdown: 'まもなく開始', live: '試合中', results: '結果' };

function onState(st) {
  const prev = S.state;
  S.state = st;
  document.body.dataset.phase = st.phase;
  $('phase-name').textContent = PHASE_NAMES[st.phase] || st.phase;
  const clock =
    st.phase === 'countdown'
      ? `${st.countdown ?? 0} 秒`
      : st.phase === 'results'
        ? fmtTime(st.intermission ?? 0)
        : st.phase === 'lobby'
          ? fmtTime(st.next.time_limit * 60)
          : fmtTime(st.left);
  $('phase-clock').textContent = clock;
  $('phase-clock').classList.toggle('low', st.phase === 'live' && st.left <= 60);
  $('clock').textContent = `${PHASE_NAMES[st.phase]} ${clock}`;

  // Smoothing starts from the first position seen (and from a respawn).
  for (const p of st.players) {
    const was = prev && prev.players.find((q) => q.id === p.id);
    if (!S.view.has(p.id) || (was && !was.alive && p.alive)) S.view.set(p.id, { x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch });
  }
  for (const id of [...S.view.keys()]) if (!st.players.some((p) => p.id === id)) S.view.delete(id);
  if (S.sel != null && S.sel !== CAM && !players().some((p) => p.id === S.sel)) S.sel = null;

  renderAll();
  if (renderer) {
    renderer.setGrenades(st.grenades);
    renderer.setRing(st.ring);
  }
}

function renderAll() {
  if (!S.state) return;
  renderMatch();
  renderRank();
  renderBots();
  renderRules();
  layoutTiles(false);
}

function rulesText(s) {
  if (!s) return '';
  return `${s.time_limit} 分 · ${s.respawn ? `${s.frag_limit} キル先取` : '復活なし'} · 強さ ${s.bot_skill} · リング${s.ring ? 'あり' : 'なし'} · 戦車${s.tanks ? 'あり' : 'なし'}`;
}

// ---------------------------------------------------------------- list windows

/// Draws rows into a list (only when something changed, so a click is
/// never lost to a redraw). Row: {label, sub, val, ok, danger, dirty}.
function renderList(ol, rows, cur) {
  const key = JSON.stringify([rows.map((r) => [r.label, r.sub, r.val, r.ok, r.danger, r.dirty]), cur]);
  if (ol._key === key) return;
  ol._key = key;
  ol.innerHTML = '';
  rows.forEach((r, i) => {
    const li = document.createElement('li');
    li.className = [i === cur ? 'sel' : '', r.ok === false ? 'disabled' : '', r.danger ? 'danger' : '', r.dirty ? 'dirty' : ''].join(' ');
    li.innerHTML = `${esc(r.label)}${r.sub ? `<span class="sub">${esc(r.sub)}</span>` : ''}${
      r.val != null ? `<span class="val">${r.adj ? '<a data-d="-1">◀</a>' : ''}${esc(r.val)}${r.adj ? '<a data-d="1">▶</a>' : ''}</span>` : ''
    }`;
    li.dataset.i = i;
    ol.appendChild(li);
  });
}

// 2: the match

function matchRows() {
  const st = S.state;
  const ph = st ? st.phase : 'none';
  return [
    {
      label: ph === 'countdown' ? `開始まで ${st.countdown ?? 0} 秒` : ph === 'live' ? '試合中' : '試合を開始',
      val: `秒読み ${S.countdown} 秒`,
      ok: ph === 'lobby' || ph === 'results',
      adj: (d) => {
        S.countdown = clamp(S.countdown + d, 0, 60);
        renderMatch();
      },
      run: () => send({ t: 'start', countdown: S.countdown }),
    },
    { label: '開始を取り消す', ok: ph === 'countdown', run: () => send({ t: 'cancel' }) },
    { label: '試合を終了', sub: '結果を出して待機へ', ok: ph === 'live', danger: true, run: () => ask('試合を終了して結果を出しますか？', () => send({ t: 'end' })) },
    {
      label: '待機に戻す',
      sub: '結果なし',
      ok: ph !== 'lobby' && ph !== 'none',
      danger: true,
      run: () => (ph === 'live' ? ask('結果を出さずに試合を中止して、待機に戻しますか？', () => send({ t: 'lobby' })) : send({ t: 'lobby' })),
    },
    {
      label: '結果のあと次の試合へ',
      val: st && st.auto ? '自動で始める' : '管理者が始める',
      ok: !!st,
      adj: () => send({ t: 'auto', on: !(st && st.auto) }),
      run: () => send({ t: 'auto', on: !(st && st.auto) }),
    },
  ];
}

function renderMatch() {
  renderList($('match-list'), matchRows(), S.cur.match);
}

// 4: ranking

function renderRank() {
  const body = $('ranking').querySelector('tbody');
  const rows = players();
  const st = S.state;
  const key = JSON.stringify([rows.map((p) => [p.id, p.name, p.alive, Math.round(p.hp), p.kills, p.deaths, p.ping, p.out]), S.sel]);
  if (body._key !== key) {
    body._key = key;
    body.innerHTML = '';
    rows.forEach((p, i) => {
      const tr = document.createElement('tr');
      tr.className = [!p.alive ? 'dead' : '', p.bot ? 'bot' : '', p.id === S.sel ? 'sel' : ''].join(' ');
      const hp = p.alive ? Math.max(0, Math.round(p.hp)) : !st.settings.respawn && p.out ? '敗退' : '—';
      const ping = p.bot ? `強さ ${p.level ?? ''}` : p.ping != null ? `${p.ping} ms` : '—';
      tr.innerHTML = `<td>${i + 1}</td><td class="name" title="#${p.id}">${esc(p.name)}</td><td>${hp}</td><td>${p.kills}</td><td>${p.deaths}</td><td class="ping ${pingClass(p.ping)}">${ping}</td>`;
      tr.dataset.id = p.id;
      body.appendChild(tr);
    });
    if (!rows.length) body.innerHTML = '<tr><td colspan="6">まだ誰も参加していません</td></tr>';
  }
  const w = st.players.filter((p) => p.spectator);
  $('watchers').textContent = w.length ? `観戦: ${w.map((p) => p.name).join('、')}` : '';
}

// 5: bots

/// Values sent but not yet back in a state (keys pressed quickly in a
/// row build on them): 'bots' -> count, bot id -> level.
const pending = new Map();

function pendingOr(key, host) {
  const v = pending.get(key);
  if (v == null) return host;
  if (v.value === host || performance.now() - v.at > 1500) {
    pending.delete(key);
    return host;
  }
  return v.value;
}

function sendPending(key, value, msg) {
  pending.set(key, { value, at: performance.now() });
  send(msg);
  renderBots();
}

function botRows() {
  const st = S.state;
  const n = pendingOr('bots', st ? st.next.bots : 0);
  const max = S.maxBots || 500;
  const rows = [{ label: 'bot の数', sub: n > 150 ? '多いとホストが追いつかず試合が遅くなります' : '', val: `${n} 体`, adj: (d) => sendPending('bots', clamp(n + d, 0, max), { t: 'bots', n: clamp(n + d, 0, max) }) }];
  for (const b of bots()) {
    const l = pendingOr(b.id, b.level || 3);
    const set = (v) => sendPending(b.id, v, { t: 'bot_level', id: b.id, level: v });
    rows.push({
      label: b.name,
      sub: b.own_level ? '' : '全体の設定',
      val: `${l} ${SKILL_NAMES[l - 1]}`,
      adj: (d) => set(clamp(l + Math.sign(d) * Math.min(4, Math.abs(d)), 1, 5)),
      reset: () => send({ t: 'bot_level', id: b.id, level: null }),
      id: b.id,
    });
  }
  if (rows.length === 1) rows.push({ label: 'bot はいません (h / l で数を変える)', ok: false });
  return rows;
}

function renderBots() {
  const rows = botRows();
  S.cur.bots = clamp(S.cur.bots, 0, rows.length - 1);
  renderList($('bot-list'), rows, S.cur.bots);
}

// 6: rules of the next match

function rules() {
  return S.draft || (S.state ? S.state.next : null);
}

function editRule(fn) {
  const base = rules();
  if (!base) return;
  S.draft = { ...base };
  fn(S.draft);
  renderRules();
}

function ruleRows() {
  const r = rules();
  if (!r) return [];
  const host = S.state.next;
  const dirty = (k) => !!S.draft && S.draft[k] !== host[k];
  const yes = (v) => (v ? 'あり' : 'なし');
  return [
    { label: '時間', val: `${r.time_limit} 分`, dirty: dirty('time_limit'), adj: (d) => editRule((s) => (s.time_limit = clamp(Math.round(s.time_limit) + d, 1, 120))) },
    {
      label: '終了キル数',
      val: r.respawn ? `${r.frag_limit} キル` : '— (復活なし)',
      ok: r.respawn,
      dirty: dirty('frag_limit'),
      adj: (d) => editRule((s) => (s.frag_limit = clamp(s.frag_limit + d, 1, 999))),
    },
    { label: 'bot の強さ (全体)', val: `${r.bot_skill} ${SKILL_NAMES[r.bot_skill - 1]}`, dirty: dirty('bot_skill'), adj: (d) => editRule((s) => (s.bot_skill = clamp(s.bot_skill + Math.sign(d), 1, 5))) },
    { label: '復活', val: r.respawn ? 'あり' : 'なし (最後の 1 人が勝ち)', dirty: dirty('respawn'), adj: () => editRule((s) => (s.respawn = !s.respawn)), toggle: true },
    { label: 'リング', val: yes(r.ring), dirty: dirty('ring'), adj: () => editRule((s) => (s.ring = !s.ring)), toggle: true },
    { label: '戦車', val: yes(r.tanks), dirty: dirty('tanks'), adj: () => editRule((s) => (s.tanks = !s.tanks)), toggle: true },
    { label: S.draft ? '保存する (:w)' : '保存済み', ok: !!S.draft, run: saveRules },
  ];
}

function renderRules() {
  const rows = ruleRows();
  S.cur.rules = clamp(S.cur.rules, 0, Math.max(0, rows.length - 1));
  renderList($('rules-list'), rows, S.cur.rules);
  const st = S.state;
  if (!st) return;
  $('rules-note').textContent = S.draft
    ? '変更があります: Enter (保存の行) か :w で保存 · u で元に戻す'
    : JSON.stringify({ ...st.next, bots: 0 }) !== JSON.stringify({ ...st.settings, bots: 0 })
      ? `この試合: ${rulesText(st.settings)}`
      : st.phase === 'lobby'
        ? '「試合を開始」でこのルールの試合が始まります'
        : '変更は次の試合から反映されます';
}

function saveRules() {
  if (!S.draft || !S.state) return;
  send({ t: 'settings', settings: { ...S.draft, bots: S.state.next.bots } });
  S.draft = null;
  renderRules();
}

// ---------------------------------------------------------------- monitor

let tileKey = '';
const tileEls = new Map();
let tileCols = 1;

/// Everyone whose view may be on the monitor (bots if asked for).
function viewable() {
  return players().filter((p) => S.showBots || !p.bot);
}

/// Most views drawn at once when sized automatically (more go onto pages:
/// hundreds of bots would leave specks).
const AUTO_MAX = 25;

/// Views a page holds: the chosen number, or (automatic) everyone up to
/// AUTO_MAX. 0: all of them, sized to fit.
function perPage() {
  if (S.perPage > 0) return S.perPage;
  return viewable().length > AUTO_MAX ? AUTO_MAX : 0;
}

function pageCount() {
  const per = perPage();
  return per > 0 ? Math.max(1, Math.ceil(viewable().length / per)) : 1;
}

/// The camera tile's id (players' tiles go by their numbers).
const CAM = 'cam';

function camOn() {
  return S.cam.mode !== 'off';
}

/// The tiles on the monitor now: the camera (when on), then one page of
/// players.
function tileIds() {
  if (S.solo === CAM) return [CAM];
  const ps = shown().map((p) => p.id);
  return S.solo == null && camOn() ? [CAM, ...ps] : ps;
}

/// Whose views are on the monitor now (one page of them).
function shown() {
  const all = viewable();
  if (S.solo === CAM) return [];
  if (S.solo != null) return all.filter((p) => p.id === S.solo);
  const per = perPage();
  if (per <= 0) return all;
  S.page = clamp(S.page, 0, pageCount() - 1);
  return all.slice(S.page * per, (S.page + 1) * per);
}

/// More or fewer views at once (`+` / `-`), or sized to fit (`=`).
function setPerPage(v) {
  const sel = S.sel;
  S.perPage = v;
  S.page = 0;
  if (sel != null && v > 0) {
    const i = viewable().findIndex((p) => p.id === sel);
    if (i >= 0) S.page = Math.floor(i / v);
  }
  saveView();
  note(v > 0 ? `表示数: ${v}` : '表示数: 自動 (全員が入る大きさ)');
  layoutTiles(true);
}

function stepPerPage(d) {
  const i = PER_PAGE.indexOf(S.perPage);
  setPerPage(PER_PAGE[clamp((i < 0 ? 0 : i) + d, 0, PER_PAGE.length - 1)]);
}

function turnPage(d) {
  const n = pageCount();
  if (n <= 1) {
    note('ページは 1 つだけです (表示数を減らすとページに分かれます)');
    return;
  }
  S.page = (((S.page + d) % n) + n) % n;
  S.cycleAt = performance.now() + S.cycle * 1000;
  layoutTiles(true);
}

function stepCycle(d) {
  const i = CYCLES.indexOf(S.cycle);
  S.cycle = CYCLES[clamp((i < 0 ? 0 : i) + d, 0, CYCLES.length - 1)];
  S.cycleAt = performance.now() + S.cycle * 1000;
  saveView();
  renderMonitorBar();
}

function setShowBots(on) {
  S.showBots = on;
  saveView();
  layoutTiles(true);
}

/// The toolbar over the monitor (◀ ▶ work with a click or a tap).
function renderMonitorBar() {
  const bar = $('monitor-bar');
  const n = viewable().length;
  const pages = pageCount();
  const items = [
    ['per', '表示数', S.perPage > 0 ? `${S.perPage}` : n > AUTO_MAX ? `自動 (${AUTO_MAX} ずつ)` : `自動 (${n})`, false],
    ['page', 'ページ', S.solo != null ? '1 人' : `${S.page + 1} / ${pages}`, pages <= 1 || S.solo != null],
    ['cycle', '巡回', S.cycle > 0 ? `${S.cycle} 秒ごと` : 'しない', pages <= 1],
    ['bots', 'bot', S.showBots ? '出す' : '出さない', false],
    ['cam', 'カメラ', { auto: '自動', free: '手動', off: '出さない' }[S.cam.mode], false],
  ];
  const key = JSON.stringify(items);
  if (bar._key === key) return;
  bar._key = key;
  bar.innerHTML = items
    .map(([k, label, val, off]) => `<span class="${off ? 'off' : ''}" data-k="${k}"><b>${label}</b><a data-d="-1">◀</a><i>${esc(val)}</i><a data-d="1">▶</a></span>`)
    .join('');
}

$('monitor-bar').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-d]');
  const item = e.target.closest('[data-k]');
  if (!a || !item) return;
  const d = Number(a.dataset.d);
  ({ per: () => stepPerPage(d), page: () => turnPage(d), cycle: () => stepCycle(d), bots: () => setShowBots(!S.showBots), cam: () => stepCam(d) })[item.dataset.k]();
});

/// Lays the tiles out so all of them fit, each a 16:9 picture with its
/// title and status bars.
function layoutTiles(force) {
  if (!S.state) return;
  const box = $('tiles');
  const map = S.mode === 'map';
  box.hidden = map;
  $('gl').hidden = map;
  $('bigmap').hidden = !map;
  if (S.solo != null && S.solo !== CAM && !players().some((p) => p.id === S.solo)) S.solo = null;
  if (S.solo === CAM && !camOn()) S.solo = null;
  const ids = tileIds();
  const pages = pageCount();
  $('monitor-title').textContent = map
    ? 'モニター — マップ'
    : S.solo === CAM
      ? 'モニター — カメラ'
      : S.solo != null
        ? `モニター — ${nameOf(S.solo)} の視点`
        : `モニター — 視点 (${viewable().length})${pages > 1 ? ` · ${S.page + 1} / ${pages} ページ` : ''}`;
  renderMonitorBar();
  if (map) return;
  const key = JSON.stringify([ids, S.solo, S.mode, S.perPage]);
  if (force || key !== tileKey) {
    tileKey = key;
    const W = box.clientWidth - 12;
    const H = box.clientHeight - 12;
    const gap = 6;
    const bars = 20 + 22 + 2;
    // A fixed number of views keeps one size from page to page.
    const n = S.solo != null ? 1 : Math.max(1, (perPage() > 0 ? perPage() : shown().length) + (camOn() ? 1 : 0));
    let best = { cols: 1, w: 0 };
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      let w = (W - gap * (cols - 1)) / cols;
      const h = w * (9 / 16) + bars;
      if (h * rows + gap * (rows - 1) > H) w = ((H - gap * (rows - 1)) / rows - bars) * (16 / 9);
      if (w > best.w) best = { cols, w };
    }
    tileCols = best.cols;
    const w = Math.max(80, Math.floor(best.w));
    box.style.gridTemplateColumns = `repeat(${best.cols}, ${w}px)`;
    box.style.gridAutoRows = `${Math.floor(w * (9 / 16)) + bars}px`;
    for (const [id, el] of tileEls) {
      if (!ids.includes(id)) {
        el.remove();
        tileEls.delete(id);
      }
    }
    for (const id of ids) {
      let el = tileEls.get(id);
      if (!el) {
        el = id === CAM ? camTile() : playerTile(id);
        tileEls.set(id, el);
      }
      box.appendChild(el);
    }
    let empty = box.querySelector('.empty');
    if (!ids.length) {
      if (!empty) {
        empty = document.createElement('p');
        empty.className = 'empty';
        box.appendChild(empty);
      }
      empty.textContent = players().length
        ? 'bot だけが参加しています。b で bot の視点も出せます'
        : '参加者が入ると、ここに一人ずつの視点が並びます。参加者は管理者が試合を開始するまで待機します';
    } else if (empty) empty.remove();
  }
  updateTiles();
}

function playerTile(id) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.innerHTML =
    '<div class="ttl"><span></span><em></em></div><div class="pic"><i class="xh"></i><i class="hm">✕</i><div class="over" hidden></div></div>' +
    '<div class="sbar"><span class="hpp"><span class="xpbar"><div></div></span><b class="hpn"></b></span><span class="kd"></span><span class="ping"></span></div>';
  el.addEventListener('click', () => {
    setFocus(0);
    S.sel = id;
    toggleSolo(id);
  });
  return el;
}

/// The camera's tile: the automatic camera (or the hand-moved one), with
/// both sides of the fight it shows under it.
function camTile() {
  const el = document.createElement('div');
  el.className = 'tile cam';
  const side = (c) => `<span class="${c}"><b></b><span class="xpbar"><div></div></span><i></i></span>`;
  el.innerHTML =
    '<div class="ttl"><span>カメラ</span><em></em></div><div class="pic"><div class="pad"><a data-m="up">▲</a><a data-m="fwd">前</a><a data-m="back">後</a><a data-m="down">▼</a></div></div>' +
    `<div class="sbar vs">${side('a')}<span class="vsx">vs</span>${side('b')}</div>`;
  const pic = el.querySelector('.pic');
  // Drag to look around (the camera goes to hand control); wheel: forward.
  let drag = null;
  pic.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.pad')) return;
    drag = { x: e.clientX, y: e.clientY, moved: 0 };
    pic.setPointerCapture(e.pointerId);
  });
  pic.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.moved < 6) return;
    if (S.cam.mode !== 'free') setCam('free');
    const f = S.cam.free;
    f.yaw = wrapAngle(f.yaw - dx * 0.006);
    f.pitch = clamp(f.pitch - dy * 0.006, -1.5, 1.2);
  });
  pic.addEventListener('pointerup', () => {
    el._dragged = drag && drag.moved >= 6;
    drag = null;
  });
  pic.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (S.cam.mode !== 'free') setCam('free');
      moveFree(-Math.sign(e.deltaY) * 4, 0, 0);
    },
    { passive: false },
  );
  // On a touch screen: held buttons move the hand camera.
  for (const a of el.querySelectorAll('.pad a')) {
    const on = (v) => (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (v && S.cam.mode !== 'free') setCam('free');
      if (v) S.cam.held.set(`pad-${a.dataset.m}`, a.dataset.m);
      else S.cam.held.delete(`pad-${a.dataset.m}`);
    };
    a.addEventListener('pointerdown', on(true));
    a.addEventListener('pointerup', on(false));
    a.addEventListener('pointerleave', on(false));
    a.addEventListener('click', (e) => e.stopPropagation());
  }
  el.addEventListener('click', () => {
    if (el._dragged) {
      el._dragged = false;
      return;
    }
    setFocus(0);
    S.sel = CAM;
    toggleSolo(CAM);
  });
  return el;
}

/// One step of the tile cursor (h j k l). Alone on the monitor (Enter),
/// it goes to the previous / next tile and shows that one alone.
function moveTile(key) {
  const back = key === 'h' || key === 'k';
  if (S.solo != null) {
    const all = [...(camOn() ? [CAM] : []), ...viewable().map((p) => p.id)];
    const i = all.indexOf(S.solo);
    const j = clamp(i + (back ? -1 : 1), 0, all.length - 1);
    if (all[j] == null || j === i) return;
    S.solo = all[j];
    select(all[j]);
    layoutTiles(true);
    return;
  }
  const ids = tileIds();
  if (!ids.length) return;
  const i = ids.indexOf(S.sel);
  if (i < 0) {
    select(ids[0]);
    return;
  }
  const cols = Math.max(1, tileCols);
  const col = i % cols;
  const row = Math.floor(i / cols);
  const rows = Math.ceil(ids.length / cols);
  let j = i;
  if (key === 'h' && col > 0) j = i - 1;
  else if (key === 'l' && col < cols - 1 && i + 1 < ids.length) j = i + 1;
  else if (key === 'k' && row > 0) j = i - cols;
  else if (key === 'j' && row < rows - 1) j = Math.min(i + cols, ids.length - 1);
  if (j !== i) {
    select(ids[j]);
    return;
  }
  // At the edge: the next / previous page, if there is one.
  const pages = pageCount();
  if (pages <= 1) return;
  const forward = key === 'l' || key === 'j';
  if (forward ? S.page >= pages - 1 : S.page <= 0) return;
  S.page += forward ? 1 : -1;
  S.cycleAt = performance.now() + S.cycle * 1000;
  layoutTiles(true);
  const next = tileIds();
  // Same column on the new page (top row going down, bottom row going up).
  let k;
  if (key === 'j') k = col;
  else if (key === 'k') k = (Math.ceil(next.length / cols) - 1) * cols + col;
  // l: the first player there (the camera's tile is on every page).
  else k = forward ? (camOn() && next[0] === CAM && next.length > 1 ? 1 : 0) : next.length - 1;
  select(next[clamp(k, 0, next.length - 1)]);
}

/// The camera: 'auto', 'free' or 'off'.
function setCam(mode) {
  const was = S.cam.mode;
  S.cam.mode = mode;
  if (mode === 'free' && was !== 'free' && S.cam.last) S.cam.free = { ...S.cam.last };
  if (mode === 'auto' && S.cam.director && S.cam.last) {
    S.cam.director.reset();
    S.cam.director.start(S.cam.last);
  }
  if (mode !== 'free') S.cam.held.clear();
  saveView();
  note({ auto: 'カメラ: 自動 (見どころを追う)', free: 'カメラ: 手動 (hjkl 移動・旋回 · K/J 上下 · u/d 見上げる · ドラッグで向き · a で自動)', off: 'カメラを消しました' }[mode]);
  layoutTiles(true);
}

function stepCam(d) {
  const order = ['auto', 'free', 'off'];
  setCam(order[(order.indexOf(S.cam.mode) + (d > 0 ? 1 : 2)) % 3]);
}

/// Moves the hand camera: forward, sideways (m), up (m).
function moveFree(fwd, side, up) {
  const f = S.cam.free;
  f.x += -Math.sin(f.yaw) * fwd + Math.cos(f.yaw) * side;
  f.z += -Math.cos(f.yaw) * fwd - Math.sin(f.yaw) * side;
  f.y += up;
  const half = S.map ? S.map.half : 200;
  f.x = clamp(f.x, -half - 50, half + 50);
  f.z = clamp(f.z, -half - 50, half + 50);
  const ground = S.world ? S.world.height(f.x, f.z) : 0;
  f.y = clamp(f.y, ground + 1.2, 400);
}

/// The camera this frame.
function camPose(now, dt) {
  const c = S.cam;
  if (c.mode === 'free') {
    const f = c.free;
    const ground = S.world ? S.world.height(f.x, f.z) : 0;
    // Faster the higher it is.
    const speed = Math.max(12, (f.y - ground) * 0.7) * dt;
    const h = new Set(c.held.values());
    moveFree(((h.has('fwd') ? 1 : 0) - (h.has('back') ? 1 : 0)) * speed, ((h.has('right') ? 1 : 0) - (h.has('left') ? 1 : 0)) * speed, ((h.has('up') ? 1 : 0) - (h.has('down') ? 1 : 0)) * speed);
    f.yaw = wrapAngle(f.yaw + ((h.has('turnl') ? 1 : 0) - (h.has('turnr') ? 1 : 0)) * 1.6 * dt);
    f.pitch = clamp(f.pitch + ((h.has('tiltu') ? 1 : 0) - (h.has('tiltd') ? 1 : 0)) * 1.0 * dt, -1.5, 1.2);
    c.out = null;
    c.last = { ...f, fov: 70 };
    return c.last;
  }
  if (!c.director || c.director.world !== S.world) c.director = new Director(S.world);
  const live = S.state.phase === 'live' || S.state.phase === 'results';
  const alive = live
    ? players()
        .filter((p) => p.alive && S.view.has(p.id))
        .map((p) => ({ ...p, ...S.view.get(p.id) }))
    : [];
  const out = c.director.update(now / 1000, dt, alive);
  if (out) {
    c.out = out;
    c.last = out.cam;
    return out.cam;
  }
  // Nobody to show: a slow turn high over the middle of the field.
  c.out = null;
  const a = (now / 1000) * 0.05;
  c.last = { x: Math.sin(a) * 150, y: 95, z: Math.cos(a) * 150, yaw: a, pitch: -0.5, fov: 60 };
  return c.last;
}

/// The monitor over the whole page (F, or the □ button), and the screen
/// itself when the browser lets it.
function setMax(on) {
  S.max = on;
  document.body.classList.toggle('maxmon', on);
  try {
    if (on && document.fullscreenEnabled && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  } catch {
    // No full screen here: the page is still filled.
  }
  setFocus(0);
  note(on ? 'モニターを全画面にしました (F でもとに戻す)' : 'モニターをもとの大きさに戻しました');
  layoutTiles(true);
}

/// A class on a player's tile for a moment (hit mark, being hit).
function flashTile(id, cls, ms) {
  const el = tileEls.get(id);
  if (!el) return;
  el.classList.add(cls);
  clearTimeout(el[`_${cls}`]);
  el[`_${cls}`] = setTimeout(() => el.classList.remove(cls), ms);
}

function toggleSolo(id) {
  S.solo = S.solo === id || id == null ? null : id;
  if (S.solo != null) S.mode = 'tiles';
  layoutTiles(true);
}

function updateCamTile() {
  const el = tileEls.get(CAM);
  if (!el) return;
  const c = S.cam;
  const out = c.out;
  el.classList.toggle('cur', S.sel === CAM);
  el.classList.toggle('manual', c.mode === 'free');
  el.querySelector('.ttl span').textContent = c.mode === 'free' ? 'カメラ — 手動' : 'カメラ — 自動';
  const who = (id) => (id != null ? S.state.players.find((p) => p.id === id) : null);
  const a = out ? who(out.subject) : null;
  const b = out ? who(out.rival) : null;
  el.querySelector('.ttl em').textContent = a ? `${a.name}${b ? ` vs ${b.name}` : ''}` : c.mode === 'free' ? 'ドラッグで向き · a で自動' : '';
  const fill = (cls, p) => {
    const box = el.querySelector(`.sbar .${cls}`);
    box.hidden = !p;
    if (!p) return;
    const hp = p.alive ? Math.max(0, Math.round(p.hp)) : 0;
    box.querySelector('b').textContent = p.name;
    const bar = box.querySelector('.xpbar');
    bar.firstChild.style.width = `${hp}%`;
    bar.className = `xpbar ${hpClass(hp)}`;
    box.querySelector('i').textContent = String(hp);
  };
  fill('a', a);
  fill('b', b);
  el.querySelector('.vsx').hidden = !(a && b);
}

function updateTiles() {
  const st = S.state;
  const now = performance.now();
  updateCamTile();
  for (const p of shown()) {
    const el = tileEls.get(p.id);
    if (!el) continue;
    const waiting = st.phase === 'lobby' || st.phase === 'countdown';
    el.classList.toggle('waiting', waiting);
    el.classList.toggle('down', waiting || !p.alive);
    el.classList.toggle('fight', st.phase === 'live' && p.alive && now - (S.action.get(p.id) || -1e9) < 1500);
    el.classList.toggle('cur', p.id === S.sel);
    el.classList.toggle('scoped', p.alive && p.ads && p.gun === 'sr' && p.tank == null && st.phase === 'live');
    el.classList.toggle('aim', p.alive && !!p.ads);
    el.querySelector('.ttl span').textContent = p.name;
    el.querySelector('.ttl em').textContent = p.tank != null ? '戦車' : p.alive && p.gun ? `${gunName(p.gun)}${p.zoom === 2 ? ' · スコープ' : p.ads ? ' · 構え' : ''}` : '';
    const hp = p.alive ? Math.max(0, Math.round(p.hp)) : 0;
    const bar = el.querySelector('.xpbar');
    bar.firstChild.style.width = `${hp}%`;
    bar.className = `xpbar ${hpClass(hp)}`;
    el.querySelector('.hpn').textContent = String(hp);
    el.querySelector('.kd').textContent = `${p.kills} / ${p.deaths}`;
    const ping = el.querySelector('.ping');
    ping.textContent = p.bot ? `bot ${p.level ?? ''}` : p.ping != null ? `${p.ping} ms` : '— ms';
    ping.className = `ping ${pingClass(p.ping)}`;
    const over = el.querySelector('.over');
    let text = '';
    if (waiting) text = st.phase === 'countdown' ? `まもなく開始 · ${st.countdown ?? ''}` : '待機中';
    else if (st.phase === 'results') text = '試合終了';
    else if (!p.alive) text = !st.settings.respawn && p.out ? '敗退 (観戦中)' : `倒されました · 復活まで ${Math.ceil(p.respawn)} 秒`;
    over.hidden = !text;
    over.textContent = text;
  }
}

// ---------------------------------------------------------------- 3D

/// What a player sees: eye position, direction and field of view.
function eyeOf(p, v) {
  if (p.tank != null && S.state) {
    const t = S.state.tanks.find((q) => q.id === p.tank);
    if (t) return { x: t.x, y: t.y + TANK.eye, z: t.z, yaw: t.aim, pitch: t.pitch, fov: p.zoom === 2 ? TANK.scope : p.zoom === 1 ? TANK.ads : 80 };
  }
  const g = GUNS[p.gun] || GUNS.ar;
  const fov = p.zoom === 2 ? g.scope : p.zoom === 1 ? g.ads : 80;
  return { x: v.x, y: v.y + eyeHeight(p.sneak), z: v.z, yaw: v.yaw, pitch: v.pitch, fov };
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const st = S.state;
  if (st && !$('desk').hidden) {
    // Ease each drawn position toward the latest (20 updates a second).
    const k = 1 - Math.exp(-dt * 16);
    for (const p of st.players) {
      const v = S.view.get(p.id);
      if (!v) continue;
      if (Math.hypot(p.x - v.x, p.z - v.z) > 8) Object.assign(v, { x: p.x, y: p.y, z: p.z });
      v.x += (p.x - v.x) * k;
      v.y += (p.y - v.y) * k;
      v.z += (p.z - v.z) * k;
      v.yaw = wrapAngle(v.yaw + wrapAngle(p.yaw - v.yaw) * k);
      v.pitch += (p.pitch - v.pitch) * k;
    }
    // Pages turn by themselves when cycling.
    if (S.cycle > 0 && S.solo == null && S.mode === 'tiles' && pageCount() > 1 && now >= S.cycleAt) {
      if (S.cycleAt) turnPage(1);
      S.cycleAt = now + S.cycle * 1000;
    }
    if (S.mode === 'tiles' && renderer && S.map) drawTiles(dt);
    if (S.mode === 'map') drawMap($('bigmap'), true);
    drawMap($('minimap'), false);
    if (now - (S.tileTick || 0) > 200) {
      S.tileTick = now;
      updateTiles();
    }
  }
  requestAnimationFrame(frame);
}

function drawTiles(dt) {
  const st = S.state;
  for (const p of st.players) {
    const v = S.view.get(p.id);
    if (!v || p.spectator) {
      renderer.hidePlayer(p.id);
      continue;
    }
    renderer.setPlayer(p.id, { ...p, ...v, hp: p.hp }, p.name);
  }
  for (const id of [...renderer.players.keys()]) if (!st.players.some((p) => p.id === id && !p.spectator)) renderer.removePlayer(id);
  renderer.setTanks(st.tanks, S.specs && S.specs.tank_hp, null, (t) => (t.driver != null ? `戦車 · ${nameOf(t.driver)}` : '戦車'));
  renderer.updateEffects(dt);
  const r = renderer.renderer;
  const canvas = $('gl');
  r.setScissorTest(false);
  r.setClearColor(0x3a6ea5, 1);
  r.clear();
  const base = canvas.getBoundingClientRect();
  const camEl = tileEls.get(CAM);
  if (camEl) {
    const pic = camEl.querySelector('.pic').getBoundingClientRect();
    const rect = { x: pic.left - base.left, y: pic.top - base.top, w: pic.width, h: pic.height };
    const cam = camPose(performance.now(), dt);
    if (rect.w >= 8 && rect.h >= 8) renderer.renderInset({ cam, rect, hide: null });
  }
  if (st.phase !== 'live' && st.phase !== 'results') return;
  for (const p of shown()) {
    const el = tileEls.get(p.id);
    const v = S.view.get(p.id);
    if (!el || !v) continue;
    const pic = el.querySelector('.pic').getBoundingClientRect();
    const rect = { x: pic.left - base.left, y: pic.top - base.top, w: pic.width, h: pic.height };
    if (rect.w < 8 || rect.h < 8) continue;
    // Their gun in their hands, flashing and kicking when they fire.
    const since = performance.now() - (S.muzzle.get(p.id) || -1e9);
    const scope = p.ads && p.gun === 'sr';
    const vm = { held: p.tank != null ? null : p.gun, ads: p.ads ? 1 : 0, kick: Math.max(0, 0.06 - since * 0.0006), flash: since < 50, hide: !p.alive || p.tank != null || scope };
    renderer.renderInset({ cam: eyeOf(p, v), rect, hide: p.id, vm });
  }
}

// ---------------------------------------------------------------- map

const PLAYER_HUES = [0.0, 0.58, 0.12, 0.33, 0.8, 0.5, 0.05, 0.68, 0.22, 0.9];

/// The field (ground and buildings), drawn once.
function fieldImage(size) {
  if (mapImage && mapImage.width === size) return mapImage;
  const map = S.map;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const k = size / (map.half * 2);
  const tx = (x) => (x + map.half) * k;
  ctx.fillStyle = '#6fae4a';
  ctx.fillRect(0, 0, size, size);
  const col = { wall: '#d9d0b8', roof: 'rgba(154,90,58,0.55)', rock: '#8b8d90', cover: '#b9a774', crate: '#9c7240', trunk: '#2f7a35', fence: '#555' };
  for (const s of map.solids) {
    ctx.fillStyle = col[s.kind] || '#999';
    ctx.fillRect(tx(s.min.x), tx(s.min.z), Math.max(1.5, (s.max.x - s.min.x) * k), Math.max(1.5, (s.max.z - s.min.z) * k));
  }
  mapImage = c;
  return c;
}

function drawMap(canvas, big) {
  const st = S.state;
  if (!S.map || !st) return;
  // Square, as large as the box allows, at the screen's pixel density.
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let W;
  if (big) {
    const box = canvas.parentElement;
    W = Math.floor(Math.min(box.clientWidth, box.clientHeight) * dpr);
    if (canvas.width !== box.clientWidth * dpr || canvas.height !== box.clientHeight * dpr) {
      canvas.width = box.clientWidth * dpr;
      canvas.height = box.clientHeight * dpr;
    }
  } else W = canvas.width;
  const ctx = canvas.getContext('2d');
  const ox = big ? (canvas.width - W) / 2 : 0;
  const oy = big ? (canvas.height - W) / 2 : 0;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (big) {
    ctx.fillStyle = '#3a6ea5';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.translate(ox, oy);
  const map = S.map;
  const k = W / (map.half * 2);
  const tx = (x) => (x + map.half) * k;
  ctx.drawImage(fieldImage(big ? Math.max(560, Math.min(2048, W)) : 560), 0, 0, W, W);
  const u = W / 560; // marks scale with the map
  const ring = st.ring;
  if (ring) {
    ctx.save();
    ctx.fillStyle = 'rgba(255, 70, 20, 0.22)';
    ctx.beginPath();
    ctx.rect(0, 0, W, W);
    ctx.arc(tx(ring.x), tx(ring.z), ring.r * k, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#ff4a1a';
    ctx.lineWidth = 2.5 * u;
    ctx.beginPath();
    ctx.arc(tx(ring.x), tx(ring.z), ring.r * k, 0, Math.PI * 2);
    ctx.stroke();
    if (ring.t >= 0) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5 * u;
      ctx.setLineDash([6 * u, 5 * u]);
      ctx.beginPath();
      ctx.arc(tx(ring.nx), tx(ring.nz), ring.nr * k, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
  for (const t of st.tanks) {
    ctx.save();
    ctx.translate(tx(t.x), tx(t.z));
    ctx.rotate(-t.yaw);
    ctx.fillStyle = t.driver != null ? '#1f3d12' : '#55632f';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5 * u;
    ctx.fillRect(-5 * u, -6.5 * u, 10 * u, 13 * u);
    ctx.strokeRect(-5 * u, -6.5 * u, 10 * u, 13 * u);
    ctx.restore();
  }
  const now = performance.now();
  ctx.font = `600 ${Math.round(12 * u)}px system-ui, sans-serif`;
  // Waiting: nobody is on the field yet.
  const onField = st.phase === 'live' || st.phase === 'results' ? players() : [];
  for (const p of onField) {
    const v = S.view.get(p.id);
    if (!v) continue;
    const x = tx(v.x);
    const z = tx(v.z);
    const sel = p.id === S.sel || p.id === S.solo;
    const hue = (PLAYER_HUES[p.id % PLAYER_HUES.length] * 360).toFixed(0);
    if (!p.alive) {
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 2 * u;
      ctx.beginPath();
      ctx.moveTo(x - 4 * u, z - 4 * u);
      ctx.lineTo(x + 4 * u, z + 4 * u);
      ctx.moveTo(x + 4 * u, z - 4 * u);
      ctx.lineTo(x - 4 * u, z + 4 * u);
      ctx.stroke();
      continue;
    }
    // Where each one looks: a wedge as wide as their view.
    const eye = eyeOf(p, v);
    const half = ((eye.fov / 2) * Math.PI) / 180;
    const dir = -eye.yaw - Math.PI / 2;
    const reach = (p.zoom ? 60 : 36) * u;
    ctx.fillStyle = sel ? 'rgba(242,166,38,0.35)' : `hsla(${hue}, 70%, 55%, 0.22)`;
    ctx.beginPath();
    ctx.moveTo(x, z);
    ctx.arc(x, z, reach, dir - half, dir + half);
    ctx.closePath();
    ctx.fill();
    const firing = now - (S.action.get(p.id) || -1e9) < 1500;
    ctx.fillStyle = sel ? '#f2a626' : `hsl(${hue}, 65%, 50%)`;
    ctx.strokeStyle = firing ? '#e5372c' : '#000';
    ctx.lineWidth = (firing ? 3 : 1.5) * u;
    ctx.beginPath();
    ctx.arc(x, z, (sel ? 6 : 4.5) * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    const label = `${p.name} ${Math.round(p.hp)}`;
    ctx.lineWidth = 3 * u;
    ctx.strokeStyle = '#000';
    ctx.fillStyle = '#fff';
    ctx.strokeText(label, x + 7 * u, z - 6 * u);
    ctx.fillText(label, x + 7 * u, z - 6 * u);
  }
  canvas._map = { ox, oy, k, half: map.half };
}

/// A click on a map picks the nearest player.
function mapClick(canvas, e) {
  const m = canvas._map;
  if (!m) return;
  const r = canvas.getBoundingClientRect();
  const wx = ((e.clientX - r.left) * (canvas.width / r.width) - m.ox) / m.k - m.half;
  const wz = ((e.clientY - r.top) * (canvas.height / r.height) - m.oy) / m.k - m.half;
  let best = null;
  for (const p of players()) {
    const v = S.view.get(p.id);
    if (!v) continue;
    const d = Math.hypot(v.x - wx, v.z - wz);
    if (d < 12 && (!best || d < best.d)) best = { id: p.id, d };
  }
  if (best) select(best.id);
}

function select(id) {
  S.sel = id;
  renderRank();
  updateTiles();
}

// ---------------------------------------------------------------- messages

/// The bottom line (Vim's message line).
function note(text, err = false) {
  const el = $('showcmd');
  el.textContent = text;
  el.style.color = err ? '#ffd2cc' : '';
  S.noted = true;
}

function log(html, cls = '', isHtml = false) {
  const ol = $('log');
  const li = document.createElement('li');
  if (cls) li.className = cls;
  const t = new Date();
  const time = [t.getHours(), t.getMinutes(), t.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  li.innerHTML = `<time>${time}</time>${isHtml ? html : esc(html)}`;
  const atEnd = ol.scrollTop + ol.clientHeight >= ol.scrollHeight - 4;
  ol.appendChild(li);
  while (ol.children.length > 300) ol.firstChild.remove();
  if (atEnd) ol.scrollTop = ol.scrollHeight;
}

/// A message window (Enter / Esc / q closes; j / k scroll).
function showMessage(title, text) {
  $('msg-title').textContent = title;
  $('msg-icon').hidden = true;
  const body = $('msg-body');
  body.className = '';
  body.textContent = text;
  $('msg-btns').innerHTML = '';
  addBtn('OK (Enter)', closeMessage, true);
  $('msgwin').hidden = false;
  S.msgYes = null;
  setMode('msg');
}

/// A question: y / Enter yes, n / Esc no.
function ask(text, yes) {
  $('msg-title').textContent = '確認';
  $('msg-icon').hidden = false;
  const body = $('msg-body');
  body.className = 'plain';
  body.textContent = text;
  $('msg-btns').innerHTML = '';
  S.msgYes = yes;
  addBtn('はい (y)', () => answer(true), true);
  addBtn('いいえ (n)', () => answer(false), false);
  $('msgwin').hidden = false;
  setMode('confirm');
}

function addBtn(label, fn, def) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `xpbtn${def ? ' def' : ''}`;
  b.textContent = label;
  b.onclick = fn;
  $('msg-btns').appendChild(b);
}

function answer(ok) {
  const yes = S.msgYes;
  closeMessage();
  if (ok && yes) yes();
}

function closeMessage() {
  $('msgwin').hidden = true;
  S.msgYes = null;
  setMode('normal');
}

const HELP = `管理ページのキー (マウスでも操作できます)

どこでも
  gt / gT          次 / 前のウィンドウ ({n}gt で n 番)    Tab / Shift-Tab も
  Ctrl-w w / W     次 / 前のウィンドウ   Ctrl-w h j k l  その方向のウィンドウ
  :                コマンド (ホストの端末と同じ。:help で一覧)
  i                全員にメッセージ
  m                モニター: 視点 / マップ の切り替え
  ?                このヘルプ
  Esc              閉じる・一覧に戻る

ウィンドウの中
  j / k            選ぶ ({n}j で n 行)   gg / G  先頭 / 末尾
  h / l            値を変える (H / L で 5 ずつ)
  Enter            実行

1 モニター   hjkl 選手を選ぶ · Enter 1 人を大きく · b bot の視点も出す
             + / - 一度に出す数 (= で自動: 全員が入る大きさ)
             ] / [ (Ctrl-f / Ctrl-b) 次 / 前のページ · c ページの巡回 (10 秒ごと)
             a カメラを自動に (観戦の自動カメラと同じ: 見どころを追い、1 対 1 は両方の体力)
             o カメラを手動に (CAMERA モード: k/j 前後 · h/l 旋回 · H/L 横 · K/J 上下
               u/d 見上げる・見下ろす · O 真上から · a 自動に戻す · Esc 抜ける)
               マウス・指ではカメラをドラッグで向き、ホイールで前後
F            モニターを全画面に (もう一度でもとに戻す。Enter で 1 つだけ大きくすると全画面に 1 人)
2 試合       開始 (h / l で秒読み) · 取り消し · 終了 · 待機に戻す · 自動で次へ
3 マップ     j / k 選手を選ぶ · Enter モニターで大きく
4 順位       Enter 視点を大きく · w 観戦に回す · dd 退出させる · h / l bot の強さ
5 bot        1 行目 h / l で数 · bot の行で h / l 強さ · a 全体の強さに戻す
6 ルール     h / l で変更 · Enter / :w 保存 · u 元に戻す (次の試合から)
7 ログ       j / k スクロール

コマンド (:)
  start [秒]   end   cancel   lobby   auto on|off   status
  bots 数      level 名前 1〜5|auto   set time=分 frags=数 skill=1〜5 respawn=on|off ring=on|off tanks=on|off
  kick 名前    watch 名前   say 文   w (ルール保存)   q (ログオフ)   {n} (n 番のウィンドウへ)
  fs (全画面)  cam auto|free|off (カメラ)`;

// ---------------------------------------------------------------- windows and modes

const MODE_NAMES = { normal: 'NORMAL', command: 'COMMAND', insert: 'INSERT', msg: 'MESSAGE', confirm: 'CONFIRM', camera: 'CAMERA' };

/// CAMERA mode: keys that move the hand camera while held (by e.code, so a
/// released Shift does not leave one stuck).
const CAM_KEYS = { k: 'fwd', j: 'back', h: 'turnl', l: 'turnr', H: 'left', L: 'right', K: 'up', J: 'down', u: 'tiltu', d: 'tiltd', ArrowUp: 'fwd', ArrowDown: 'back', ArrowLeft: 'turnl', ArrowRight: 'turnr' };

/// High over where the camera is, looking down.
function birdsEye() {
  const f = S.cam.free;
  const ground = S.world ? S.world.height(f.x, f.z) : 0;
  f.y = ground + 150;
  f.pitch = -1.45;
}

function cameraKey(e, escKey) {
  if (escKey || e.key === ':') {
    S.cam.held.clear();
    setMode('normal');
    if (e.key === ':') openCommand();
    return;
  }
  if (e.key === 'a') {
    setCam('auto');
    setMode('normal');
    return;
  }
  if (e.key === 'O') return birdsEye();
  if (e.key === 'F') return setMax(!S.max);
  const act = CAM_KEYS[e.key];
  if (act) S.cam.held.set(e.code, act);
}

function setMode(m) {
  S.vmode = m;
  S.count = '';
  S.pending = '';
  $('mode').textContent = MODE_NAMES[m];
  $('start').dataset.mode = MODE_NAMES[m];
  if (!S.noted) $('showcmd').textContent = '';
}

function win(i) {
  return $(`w-${WINDOWS[i]}`);
}

function setFocus(i) {
  S.focus = ((i % WINDOWS.length) + WINDOWS.length) % WINDOWS.length;
  WINDOWS.forEach((_, j) => win(j).classList.toggle('focus', j === S.focus));
  const w = win(S.focus);
  if (w.scrollIntoView && w.parentElement.id === 'side') w.scrollIntoView({ block: 'nearest' });
  renderTasks();
}

function renderTasks() {
  const box = $('tasks');
  if (!box.children.length) {
    WINDOWS.forEach((_, i) => {
      const b = document.createElement('div');
      b.className = 'tb';
      b.innerHTML = `<b>${i + 1}</b>${esc(win(i).dataset.title)}`;
      b.onclick = () => setFocus(i);
      box.appendChild(b);
    });
  }
  [...box.children].forEach((b, i) => b.classList.toggle('on', i === S.focus));
}

/// The window beside the focused one, in a direction (Ctrl-w h/j/k/l).
function focusToward(dx, dy) {
  const a = win(S.focus).getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  let best = null;
  WINDOWS.forEach((_, i) => {
    if (i === S.focus) return;
    const b = win(i).getBoundingClientRect();
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    const along = (bx - ax) * dx + (by - ay) * dy;
    if (along <= 0) return;
    const across = Math.abs((bx - ax) * dy) + Math.abs((by - ay) * dx);
    const score = along + across * 2;
    if (!best || score < best.s) best = { i, s: score };
  });
  if (best) setFocus(best.i);
}

function openCommand(text = '') {
  $('cmdwin').hidden = false;
  const input = $('cmdinput');
  input.value = text;
  S.histAt = S.history.length;
  setMode('command');
  input.focus();
}

function closeCommand() {
  $('cmdwin').hidden = true;
  $('cmdinput').blur();
  setMode('normal');
}

function openSay() {
  $('saywin').hidden = false;
  $('sayinput').value = '';
  setMode('insert');
  $('sayinput').focus();
}

function closeSay() {
  $('saywin').hidden = true;
  $('sayinput').blur();
  setMode('normal');
}

function runCommand(line) {
  const l = line.trim();
  if (!l) return;
  S.history.push(l);
  if (S.history.length > 50) S.history.shift();
  if (/^\d+$/.test(l)) return setFocus(Number(l) - 1);
  if (l === 'w' || l === 'write') {
    if (S.draft) saveRules();
    else note('ルールの変更はありません');
    return;
  }
  if (l === 'help' || l === 'h') return showMessage(':help', HELP);
  if (l === 'q' || l === 'q!' || l === 'quit') return ask('管理ページからログオフしますか？ (試合はそのまま続きます)', signOut);
  if (l === 'fs' || l === 'full') return setMax(!S.max);
  if (l === 'cam' || l === 'cam auto') return setCam('auto');
  if (l === 'cam off') return setCam('off');
  if (l === 'cam free') return setCam('free');
  if (l === 'map' || l === 'tiles') {
    S.mode = l;
    return layoutTiles(true);
  }
  send({ t: 'command', line: l });
}

$('cmdform').addEventListener('submit', (e) => {
  e.preventDefault();
  const line = $('cmdinput').value;
  closeCommand();
  runCommand(line);
});
$('sayform').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('sayinput').value.trim();
  closeSay();
  if (text) send({ t: 'say', text });
});

// ---------------------------------------------------------------- keys

/// Moves a cursor among `n` rows.
function moveCur(cur, d, n, abs = false) {
  if (n <= 0) return 0;
  return abs ? clamp(d, 0, n - 1) : clamp(cur + d, 0, n - 1);
}

/// The player list's cursor (ranking, map): the selected player.
function movePlayer(d, abs = false) {
  const list = players();
  if (!list.length) return;
  const i = list.findIndex((p) => p.id === S.sel);
  const j = abs ? clamp(d < 0 ? list.length - 1 : d, 0, list.length - 1) : i < 0 ? 0 : clamp(i + d, 0, list.length - 1);
  select(list[j].id);
}

/// A key in the focused window. Returns false when it means nothing there.
function windowKey(key, n, count) {
  const w = WINDOWS[S.focus];
  const big = key === 'H' || key === 'L';
  const dir = key === 'h' || key === 'H' ? -1 : key === 'l' || key === 'L' ? 1 : 0;
  if (w === 'monitor') {
    // hjkl move over the tiles as they are on screen (the camera's tile
    // first); past the edge of a page, onto the next / previous one.
    if ('hjkl'.includes(key) && key.length === 1) {
      for (let i = 0; i < n; i++) moveTile(key);
      return true;
    }
    if (key === 'gg' || key === 'G') {
      const ids = tileIds();
      if (ids.length) select(ids[key === 'G' ? ids.length - 1 : 0]);
      return true;
    }
    if (key === 'a') {
      setCam('auto');
      return true;
    }
    if (key === 'o' || key === 'O') {
      // The camera by hand: CAMERA mode until Esc.
      if (S.cam.mode !== 'free') setCam('free');
      if (key === 'O') birdsEye();
      S.sel = CAM;
      setMode('camera');
      layoutTiles(true);
      return true;
    }
    if (key === '+' || key === '-') {
      stepPerPage(key === '+' ? n : -n);
      return true;
    }
    if (key === '=') {
      setPerPage(0);
      return true;
    }
    if (key === ']' || key === '[') {
      turnPage(key === ']' ? n : -n);
      return true;
    }
    if (key === 'c') {
      stepCycle(S.cycle > 0 ? -CYCLES.length : 2);
      note(S.cycle > 0 ? `${S.cycle} 秒ごとに次のページへ` : 'ページの巡回を止めました');
      return true;
    }
    if (key === 'Enter') {
      if (S.solo != null) toggleSolo(null);
      else if (S.sel != null) toggleSolo(S.sel);
      return true;
    }
    if (key === 'b') {
      setShowBots(!S.showBots);
      note(S.showBots ? 'bot の視点も出します' : 'bot の視点を隠します');
      return true;
    }
    return false;
  }
  if (w === 'map' || w === 'rank') {
    if (key === 'j') return movePlayer(n), true;
    if (key === 'k') return movePlayer(-n), true;
    if (key === 'gg') return movePlayer(count ? n - 1 : 0, true), true;
    if (key === 'G') return movePlayer(-1, true), true;
    if (key === 'Enter') {
      if (S.sel != null) {
        S.solo = null;
        toggleSolo(S.sel);
      }
      return true;
    }
    if (w === 'rank' && S.sel != null) {
      const p = players().find((q) => q.id === S.sel);
      if (!p) return true;
      if (key === 'w') {
        if (p.bot) note('E: bot は観戦に回せません (bot の数で調整)', true);
        else send({ t: 'spectate', id: p.id });
        return true;
      }
      if (key === 'dd') {
        if (p.bot) note('E: bot は退出させられません (bot の数で調整)', true);
        else ask(`${p.name} を退出させますか？ (もう一度参加することはできます)`, () => send({ t: 'kick', id: p.id }));
        return true;
      }
      if (dir && p.bot) {
        const l = clamp(pendingOr(p.id, p.level || 3) + dir, 1, 5);
        sendPending(p.id, l, { t: 'bot_level', id: p.id, level: l });
        return true;
      }
      if (key === 'a' && p.bot) {
        send({ t: 'bot_level', id: p.id, level: null });
        return true;
      }
    }
    return false;
  }
  if (w === 'log') {
    const ol = $('log');
    if (key === 'j' || key === 'k') ol.scrollTop += (key === 'j' ? 1 : -1) * 20 * n;
    else if (key === 'gg') ol.scrollTop = 0;
    else if (key === 'G') ol.scrollTop = ol.scrollHeight;
    else return false;
    return true;
  }
  // The list windows.
  const lists = { match: [matchRows, renderMatch], bots: [botRows, renderBots], rules: [ruleRows, renderRules] };
  const [rowsOf, render] = lists[w];
  const rows = rowsOf();
  const cur = S.cur[w];
  if (key === 'j' || key === 'k') S.cur[w] = moveCur(cur, (key === 'j' ? 1 : -1) * n, rows.length);
  else if (key === 'gg') S.cur[w] = moveCur(cur, count ? n - 1 : 0, rows.length, true);
  else if (key === 'G') S.cur[w] = rows.length - 1;
  else if (dir) {
    const r = rows[cur];
    if (!r || !r.adj || r.ok === false) return true;
    r.adj(dir * (big ? 5 : 1) * n);
  } else if (key === 'Enter') {
    const r = rows[cur];
    if (!r || r.ok === false) return true;
    if (w === 'rules' && r.toggle) r.adj(1);
    else if (r.run) r.run();
    else if (w === 'rules') saveRules();
  } else if (key === 'a' && w === 'bots') {
    const r = rows[cur];
    if (r && r.reset) r.reset();
  } else if (key === 'u' && w === 'rules') {
    S.draft = null;
    note('ルールの変更を取り消しました');
  } else return false;
  render();
  return true;
}

function normalKey(e) {
  const key = e.key;
  // Ctrl-w {w W h j k l}
  if (S.pending === 'C-w') {
    S.pending = '';
    const d = { h: [-1, 0], l: [1, 0], k: [0, -1], j: [0, 1] }[key];
    if (d) focusToward(d[0], d[1]);
    else if (key === 'w' || (e.ctrlKey && key === 'w')) setFocus(S.focus + 1);
    else if (key === 'W') setFocus(S.focus - 1);
    showcmd();
    return true;
  }
  // Ctrl-f / Ctrl-b: pages of views (monitor).
  if (e.ctrlKey && (key === 'f' || key === 'b') && WINDOWS[S.focus] === 'monitor') {
    turnPage(key === 'f' ? 1 : -1);
    return true;
  }
  if (e.ctrlKey && key === 'w') {
    S.pending = 'C-w';
    showcmd();
    return true;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (key === 'Tab') {
    setFocus(S.focus + (e.shiftKey ? -1 : 1));
    return true;
  }
  if (/^[0-9]$/.test(key) && !S.pending && (key !== '0' || S.count)) {
    S.count += key;
    showcmd();
    return true;
  }
  const count = S.count ? Number(S.count) : 0;
  const n = Math.max(1, count);
  let k = key;
  if (S.pending === 'g') {
    S.pending = '';
    S.count = '';
    if (key === 't') setFocus(count ? count - 1 : S.focus + 1);
    else if (key === 'T') setFocus(S.focus - n);
    else if (key === 'g') windowKey('gg', n, count);
    showcmd();
    return true;
  }
  if (S.pending === 'd') {
    S.pending = '';
    S.count = '';
    if (key === 'd') windowKey('dd', n, count);
    showcmd();
    return true;
  }
  if (key === 'g' || key === 'd') {
    S.pending = key;
    showcmd();
    return true;
  }
  S.noted = false;
  S.count = '';
  showcmd();
  switch (k) {
    case ':':
      openCommand();
      return true;
    case 'i':
      openSay();
      return true;
    case '?':
      showMessage(':help', HELP);
      return true;
    case 'm':
      S.mode = S.mode === 'map' ? 'tiles' : 'map';
      layoutTiles(true);
      return true;
    case 'F':
      setMax(!S.max);
      return true;
    case 'Escape':
      if (S.solo != null) toggleSolo(null);
      else if (S.max) setMax(false);
      return true;
    default:
      if (k === 'ArrowDown') k = 'j';
      else if (k === 'ArrowUp') k = 'k';
      else if (k === 'ArrowLeft') k = 'h';
      else if (k === 'ArrowRight') k = 'l';
      return windowKey(k, n, count);
  }
}

function showcmd() {
  if (S.noted && !S.count && !S.pending) return;
  S.noted = false;
  $('showcmd').style.color = '';
  $('showcmd').textContent = `${S.count}${S.pending === 'C-w' ? '^W' : S.pending}`;
}

document.addEventListener('keydown', (e) => {
  if ($('desk').hidden || e.isComposing) return;
  const m = S.vmode;
  // Ctrl-[ is Esc (the browser takes Esc out of full screen).
  const escKey = e.key === 'Escape' || (e.ctrlKey && e.key === '[');
  if (m === 'command') {
    if (escKey) {
      e.preventDefault();
      closeCommand();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      S.histAt = clamp(S.histAt + (e.key === 'ArrowUp' ? -1 : 1), 0, S.history.length);
      $('cmdinput').value = S.history[S.histAt] || '';
    }
    return;
  }
  if (m === 'insert') {
    if (escKey) {
      e.preventDefault();
      closeSay();
    }
    return;
  }
  if (m === 'confirm') {
    e.preventDefault();
    if (e.key === 'y' || e.key === 'Y' || e.key === 'Enter') answer(true);
    else if (e.key === 'n' || e.key === 'N' || escKey) answer(false);
    return;
  }
  if (m === 'camera') {
    e.preventDefault();
    cameraKey(e, escKey);
    return;
  }
  if (m === 'msg') {
    e.preventDefault();
    const body = $('msg-body');
    // One whole line a press (held: keeps going), as in the game.
    const line = parseFloat(getComputedStyle(body).lineHeight) || 20;
    const at = Math.round(body.scrollTop / line);
    if (e.key === 'Enter' || e.key === 'q' || escKey) closeMessage();
    else if (e.key === 'j' || e.key === 'ArrowDown') body.scrollTop = (at + 1) * line;
    else if (e.key === 'k' || e.key === 'ArrowUp') body.scrollTop = Math.max(0, at - 1) * line;
    else if (e.key === 'G') body.scrollTop = body.scrollHeight;
    else if (e.key === 'g') body.scrollTop = 0;
    return;
  }
  if (escKey && e.key !== 'Escape') {
    e.preventDefault();
    normalKey({ key: 'Escape', ctrlKey: false, shiftKey: false });
    return;
  }
  if (normalKey(e)) e.preventDefault();
});

document.addEventListener('keyup', (e) => S.cam.held.delete(e.code));
window.addEventListener('blur', () => S.cam.held.clear());

// ---------------------------------------------------------------- mouse

WINDOWS.forEach((_, i) => win(i).addEventListener('mousedown', () => setFocus(i)));

/// A click on a list row: pick it; on ◀ ▶, change the value; on an action
/// row, run it.
function listClick(w, e) {
  const li = e.target.closest('li');
  if (!li || li.dataset.i == null) return;
  const i = Number(li.dataset.i);
  S.cur[w] = i;
  const rows = { match: matchRows, bots: botRows, rules: ruleRows }[w]();
  const r = rows[i];
  const a = e.target.closest('a[data-d]');
  if (r && r.ok !== false) {
    if (a && r.adj) r.adj(Number(a.dataset.d));
    else if (!a && (w === 'match' || w === 'rules')) {
      if (r.toggle) r.adj(1);
      else if (r.run) r.run();
    }
  }
  ({ match: renderMatch, bots: renderBots, rules: renderRules })[w]();
}
$('match-list').addEventListener('click', (e) => listClick('match', e));
$('bot-list').addEventListener('click', (e) => listClick('bots', e));
$('rules-list').addEventListener('click', (e) => listClick('rules', e));
$('ranking').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) select(Number(tr.dataset.id));
});
$('ranking').addEventListener('dblclick', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) toggleSolo(Number(tr.dataset.id));
});
$('minimap').addEventListener('click', (e) => mapClick($('minimap'), e));
$('minimap').addEventListener('dblclick', () => S.sel != null && toggleSolo(S.sel));
$('bigmap').addEventListener('click', (e) => mapClick($('bigmap'), e));
$('start').addEventListener('click', () => showMessage(':help', HELP));
$('btn-max').addEventListener('click', (e) => {
  e.stopPropagation();
  setMax(!S.max);
});
$('cmdbtn').addEventListener('click', () => openCommand());
$('btn-say').addEventListener('click', () => openSay());
$('rank-acts').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  setFocus(WINDOWS.indexOf('rank'));
  if (S.sel == null) {
    note('E: 先に順位の表で選手を選んでください', true);
    return;
  }
  windowKey({ solo: 'Enter', watch: 'w', kick: 'dd' }[b.dataset.act], 1, 0);
});
$('cmdwin').querySelector('.x').addEventListener('click', closeCommand);
$('saywin').querySelector('.x').addEventListener('click', closeSay);
$('msgwin').querySelector('.x').addEventListener('click', () => answer(false));
window.addEventListener('resize', () => layoutTiles(true));

// ---------------------------------------------------------------- start

(function start() {
  const m = location.hash.match(/key=([^&]+)/);
  let key = null;
  if (m) {
    try {
      key = decodeURIComponent(m[1]);
    } catch {
      key = m[1];
    }
    // Out of the address bar (and history) at once.
    history.replaceState(null, '', location.pathname + location.search);
  }
  key = key || storeGet();
  loadView();
  setFocus(1);
  setMode('normal');
  if (key) signIn(key);
  else showSignin('');
  requestAnimationFrame(frame);
})();
