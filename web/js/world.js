// Client-side copy of the movement rules (crates/vimfps-core: map.rs and
// sim.rs) so your own movement shows at once; the server stays in charge.

export const RUN_SPEED = 6.0;
export const SNEAK_SPEED = 2.6;
export const ACCEL = 40.0;
export const PLAYER_RADIUS = 0.4;

export const eyeHeight = (sneak) => (sneak ? 1.15 : 1.6);

export const GUNS = {
  ar: { name: 'AR', mag: 30, ads: 55, scope: 32, auto: true },
  smg: { name: 'SMG', mag: 32, ads: 62, scope: 48, auto: true },
  sg: { name: 'SG', mag: 6, ads: 66, scope: 58, auto: false },
  sr: { name: 'SR', mag: 5, ads: 45, scope: 14, auto: false },
};

export class World {
  constructor(map) {
    this.map = map;
    this.half = map.half;
    this.walls = map.solids.filter((s) => s.min.y < 1.7 && s.max.y > 0.3);
  }

  blocked(x, z, r) {
    if (Math.abs(x) > this.half - r || Math.abs(z) > this.half - r) return true;
    for (const s of this.walls) {
      if (x - r < s.max.x && x + r > s.min.x && z - r < s.max.z && z + r > s.min.z) return true;
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
    return { x, y: p.y, z };
  }
}

/// Wanted velocity for (mx, mz) at yaw, as on the server.
export function wantVelocity(mx, mz, yaw, sneak) {
  const speed = sneak ? SNEAK_SPEED : RUN_SPEED;
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  let vx = fx * mz + rx * mx;
  let vz = fz * mz + rz * mx;
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
