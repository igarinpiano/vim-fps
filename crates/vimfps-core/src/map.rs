//! Outdoor map, generated from a seed: rolling terrain (a height grid,
//! bilinearly interpolated) with axis-aligned boxes standing on it.

use crate::math::{Aabb, Vec3};
use crate::rng::Rng;
use serde::{Deserialize, Serialize};

/// Half of the playable field's side (the field is 2*HALF square).
pub const HALF: f32 = 200.0;
/// Player collision radius.
pub const PLAYER_RADIUS: f32 = 0.4;
/// Height samples per side of the terrain grid.
pub const GRID: usize = 135;
/// A ledge lower than this above your feet does not block walking.
pub const STEP: f32 = 0.45;

// What a generated field holds (it is 400 m square; the counts are about
// three times the 240 m field's, for more cover per square metre too).
const BUILDINGS: usize = 24;
const ROCKS: usize = 170;
const COVERS: usize = 170;
const CRATES: usize = 110;
const TREES: usize = 420;
const SPAWNS: usize = 48;
/// Rolling hills: bumps on the field (the first third of them big).
const BUMPS: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BoxKind {
    Wall,
    Roof,
    Rock,
    Cover,
    Crate,
    Trunk,
    Fence,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Solid {
    pub kind: BoxKind,
    #[serde(flatten)]
    pub aabb: Aabb,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PickupKind {
    Ar,
    Smg,
    Sg,
    Sr,
    Medkit,
    Grenade,
    Ammo,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PickupSpot {
    pub kind: PickupKind,
    pub pos: Vec3,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Map {
    pub seed: u64,
    pub half: f32,
    /// Terrain: `grid` x `grid` heights (row-major, z then x) spaced `cell`
    /// metres apart, starting at (-half, -half).
    pub grid: usize,
    pub cell: f32,
    pub heights: Vec<f32>,
    pub solids: Vec<Solid>,
    /// Foliage (visual only): x, z, radius, height of the crown's base.
    pub trees: Vec<[f32; 4]>,
    pub spawns: Vec<Vec3>,
    pub pickups: Vec<PickupSpot>,
    /// Firing range: practice dummies (where they stand, how far they
    /// strafe left and right).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub targets: Vec<RangeTarget>,
    /// Text shown in the world (distance signs).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<Label>,
    /// The highest terrain sample, worked out once (rays above it miss).
    #[serde(skip)]
    pub top: std::sync::OnceLock<f32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RangeTarget {
    pub pos: Vec3,
    pub strafe: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Label {
    pub pos: Vec3,
    pub text: String,
}

impl Map {
    pub fn generate(seed: u64) -> Map {
        let mut rng = Rng::new(seed);
        let mut solids: Vec<Solid> = Vec::new();
        let mut footprints: Vec<Aabb> = Vec::new();
        let mut trees = Vec::new();
        let h = HALF;
        let mut map = Map {
            seed,
            half: h,
            grid: GRID,
            cell: 2.0 * h / (GRID - 1) as f32,
            heights: hills(&mut rng, h),
            solids: Vec::new(),
            trees: Vec::new(),
            spawns: Vec::new(),
            pickups: Vec::new(),
            targets: Vec::new(),
            labels: Vec::new(),
            top: Default::default(),
        };

        // Fence around the field (the terrain is flat near the edge).
        for b in [
            Aabb::new(
                Vec3::new(-h - 1.0, -5.0, -h - 1.0),
                Vec3::new(h + 1.0, 2.5, -h),
            ),
            Aabb::new(
                Vec3::new(-h - 1.0, -5.0, h),
                Vec3::new(h + 1.0, 2.5, h + 1.0),
            ),
            Aabb::new(Vec3::new(-h - 1.0, -5.0, -h), Vec3::new(-h, 2.5, h)),
            Aabb::new(Vec3::new(h, -5.0, -h), Vec3::new(h + 1.0, 2.5, h)),
        ] {
            solids.push(Solid {
                kind: BoxKind::Fence,
                aabb: b,
            });
        }

        let free = |fp: &Aabb, footprints: &[Aabb], margin: f32| {
            fp.min.x > -h + 3.0
                && fp.max.x < h - 3.0
                && fp.min.z > -h + 3.0
                && fp.max.z < h - 3.0
                && !footprints.iter().any(|o| o.overlaps_xz(fp, margin))
        };

        // Buildings: four walls with door gaps and a roof.
        let mut buildings = 0;
        let mut tries = 0;
        while buildings < BUILDINGS && tries < 6000 {
            tries += 1;
            let w = rng.range(9.0, 16.0).round();
            let d = rng.range(9.0, 16.0).round();
            let cx = rng.range(-h + 15.0, h - 15.0).round();
            let cz = rng.range(-h + 15.0, h - 15.0).round();
            let fp = Aabb::ground(cx, cz, w, d, 3.6);
            if !free(&fp, &footprints, 6.0) {
                continue;
            }
            footprints.push(fp);
            buildings += 1;
            // Level the ground under the building and blend it into the hills.
            let floor = map.flatten(cx, cz, w / 2.0 + 2.0, d / 2.0 + 2.0, 7.0);
            add_building(&mut solids, &mut rng, cx, cz, w, d, floor);
        }
        map.round_heights();

        // Rocks, cover lines (sandbag-like low walls) and crates.
        let place = |rng: &mut Rng,
                     solids: &mut Vec<Solid>,
                     footprints: &mut Vec<Aabb>,
                     kind: BoxKind,
                     count: usize,
                     size: (f32, f32),
                     height: (f32, f32)| {
            let mut n = 0;
            let mut tries = 0;
            while n < count && tries < count * 40 {
                tries += 1;
                let (w, d) = if kind == BoxKind::Cover {
                    let long = rng.range(size.0, size.1);
                    if rng.chance(0.5) {
                        (long, 0.8)
                    } else {
                        (0.8, long)
                    }
                } else {
                    (rng.range(size.0, size.1), rng.range(size.0, size.1))
                };
                let cx = rng.range(-h + 6.0, h - 6.0);
                let cz = rng.range(-h + 6.0, h - 6.0);
                let tall = rng.range(height.0, height.1);
                let fp = Aabb::ground(cx, cz, w, d, tall);
                if !free(&fp, footprints, 2.5) {
                    continue;
                }
                footprints.push(fp);
                solids.push(Solid {
                    kind,
                    aabb: map.on_ground(cx, cz, w, d, tall),
                });
                n += 1;
            }
        };
        place(
            &mut rng,
            &mut solids,
            &mut footprints,
            BoxKind::Rock,
            ROCKS,
            (1.5, 4.5),
            (1.3, 2.8),
        );
        place(
            &mut rng,
            &mut solids,
            &mut footprints,
            BoxKind::Cover,
            COVERS,
            (4.0, 10.0),
            (1.0, 1.15),
        );
        place(
            &mut rng,
            &mut solids,
            &mut footprints,
            BoxKind::Crate,
            CRATES,
            (1.2, 2.0),
            (1.2, 2.0),
        );

        // Trees: a trunk (solid) and a crown (visual).
        let mut n = 0;
        let mut tries = 0;
        while n < TREES && tries < 16000 {
            tries += 1;
            let cx = rng.range(-h + 4.0, h - 4.0);
            let cz = rng.range(-h + 4.0, h - 4.0);
            let fp = Aabb::ground(cx, cz, 0.6, 0.6, 7.0);
            if !free(&fp, &footprints, 2.0) {
                continue;
            }
            footprints.push(fp);
            solids.push(Solid {
                kind: BoxKind::Trunk,
                aabb: map.on_ground(cx, cz, 0.6, 0.6, 7.0),
            });
            let base = map.height(cx, cz) + rng.range(2.2, 3.2);
            trees.push([cx, cz, rng.range(1.8, 3.0), (base * 100.0).round() / 100.0]);
            n += 1;
        }
        map.solids = solids;
        map.trees = trees;

        // Spawn points, spread over the field.
        let mut tries = 0;
        // Each next to something to take cover behind (a rock, a low wall, a
        // crate, a tree or a building, within 5 m).
        while map.spawns.len() < SPAWNS && tries < 40000 {
            tries += 1;
            let mut p = Vec3::new(
                rng.range(-h + 8.0, h - 8.0),
                0.0,
                rng.range(-h + 8.0, h - 8.0),
            );
            p.y = map.height(p.x, p.z);
            if map.blocked(p, 1.5) || map.spawns.iter().any(|s| s.distance(p) < 30.0) {
                continue;
            }
            let covered = map.solids.iter().any(|s| {
                !matches!(s.kind, BoxKind::Fence | BoxKind::Roof)
                    && s.aabb.max.y > p.y + 1.0
                    && s.aabb.distance_xz(p) < 5.0
            });
            if !covered && tries < 30000 {
                continue;
            }
            map.spawns.push(p);
        }

        // Pickups: weapons more often inside/near buildings, items anywhere.
        let kinds = [
            (PickupKind::Sr, 9),
            (PickupKind::Sg, 12),
            (PickupKind::Smg, 12),
            (PickupKind::Ar, 10),
            (PickupKind::Medkit, 30),
            (PickupKind::Grenade, 20),
            (PickupKind::Ammo, 28),
        ];
        let building_centres: Vec<Vec3> = footprints
            .iter()
            .filter(|f| f.max.y > 3.55 && f.max.y < 3.65)
            .map(|f| Vec3::new((f.min.x + f.max.x) / 2.0, 0.0, (f.min.z + f.max.z) / 2.0))
            .collect();
        for (kind, count) in kinds {
            let mut placed = 0;
            let mut tries = 0;
            while placed < count && tries < 6000 {
                tries += 1;
                let weapon = matches!(
                    kind,
                    PickupKind::Ar | PickupKind::Smg | PickupKind::Sg | PickupKind::Sr
                );
                let mut p = if weapon && !building_centres.is_empty() && rng.chance(0.6) {
                    let c = building_centres[rng.below(building_centres.len())];
                    Vec3::new(c.x + rng.range(-3.0, 3.0), 0.0, c.z + rng.range(-3.0, 3.0))
                } else {
                    Vec3::new(
                        rng.range(-h + 6.0, h - 6.0),
                        0.0,
                        rng.range(-h + 6.0, h - 6.0),
                    )
                };
                p.y = map.height(p.x, p.z);
                if map.blocked(p, 1.0) || map.pickups.iter().any(|s| s.pos.distance(p) < 6.0) {
                    continue;
                }
                map.pickups.push(PickupSpot { kind, pos: p });
                placed += 1;
            }
        }
        map
    }

    /// The firing range: a long flat field. You start at the bench (z =
    /// +200, facing -Z) with every gun and item on the rack; dummies stand
    /// 10–400 m away, some strafing, some behind cover, each with a sign.
    pub fn firing_range() -> Map {
        let half = 240.0;
        let n = GRID;
        let cell = 2.0 * half / (n - 1) as f32;
        let mut heights = vec![0.0f32; n * n];
        // A berm behind the farthest targets.
        for j in 0..n {
            let z = -half + j as f32 * cell;
            if z < -215.0 {
                for i in 0..n {
                    heights[j * n + i] = ((-215.0 - z) * 0.4).min(8.0);
                }
            }
        }
        let mut map = Map {
            seed: 0,
            half,
            grid: n,
            cell,
            heights,
            solids: Vec::new(),
            trees: Vec::new(),
            spawns: vec![Vec3::new(0.0, 0.0, 200.0)],
            pickups: Vec::new(),
            targets: Vec::new(),
            labels: Vec::new(),
            top: Default::default(),
        };
        let h = half;
        for b in [
            Aabb::new(
                Vec3::new(-h - 1.0, -5.0, -h - 1.0),
                Vec3::new(h + 1.0, 12.0, -h),
            ),
            Aabb::new(
                Vec3::new(-h - 1.0, -5.0, h),
                Vec3::new(h + 1.0, 2.5, h + 1.0),
            ),
            Aabb::new(Vec3::new(-h - 1.0, -5.0, -h), Vec3::new(-h, 2.5, h)),
            Aabb::new(Vec3::new(h, -5.0, -h), Vec3::new(h + 1.0, 2.5, h)),
        ] {
            map.solids.push(Solid {
                kind: BoxKind::Fence,
                aabb: b,
            });
        }
        // The bench and the rack behind it.
        map.solids.push(Solid {
            kind: BoxKind::Crate,
            aabb: Aabb::ground(0.0, 196.5, 14.0, 0.8, 1.0),
        });
        let rack = [
            PickupKind::Ar,
            PickupKind::Smg,
            PickupKind::Sg,
            PickupKind::Sr,
            PickupKind::Medkit,
            PickupKind::Grenade,
            PickupKind::Ammo,
        ];
        for (i, kind) in rack.into_iter().enumerate() {
            map.pickups.push(PickupSpot {
                kind,
                pos: Vec3::new(-6.0 + i as f32 * 2.0, 0.0, 202.5),
            });
        }
        // Lanes: (distance, x, strafe, cover in front).
        let lanes: [(f32, f32, f32, bool); 12] = [
            (10.0, -6.0, 0.0, false),
            (10.0, 6.0, 0.0, true),
            (25.0, -10.0, 0.0, false),
            (25.0, 10.0, 3.0, false),
            (50.0, -14.0, 0.0, false),
            (50.0, 14.0, 4.0, false),
            (100.0, -18.0, 0.0, true),
            (100.0, 18.0, 5.0, false),
            (200.0, -24.0, 0.0, false),
            (200.0, 24.0, 6.0, false),
            (300.0, 0.0, 0.0, false),
            (400.0, 0.0, 0.0, false),
        ];
        for (d, x, strafe, cover) in lanes {
            let z = 200.0 - d;
            map.targets.push(RangeTarget {
                pos: Vec3::new(x, 0.0, z),
                strafe,
            });
            map.labels.push(Label {
                pos: Vec3::new(x, 2.8, z),
                text: if strafe > 0.0 {
                    format!("{d} m ↔")
                } else {
                    format!("{d} m")
                },
            });
            if cover {
                // Waist-high cover: only the head shows.
                map.solids.push(Solid {
                    kind: BoxKind::Cover,
                    aabb: Aabb::ground(x, z + 1.2, 1.6, 0.6, 1.25),
                });
            }
        }
        // A wall to shoot around, and posts every 50 m down the middle.
        map.solids.push(Solid {
            kind: BoxKind::Wall,
            aabb: Aabb::ground(-40.0, 170.0, 8.0, 0.4, 3.0),
        });
        for k in 1..=8 {
            let z = 200.0 - 50.0 * k as f32;
            map.solids.push(Solid {
                kind: BoxKind::Trunk,
                aabb: Aabb::ground(-34.0, z, 0.3, 0.3, 1.5),
            });
            map.solids.push(Solid {
                kind: BoxKind::Trunk,
                aabb: Aabb::ground(34.0, z, 0.3, 0.3, 1.5),
            });
        }
        map
    }

    /// Terrain height at (x, z): bilinear between grid samples.
    pub fn height(&self, x: f32, z: f32) -> f32 {
        let n = self.grid;
        if n < 2 || self.heights.len() < n * n {
            return 0.0;
        }
        let max = (n - 1) as f32;
        let gx = ((x + self.half) / self.cell).clamp(0.0, max);
        let gz = ((z + self.half) / self.cell).clamp(0.0, max);
        let ix = (gx.floor() as usize).min(n - 2);
        let iz = (gz.floor() as usize).min(n - 2);
        let fx = gx - ix as f32;
        let fz = gz - iz as f32;
        let h = |i: usize, j: usize| self.heights[j * n + i];
        let a = h(ix, iz) + (h(ix + 1, iz) - h(ix, iz)) * fx;
        let b = h(ix, iz + 1) + (h(ix + 1, iz + 1) - h(ix, iz + 1)) * fx;
        a + (b - a) * fz
    }

    fn max_height(&self) -> f32 {
        *self
            .top
            .get_or_init(|| self.heights.iter().copied().fold(0.0, f32::max))
    }

    /// Sets the grid inside a rectangle to its mean height and blends a ring
    /// of `blend` metres around it. Returns the level.
    fn flatten(&mut self, cx: f32, cz: f32, hx: f32, hz: f32, blend: f32) -> f32 {
        let n = self.grid;
        let pos = |i: usize| -self.half + i as f32 * self.cell;
        let mut sum = 0.0;
        let mut cnt = 0.0;
        for j in 0..n {
            for i in 0..n {
                if (pos(i) - cx).abs() <= hx && (pos(j) - cz).abs() <= hz {
                    sum += self.heights[j * n + i];
                    cnt += 1.0;
                }
            }
        }
        let level = if cnt > 0.0 {
            sum / cnt
        } else {
            self.height(cx, cz)
        };
        for j in 0..n {
            for i in 0..n {
                let dx = ((pos(i) - cx).abs() - hx).max(0.0);
                let dz = ((pos(j) - cz).abs() - hz).max(0.0);
                let d = (dx * dx + dz * dz).sqrt();
                if d >= blend {
                    continue;
                }
                let k = d / blend;
                let k = k * k * (3.0 - 2.0 * k);
                let v = &mut self.heights[j * n + i];
                *v = level + (*v - level) * k;
            }
        }
        level
    }

    /// Heights rounded to centimetres, so the JSON sent to the browser holds
    /// exactly what the server uses.
    fn round_heights(&mut self) {
        for v in &mut self.heights {
            *v = (*v * 100.0).round() / 100.0;
        }
    }

    /// A box of footprint w x d and height `tall` standing on the terrain at
    /// (cx, cz): sunk into the ground on its low side, `tall` above its high side.
    pub fn on_ground(&self, cx: f32, cz: f32, w: f32, d: f32, tall: f32) -> Aabb {
        let mut lo = f32::MAX;
        let mut hi = f32::MIN;
        for (x, z) in [
            (cx, cz),
            (cx - w / 2.0, cz - d / 2.0),
            (cx + w / 2.0, cz - d / 2.0),
            (cx - w / 2.0, cz + d / 2.0),
            (cx + w / 2.0, cz + d / 2.0),
        ] {
            let y = self.height(x, z);
            lo = lo.min(y);
            hi = hi.max(y);
        }
        let r = |v: f32| (v * 100.0).round() / 100.0;
        Aabb::new(
            Vec3::new(r(cx - w / 2.0), r(lo - 0.3), r(cz - d / 2.0)),
            Vec3::new(r(cx + w / 2.0), r(hi + tall), r(cz + d / 2.0)),
        )
    }

    /// Whether a circle of radius `r` standing at (p.x, p.z) touches a solid
    /// that blocks walking (or lies outside the field). Feet are on the
    /// terrain there.
    pub fn blocked(&self, p: Vec3, r: f32) -> bool {
        if p.x.abs() > self.half - r || p.z.abs() > self.half - r {
            return true;
        }
        let feet = self.height(p.x, p.z);
        let probe = Aabb::ground(p.x, p.z, 2.0 * r, 2.0 * r, 1.8);
        self.solids.iter().any(|s| {
            s.aabb.min.y < feet + 1.7
                && s.aabb.max.y > feet + STEP
                && s.aabb.overlaps_xz(&probe, 0.0)
        })
    }

    /// Moves a walker from `from` by `delta`, sliding along solids.
    pub fn slide(&self, from: Vec3, delta: Vec3) -> Vec3 {
        let mut p = from;
        // Sub-steps so a fast mover never skips a thin wall.
        let steps = ((delta.length_xz() / 0.2).ceil() as usize).max(1);
        let step = delta * (1.0 / steps as f32);
        for _ in 0..steps {
            let nx = Vec3::new(p.x + step.x, p.y, p.z);
            if !self.blocked(nx, PLAYER_RADIUS) {
                p = nx;
            }
            let nz = Vec3::new(p.x, p.y, p.z + step.z);
            if !self.blocked(nz, PLAYER_RADIUS) {
                p = nz;
            }
        }
        p.y = self.height(p.x, p.z);
        p
    }

    /// Nearest solid or terrain hit by a ray, as a distance.
    pub fn raycast(&self, origin: Vec3, dir: Vec3, max: f32) -> Option<f32> {
        let mut best: Option<f32> = None;
        for s in &self.solids {
            if let Some(t) = s.aabb.ray(origin, dir, max)
                && best.is_none_or(|b| t < b)
            {
                best = Some(t);
            }
        }
        if let Some(t) = self.ray_terrain(origin, dir, best.unwrap_or(max)) {
            best = Some(t);
        }
        best
    }

    /// Where a ray first goes below the terrain (marching, then bisection).
    pub fn ray_terrain(&self, origin: Vec3, dir: Vec3, max: f32) -> Option<f32> {
        let top = self.max_height();
        let below = |t: f32| {
            let p = origin + dir * t;
            p.y < self.height(p.x, p.z)
        };
        if below(0.0) {
            return Some(0.0);
        }
        let step = 0.5;
        let mut t = 0.0;
        while t < max {
            let next = (t + step).min(max);
            let p = origin + dir * next;
            if p.y > top && dir.y >= 0.0 {
                return None;
            }
            if below(next) {
                let (mut lo, mut hi) = (t, next);
                for _ in 0..8 {
                    let mid = (lo + hi) / 2.0;
                    if below(mid) {
                        hi = mid;
                    } else {
                        lo = mid;
                    }
                }
                return Some(hi);
            }
            t = next;
        }
        None
    }

    /// Clear line between two points.
    pub fn line_of_sight(&self, a: Vec3, b: Vec3) -> bool {
        let d = b - a;
        let len = d.length();
        if len < 1e-4 {
            return true;
        }
        self.raycast(a, d * (1.0 / len), len)
            .is_none_or(|t| t >= len - 0.05)
    }
}

/// Rolling hills: a few anisotropic bumps (some of them dips), fading to
/// flat ground near the fence.
fn hills(rng: &mut Rng, half: f32) -> Vec<f32> {
    struct Bump {
        x: f32,
        z: f32,
        rx: f32,
        rz: f32,
        a: f32,
    }
    let mut bumps = Vec::new();
    for i in 0..BUMPS {
        let big = i < BUMPS / 3;
        bumps.push(Bump {
            x: rng.range(-half + 20.0, half - 20.0),
            z: rng.range(-half + 20.0, half - 20.0),
            rx: if big {
                rng.range(18.0, 40.0)
            } else {
                rng.range(8.0, 20.0)
            },
            rz: if big {
                rng.range(18.0, 40.0)
            } else {
                rng.range(8.0, 20.0)
            },
            a: if rng.chance(0.75) {
                if big {
                    rng.range(4.0, 11.0)
                } else {
                    rng.range(1.5, 5.0)
                }
            } else {
                -rng.range(1.0, 3.0)
            },
        });
    }
    let n = GRID;
    let cell = 2.0 * half / (n - 1) as f32;
    let mut v = vec![0.0; n * n];
    for j in 0..n {
        for i in 0..n {
            let x = -half + i as f32 * cell;
            let z = -half + j as f32 * cell;
            let mut y = 0.0;
            for b in &bumps {
                let dx = (x - b.x) / b.rx;
                let dz = (z - b.z) / b.rz;
                y += b.a * (-(dx * dx + dz * dz)).exp();
            }
            let edge = (half - x.abs()).min(half - z.abs());
            let k = ((edge - 4.0) / 18.0).clamp(0.0, 1.0);
            let k = k * k * (3.0 - 2.0 * k);
            v[j * n + i] = (y * k).max(-2.5);
        }
    }
    v
}

#[allow(clippy::too_many_arguments)]
fn add_building(
    solids: &mut Vec<Solid>,
    rng: &mut Rng,
    cx: f32,
    cz: f32,
    w: f32,
    d: f32,
    floor: f32,
) {
    let floor = (floor * 100.0).round() / 100.0;
    let t = 0.4;
    let hgt = 3.4;
    let door = 2.2;
    let x0 = cx - w / 2.0;
    let x1 = cx + w / 2.0;
    let z0 = cz - d / 2.0;
    let z1 = cz + d / 2.0;
    let mut wall = |a: Vec3, b: Vec3| {
        solids.push(Solid {
            kind: BoxKind::Wall,
            aabb: Aabb::new(a, b),
        });
    };
    // Each side gets a door with some probability (at least two doors).
    let first = rng.below(4);
    let second = (first + 2) % 4;
    for side in 0..4 {
        let has_door = side == first || side == second || rng.chance(0.3);
        let window = rng.chance(0.6);
        let (along_lo, along_hi) = if side < 2 { (x0, x1) } else { (z0, z1) };
        let mid = (along_lo + along_hi) / 2.0 + rng.range(-1.5, 1.5);
        let segs: Vec<(f32, f32)> = if has_door {
            vec![(along_lo, mid - door / 2.0), (mid + door / 2.0, along_hi)]
        } else {
            vec![(along_lo, along_hi)]
        };
        for (a, b) in segs {
            let (y0, y1) = (floor - 1.0, floor + hgt);
            let (lo, hi) = match side {
                0 => (Vec3::new(a, y0, z0), Vec3::new(b, y1, z0 + t)),
                1 => (Vec3::new(a, y0, z1 - t), Vec3::new(b, y1, z1)),
                2 => (Vec3::new(x0, y0, a), Vec3::new(x0 + t, y1, b)),
                _ => (Vec3::new(x1 - t, y0, a), Vec3::new(x1, y1, b)),
            };
            if window && (b - a) > 4.0 {
                // A window: wall below 1.0 and above 1.9.
                let wa = a + (b - a) * 0.35;
                let wb = a + (b - a) * 0.65;
                let split = |lo: Vec3, hi: Vec3, s0: f32, s1: f32| -> (Vec3, Vec3) {
                    if side < 2 {
                        (Vec3::new(s0, lo.y, lo.z), Vec3::new(s1, hi.y, hi.z))
                    } else {
                        (Vec3::new(lo.x, lo.y, s0), Vec3::new(hi.x, hi.y, s1))
                    }
                };
                let (l1, h1) = split(lo, hi, a, wa);
                wall(l1, h1);
                let (l2, h2) = split(lo, hi, wb, b);
                wall(l2, h2);
                let (l3, mut h3) = split(lo, hi, wa, wb);
                h3.y = floor + 1.0;
                wall(l3, h3);
                let (mut l4, h4) = split(lo, hi, wa, wb);
                l4.y = floor + 1.9;
                wall(l4, h4);
            } else {
                wall(lo, hi);
            }
        }
    }
    solids.push(Solid {
        kind: BoxKind::Roof,
        aabb: Aabb::new(
            Vec3::new(x0, floor + hgt, z0),
            Vec3::new(x1, floor + hgt + 0.3, z1),
        ),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_seed_same_map() {
        let a = Map::generate(7);
        let b = Map::generate(7);
        assert_eq!(a.solids.len(), b.solids.len());
        assert_eq!(
            serde_json::to_string(&a).unwrap(),
            serde_json::to_string(&b).unwrap()
        );
    }

    #[test]
    fn spawns_and_pickups_are_free() {
        for seed in 0..5 {
            let m = Map::generate(seed);
            assert!(
                m.spawns.len() >= 12,
                "seed {seed}: {} spawns",
                m.spawns.len()
            );
            assert!(m.pickups.len() >= 30);
            for s in &m.spawns {
                assert!(!m.blocked(*s, PLAYER_RADIUS));
            }
        }
    }

    #[test]
    fn terrain_has_hills_and_flat_edges() {
        let m = Map::generate(3);
        let top = m.heights.iter().copied().fold(f32::MIN, f32::max);
        assert!(top > 3.0, "highest point {top}");
        assert!(m.height(HALF - 1.0, 0.0).abs() < 0.2);
        // Interpolation hits the samples exactly.
        let i = 40;
        let j = 30;
        let x = -HALF + i as f32 * m.cell;
        let z = -HALF + j as f32 * m.cell;
        assert!((m.height(x, z) - m.heights[j * GRID + i]).abs() < 1e-4);
        // Spawns stand on the ground.
        for s in &m.spawns {
            assert!((s.y - m.height(s.x, s.z)).abs() < 1e-4);
        }
    }

    #[test]
    fn rays_hit_hills() {
        let m = Map::generate(3);
        // Straight down from 50 m above the highest sample.
        let (k, _) = m
            .heights
            .iter()
            .enumerate()
            .fold((0, f32::MIN), |b, (k, &v)| if v > b.1 { (k, v) } else { b });
        let x = -HALF + (k % GRID) as f32 * m.cell;
        let z = -HALF + (k / GRID) as f32 * m.cell;
        let o = Vec3::new(x, 50.0, z);
        let t = m.ray_terrain(o, Vec3::new(0.0, -1.0, 0.0), 100.0).unwrap();
        assert!((50.0 - t - m.height(x, z)).abs() < 0.05);
    }

    #[test]
    fn firing_range_is_open_where_it_matters() {
        let m = Map::firing_range();
        assert!(
            !m.blocked(m.spawns[0], PLAYER_RADIUS),
            "the bench spot is free"
        );
        assert_eq!(m.targets.len(), m.labels.len());
        for t in &m.targets {
            assert!(
                !m.blocked(t.pos, PLAYER_RADIUS),
                "target at {:?} is free",
                t.pos
            );
        }
        // The rack is right behind the bench, within reach.
        for p in &m.pickups {
            assert!(p.pos.distance(m.spawns[0]) < 7.0);
        }
        // 400 m target: a clear shot from the bench at head height.
        let far = m
            .targets
            .iter()
            .find(|t| (m.spawns[0].z - t.pos.z - 400.0).abs() < 0.1)
            .unwrap();
        assert!(m.line_of_sight(
            m.spawns[0] + Vec3::new(0.0, 1.6, 0.0),
            far.pos + Vec3::new(0.0, 1.6, 0.0)
        ));
    }

    #[test]
    fn slide_stops_at_wall() {
        let m = Map::generate(1);
        let s = m.spawns[0];
        // Walk 500 m in one direction: must stay inside the fence.
        let p = m.slide(s, Vec3::new(500.0, 0.0, 0.0));
        assert!(p.x < HALF);
        assert!(!m.blocked(p, PLAYER_RADIUS));
        assert!((p.y - m.height(p.x, p.z)).abs() < 1e-4);
    }
}
