// The lens: how the view maps directions onto the screen, for any field of
// view up to 360°. Pure module (no three.js) so it can be tested with
// node --test.
//
// `fov` is the angle across the height of the screen, as it has always been.
// Up to PERSPECTIVE_MAX the view is the ordinary (rectilinear) perspective.
// Wider than that a flat picture cannot go (it would reach infinity at
// 180°), so the view becomes a fisheye: a point ρ half-heights away from the
// centre of the screen looks along a direction θ off the line of sight, with
//
//     tan(s·θ) / s ∝ ρ,     s = PERSPECTIVE_MAX / fov   (s ≤ 1).
//
// s = 1 is the perspective itself (so nothing jumps at PERSPECTIVE_MAX), and
// the smaller s, the more the edges are squeezed. The top and bottom edges
// are always fov/2 off the centre: at 360° they are straight behind you, and
// the whole sphere fits in the circle that touches them. Directions past
// 180° (the screen's corners then) have nothing to show.

export const PERSPECTIVE_MAX = 120;
export const FOV_MAX = 360;
const DEG = Math.PI / 180;

/// s of the formula above: 1 for the perspective, less for the fisheye.
export function lensStrength(fov) {
  return fov <= PERSPECTIVE_MAX ? 1 : PERSPECTIVE_MAX / fov;
}

/// Whether the view needs the fisheye (a flat camera cannot show it).
export function isFisheye(fov) {
  return fov > PERSPECTIVE_MAX;
}

/// tan(s·fov/2): the screen's half-height in the units of the formula.
export function lensScale(fov) {
  return Math.tan((lensStrength(fov) * fov * DEG) / 2);
}

/// The angle (radians) off the line of sight of a point ρ half-heights from
/// the centre of the screen. May be more than π (outside the sphere).
export function angleAt(rho, fov) {
  const s = lensStrength(fov);
  return Math.atan(rho * lensScale(fov)) / s;
}

/// Half the horizontal view (radians), at most π (all the way round).
export function halfWidth(fov, aspect) {
  return Math.min(Math.PI, angleAt(aspect, fov));
}

/// The largest angle anywhere on the screen (at the corners), at most π.
export function maxAngle(fov, aspect) {
  return Math.min(Math.PI, angleAt(Math.hypot(aspect, 1), fov));
}
