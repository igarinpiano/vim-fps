import test from 'node:test';
import assert from 'node:assert/strict';
import { Director } from '../../web/js/director.js';

// A flat, empty field (one wall when asked for).
function world(wall = null) {
  return {
    half: 100,
    height: () => 0,
    lineOfSight(a, b) {
      if (!wall) return true;
      // The wall is the plane x = wall, up to 5 m high.
      if ((a.x - wall) * (b.x - wall) >= 0) return true;
      const k = (wall - a.x) / (b.x - a.x);
      return a.y + (b.y - a.y) * k > 5;
    },
  };
}

function seq(...v) {
  let i = 0;
  return () => v[i++ % v.length];
}

const P = (id, x, z, extra = {}) => ({ id, x, y: 0, z, yaw: 0, pitch: 0, sneak: false, ads: false, alive: true, ...extra });

/// Where on the camera's forward axis a point lies (m ahead, and the angle off it).
function seen(cam, p) {
  const f = { x: -Math.sin(cam.yaw) * Math.cos(cam.pitch), y: Math.sin(cam.pitch), z: -Math.cos(cam.yaw) * Math.cos(cam.pitch) };
  const d = { x: p.x - cam.x, y: p.y + 1.2 - cam.y, z: p.z - cam.z };
  const len = Math.hypot(d.x, d.y, d.z);
  const ahead = d.x * f.x + d.y * f.y + d.z * f.z;
  return { ahead, angle: Math.acos(Math.max(-1, Math.min(1, ahead / len))), dist: len };
}

function run(d, players, from, to, step = 1 / 60) {
  let r = null;
  for (let t = from; t < to; t += step) r = d.update(t, step, players);
  return r;
}

test('nobody to show: no camera', () => {
  const d = new Director(world());
  assert.equal(d.update(0, 1 / 60, []), null);
});

test('one player: a third-person view from diagonally above, looking at them', () => {
  const d = new Director(world(), seq(0.5));
  const a = P(1, 10, -20);
  const r = run(d, [a], 0, 3);
  assert.equal(r.subject, 1);
  const s = seen(r.cam, a);
  assert.ok(r.cam.y > 2, 'above the player');
  assert.ok(s.dist > 3 && s.dist < 25, `not first person (${s.dist} m away)`);
  assert.ok(s.angle < 0.45, 'the player is in the picture');
  assert.ok(r.cam.pitch < 0, 'looking down at them');
});

test('circling: the camera goes around the player', () => {
  const d = new Director(world(), seq(0.5));
  const a = P(1, 0, 0);
  d.shot = 'chase'; // so the shot picked first is the circling one
  const at = [];
  for (let t = 0; t < 6; t += 1 / 60) {
    const r = d.update(t, 1 / 60, [a]);
    if (r.shot === 'orbit') at.push(Math.atan2(r.cam.x, r.cam.z));
  }
  assert.ok(at.length > 60);
  const turned = Math.abs(at[at.length - 1] - at[0]);
  assert.ok(turned > 0.5, `went around (${turned} rad)`);
});

test('a duel shows the player near and the enemy in the distance', () => {
  const d = new Director(world(), seq(0));
  const a = P(1, 0, 0);
  const b = P(2, 0, -40);
  d.update(0, 1 / 60, [a, b]);
  d.note('hit', 1, 2);
  d.force(1);
  d.shot = 'orbit'; // so the next shot picked (first of the pool) is the duel
  const r = run(d, [a, b], 1 / 60, 5);
  assert.equal(r.shot, 'duel');
  assert.equal(r.subject, 1);
  assert.equal(r.rival, 2);
  const near = seen(r.cam, a);
  const far = seen(r.cam, b);
  assert.ok(near.ahead > 0 && far.ahead > 0, 'both in front of the camera');
  assert.ok(far.dist > near.dist * 3, 'the enemy is the far one');
  assert.ok(near.angle < 0.6 && far.angle < 0.3, 'both in the picture');
});

test('the action elsewhere takes the camera, flying there smoothly', () => {
  const d = new Director(world(), seq(0.5));
  const a = P(1, -60, 0);
  const b = P(2, 60, 0);
  const c = P(3, 60, 30);
  d.update(0, 1 / 60, [a]);
  d.subject = 1;
  let r = run(d, [a, b, c], 1 / 60, 4);
  assert.equal(r.subject, 1);
  for (let i = 0; i < 4; i++) d.note('hit', 2, 3);
  let prev = r.cam;
  let jump = 0;
  let turn = 0;
  for (let t = 4; t < 9; t += 1 / 60) {
    r = d.update(t, 1 / 60, [a, b, c]);
    jump = Math.max(jump, Math.hypot(r.cam.x - prev.x, r.cam.y - prev.y, r.cam.z - prev.z));
    let dy = Math.abs(r.cam.yaw - prev.yaw);
    if (dy > Math.PI) dy = Math.PI * 2 - dy;
    turn = Math.max(turn, dy);
    prev = r.cam;
  }
  assert.ok([2, 3].includes(r.subject), 'went to the fight');
  assert.ok(Math.abs(r.cam.x - 60) < 30, 'and arrived');
  assert.ok(jump < 2.5, `no jump cut (${jump} m in a frame)`);
  assert.ok(turn < 0.2, `no whip pan (${turn} rad in a frame)`);
});

test('the one followed falls: after a moment the camera goes to the killer', () => {
  const d = new Director(world(), seq(0.5));
  const a = P(1, 0, 0);
  const b = P(2, 20, 0);
  d.update(0, 1 / 60, [a]);
  run(d, [a, b], 1 / 60, 1);
  assert.equal(d.subject, 1);
  d.note('kill', 2, 1);
  let r = d.update(1.1, 1 / 60, [b]);
  assert.ok(r && r.subject == null, 'stays on the scene first');
  r = run(d, [b], 1.1, 4);
  assert.equal(r.subject, 2);
});

test('n / :follow: the camera is told whom to show', () => {
  const d = new Director(world(), seq(0.5));
  const a = P(1, 0, 0);
  const b = P(2, 50, 0);
  run(d, [a, b], 0, 1);
  const other = d.subject === 1 ? 2 : 1;
  d.force(other);
  const r = run(d, [a, b], 1, 1.1);
  assert.equal(r.subject, other);
});

test('a wall in the way: the camera comes in until it sees the player', () => {
  const w = world(3);
  const d = new Director(w, seq(0.5));
  const a = P(1, 0, 0);
  for (let t = 0; t < 30; t += 1 / 30) {
    const r = d.update(t, 1 / 30, [a]);
    if (!r.flying && t > 2) {
      const want = d.frame(a, null).pos;
      assert.ok(w.lineOfSight({ x: 0, y: 1.2, z: 0 }, want), `sees the player (t=${t.toFixed(1)}, ${r.shot})`);
    }
  }
});

test('starting from the view on screen: pulled back from, not cut', () => {
  const d = new Director(world(), seq(0.5));
  const a = P(1, 0, 0);
  d.start({ x: 0, y: 1.6, z: 0, yaw: 0, pitch: 0, fov: 80 });
  d.force(1);
  const first = d.update(0, 1 / 60, [a]);
  assert.ok(Math.hypot(first.cam.x, first.cam.y - 1.6, first.cam.z) < 0.5, 'begins at the eyes');
  const r = run(d, [a], 1 / 60, 3);
  assert.ok(seen(r.cam, a).dist > 3, 'ends outside');
});
