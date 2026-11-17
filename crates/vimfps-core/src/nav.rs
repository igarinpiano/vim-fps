//! Walking routes for bots. The field as a grid of 0.5 m cells, each either
//! free (a player standing at its centre touches nothing) or not; A* over
//! it finds the way round walls, out through a building's door, past rocks
//! and crates. Built once per map, on first use.
//!
//! Only walkers: a tank (much wider) does not fit through doors, and keeps
//! its old ways (drive at the goal, leave the tank when stuck).

use crate::map::{Map, PLAYER_RADIUS, STEP};
use crate::math::Vec3;
use std::cmp::Reverse;
use std::collections::BinaryHeap;

/// Cell size (m). The cells a wall blocks (its 0.4 m and a player's
/// clearance either side) are at least two deep, so a straight line never
/// slips through a wall inside one cell. A door (2.2 m) leaves 1.3 m of
/// free centres: two cells or more.
const CELL: f32 = 0.5;
/// A little more than a player's radius, so routes keep off the walls.
const CLEAR: f32 = PLAYER_RADIUS + 0.05;
/// Cells A* may look at before it gives up (a route across the whole field
/// takes well under this).
pub const BUDGET: usize = 200_000;

pub struct NavGrid {
    n: usize,
    half: f32,
    free: Vec<bool>,
}

impl NavGrid {
    pub fn build(map: &Map) -> NavGrid {
        let n = ((map.half * 2.0) / CELL).ceil() as usize;
        let mut g = NavGrid {
            n,
            half: map.half,
            free: vec![true; n * n],
        };
        // The edge of the field.
        for j in 0..n {
            for i in 0..n {
                let (x, z) = g.centre(i, j);
                if x.abs() > map.half - CLEAR || z.abs() > map.half - CLEAR {
                    g.free[j * n + i] = false;
                }
            }
        }
        // Each solid on the cells it can touch (as Map::blocked sees it).
        for s in &map.solids {
            let a = &s.aabb;
            let (i0, j0) = g.cell_xz(a.min.x - CLEAR, a.min.z - CLEAR);
            let (i1, j1) = g.cell_xz(a.max.x + CLEAR, a.max.z + CLEAR);
            for j in j0..=j1 {
                for i in i0..=i1 {
                    let k = j * n + i;
                    if !g.free[k] {
                        continue;
                    }
                    let (x, z) = g.centre(i, j);
                    if x + CLEAR <= a.min.x
                        || x - CLEAR >= a.max.x
                        || z + CLEAR <= a.min.z
                        || z - CLEAR >= a.max.z
                    {
                        continue;
                    }
                    let feet = map.height(x, z);
                    if a.min.y < feet + 1.7 && a.max.y > feet + STEP {
                        g.free[k] = false;
                    }
                }
            }
        }
        g
    }

    fn centre(&self, i: usize, j: usize) -> (f32, f32) {
        (
            -self.half + (i as f32 + 0.5) * CELL,
            -self.half + (j as f32 + 0.5) * CELL,
        )
    }

    /// The cell a point is in (clamped onto the grid).
    fn cell_xz(&self, x: f32, z: f32) -> (usize, usize) {
        let f = |v: f32| (((v + self.half) / CELL).floor().max(0.0) as usize).min(self.n - 1);
        (f(x), f(z))
    }

    fn is_free(&self, i: usize, j: usize) -> bool {
        self.free[j * self.n + i]
    }

    /// Whether the cell under `p` is free.
    pub fn walkable(&self, p: Vec3) -> bool {
        let (i, j) = self.cell_xz(p.x, p.z);
        self.is_free(i, j)
    }

    /// Whether walking straight from `a` to `b` stays on free cells. The
    /// cell `a` is in does not count (a walker may stand half on a wall's
    /// cell and still walk away from it).
    pub fn clear_line(&self, a: Vec3, b: Vec3) -> bool {
        let (dx, dz) = (b.x - a.x, b.z - a.z);
        let len = dx.hypot(dz);
        let steps = (len / (CELL * 0.25)).ceil().max(1.0) as usize;
        let start = self.cell_xz(a.x, a.z);
        (1..=steps).all(|s| {
            let t = s as f32 / steps as f32;
            let c = self.cell_xz(a.x + dx * t, a.z + dz * t);
            c == start || self.is_free(c.0, c.1)
        })
    }

    /// The free cell nearest to `p` within `reach` cells (ring by ring;
    /// within a ring, by the distance from `p` itself, so a walker against a
    /// wall gets a cell on its own side).
    fn nearest_free(&self, p: Vec3, reach: usize) -> Option<(usize, usize)> {
        let (i, j) = self.cell_xz(p.x, p.z);
        if self.is_free(i, j) {
            return Some((i, j));
        }
        for r in 1..=reach as isize {
            let mut best: Option<((usize, usize), f32)> = None;
            for dj in -r..=r {
                for di in -r..=r {
                    if di.abs() != r && dj.abs() != r {
                        continue;
                    }
                    let (x, z) = (i as isize + di, j as isize + dj);
                    if x < 0 || z < 0 || x >= self.n as isize || z >= self.n as isize {
                        continue;
                    }
                    let (x, z) = (x as usize, z as usize);
                    let (cx, cz) = self.centre(x, z);
                    let d = (cx - p.x).hypot(cz - p.z);
                    if self.is_free(x, z) && best.is_none_or(|b| d < b.1) {
                        best = Some(((x, z), d));
                    }
                }
            }
            if let Some((c, _)) = best {
                return Some(c);
            }
        }
        None
    }

    /// A walking route from `from` to `to`: corner points to head for in
    /// turn, ending at `to` (or the free spot nearest to it). None when
    /// there is no way within the budget.
    pub fn path(&self, from: Vec3, to: Vec3, budget: usize) -> Option<Vec<Vec3>> {
        let n = self.n;
        let (si, sj) = self.nearest_free(from, 4)?;
        let goal_free = self.walkable(to);
        let (gi, gj) = self.nearest_free(to, 16)?;
        let start = sj * n + si;
        let goal = gj * n + gi;
        let h = |k: usize| -> f32 {
            let (dx, dz) = ((k % n).abs_diff(gi) as f32, (k / n).abs_diff(gj) as f32);
            dx.max(dz) + (std::f32::consts::SQRT_2 - 1.0) * dx.min(dz)
        };
        let mut g = vec![f32::INFINITY; n * n];
        let mut came = vec![u32::MAX; n * n];
        let mut open = BinaryHeap::new();
        g[start] = 0.0;
        open.push(Reverse(((h(start) * 1000.0) as u32, start as u32)));
        let mut looked = 0;
        let mut found = start == goal;
        while let Some(Reverse((_, k))) = open.pop() {
            let k = k as usize;
            if k == goal {
                found = true;
                break;
            }
            looked += 1;
            if looked > budget {
                return None;
            }
            let (i, j) = ((k % n) as isize, (k / n) as isize);
            for (di, dj) in [
                (1, 0),
                (-1, 0),
                (0, 1),
                (0, -1),
                (1, 1),
                (1, -1),
                (-1, 1),
                (-1, -1),
            ] {
                let (x, z) = (i + di, j + dj);
                if x < 0 || z < 0 || x >= n as isize || z >= n as isize {
                    continue;
                }
                let (x, z) = (x as usize, z as usize);
                if !self.is_free(x, z) {
                    continue;
                }
                // No cutting a corner: both sides of a diagonal step free.
                if di != 0
                    && dj != 0
                    && (!self.is_free(x, j as usize) || !self.is_free(i as usize, z))
                {
                    continue;
                }
                let nk = z * n + x;
                let cost = g[k]
                    + if di != 0 && dj != 0 {
                        std::f32::consts::SQRT_2
                    } else {
                        1.0
                    };
                if cost < g[nk] {
                    g[nk] = cost;
                    came[nk] = k as u32;
                    open.push(Reverse((((cost + h(nk)) * 1000.0) as u32, nk as u32)));
                }
            }
        }
        if !found {
            return None;
        }
        // The cells back from the goal, as points.
        let mut cells = vec![goal];
        let mut k = goal;
        while k != start {
            k = came[k] as usize;
            cells.push(k);
        }
        cells.reverse();
        let mut pts: Vec<Vec3> = cells
            .iter()
            .map(|&k| {
                let (x, z) = self.centre(k % n, k / n);
                Vec3::new(x, 0.0, z)
            })
            .collect();
        if goal_free && let Some(last) = pts.last_mut() {
            *last = Vec3::new(to.x, 0.0, to.z);
        }
        // Only the corners: from each point, on to the farthest one in a
        // straight free line (looking a limited way ahead).
        let mut out = Vec::new();
        let mut at = Vec3::new(from.x, 0.0, from.z);
        let mut i = 0;
        while i < pts.len() {
            let mut far = i;
            for k in (i + 1..pts.len().min(i + 160)).rev() {
                if self.clear_line(at, pts[k]) {
                    far = k;
                    break;
                }
            }
            at = pts[far];
            out.push(at);
            i = far + 1;
        }
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::map::{BoxKind, Solid};
    use crate::math::Aabb;

    /// A flat field with one closed room (a door on its east side only).
    fn room_map() -> Map {
        let mut m = Map::generate(1);
        m.heights.iter_mut().for_each(|h| *h = 0.0);
        let _ = m.top.take();
        m.solids.clear();
        let mut wall = |x0: f32, z0: f32, x1: f32, z1: f32| {
            m.solids.push(Solid {
                kind: BoxKind::Wall,
                aabb: Aabb::new(Vec3::new(x0, -1.0, z0), Vec3::new(x1, 3.4, z1)),
            })
        };
        // 10 x 10 room from (-5, -5) to (5, 5); the door: x = 5, z -1.1..1.1.
        wall(-5.0, -5.0, 5.0, -4.6); // north
        wall(-5.0, 4.6, 5.0, 5.0); // south
        wall(-5.0, -5.0, -4.6, 5.0); // west
        wall(4.6, -5.0, 5.0, -1.1); // east, either side of the door
        wall(4.6, 1.1, 5.0, 5.0);
        m
    }

    #[test]
    fn walls_are_not_free_and_the_door_is() {
        let m = room_map();
        let g = NavGrid::build(&m);
        assert!(!g.walkable(Vec3::new(-4.8, 0.0, 0.0)));
        assert!(g.walkable(Vec3::new(0.0, 0.0, 0.0)));
        assert!(g.walkable(Vec3::new(4.8, 0.0, 0.0)), "the door");
        assert!(!g.walkable(Vec3::new(4.8, 0.0, 3.0)));
        assert!(!g.clear_line(Vec3::new(0.0, 0.0, 0.0), Vec3::new(-20.0, 0.0, 0.0)));
        assert!(g.clear_line(Vec3::new(0.0, 0.0, 0.0), Vec3::new(20.0, 0.0, 0.0)));
    }

    #[test]
    fn out_of_a_room_by_its_door() {
        let m = room_map();
        let g = NavGrid::build(&m);
        // From inside, to a spot due west behind the wall.
        let to = Vec3::new(-20.0, 0.0, 0.0);
        let path = g.path(Vec3::new(-2.0, 0.0, 0.0), to, BUDGET).unwrap();
        assert!(
            path.iter().any(|p| p.x > 4.0 && p.z.abs() < 1.2),
            "goes out by the door: {path:?}"
        );
        assert_eq!(*path.last().unwrap(), to);
        // Every leg is a straight free line, and it really gets there by
        // walking (as players move: sliding along solids).
        let mut at = Vec3::new(-2.0, 0.0, 0.0);
        for p in &path {
            assert!(g.clear_line(at, *p), "{at:?} -> {p:?}");
            for _ in 0..400 {
                let d = Vec3::new(p.x - at.x, 0.0, p.z - at.z);
                if d.length_xz() < 0.3 {
                    break;
                }
                at = m.slide(at, d.normalize() * 0.1);
            }
        }
        assert!((at - to).length_xz() < 0.5, "ended at {at:?}");
    }

    #[test]
    fn no_way_into_a_closed_box() {
        let mut m = room_map();
        m.solids.push(Solid {
            kind: BoxKind::Wall,
            aabb: Aabb::new(Vec3::new(4.6, -1.0, -1.2), Vec3::new(5.0, 3.4, 1.2)),
        });
        let g = NavGrid::build(&m);
        assert!(
            g.path(Vec3::new(0.0, 0.0, 0.0), Vec3::new(30.0, 0.0, 0.0), BUDGET)
                .is_none()
        );
    }

    #[test]
    fn routes_on_a_generated_field() {
        let m = Map::generate(7);
        let g = NavGrid::build(&m);
        let free = g.free.iter().filter(|f| **f).count() as f32 / g.free.len() as f32;
        assert!(free > 0.8, "most of the field is open: {free}");
        // Between spawn points (all in the open), there is always a way.
        for (a, b) in m.spawns.iter().zip(m.spawns.iter().rev()).take(10) {
            let p = g.path(*a, *b, BUDGET);
            assert!(p.is_some(), "{a:?} -> {b:?}");
        }
    }
}
