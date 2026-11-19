// 3D view (three.js): the map, players, pickups, grenades, tracers and the
// gun in your hands.

import * as THREE from '../vendor/three.module.min.js';
import { PERSPECTIVE_MAX, isFisheye, lensStrength, lensScale, maxAngle } from './lens.js';

const COLORS = {
  wall: 0xd9d0b8,
  roof: 0x9a5a3a,
  rock: 0x8b8d90,
  cover: 0xb9a774,
  crate: 0x9c7240,
  trunk: 0x6b4a2b,
  fence: 0x6f7a80,
};

/// Surfaces a user texture can go on (textures.js): the solids by kind,
/// the ground, tree crowns, tanks. (`sky` is the scene's background.)
const TILED = ['ground', 'wall', 'roof', 'rock', 'cover', 'crate', 'trunk', 'fence'];

/// Texture coordinates from where a surface is in the world, so an image
/// tiles at one size whatever the size of the box it is on (the boxes are
/// instances of one unit cube). `flat`: always from above (the ground).
function worldUv(mat, flat) {
  mat.userData.texSize = { value: 4 };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.texSize = mat.userData.texSize;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform float texSize;').replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>
#ifdef USE_MAP
{
  vec4 wp = vec4( position, 1.0 );
  #ifdef USE_INSTANCING
  wp = instanceMatrix * wp;
  #endif
  wp = modelMatrix * wp;
  vec3 an = abs( normal );
  vec2 wuv = ${flat ? 'wp.xz' : '( an.y > 0.5 ? wp.xz : ( an.x > 0.5 ? wp.zy : wp.xy ) )'};
  vMapUv = wuv / texSize;
}
#endif`,
    );
  };
  mat.customProgramCacheKey = () => (flat ? 'world-uv-flat' : 'world-uv-box');
  return mat;
}

const TANK_COLOR = 0x5b6b3a;

const PICKUP_STYLE = {
  ar: [0x2f6fd6, 'AR'],
  smg: [0x2f6fd6, 'SMG'],
  sg: [0x2f6fd6, 'SG'],
  sr: [0x2f6fd6, 'SR'],
  medkit: [0xd83a3a, '+'],
  grenade: [0x3f7d2c, 'G'],
  ammo: [0xc9a227, '弾'],
};

function playerColor(id) {
  const hues = [0.0, 0.58, 0.12, 0.33, 0.8, 0.5, 0.05, 0.68, 0.22, 0.9];
  return new THREE.Color().setHSL(hues[id % hues.length], 0.65, 0.5);
}

function labelSprite(text, color = '#ffffff', bg = 'rgba(0,0,0,0.45)', scale = 1) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = '28px system-ui, sans-serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 16;
  c.width = w;
  c.height = 40;
  ctx.font = font;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, 40);
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 8, 21);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true, fog: false });
  const s = new THREE.Sprite(mat);
  s.scale.set((w / 40) * 0.45 * scale, 0.45 * scale, 1);
  return s;
}

/// A name plate over a player: the name, and a health bar when the health
/// is known (watching, offline practice). Redrawn only when it changes.
function makePlate() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 76;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true, fog: false });
  const s = new THREE.Sprite(mat);
  s.userData = { canvas: c, tex, key: null };
  s.scale.set(2.5, (2.5 * 76) / 256, 1);
  return s;
}

function drawPlate(s, name, hp, showName, showHp) {
  const bar = showHp && hp != null;
  const key = `${showName ? name : ''}|${bar ? Math.round(hp) : ''}`;
  if (s.userData.key === key) return;
  s.userData.key = key;
  const c = s.userData.canvas;
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  if (showName) {
    g.font = '600 26px system-ui, sans-serif';
    const w = Math.min(c.width - 4, Math.ceil(g.measureText(name).width) + 16);
    g.fillStyle = 'rgba(0,0,0,0.5)';
    g.fillRect((c.width - w) / 2, 2, w, 34);
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(name, c.width / 2, 20, c.width - 12);
  }
  if (bar) {
    const v = Math.max(0, Math.min(100, hp)) / 100;
    const x = 28;
    const y = 46;
    const w = c.width - 56;
    g.fillStyle = 'rgba(0,0,0,0.65)';
    g.fillRect(x - 3, y - 3, w + 6, 22);
    g.fillStyle = '#3a3a3a';
    g.fillRect(x, y, w, 16);
    g.fillStyle = v > 0.6 ? '#45d14a' : v > 0.3 ? '#f2c230' : '#f04030';
    g.fillRect(x, y, w * v, 16);
  }
  s.visible = showName || bar;
  s.userData.tex.needsUpdate = true;
}

function makeMarker() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.strokeStyle = '#000000';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(4, 6);
  g.lineTo(28, 6);
  g.lineTo(16, 26);
  g.closePath();
  g.stroke();
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false, fog: false });
  const s = new THREE.Sprite(mat);
  s.scale.set(0.035, 0.035, 1);
  s.renderOrder = 10;
  return s;
}

/// The directions of the cube's faces, in the order of CubeCamera's
/// cameras (and of the faces of its render target): +x −x +y −y +z −z.
const FACE_AXES = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

export class Renderer {
  constructor(canvas, settings) {
    this.s = settings;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x8ec5f5);
    this.scene.fog = new THREE.Fog(0x8ec5f5, 70, 230);
    this.camera = new THREE.PerspectiveCamera(80, 1, 0.05, 600);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);
    // The small second view (the wipe while watching with the automatic camera).
    this.insetCamera = new THREE.PerspectiveCamera(80, 16 / 9, 0.05, 600);
    this.insetCamera.rotation.order = 'YXZ';
    // In the scene, so the gun it carries for an inset view is drawn.
    this.scene.add(this.insetCamera);
    this.scene.add(new THREE.HemisphereLight(0xdff0ff, 0x6b8a4a, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(60, 100, 30);
    this.scene.add(sun);
    this.mapGroup = new THREE.Group();
    this.scene.add(this.mapGroup);
    this.players = new Map();
    this.pickups = new Map();
    this.grenades = new Map();
    this.tanks = new Map();
    this.effects = [];
    this.sky = this.scene.background;
    // Materials a texture can go on, and the textures set (slot -> {tex, size}).
    this.mats = {};
    this.textures = new Map();
    for (const kind of TILED) {
      const flat = kind === 'ground';
      this.mats[kind] = worldUv(new THREE.MeshLambertMaterial(flat ? { vertexColors: true } : { color: COLORS[kind] }), flat);
    }
    this.mats.leaves = new THREE.MeshLambertMaterial({ color: 0x2f7a35 });
    this.mats.tank = new THREE.MeshLambertMaterial({ color: TANK_COLOR });
    // The ring: a wall of light around the circle.
    this.ring = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 1, 128, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xff5a2a, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false, fog: false }),
    );
    this.ring.visible = false;
    this.ring.renderOrder = 5;
    this.scene.add(this.ring);
    this.buildViewmodel();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  clear() {
    this.mapGroup.clear();
    for (const p of this.players.values()) this.scene.remove(p.group);
    this.players.clear();
    for (const p of this.pickups.values()) this.scene.remove(p);
    this.pickups.clear();
    for (const g of this.grenades.values()) this.scene.remove(g);
    this.grenades.clear();
    for (const t of this.tanks.values()) this.scene.remove(t.group);
    this.tanks.clear();
    this.ring.visible = false;
    for (const e of this.effects) this.scene.remove(e.obj);
    this.effects = [];
  }

  buildMap(map) {
    this.clear();
    // Outside the fence: flat ground, as a frame around the field only. (One
    // plane under everything showed through wherever the field dips below
    // it, down to -2.5 m: over the feet, and in deep dips over the eyes.)
    const outerMat = new THREE.MeshLambertMaterial({ color: 0x5f9a40 });
    const inner = map.half;
    const outerHalf = map.half + 200;
    const band = outerHalf - inner;
    for (const [w, d, x, z] of [
      [outerHalf * 2, band, 0, -(inner + band / 2)],
      [outerHalf * 2, band, 0, inner + band / 2],
      [band, inner * 2, -(inner + band / 2), 0],
      [band, inner * 2, inner + band / 2, 0],
    ]) {
      const outer = new THREE.Mesh(new THREE.PlaneGeometry(w, d), outerMat);
      outer.rotation.x = -Math.PI / 2;
      outer.position.set(x, -0.05, z);
      this.mapGroup.add(outer);
    }

    // The terrain: one vertex per height sample, coloured by height, with a
    // faint grid so slopes and movement are easy to read.
    const n = map.grid;
    const geo = new THREE.PlaneGeometry(map.half * 2, map.half * 2, n - 1, n - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const low = new THREE.Color(0x5e9b3e);
    const mid = new THREE.Color(0x7fb24f);
    const high = new THREE.Color(0xb6b27a);
    const c = new THREE.Color();
    for (let k = 0; k < pos.count; k++) {
      // PlaneGeometry rows run from -z to +z after the rotation, matching
      // the row-major (z, then x) height grid.
      const i = k % n;
      const j = Math.floor(k / n);
      const y = map.heights[j * n + i];
      pos.setY(k, y);
      const t = Math.max(0, Math.min(1, y / 9));
      if (t < 0.5) c.copy(low).lerp(mid, t * 2);
      else c.copy(mid).lerp(high, (t - 0.5) * 2);
      const checker = (i + j) % 2 ? 1 : 0.95;
      colors[k * 3] = c.r * checker;
      colors[k * 3 + 1] = c.g * checker;
      colors[k * 3 + 2] = c.b * checker;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const terrain = new THREE.Mesh(geo, this.mats.ground);
    this.mapGroup.add(terrain);

    // Solids and tree crowns: instanced, one mesh per kind and 100 m tile
    // (a draw call for each instead of one per box, of which the field holds
    // well over a thousand; tiles out of view are still skipped).
    const TILE = 100;
    const tile = (x, z) => `${Math.floor((x + map.half) / TILE)},${Math.floor((z + map.half) / TILE)}`;
    const box = new THREE.BoxGeometry(1, 1, 1);
    const byKind = new Map();
    for (const s of map.solids) {
      const kind = COLORS[s.kind] !== undefined ? s.kind : 'wall';
      const key = `${kind}|${tile((s.min.x + s.max.x) / 2, (s.min.z + s.max.z) / 2)}`;
      if (!byKind.has(key)) byKind.set(key, []);
      byKind.get(key).push(s);
    }
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const sc = new THREE.Vector3();
    for (const [key, list] of byKind) {
      const kind = key.split('|')[0];
      const inst = new THREE.InstancedMesh(box, this.mats[kind], list.length);
      list.forEach((s, i) => {
        v.set((s.min.x + s.max.x) / 2, (s.min.y + s.max.y) / 2, (s.min.z + s.max.z) / 2);
        sc.set(s.max.x - s.min.x, s.max.y - s.min.y, s.max.z - s.min.z);
        inst.setMatrixAt(i, m4.compose(v, q, sc));
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.computeBoundingSphere();
      this.mapGroup.add(inst);
    }
    // Signs (firing range distances).
    for (const l of map.labels || []) {
      const s = labelSprite(l.text, '#ffffff', 'rgba(20,40,120,0.8)', 2.2);
      s.position.set(l.pos.x, this.groundAt(map, l.pos.x, l.pos.z) + l.pos.y, l.pos.z);
      this.mapGroup.add(s);
    }
    const leaves = this.mats.leaves;
    const cone = new THREE.ConeGeometry(1, 1, 7);
    const treeTiles = new Map();
    for (const t of map.trees) {
      const key = tile(t[0], t[1]);
      if (!treeTiles.has(key)) treeTiles.set(key, []);
      treeTiles.get(key).push(t);
    }
    for (const list of treeTiles.values()) {
      const crowns = new THREE.InstancedMesh(cone, leaves, list.length);
      list.forEach(([x, z, r, base], i) => {
        crowns.setMatrixAt(i, m4.compose(v.set(x, base + 2.5, z), q, sc.set(r, 5, r)));
      });
      crowns.instanceMatrix.needsUpdate = true;
      crowns.computeBoundingSphere();
      this.mapGroup.add(crowns);
    }
  }

  /// Puts an image on a surface (a slot of textures.js), or with image =
  /// null takes it off again. `size`: metres one copy covers.
  setTexture(slot, image, size) {
    const old = this.textures.get(slot);
    if (old) {
      old.tex.dispose();
      this.textures.delete(slot);
    }
    if (image) {
      const tex = new THREE.Texture(image);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      if (slot === 'sky') tex.mapping = THREE.EquirectangularReflectionMapping;
      else {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      }
      this.textures.set(slot, { tex, size });
    }
    this.applyTexture(slot);
  }

  applyTexture(slot) {
    const t = this.textures.get(slot);
    if (slot === 'sky') {
      this.scene.background = t ? t.tex : this.sky;
      return;
    }
    const mat = this.mats[slot];
    if (!mat) return;
    mat.map = t ? t.tex : null;
    if (slot === 'ground') {
      // The image replaces the height colours (they would tint it green).
      mat.vertexColors = !t;
    } else {
      const plain = { leaves: 0x2f7a35, tank: TANK_COLOR }[slot] ?? COLORS[slot];
      mat.color.setHex(t ? 0xffffff : plain);
    }
    if (mat.userData.texSize) mat.userData.texSize.value = (t && t.size) || 4;
    else if (t) {
      // Ordinary texture coordinates (tree crowns, tanks): repeat instead.
      const n = slot === 'leaves' ? 3 : 1;
      t.tex.repeat.set(n, n);
    }
    mat.needsUpdate = true;
  }

  /// Tanks on the field: [{id, x, y, z, yaw, aim, pitch, hp, driver}].
  /// `mine`: the tank you drive (its name plate is not shown). `label(t)`
  /// gives the text over a tank.
  setTanks(list, maxHp, mine, label) {
    const seen = new Set();
    for (const t of list) {
      seen.add(t.id);
      let m = this.tanks.get(t.id);
      if (!m) {
        m = this.buildTank();
        this.scene.add(m.group);
        this.tanks.set(t.id, m);
      }
      m.group.position.set(t.x, t.y, t.z);
      m.hull.rotation.y = t.yaw;
      m.turret.rotation.y = t.aim;
      m.gun.rotation.x = t.pitch;
      const own = t.id === mine;
      // From inside, only the gun is in view (the hull would fill it).
      m.hull.visible = !own;
      m.body.visible = !own;
      drawPlate(m.plate, label(t), (t.hp / (maxHp || 400)) * 100, this.s.get('nameplates') && !own, this.s.get('hpbars') && !own);
      const ls = this.labelScale || 1;
      m.plate.scale.set(3.2 * ls, ((3.2 * 76) / 256) * ls, 1);
    }
    for (const [id, m] of this.tanks) {
      if (!seen.has(id)) {
        this.scene.remove(m.group);
        this.tanks.delete(id);
      }
    }
  }

  buildTank() {
    const body = this.mats.tank;
    const dark = new THREE.MeshLambertMaterial({ color: 0x2c3122 });
    const B = (w, h, d, mat, x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      return m;
    };
    const group = new THREE.Group();
    // The hull points along -Z, as players do.
    const hull = new THREE.Group();
    hull.add(B(2.6, 0.9, 4.2, body, 0, 0.95, 0), B(0.7, 0.9, 4.5, dark, -1.45, 0.45, 0), B(0.7, 0.9, 4.5, dark, 1.45, 0.45, 0));
    hull.add(B(2.6, 0.35, 0.9, body, 0, 0.75, -2.3));
    const turret = new THREE.Group();
    const turretBody = new THREE.Group();
    turretBody.add(B(2.0, 0.7, 2.3, body, 0, 1.75, 0.1), B(0.7, 0.2, 0.7, dark, 0.45, 2.2, 0.5));
    turret.add(turretBody);
    const gun = new THREE.Group();
    gun.position.set(0, 1.8, -0.9);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 3.2, 12), dark);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.z = -1.6;
    const brake = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.4, 12), dark);
    brake.rotation.x = Math.PI / 2;
    brake.position.z = -3.2;
    gun.add(barrel, brake);
    turret.add(gun);
    const plate = makePlate();
    plate.position.y = 3.5;
    group.add(hull, turret, plate);
    return { group, hull, turret, body: turretBody, gun, plate };
  }

  /// The ring's wall: {x, z, r}, or null for none.
  setRing(ring) {
    this.ring.visible = !!ring;
    if (!ring) return;
    this.ring.position.set(ring.x, 30, ring.z);
    this.ring.scale.set(ring.r, 160, ring.r);
  }

  /// A tank shell: a glowing ball flying its arc until it reaches `to`.
  shell(from, to, vel, gravity = 9.81) {
    const speedXZ = Math.hypot(vel.x, vel.z);
    const speed = Math.hypot(vel.x, vel.y, vel.z);
    if (speed < 1) return;
    const flight = speedXZ > 1 ? Math.hypot(to.x - from.x, to.z - from.z) / speedXZ : Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) / speed;
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffb040, fog: false }));
    m.position.set(from.x, from.y, from.z);
    this.scene.add(m);
    this.effects.push({ obj: m, t: 0, life: Math.max(0.03, flight), kind: 'shell', from, vel, g: gravity });
  }

  groundAt(map, x, z) {
    const n = map.grid;
    if (!n || !map.heights) return 0;
    const i = Math.max(0, Math.min(n - 1, Math.round((x + map.half) / map.cell)));
    const j = Math.max(0, Math.min(n - 1, Math.round((z + map.half) / map.cell)));
    return map.heights[j * n + i];
  }

  /// A number rising from where a hit landed.
  damageNumber(pos, dmg, head) {
    const text = String(Math.round(dmg));
    const s = labelSprite(text, head ? '#ff4040' : '#ffffff', 'rgba(0,0,0,0)', head ? 1.6 : 1.2);
    s.material.depthTest = false;
    s.renderOrder = 11;
    s.position.set(pos.x + (Math.random() - 0.5) * 0.4, pos.y, pos.z);
    this.scene.add(s);
    const anim = this.s.get('uianim');
    this.effects.push({ obj: s, t: 0, life: anim ? 0.9 : 0.6, kind: anim ? 'rise' : 'static', y: pos.y });
  }

  /// Hide one player's body (the one a spectator looks through).
  hidePlayer(id) {
    const p = this.players.get(id);
    if (p) p.group.visible = false;
  }

  /// One model per gun (and items), each with its own sight picture when
  /// aiming down sights.
  buildViewmodel() {
    const dark = new THREE.MeshLambertMaterial({ color: 0x2b2f36 });
    const black = new THREE.MeshLambertMaterial({ color: 0x111316 });
    const wood = new THREE.MeshLambertMaterial({ color: 0x7a4f2a });
    const glass = new THREE.MeshBasicMaterial({ color: 0x9fd0ff, transparent: true, opacity: 0.18, depthWrite: false });
    const red = new THREE.MeshBasicMaterial({ color: 0xff2a2a });
    const B = (w, h, d, mat, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      return m;
    };
    const Cyl = (r, len, mat, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 14), mat);
      m.rotation.x = Math.PI / 2;
      m.position.set(x, y, z);
      return m;
    };
    const ring = (r, tube, mat, y, z) => {
      const m = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 6, 24), mat);
      m.position.set(0, y, z);
      return m;
    };
    const models = {};
    // AR: long body, angled magazine, holographic sight (rectangular frame).
    {
      const g = new THREE.Group();
      g.add(B(0.07, 0.09, 0.56, dark), B(0.035, 0.035, 0.3, black, 0, 0.015, -0.42));
      const mag = B(0.05, 0.16, 0.07, black, 0, -0.11, -0.06);
      mag.rotation.x = 0.25;
      g.add(mag, B(0.055, 0.13, 0.06, dark, 0, -0.1, 0.12), B(0.06, 0.09, 0.18, dark, 0, -0.01, 0.34));
      // Holo frame: two posts and a hood around a window.
      g.add(B(0.006, 0.05, 0.05, black, -0.026, 0.075, -0.05), B(0.006, 0.05, 0.05, black, 0.026, 0.075, -0.05));
      g.add(B(0.058, 0.006, 0.05, black, 0, 0.1, -0.05), B(0.058, 0.012, 0.07, black, 0, 0.048, -0.05));
      g.add(B(0.046, 0.04, 0.002, glass, 0, 0.075, -0.05));
      models.ar = { group: g, sight: 0.075, ads: 'holo' };
    }
    // SMG: short, straight magazine, ring sight.
    {
      const g = new THREE.Group();
      g.add(B(0.065, 0.085, 0.36, dark), B(0.03, 0.03, 0.12, black, 0, 0.01, -0.24));
      g.add(B(0.04, 0.2, 0.05, black, 0, -0.14, -0.05), B(0.05, 0.12, 0.06, dark, 0, -0.09, 0.1));
      g.add(ring(0.018, 0.004, black, 0.075, -0.02), B(0.01, 0.03, 0.01, black, 0, 0.055, -0.02));
      g.add(B(0.008, 0.02, 0.008, black, 0, 0.06, -0.19));
      models.smg = { group: g, sight: 0.075, ads: 'ring' };
    }
    // SG: long tube, wooden pump and stock, bead sight.
    {
      const g = new THREE.Group();
      g.add(Cyl(0.022, 0.62, black, 0, 0.02, -0.18), Cyl(0.016, 0.5, black, 0, -0.02, -0.15));
      g.add(B(0.06, 0.07, 0.16, wood, 0, -0.02, -0.18), B(0.07, 0.09, 0.22, dark, 0, 0, 0.1));
      g.add(B(0.06, 0.1, 0.22, wood, 0, -0.03, 0.3));
      const bead = new THREE.Mesh(new THREE.SphereGeometry(0.008, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffe9a0 }));
      bead.position.set(0, 0.048, -0.48);
      g.add(bead);
      models.sg = { group: g, sight: 0.048, ads: 'bead' };
    }
    // SR: long barrel, big scope, bolt.
    {
      const g = new THREE.Group();
      g.add(B(0.07, 0.08, 0.62, wood), Cyl(0.017, 0.5, black, 0, 0.02, -0.52));
      g.add(Cyl(0.03, 0.34, black, 0, 0.09, -0.02), Cyl(0.038, 0.06, black, 0, 0.09, -0.19), Cyl(0.036, 0.05, black, 0, 0.09, 0.15));
      g.add(B(0.02, 0.04, 0.02, black, 0, 0.05, -0.1), B(0.02, 0.04, 0.02, black, 0, 0.05, 0.08));
      g.add(B(0.05, 0.015, 0.015, black, 0.05, 0.03, 0.1));
      models.sr = { group: g, sight: 0.09, ads: 'scope' };
    }
    // Items.
    {
      const g = new THREE.Group();
      g.add(B(0.16, 0.11, 0.06, new THREE.MeshLambertMaterial({ color: 0xd83a3a })));
      g.add(B(0.07, 0.02, 0.062, new THREE.MeshBasicMaterial({ color: 0xffffff })), B(0.02, 0.07, 0.062, new THREE.MeshBasicMaterial({ color: 0xffffff })));
      models.medkit = { group: g, sight: 0, ads: null };
    }
    {
      const g = new THREE.Group();
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), new THREE.MeshLambertMaterial({ color: 0x3a5a26 }));
      g.add(ball, B(0.02, 0.03, 0.02, black, 0, 0.05, 0), B(0.06, 0.008, 0.012, black, 0.025, 0.06, 0));
      models.grenade = { group: g, sight: 0, ads: null };
    }
    const vm = new THREE.Group();
    for (const m of Object.values(models)) {
      m.group.visible = false;
      vm.add(m.group);
    }
    const flash = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 4), new THREE.MeshBasicMaterial({ color: 0xffd36b }));
    flash.visible = false;
    vm.add(flash);
    vm.scale.setScalar(0.6);
    this.flash = flash;
    this.models = models;
    this.viewmodel = vm;
    this.camera.add(vm);
    this.vmHip = new THREE.Vector3(0.16, -0.14, -0.34);
    this.vmTarget = new THREE.Vector3();
    void red;
  }

  /// Which model is in your hands ('ar', 'sr', 'medkit', ...).
  setHeld(kind) {
    if (this.held === kind) return;
    this.held = kind;
    for (const [k, m] of Object.entries(this.models)) m.group.visible = k === kind;
    const len = { ar: -0.72, smg: -0.42, sg: -0.66, sr: -1.0 }[kind];
    this.flash.position.set(0, 0.02, len ?? -0.5);
  }

  /// Sight style of what is held while aiming (for the HUD reticle).
  adsStyle() {
    const m = this.models[this.held];
    return m ? m.ads : null;
  }

  ensurePlayer(id, name) {
    let p = this.players.get(id);
    if (p) {
      if (name && p.name !== name) p.name = name;
      return p;
    }
    const group = new THREE.Group();
    const col = playerColor(id);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.62, 1.45, 0.4), new THREE.MeshLambertMaterial({ color: col }));
    body.position.y = 0.725;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 12, 8), new THREE.MeshLambertMaterial({ color: 0xf0c9a0 }));
    head.position.y = 1.67;
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.6), new THREE.MeshLambertMaterial({ color: 0x222222 }));
    gun.position.set(0.25, 1.25, -0.35);
    group.add(body, head, gun);
    const label = makePlate();
    label.position.y = 2.15;
    group.add(label);
    const marker = makeMarker();
    marker.position.y = 3.0;
    marker.visible = false;
    group.add(marker);
    this.scene.add(group);
    p = { group, body, head, gun, label, name: name || `#${id}`, marker };
    this.players.set(id, p);
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (p) {
      this.scene.remove(p.group);
      this.players.delete(id);
    }
  }

  /// mark: null, 'seen' (in view) or 'spotted' (marked with *, shows through walls).
  setPlayer(id, st, name, mark = null) {
    const p = this.ensurePlayer(id, name);
    p.marker.visible = !!mark && st.alive;
    drawPlate(p.label, p.name, st.hp, this.s.get('nameplates'), this.s.get('hpbars'));
    const ls = this.labelScale || 1;
    if (!p.label.userData.base) p.label.userData.base = p.label.scale.clone();
    p.label.scale.copy(p.label.userData.base).multiplyScalar(ls);
    if (mark) p.marker.material.color.setHex(mark === 'spotted' ? 0xffd400 : 0xff3030);
    const len = { ar: 0.6, smg: 0.4, sg: 0.65, sr: 0.9 }[st.gun] || 0.5;
    p.gun.scale.z = len / 0.6;
    // Inside a tank there is no body to see.
    p.group.visible = st.alive && st.tank == null;
    p.group.position.set(st.x, st.y, st.z);
    p.group.rotation.y = st.yaw;
    const sneak = st.sneak;
    p.body.scale.y = sneak ? 0.69 : 1;
    p.body.position.y = sneak ? 0.5 : 0.725;
    p.head.position.y = sneak ? 1.22 : 1.67;
    p.gun.position.y = sneak ? 0.85 : 1.25;
    p.gun.position.x = st.ads ? 0.12 : 0.25;
    p.label.position.y = sneak ? 1.85 : 2.3;
    p.marker.position.y = sneak ? 2.5 : 2.95;
  }

  setPickups(list) {
    const seen = new Set();
    for (const pk of list) {
      seen.add(pk.id);
      if (this.pickups.has(pk.id)) continue;
      const [col, text] = PICKUP_STYLE[pk.kind] || [0xffffff, '?'];
      const g = new THREE.Group();
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.5), new THREE.MeshLambertMaterial({ color: col }));
      m.position.y = 0.25;
      const label = labelSprite(text, '#ffffff', 'rgba(0,0,0,0.5)', 0.9);
      label.position.y = 0.85;
      g.add(m, label);
      g.position.set(pk.x, 0, pk.z);
      this.scene.add(g);
      this.pickups.set(pk.id, g);
    }
    for (const [id, g] of this.pickups) {
      if (!seen.has(id)) {
        this.scene.remove(g);
        this.pickups.delete(id);
      }
    }
  }

  setGrenades(list) {
    const seen = new Set();
    for (const g of list) {
      seen.add(g.id);
      let m = this.grenades.get(g.id);
      if (!m) {
        m = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), new THREE.MeshLambertMaterial({ color: 0x2d4a1e }));
        this.scene.add(m);
        this.grenades.set(g.id, m);
      }
      m.position.set(g.x, g.y, g.z);
    }
    for (const [id, m] of this.grenades) {
      if (!seen.has(id)) {
        this.scene.remove(m);
        this.grenades.delete(id);
      }
    }
  }

  /// A bullet: with `vel`, a short streak flying the same falling arc as
  /// on the server (x = x0 + v·t + ½·g·t²) until it reaches `to`; without it
  /// (an older server), a straight flash.
  tracer(from, to, mine, vel, gravity = 9.81) {
    const speedXZ = vel ? Math.hypot(vel.x, vel.z) : 0;
    if (!vel || Math.hypot(vel.x, vel.y, vel.z) < 1) {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(from.x, from.y - (mine ? 0.15 : 0), from.z),
        new THREE.Vector3(to.x, to.y, to.z),
      ]);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xfff2a8, transparent: true, opacity: 0.85 }));
      this.scene.add(line);
      this.effects.push({ obj: line, t: 0, life: 0.06, kind: 'tracer' });
      return;
    }
    const flight =
      speedXZ > 1
        ? Math.hypot(to.x - from.x, to.z - from.z) / speedXZ
        : Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) / Math.hypot(vel.x, vel.y, vel.z);
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xfff2a8, transparent: true, opacity: 0.9 }));
    line.frustumCulled = false;
    this.scene.add(line);
    // Start at the muzzle for your own shots (a little below the eye).
    const start = { x: from.x, y: from.y - (mine ? 0.12 : 0), z: from.z };
    this.effects.push({ obj: line, t: 0, life: Math.max(0.03, flight), kind: 'bullet', from: start, vel, g: gravity });
  }

  explosion(pos) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 10),
      new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.8 }),
    );
    m.position.set(pos.x, pos.y + 0.5, pos.z);
    const anim = this.s.get('uianim');
    m.scale.setScalar(anim ? 0.5 : 4);
    this.scene.add(m);
    this.effects.push({ obj: m, t: 0, life: anim ? 0.45 : 0.25, kind: anim ? 'boom' : 'static' });
  }

  muzzle() {
    this.flash.visible = true;
    this.flashTime = 0.04;
  }

  updateEffects(dt) {
    if (this.flashTime > 0) {
      this.flashTime -= dt;
      if (this.flashTime <= 0) this.flash.visible = false;
    }
    for (const e of this.effects) {
      e.t += dt;
      if (e.kind === 'bullet') {
        // Streak from where the bullet was 15 ms ago to where it is now.
        const at = (t) => {
          const tt = Math.min(t, e.life);
          return [e.from.x + e.vel.x * tt, e.from.y + e.vel.y * tt - 0.5 * e.g * tt * tt, e.from.z + e.vel.z * tt];
        };
        const a = at(Math.max(0, e.t - 0.015));
        const b = at(e.t);
        const pos = e.obj.geometry.attributes.position;
        pos.setXYZ(0, a[0], a[1], a[2]);
        pos.setXYZ(1, b[0], b[1], b[2]);
        pos.needsUpdate = true;
      }
      if (e.kind === 'shell') {
        const tt = Math.min(e.t, e.life);
        e.obj.position.set(e.from.x + e.vel.x * tt, e.from.y + e.vel.y * tt - 0.5 * e.g * tt * tt, e.from.z + e.vel.z * tt);
      }
      if (e.kind === 'rise') {
        e.obj.position.y = e.y + e.t * 1.2;
        e.obj.material.opacity = 1 - (e.t / e.life) ** 2;
      }
      if (e.kind === 'boom') {
        const k = e.t / e.life;
        e.obj.scale.setScalar(0.5 + 6 * k);
        e.obj.material.opacity = 0.8 * (1 - k);
      }
    }
    this.effects = this.effects.filter((e) => {
      if (e.t >= e.life) {
        this.scene.remove(e.obj);
        if (e.obj.isSprite) {
          // Sprites share one geometry: free only their own texture.
          if (e.obj.material.map) e.obj.material.map.dispose();
          e.obj.material.dispose();
        } else e.obj.geometry.dispose();
        return false;
      }
      return true;
    });
  }

  /// cam: {x,y,z,yaw,pitch,fov}, vm: {ads 0..1, hide, bob, kick}
  /// inset (optional): a second, small view drawn over the first —
  /// {cam, rect: {x, y, w, h} in CSS pixels from the top left, hide: the id
  /// of the player whose eyes it looks through}.
  render(cam, vm, inset = null) {
    // The fog starts farther away the higher the camera (the sky view).
    const lift = Math.max(0, cam.lift || 0);
    this.scene.fog.near = 70 + lift;
    this.scene.fog.far = 230 + lift * 1.6;
    this.camera.position.set(cam.x, cam.y, cam.z);
    this.camera.rotation.set(cam.pitch, cam.yaw, 0);
    // (Wider than a flat camera can go, it only carries the gun in your
    // hands and gives the direction; renderFisheye draws the view.)
    const flat = Math.min(cam.fov, PERSPECTIVE_MAX);
    if (Math.abs(this.camera.fov - flat) > 1e-3) {
      this.camera.fov = flat;
      this.camera.updateProjectionMatrix();
    }
    this.viewmodel.visible = !vm.hide;
    this.poseViewmodel(vm);
    if (isFisheye(cam.fov)) this.renderFisheye(cam);
    else this.renderer.render(this.scene, this.camera);
    if (inset) this.renderInset(inset);
  }

  /// Where the gun in the hands sits: at the hip, or (ads 1) with its
  /// sight on the middle of the view; bob and kick move it.
  poseViewmodel(vm) {
    const m = this.models[this.held];
    // Aiming: the sight's centre sits exactly on the screen centre.
    const sight = m ? m.sight * this.viewmodel.scale.y : 0;
    const ads = m && m.ads ? vm.ads || 0 : 0;
    this.vmTarget.set(0, -sight, m && m.ads === 'scope' ? -0.22 : -0.32);
    this.viewmodel.position.lerpVectors(this.vmHip, this.vmTarget, ads);
    this.viewmodel.position.y += vm.bob || 0;
    this.viewmodel.position.z += vm.kick || 0;
    this.viewmodel.rotation.z = (1 - ads) * 0.04;
  }

  /// A view wider than a flat camera can show (lens.js): the six directions
  /// around the eye go into a cube, and a pass over the screen looks each
  /// pixel's direction up in it. (The faces the screen cannot reach are
  /// skipped: looking ahead at a little over 120°, the one behind you.)
  renderFisheye(cam) {
    const r = this.renderer;
    const buf = r.getDrawingBufferSize(this.fishBuf || (this.fishBuf = new THREE.Vector2()));
    const s = lensStrength(cam.fov);
    const scale = lensScale(cam.fov);
    // A face has 1.5 times as many pixels per degree in its middle as the
    // middle of the screen (the faces have no antialiasing of their own).
    const want = (buf.y / 2) * (s / scale) * 2 * 1.5;
    const size = Math.max(128, Math.min(r.capabilities.maxCubemapSize || 2048, 2048, Math.ceil(want / 64) * 64));
    if (!this.fish || this.fish.size !== size) this.buildFisheye(size);
    const f = this.fish;
    const cube = f.cubeCamera;
    if (cube.coordinateSystem !== r.coordinateSystem) {
      cube.coordinateSystem = r.coordinateSystem;
      cube.updateCoordinateSystem();
    }
    cube.position.set(cam.x, cam.y, cam.z);
    cube.updateMatrixWorld();
    this.camera.updateMatrixWorld();
    // The faces in view: those that come within the widest angle on screen
    // of where you look (a face reaches 54.7° from its axis, at its corners).
    const reach = maxAngle(cam.fov, buf.x / Math.max(1, buf.y)) + 0.96 + 0.05;
    const look = this.fishLook || (this.fishLook = new THREE.Vector3());
    this.camera.getWorldDirection(look);
    const axes = FACE_AXES;
    const prevTarget = r.getRenderTarget();
    for (let i = 0; i < 6; i++) {
      const a = axes[i];
      const dot = look.x * a[0] + look.y * a[1] + look.z * a[2];
      if (Math.acos(Math.max(-1, Math.min(1, dot))) > reach) continue;
      r.setRenderTarget(f.target, i);
      r.render(this.scene, cube.children[i]);
    }
    r.setRenderTarget(prevTarget);
    const u = f.quad.material.uniforms;
    u.aspect.value = buf.x / Math.max(1, buf.y);
    u.scale.value = scale;
    u.invS.value = 1 / s;
    u.rot.value.setFromMatrix4(this.camera.matrixWorld);
    r.render(f.scene, f.camera);
  }

  buildFisheye(size) {
    if (this.fish) {
      this.fish.target.dispose();
      this.fish.target = null;
    }
    const target = new THREE.WebGLCubeRenderTarget(size, {
      colorSpace: THREE.SRGBColorSpace,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    if (this.fish) {
      this.fish.size = size;
      this.fish.target = target;
      this.fish.cubeCamera.renderTarget = target;
      this.fish.quad.material.uniforms.cube.value = target.texture;
      return;
    }
    const cubeCamera = new THREE.CubeCamera(this.camera.near, this.camera.far, target);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        cube: { value: target.texture },
        aspect: { value: 1 },
        scale: { value: 1 },
        invS: { value: 1 },
        rot: { value: new THREE.Matrix3() },
        outside: { value: new THREE.Color(0x101010) },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      fragmentShader: `
        uniform samplerCube cube;
        uniform float aspect;
        uniform float scale;
        uniform float invS;
        uniform mat3 rot;
        uniform vec3 outside;
        varying vec2 vUv;
        void main() {
          vec2 p = (vUv * 2.0 - 1.0) * vec2(aspect, 1.0);
          float rho = length(p);
          float th = atan(rho * scale) * invS;
          if (th > 3.14159265) {
            gl_FragColor = vec4(outside, 1.0);
          } else {
            vec2 d = rho > 1e-6 ? p / rho : vec2(0.0);
            vec3 v = vec3(d * sin(th), -cos(th));
            gl_FragColor = vec4(textureCube(cube, rot * v).rgb, 1.0);
          }
          #include <colorspace_fragment>
        }`,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    quad.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(quad);
    this.fish = { size, target, cubeCamera, quad, scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) };
  }

  /// `vm` (optional): the gun in that player's hands, as in render() —
  /// {held: 'ar' | ..., ads, kick, flash: the muzzle flash shows, hide}.
  renderInset({ cam, rect, hide, vm = null }) {
    const r = this.renderer;
    const c = this.insetCamera;
    c.position.set(cam.x, cam.y, cam.z);
    c.rotation.set(cam.pitch, cam.yaw, 0);
    // The small view stays a flat camera (a fisheye there would be unreadable).
    c.fov = Math.min(cam.fov, PERSPECTIVE_MAX);
    c.aspect = rect.w / rect.h;
    c.updateProjectionMatrix();
    const body = hide != null ? this.players.get(hide) : null;
    const shown = body && body.group.visible;
    if (body) body.group.visible = false;
    const shownVm = this.viewmodel.visible;
    const held = this.held;
    const flash = this.flash.visible;
    const pose = vm && !vm.hide && vm.held;
    if (pose) {
      // The gun goes to this camera for the one view, then back.
      c.add(this.viewmodel);
      c.updateMatrixWorld();
      this.setHeld(vm.held);
      this.poseViewmodel(vm);
      this.flash.visible = !!vm.flash;
    }
    this.viewmodel.visible = !!pose;
    // The canvas may be shown at another size than it is drawn at.
    const el = r.domElement;
    const size = r.getSize(this.insetSize || (this.insetSize = new THREE.Vector2()));
    const kx = size.x / (el.clientWidth || size.x);
    const ky = size.y / (el.clientHeight || size.y);
    const x = rect.x * kx;
    const y = size.y - (rect.y + rect.h) * ky;
    r.setScissorTest(true);
    r.setViewport(x, y, rect.w * kx, rect.h * ky);
    r.setScissor(x, y, rect.w * kx, rect.h * ky);
    r.render(this.scene, c);
    r.setScissorTest(false);
    r.setViewport(0, 0, size.x, size.y);
    if (body) body.group.visible = shown;
    if (pose) {
      this.camera.add(this.viewmodel);
      this.setHeld(held);
      this.flash.visible = flash;
    }
    this.viewmodel.visible = shownVm;
  }
}
