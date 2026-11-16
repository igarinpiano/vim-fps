// The automatic camera for watching ("the director"): a third-person,
// broadcast-style view. It picks whoever is in the thick of it, frames them
// with one of a few shots (circling from above, over the shoulder, a duel
// with the enemy in the distance, a high crane), and flies smoothly to the
// next player when the action moves.
//
// Pure: positions in, a camera pose out (no DOM, no three.js).

/// The shots, and the field of view each uses (degrees).
export const SHOTS = {
  orbit: { fov: 62 },
  chase: { fov: 72 },
  duel: { fov: 56 },
  crane: { fov: 66 },
};

/// How long one shot is held before the director looks for the next (s).
const HOLD = [7, 12];
/// The least time on a subject before hotter action elsewhere may cut in (s).
const MIN_HOLD = 3.5;
/// After the subject falls, stay on the scene this long (s).
const LINGER = 1.2;
/// An enemy this close makes a pair worth framing together (m); one they
/// are trading fire with, from farther still.
const RIVAL_RANGE = 120;
const FOE_RANGE = 260;
/// When something stands between the camera and the player: swing around
/// them by these angles (radians), and come in by these factors.
const SWING = [0, 0.6, -0.6, 1.2, -1.2, 2.1, -2.1, Math.PI];
const PULL = [1, 0.7, 0.45];
/// Heat (recent shooting, hits, kills) halves every this many seconds.
const HEAT_HALF = 4;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smooth = (k) => k * k * (3 - 2 * k);
const wrap = (a) => {
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  if (r < -Math.PI) r += Math.PI * 2;
  return r;
};

export class Director {
  /// world: { height(x, z), lineOfSight(a, b), half }, rand: () => [0, 1).
  constructor(world, rand = Math.random) {
    this.world = world;
    this.rand = rand;
    this.reset();
  }

  reset() {
    this.heat = new Map();
    this.foes = new Map(); // id -> { id, t }: whom they last traded fire with
    this.subject = null;
    this.rival = null;
    this.shot = 'orbit';
    this.since = 0; // when this subject got the camera
    this.cutAt = 0; // when to look for the next shot
    this.pending = null; // { id, at }: a cut waiting for its moment
    this.pos = null; // the camera, and the point it looks at
    this.look = null;
    this.fov = SHOTS.orbit.fov;
    this.fly = null; // { from, lookFrom, fovFrom, t, dur, arc }
    this.angle = 0;
    this.spin = 0.3;
    this.side = 1;
    this.heading = 0;
    this.want = null; // where the shot wants the camera (kept to linger on)
    this.way = [0, 0]; // which SWING / PULL gave a clear view last
    this.t = 0;
  }

  bump(id, v) {
    this.heat.set(id, Math.min(12, (this.heat.get(id) || 0) + v));
  }

  /// Things that happened: ('shot', id), ('hit', attacker, victim),
  /// ('kill', killer, victim).
  note(kind, a, b) {
    if (kind === 'shot') this.bump(a, 0.6);
    else if (kind === 'hit') {
      if (a === b) return;
      this.bump(a, 2.5);
      this.bump(b, 2);
      this.foes.set(a, { id: b, t: this.t });
      this.foes.set(b, { id: a, t: this.t });
    } else if (kind === 'kill') {
      if (a !== b) this.bump(a, 5);
      this.heat.delete(b);
      // The one we watched fell: after a moment, go to whoever got them.
      if (b === this.subject) this.pending = { id: a !== b ? a : null, at: this.t + LINGER };
    }
  }

  /// Begin from this camera pose (the view on screen), so the first shot
  /// is flown to rather than cut to.
  start(cam) {
    this.pos = { x: cam.x, y: cam.y, z: cam.z };
    const c = Math.cos(cam.pitch);
    this.look = { x: cam.x - Math.sin(cam.yaw) * c * 10, y: cam.y + Math.sin(cam.pitch) * 10, z: cam.z - Math.cos(cam.yaw) * c * 10 };
    this.fov = cam.fov;
  }

  /// Cut to this player now (n / N, :follow).
  force(id) {
    this.pending = { id, at: this.t, forced: true };
  }

  nearest(p, players) {
    let best = null;
    for (const q of players) {
      if (q.id === p.id) continue;
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (!best || d < best.d) best = { p: q, d };
    }
    return best;
  }

  /// How much is going on around a player.
  score(p, players) {
    let s = this.heat.get(p.id) || 0;
    const n = this.nearest(p, players);
    if (n && n.d < 70) s += (1 - n.d / 70) * 2.5;
    if (p.ads) s += 0.6;
    if (p.mv) s += 0.2;
    return s;
  }

  /// The enemy to frame with the subject: whom they are trading fire with,
  /// else the nearest one.
  pickRival(p, players) {
    const foe = this.foes.get(p.id);
    if (foe && this.t - foe.t < 6) {
      const q = players.find((x) => x.id === foe.id);
      if (q && Math.hypot(q.x - p.x, q.z - p.z) < FOE_RANGE) return q;
    }
    const n = this.nearest(p, players);
    return n && n.d < RIVAL_RANGE ? n.p : null;
  }

  pickSubject(players, avoid) {
    let best = null;
    for (const p of players) {
      // A little noise, and a turn for someone else, keep the picture varied.
      const s = this.score(p, players) + this.rand() * 0.8 - (p.id === avoid ? 1.5 : 0);
      if (!best || s > best.s) best = { p, s };
    }
    return best ? best.p : null;
  }

  pickShot(hasRival) {
    const pool = hasRival ? ['duel', 'duel', 'orbit', 'chase', 'crane'] : ['orbit', 'orbit', 'chase', 'crane'];
    const other = pool.filter((s) => s !== this.shot);
    const from = other.length ? other : pool;
    return from[Math.floor(this.rand() * from.length) % from.length];
  }

  /// Give `p` the camera with a new shot.
  cut(p, players) {
    const changed = p.id !== this.subject;
    this.subject = p.id;
    if (changed) this.since = this.t;
    const rival = this.pickRival(p, players);
    this.shot = this.pickShot(!!rival);
    this.cutAt = this.t + HOLD[0] + this.rand() * (HOLD[1] - HOLD[0]);
    this.pending = null;
    this.spin = (this.rand() < 0.5 ? -1 : 1) * (this.shot === 'crane' ? 0.12 : 0.3);
    this.side = this.rand() < 0.5 ? -1 : 1;
    this.heading = p.yaw;
    this.way = [0, 0];
    if (this.pos) {
      // Start circling from the side the camera is already on.
      this.angle = Math.atan2(this.pos.x - p.x, this.pos.z - p.z);
      this.fly = { from: { ...this.pos }, lookFrom: { ...this.look }, fovFrom: this.fov, t: 0, dur: 0, arc: 0 };
    } else this.angle = p.yaw + 0.6;
  }

  /// Nothing between the subject and the camera, and the camera above ground.
  clear(pos, target) {
    if (pos.y < this.world.height(pos.x, pos.z) + 0.8) return false;
    return this.world.lineOfSight(target, pos);
  }

  /// The camera `off` from the player, swung around them and pulled in
  /// (and so a little higher).
  place(p, off, swing, pull) {
    const half = this.world.half - 1;
    const s = Math.sin(swing);
    const c = Math.cos(swing);
    return {
      x: clamp(p.x + (off.x * c + off.z * s) * pull, -half, half),
      y: p.y + off.y * (pull < 1 ? 1 + (1 - pull) * 0.6 : 1),
      z: clamp(p.z + (off.z * c - off.x * s) * pull, -half, half),
    };
  }

  /// Where the shot wants the camera and what it looks at, for subject `p`.
  frame(p, rival) {
    const chest = { x: p.x, y: p.y + (p.sneak ? 0.8 : 1.2), z: p.z };
    let off; // camera, relative to the subject's feet
    let look = chest;
    const s = Math.sin(this.angle);
    const c = Math.cos(this.angle);
    if (this.shot === 'duel' && rival) {
      // Behind the subject on the line from the enemy, a little to one side
      // and above: the subject near, the enemy far.
      const dx = p.x - rival.x;
      const dz = p.z - rival.z;
      const d = Math.hypot(dx, dz) || 1;
      const ux = dx / d;
      const uz = dz / d;
      off = { x: ux * 6 - uz * 2.2 * this.side, y: 3.2, z: uz * 6 + ux * 2.2 * this.side };
      const k = clamp(d / 2, 4, 30) / d;
      look = { x: p.x - dx * k, y: chest.y + (rival.y - p.y) * k, z: p.z - dz * k };
    } else if (this.shot === 'chase') {
      // Over the shoulder, looking where they look.
      const fx = -Math.sin(this.heading);
      const fz = -Math.cos(this.heading);
      off = { x: -fx * 5.5 - fz * 1.3 * this.side, y: 2.8, z: -fz * 5.5 + fx * 1.3 * this.side };
      look = { x: p.x + fx * 12, y: chest.y, z: p.z + fz * 12 };
    } else if (this.shot === 'crane') {
      // High and wide, slowly circling; takes in a nearby enemy too.
      off = { x: s * 16, y: 14, z: c * 16 };
      if (rival && Math.hypot(rival.x - p.x, rival.z - p.z) < 50) {
        look = { x: (p.x + rival.x) / 2, y: (chest.y + rival.y + 1.2) / 2, z: (p.z + rival.z) / 2 };
      }
    } else {
      // Circling diagonally above.
      off = { x: s * 7.5, y: 4.2, z: c * 7.5 };
    }
    // Until nothing stands between the camera and them: the way that worked
    // last, else swing around and come in.
    const head = { x: p.x, y: p.y + (p.sneak ? 1.3 : 1.75), z: p.z };
    let pos = this.place(p, off, SWING[this.way[0]], PULL[this.way[1]]);
    if (this.way[0] + this.way[1] > 0 || !this.clear(pos, head)) {
      pos = null;
      for (let i = 0; i < SWING.length && !pos; i++) {
        for (let j = 0; j < PULL.length; j++) {
          const q = this.place(p, off, SWING[i], PULL[j]);
          if (this.clear(q, head)) {
            pos = q;
            this.way = [i, j];
            break;
          }
        }
      }
    }
    // Boxed in on every side: from right above.
    if (!pos) pos = { x: p.x + off.x * 0.1, y: p.y + 9, z: p.z + off.z * 0.1 };
    return { pos, look };
  }

  /// One frame. players: those alive ({id, x, y, z, yaw, sneak, ads, mv}).
  /// Returns { cam: {x, y, z, yaw, pitch, fov}, subject, rival, shot }, or
  /// null while there is nobody to show.
  update(now, dt, players) {
    this.t = now;
    const decay = 0.5 ** (dt / HEAT_HALF);
    for (const [id, h] of this.heat) {
      if (h * decay < 0.01) this.heat.delete(id);
      else this.heat.set(id, h * decay);
    }
    let subj = players.find((p) => p.id === this.subject) || null;

    // Who gets the camera?
    let next = null;
    if (this.pending && now >= this.pending.at) {
      next = players.find((p) => p.id === this.pending.id) || (this.pending.forced ? null : this.pickSubject(players, this.subject));
      if (!next) this.pending = null;
    } else if (!subj && !this.pending) {
      next = this.pickSubject(players, null);
    } else if (subj && !this.pending) {
      if (now >= this.cutAt) next = this.pickSubject(players, this.subject);
      else if (now - this.since > MIN_HOLD) {
        // Much hotter action elsewhere cuts in early.
        const mine = this.score(subj, players);
        const hot = players.reduce((a, p) => (this.score(p, players) > this.score(a, players) ? p : a), subj);
        if (hot.id !== subj.id && this.score(hot, players) > mine + 4) next = hot;
      }
    }
    if (next) {
      this.cut(next, players);
      subj = next;
    }

    if (!subj) {
      // The subject is gone (fallen, or left): hold the picture where it was.
      if (!this.pos) return null;
      if (!this.pending && !players.length) this.subject = null;
      return this.pose(dt, null, null);
    }

    const rival = this.pickRival(subj, players);
    this.rival = rival ? rival.id : null;
    if (this.shot === 'duel' && !rival) this.shot = 'orbit';
    this.angle += this.spin * dt;
    this.heading += wrap(subj.yaw - this.heading) * (1 - Math.exp(-dt * 3));
    return this.pose(dt, subj, rival);
  }

  pose(dt, subj, rival) {
    // With the subject gone, finish the move to where they last were.
    if (subj) this.want = this.frame(subj, rival);
    const want = this.want;
    if (want) {
      const wantFov = SHOTS[this.shot].fov;
      if (!this.pos) {
        this.pos = { ...want.pos };
        this.look = { ...want.look };
        this.fov = wantFov;
      } else if (this.fly) {
        // Flying to a new shot: ease there, rising over what is in between.
        const f = this.fly;
        if (!f.dur) {
          const d = Math.hypot(want.pos.x - f.from.x, want.pos.y - f.from.y, want.pos.z - f.from.z);
          f.dur = clamp(d / 40, 1.2, 4);
          f.arc = Math.min(30, d * 0.2);
        }
        f.t += dt;
        const k = smooth(clamp(f.t / f.dur, 0, 1));
        const mix = (a, b) => a + (b - a) * k;
        this.pos = {
          x: mix(f.from.x, want.pos.x),
          y: mix(f.from.y, want.pos.y) + Math.sin(Math.PI * k) * f.arc,
          z: mix(f.from.z, want.pos.z),
        };
        this.look = { x: mix(f.lookFrom.x, want.look.x), y: mix(f.lookFrom.y, want.look.y), z: mix(f.lookFrom.z, want.look.z) };
        this.fov = mix(f.fovFrom, wantFov);
        if (f.t >= f.dur) this.fly = null;
      } else {
        const kp = 1 - Math.exp(-dt * 5);
        const kl = 1 - Math.exp(-dt * 8);
        for (const a of ['x', 'y', 'z']) {
          this.pos[a] += (want.pos[a] - this.pos[a]) * kp;
          this.look[a] += (want.look[a] - this.look[a]) * kl;
        }
        this.fov += (wantFov - this.fov) * kp;
      }
    }
    this.pos.y = Math.max(this.pos.y, this.world.height(this.pos.x, this.pos.z) + 1);
    const dx = this.look.x - this.pos.x;
    const dy = this.look.y - this.pos.y;
    const dz = this.look.z - this.pos.z;
    return {
      cam: {
        x: this.pos.x,
        y: this.pos.y,
        z: this.pos.z,
        yaw: Math.atan2(-dx, -dz),
        pitch: clamp(Math.atan2(dy, Math.hypot(dx, dz)), -1.5, 1.5),
        fov: this.fov,
      },
      subject: subj ? subj.id : null,
      rival: subj ? this.rival : null,
      shot: this.shot,
      flying: !!this.fly,
    };
  }
}
