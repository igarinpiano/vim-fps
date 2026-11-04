// Client-side copy of the movement rules (crates/vimfps-core: map.rs and
// sim.rs) so your own movement shows at once; the server stays in charge.

export const RUN_SPEED = 6.0;
export const SNEAK_SPEED = 2.6;
export const ACCEL = 40.0;
export const PLAYER_RADIUS = 0.4;
export const STEP = 0.45;

export const eyeHeight = (sneak) => (sneak ? 1.15 : 1.6);

// Client-only numbers (field of view when aiming); the rules themselves
// come from the server in the welcome message (`:spec`).
export const GUNS = {
  ar: { name: 'AR', ads: 55, scope: 32 },
  smg: { name: 'SMG', ads: 62, scope: 48 },
  sg: { name: 'SG', ads: 66, scope: 58 },
  sr: { name: 'SR', ads: 45, scope: 14 },
};

export class World {
  constructor(map) {
    this.map = map;
    this.half = map.half;
    this.n = map.grid;
    this.cell = map.cell;
    this.h = map.heights;
    this.top = this.h.reduce((a, b) => Math.max(a, b), 0);
    this.solids = map.solids;
  }

  /// Bilinear terrain height, as Map::height.
  height(x, z) {
    const n = this.n;
    if (!n || !this.h || this.h.length < n * n) return 0;
    const max = n - 1;
    const gx = Math.min(max, Math.max(0, (x + this.half) / this.cell));
    const gz = Math.min(max, Math.max(0, (z + this.half) / this.cell));
    const ix = Math.min(n - 2, Math.floor(gx));
    const iz = Math.min(n - 2, Math.floor(gz));
    const fx = gx - ix;
    const fz = gz - iz;
    const h = (i, j) => this.h[j * n + i];
    const a = h(ix, iz) + (h(ix + 1, iz) - h(ix, iz)) * fx;
    const b = h(ix, iz + 1) + (h(ix + 1, iz + 1) - h(ix, iz + 1)) * fx;
    return a + (b - a) * fz;
  }

  blocked(x, z, r) {
    if (Math.abs(x) > this.half - r || Math.abs(z) > this.half - r) return true;
    const feet = this.height(x, z);
    for (const s of this.solids) {
      if (s.min.y < feet + 1.7 && s.max.y > feet + STEP && x - r < s.max.x && x + r > s.min.x && z - r < s.max.z && z + r > s.min.z) return true;
    }
    return false;
  }

  /// Same sub-stepped axis-separated slide as Map::slide.
  slide(p, dx, dz) {
    const len = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(len / 0.2));
    const sx = dx / steps;
    const sz = dz / steps;
    let x = p.x;
    let z = p.z;
    for (let i = 0; i < steps; i++) {
      if (!this.blocked(x + sx, z, PLAYER_RADIUS)) x += sx;
      if (!this.blocked(x, z + sz, PLAYER_RADIUS)) z += sz;
    }
    return { x, y: this.height(x, z), z };
  }

  /// Distance to the first solid or hill along a unit ray, or null.
  raycast(o, d, max) {
    let best = max;
    let hit = false;
    for (const s of this.solids) {
      const t = rayBox(o, d, s.min, s.max, best);
      if (t !== null && t < best) {
        best = t;
        hit = true;
      }
    }
    const tt = this.rayTerrain(o, d, best);
    if (tt !== null) return tt;
    return hit ? best : null;
  }

  rayTerrain(o, d, max) {
    const below = (t) => o.y + d.y * t < this.height(o.x + d.x * t, o.z + d.z * t);
    if (below(0)) return 0;
    for (let t = 0; t < max; t += 1.0) {
      const next = Math.min(max, t + 1.0);
      if (o.y + d.y * next > this.top && d.y >= 0) return null;
      if (below(next)) {
        let lo = t;
        let hi = next;
        for (let i = 0; i < 6; i++) {
          const mid = (lo + hi) / 2;
          if (below(mid)) hi = mid;
          else lo = mid;
        }
        return hi;
      }
    }
    return null;
  }

  lineOfSight(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return true;
    const t = this.raycast(a, { x: dx / len, y: dy / len, z: dz / len }, len);
    return t === null || t >= len - 0.05;
  }
}

function rayBox(o, d, lo, hi, max) {
  let tmin = 0;
  let tmax = max;
  for (const k of ['x', 'y', 'z']) {
    if (Math.abs(d[k]) < 1e-8) {
      if (o[k] < lo[k] || o[k] > hi[k]) return null;
    } else {
      let t1 = (lo[k] - o[k]) / d[k];
      let t2 = (hi[k] - o[k]) / d[k];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

/// Wanted velocity for (mx, mz) at yaw, as on the server.
export function wantVelocity(mx, mz, yaw, sneak) {
  const speed = sneak ? SNEAK_SPEED : RUN_SPEED;
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  const vx = fx * mz + rx * mx;
  const vz = fz * mz + rz * mx;
  const l = Math.hypot(vx, vz);
  if (l < 1e-6) return { x: 0, z: 0 };
  return { x: (vx / l) * speed, z: (vz / l) * speed };
}

export function wrapAngle(a) {
  const tau = Math.PI * 2;
  a %= tau;
  if (a > Math.PI) a -= tau;
  if (a < -Math.PI) a += tau;
  return a;
}

/// Bearing of (dx, dz) relative to yaw: 0 ahead, + to the left.
export function bearing(dx, dz, yaw) {
  return wrapAngle(Math.atan2(-dx, -dz) - yaw);
}
