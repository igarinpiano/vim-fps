//! Small vector math used by the simulation.

use serde::{Deserialize, Serialize};
use std::ops::{Add, AddAssign, Mul, Neg, Sub};

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Vec3 {
    pub const ZERO: Vec3 = Vec3::new(0.0, 0.0, 0.0);

    pub const fn new(x: f32, y: f32, z: f32) -> Self {
        Self { x, y, z }
    }

    pub fn dot(self, o: Vec3) -> f32 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }

    pub fn length(self) -> f32 {
        self.dot(self).sqrt()
    }

    pub fn length_xz(self) -> f32 {
        (self.x * self.x + self.z * self.z).sqrt()
    }

    pub fn normalize(self) -> Vec3 {
        let l = self.length();
        if l > 1e-6 {
            self * (1.0 / l)
        } else {
            Vec3::ZERO
        }
    }

    pub fn distance(self, o: Vec3) -> f32 {
        (self - o).length()
    }

    /// Direction a player looks at. Yaw 0 looks toward -Z; positive yaw turns
    /// left (counter-clockwise seen from above), positive pitch looks up.
    pub fn from_angles(yaw: f32, pitch: f32) -> Vec3 {
        let cp = pitch.cos();
        Vec3::new(-yaw.sin() * cp, pitch.sin(), -yaw.cos() * cp)
    }
}

impl Add for Vec3 {
    type Output = Vec3;
    fn add(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x + o.x, self.y + o.y, self.z + o.z)
    }
}

impl AddAssign for Vec3 {
    fn add_assign(&mut self, o: Vec3) {
        *self = *self + o;
    }
}

impl Sub for Vec3 {
    type Output = Vec3;
    fn sub(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x - o.x, self.y - o.y, self.z - o.z)
    }
}

impl Mul<f32> for Vec3 {
    type Output = Vec3;
    fn mul(self, s: f32) -> Vec3 {
        Vec3::new(self.x * s, self.y * s, self.z * s)
    }
}

impl Neg for Vec3 {
    type Output = Vec3;
    fn neg(self) -> Vec3 {
        Vec3::new(-self.x, -self.y, -self.z)
    }
}

/// Axis-aligned box.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Aabb {
    pub min: Vec3,
    pub max: Vec3,
}

impl Aabb {
    pub fn new(min: Vec3, max: Vec3) -> Self {
        Self { min, max }
    }

    /// Box standing on the ground, centred at (cx, cz).
    pub fn ground(cx: f32, cz: f32, w: f32, d: f32, h: f32) -> Self {
        Self::new(
            Vec3::new(cx - w / 2.0, 0.0, cz - d / 2.0),
            Vec3::new(cx + w / 2.0, h, cz + d / 2.0),
        )
    }

    pub fn contains(&self, p: Vec3) -> bool {
        p.x >= self.min.x
            && p.x <= self.max.x
            && p.y >= self.min.y
            && p.y <= self.max.y
            && p.z >= self.min.z
            && p.z <= self.max.z
    }

    pub fn overlaps_xz(&self, o: &Aabb, margin: f32) -> bool {
        self.min.x - margin < o.max.x
            && self.max.x + margin > o.min.x
            && self.min.z - margin < o.max.z
            && self.max.z + margin > o.min.z
    }

    /// Slab test. Returns the distance along `dir` (unit) to the entry point.
    pub fn ray(&self, origin: Vec3, dir: Vec3, max: f32) -> Option<f32> {
        let mut tmin = 0.0f32;
        let mut tmax = max;
        for (o, d, lo, hi) in [
            (origin.x, dir.x, self.min.x, self.max.x),
            (origin.y, dir.y, self.min.y, self.max.y),
            (origin.z, dir.z, self.min.z, self.max.z),
        ] {
            if d.abs() < 1e-8 {
                if o < lo || o > hi {
                    return None;
                }
            } else {
                let inv = 1.0 / d;
                let mut t1 = (lo - o) * inv;
                let mut t2 = (hi - o) * inv;
                if t1 > t2 {
                    std::mem::swap(&mut t1, &mut t2);
                }
                tmin = tmin.max(t1);
                tmax = tmax.min(t2);
                if tmin > tmax {
                    return None;
                }
            }
        }
        Some(tmin)
    }
}

/// Distance along `dir` (unit) to a sphere, if hit within `max`.
pub fn ray_sphere(origin: Vec3, dir: Vec3, center: Vec3, r: f32, max: f32) -> Option<f32> {
    let oc = origin - center;
    let b = oc.dot(dir);
    let c = oc.dot(oc) - r * r;
    let disc = b * b - c;
    if disc < 0.0 {
        return None;
    }
    let s = disc.sqrt();
    let t = if -b - s >= 0.0 { -b - s } else { -b + s };
    (t >= 0.0 && t <= max).then_some(t)
}

pub fn wrap_angle(a: f32) -> f32 {
    let tau = std::f32::consts::TAU;
    let mut a = a % tau;
    if a > std::f32::consts::PI {
        a -= tau;
    } else if a < -std::f32::consts::PI {
        a += tau;
    }
    a
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ray_hits_box_in_front() {
        let b = Aabb::ground(0.0, -10.0, 2.0, 2.0, 2.0);
        let t = b.ray(Vec3::new(0.0, 1.0, 0.0), Vec3::new(0.0, 0.0, -1.0), 100.0);
        assert!((t.unwrap() - 9.0).abs() < 1e-4);
        assert!(
            b.ray(Vec3::new(0.0, 1.0, 0.0), Vec3::new(0.0, 0.0, 1.0), 100.0)
                .is_none()
        );
    }

    #[test]
    fn sphere_hit() {
        let t = ray_sphere(
            Vec3::ZERO,
            Vec3::new(1.0, 0.0, 0.0),
            Vec3::new(5.0, 0.0, 0.0),
            1.0,
            100.0,
        );
        assert!((t.unwrap() - 4.0).abs() < 1e-4);
    }

    #[test]
    fn angles() {
        let f = Vec3::from_angles(0.0, 0.0);
        assert!((f.z + 1.0).abs() < 1e-6);
        let l = Vec3::from_angles(std::f32::consts::FRAC_PI_2, 0.0);
        assert!((l.x + 1.0).abs() < 1e-6);
        assert!((wrap_angle(7.0) - (7.0 - std::f32::consts::TAU)).abs() < 1e-5);
    }
}
