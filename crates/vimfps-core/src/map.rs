//! Outdoor map, generated from a seed. Ground is flat (y = 0); everything
//! else is an axis-aligned box.

use crate::math::{Aabb, Vec3};
use crate::rng::Rng;
use serde::{Deserialize, Serialize};

/// Half of the playable field's side (the field is 2*HALF square).
pub const HALF: f32 = 120.0;
/// Player collision radius.
pub const PLAYER_RADIUS: f32 = 0.4;

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
    pub solids: Vec<Solid>,
    /// Foliage (visual only): x, z, radius, height of the crown's base.
    pub trees: Vec<[f32; 4]>,
    pub spawns: Vec<Vec3>,
    pub pickups: Vec<PickupSpot>,
}

impl Map {
    pub fn generate(seed: u64) -> Map {
        let mut rng = Rng::new(seed);
        let mut solids: Vec<Solid> = Vec::new();
        let mut footprints: Vec<Aabb> = Vec::new();
        let mut trees = Vec::new();

        // Fence around the field.
        let h = HALF;
        for b in [
            Aabb::new(
                Vec3::new(-h - 1.0, 0.0, -h - 1.0),
                Vec3::new(h + 1.0, 2.5, -h),
            ),
            Aabb::new(
                Vec3::new(-h - 1.0, 0.0, h),
                Vec3::new(h + 1.0, 2.5, h + 1.0),
            ),
            Aabb::new(Vec3::new(-h - 1.0, 0.0, -h), Vec3::new(-h, 2.5, h)),
            Aabb::new(Vec3::new(h, 0.0, -h), Vec3::new(h + 1.0, 2.5, h)),
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
        while buildings < 9 && tries < 500 {
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
            add_building(&mut solids, &mut rng, cx, cz, w, d);
        }

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
                let fp = Aabb::ground(cx, cz, w, d, rng.range(height.0, height.1));
                if !free(&fp, footprints, 2.5) {
                    continue;
                }
                footprints.push(fp);
                solids.push(Solid { kind, aabb: fp });
                n += 1;
            }
        };
        place(
            &mut rng,
            &mut solids,
            &mut footprints,
            BoxKind::Rock,
            45,
            (1.5, 4.5),
            (1.3, 2.8),
        );
        place(
            &mut rng,
            &mut solids,
            &mut footprints,
            BoxKind::Cover,
            40,
            (4.0, 10.0),
            (1.0, 1.15),
        );
        place(
            &mut rng,
            &mut solids,
            &mut footprints,
            BoxKind::Crate,
            30,
            (1.2, 2.0),
            (1.2, 2.0),
        );

        // Trees: a trunk (solid) and a crown (visual).
        let mut n = 0;
        let mut tries = 0;
        while n < 140 && tries < 4000 {
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
                aabb: fp,
            });
            trees.push([cx, cz, rng.range(1.8, 3.0), rng.range(2.2, 3.2)]);
            n += 1;
        }

        let mut map = Map {
            seed,
            half: h,
            solids,
            trees,
            spawns: Vec::new(),
            pickups: Vec::new(),
        };

        // Spawn points, spread over the field.
        let mut tries = 0;
        while map.spawns.len() < 24 && tries < 5000 {
            tries += 1;
            let p = Vec3::new(
                rng.range(-h + 8.0, h - 8.0),
                0.0,
                rng.range(-h + 8.0, h - 8.0),
            );
            if map.blocked(p, 1.5) || map.spawns.iter().any(|s| s.distance(p) < 25.0) {
                continue;
            }
            map.spawns.push(p);
        }

        // Pickups: weapons more often inside/near buildings, items anywhere.
        let kinds = [
            (PickupKind::Sr, 4),
            (PickupKind::Sg, 5),
            (PickupKind::Smg, 5),
            (PickupKind::Ar, 4),
            (PickupKind::Medkit, 10),
            (PickupKind::Grenade, 8),
            (PickupKind::Ammo, 10),
        ];
        let building_centres: Vec<Vec3> = footprints
            .iter()
            .filter(|f| f.max.y > 3.5 && f.max.y < 3.7)
            .map(|f| Vec3::new((f.min.x + f.max.x) / 2.0, 0.0, (f.min.z + f.max.z) / 2.0))
            .collect();
        for (kind, count) in kinds {
            let mut placed = 0;
            let mut tries = 0;
            while placed < count && tries < 3000 {
                tries += 1;
                let weapon = matches!(
                    kind,
                    PickupKind::Ar | PickupKind::Smg | PickupKind::Sg | PickupKind::Sr
                );
                let p = if weapon && !building_centres.is_empty() && rng.chance(0.6) {
                    let c = building_centres[rng.below(building_centres.len())];
                    Vec3::new(c.x + rng.range(-3.0, 3.0), 0.0, c.z + rng.range(-3.0, 3.0))
                } else {
                    Vec3::new(
                        rng.range(-h + 6.0, h - 6.0),
                        0.0,
                        rng.range(-h + 6.0, h - 6.0),
                    )
                };
                if map.blocked(p, 1.0) || map.pickups.iter().any(|s| s.pos.distance(p) < 6.0) {
                    continue;
                }
                map.pickups.push(PickupSpot { kind, pos: p });
                placed += 1;
            }
        }
        map
    }

    /// Whether a circle of radius `r` at ground point `p` touches a solid
    /// that blocks walking (or lies outside the field).
    pub fn blocked(&self, p: Vec3, r: f32) -> bool {
        if p.x.abs() > self.half - r || p.z.abs() > self.half - r {
            return true;
        }
        let probe = Aabb::ground(p.x, p.z, 2.0 * r, 2.0 * r, 1.8);
        self.solids
            .iter()
            .any(|s| blocks_walk(&s.aabb) && s.aabb.overlaps_xz(&probe, 0.0))
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
        p
    }

    /// Nearest solid hit by a ray, as a distance.
    pub fn raycast(&self, origin: Vec3, dir: Vec3, max: f32) -> Option<f32> {
        let mut best: Option<f32> = None;
        for s in &self.solids {
            if let Some(t) = s.aabb.ray(origin, dir, max)
                && best.is_none_or(|b| t < b)
            {
                best = Some(t);
            }
        }
        best
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

/// Roofs and anything above head height do not block walking.
fn blocks_walk(b: &Aabb) -> bool {
    b.min.y < 1.7 && b.max.y > 0.3
}

fn add_building(solids: &mut Vec<Solid>, rng: &mut Rng, cx: f32, cz: f32, w: f32, d: f32) {
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
            let (lo, hi) = match side {
                0 => (Vec3::new(a, 0.0, z0), Vec3::new(b, hgt, z0 + t)),
                1 => (Vec3::new(a, 0.0, z1 - t), Vec3::new(b, hgt, z1)),
                2 => (Vec3::new(x0, 0.0, a), Vec3::new(x0 + t, hgt, b)),
                _ => (Vec3::new(x1 - t, 0.0, a), Vec3::new(x1, hgt, b)),
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
                h3.y = 1.0;
                wall(l3, h3);
                let (mut l4, h4) = split(lo, hi, wa, wb);
                l4.y = 1.9;
                wall(l4, h4);
            } else {
                wall(lo, hi);
            }
        }
    }
    solids.push(Solid {
        kind: BoxKind::Roof,
        aabb: Aabb::new(Vec3::new(x0, hgt, z0), Vec3::new(x1, hgt + 0.3, z1)),
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
    fn slide_stops_at_wall() {
        let m = Map::generate(1);
        let s = m.spawns[0];
        // Walk 500 m in one direction: must stay inside the fence.
        let p = m.slide(s, Vec3::new(500.0, 0.0, 0.0));
        assert!(p.x < HALF);
        assert!(!m.blocked(p, PLAYER_RADIUS));
    }
}
