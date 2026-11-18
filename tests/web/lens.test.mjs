import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERSPECTIVE_MAX, FOV_MAX, lensStrength, isFisheye, angleAt, halfWidth, maxAngle } from '../../web/js/lens.js';
import { OPTIONS } from '../../web/js/settings.js';

const DEG = Math.PI / 180;
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test(':set fov goes up to 360', () => {
  assert.equal(OPTIONS.fov.max, FOV_MAX);
  assert.equal(FOV_MAX, 360);
});

test('up to 120° the view is the ordinary perspective', () => {
  for (const fov of [40, 80, 120]) {
    assert.equal(isFisheye(fov), false);
    assert.equal(lensStrength(fov), 1);
    // The edge of the screen is fov/2 off; ρ follows tan.
    close(angleAt(1, fov), (fov / 2) * DEG);
    close(angleAt(16 / 9, fov), Math.atan((16 / 9) * Math.tan((fov / 2) * DEG)));
  }
  assert.equal(isFisheye(120.5), true);
});

test('the top and bottom edges are always fov/2 off the centre', () => {
  for (const fov of [121, 150, 180, 240, 300, 360]) close(angleAt(1, fov), (fov / 2) * DEG);
});

test('nothing jumps at the switch to the fisheye', () => {
  for (const rho of [0.3, 1, 16 / 9, 2.5]) close(angleAt(rho, 120), angleAt(rho, 120 + 1e-9), 1e-6);
});

test('angles grow with the distance from the centre and with fov', () => {
  for (const fov of [80, 140, 360]) {
    let last = -1;
    for (let rho = 0; rho < 4; rho += 0.25) {
      const a = angleAt(rho, fov);
      assert.ok(a > last);
      last = a;
    }
  }
  let last = 0;
  for (let fov = 40; fov <= 360; fov += 10) {
    const a = halfWidth(fov, 16 / 9);
    assert.ok(a >= last);
    last = a;
  }
});

test('at 360° every direction is on the screen', () => {
  close(halfWidth(360, 16 / 9), Math.PI);
  close(maxAngle(360, 16 / 9), Math.PI);
  // Portrait: the sides are cut, but straight behind is at the top edge.
  close(angleAt(1, 360), Math.PI);
  assert.ok(halfWidth(80, 16 / 9) < Math.PI / 2);
  assert.ok(PERSPECTIVE_MAX < FOV_MAX);
});
